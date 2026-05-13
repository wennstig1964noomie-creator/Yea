"""Agent system controlled by Atlas.

Atlas defines agents as small Python scripts with a `run(ctx)` function. The
manager keeps each agent alive on a schedule and feeds back results into the
brain so Atlas notices when an agent breaks and can iterate on its code.

Agents run in a restricted-ish exec namespace -- enough power to be useful
(file I/O, HTTP via stdlib, computation) but isolated to a per-agent module so
crashes don't take down the system.
"""

from __future__ import annotations

import io
import threading
import time
import traceback
from contextlib import redirect_stdout
from typing import Any

from . import brain, memory


class AgentContext:
    """The handle each agent gets. Lets agents read/write memory and log."""

    def __init__(self, agent_row: dict):
        self.name = agent_row["name"]
        self.purpose = agent_row["purpose"]
        self.id = agent_row["id"]
        self.log_lines: list[str] = []

    def log(self, *parts: Any) -> None:
        line = " ".join(str(p) for p in parts)
        self.log_lines.append(line)

    def remember(self, label: str, summary: str = "", detail: str = "") -> dict:
        node = memory.upsert_node(
            label=f"agent::{self.name}::{label}",
            kind="agent-output",
            summary=summary,
            detail=detail,
            embedding=brain.embed(label + " " + summary + " " + detail),
        )
        return node

    def teach(self, text: str) -> dict:
        return brain.learn(text, source=f"agent:{self.name}")


class AgentManager:
    def __init__(self):
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_run: dict[int, float] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop,
                                        name="atlas-agents", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def create(self, name: str, purpose: str, code: str,
               schedule_seconds: float = 60.0) -> dict:
        name = name.strip().replace(" ", "_")
        row = memory.save_agent(name, purpose, code, schedule_seconds)
        memory.upsert_node(
            label=f"agent::{name}",
            kind="agent",
            summary=purpose,
            detail=code[:2000],
            embedding=brain.embed(name + " " + purpose),
        )
        memory.record_thought(
            f"Atlas created agent '{name}' for: {purpose}",
            node_refs=[],
        )
        return row

    def update_code(self, agent_id: int, code: str) -> dict:
        row = memory.get_agent(agent_id)
        if not row:
            raise ValueError("agent not found")
        return memory.save_agent(row["name"], row["purpose"], code,
                                 row["schedule_seconds"])

    def delete(self, agent_id: int) -> None:
        memory.delete_agent(agent_id)

    def run_now(self, agent_id: int) -> dict:
        row = memory.get_agent(agent_id)
        if not row:
            raise ValueError("agent not found")
        return self._execute(row)

    def list(self) -> list[dict]:
        return memory.all_agents()

    def _loop(self) -> None:
        while not self._stop.is_set():
            now = time.time()
            for row in memory.all_agents():
                last = self._last_run.get(row["id"], 0)
                if now - last >= float(row["schedule_seconds"]):
                    self._last_run[row["id"]] = now
                    try:
                        self._execute(row)
                    except Exception as exc:
                        memory.update_agent_run(row["id"], "error", str(exc))
            self._stop.wait(2.0)

    def _execute(self, row: dict) -> dict:
        ctx = AgentContext(row)
        ns: dict[str, Any] = {
            "__name__": f"atlas_agent_{row['name']}",
            "ctx": ctx,
        }
        buf = io.StringIO()
        status = "ok"
        try:
            with redirect_stdout(buf):
                exec(compile(row["code"], f"<agent:{row['name']}>", "exec"), ns)
                run_fn = ns.get("run")
                if not callable(run_fn):
                    raise RuntimeError("agent has no run(ctx) function")
                result = run_fn(ctx)
            output = buf.getvalue() + "\n".join(ctx.log_lines)
            if result is not None:
                output += f"\nresult: {result}"
        except Exception:
            status = "error"
            output = buf.getvalue() + "\n" + "\n".join(ctx.log_lines) + "\n"
            output += traceback.format_exc()
            # Atlas reflects on the failure so it can attempt a fix later.
            memory.record_thought(
                f"Agent '{row['name']}' failed. Atlas should review its code."
            )
        memory.update_agent_run(row["id"], status, output)
        return {"status": status, "output": output[:8000]}


manager = AgentManager()


# A starter agent so the UI has something to look at on first boot.
STARTER_AGENT_CODE = '''
"""Heartbeat agent. Records that Atlas is alive and logs graph stats."""

def run(ctx):
    from atlas.backend import memory
    s = memory.stats()
    ctx.log(f"Heartbeat: {s['nodes']} nodes, {s['edges']} edges, "
            f"{s['thoughts']} thoughts logged so far.")
    ctx.remember(
        label="heartbeat",
        summary=f"Atlas alive with {s['nodes']} nodes",
        detail=str(s),
    )
    return s
'''


def install_starter_agents() -> None:
    existing = {a["name"] for a in memory.all_agents()}
    if "heartbeat" not in existing:
        manager.create(
            name="heartbeat",
            purpose="Records that Atlas is alive and logs graph stats.",
            code=STARTER_AGENT_CODE,
            schedule_seconds=30.0,
        )
