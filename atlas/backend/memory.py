"""Atlas persistent memory: knowledge graph + chat history.

Every concept Atlas learns becomes a Node. Relationships between concepts are
Edges with a weight that grows when ideas are co-activated. Everything is kept
on disk in SQLite so Atlas never forgets.
"""

from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "atlas.db"


SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'concept',
    summary TEXT,
    detail TEXT,
    embedding TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    activations INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src INTEGER NOT NULL,
    dst INTEGER NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    weight REAL NOT NULL DEFAULT 1.0,
    UNIQUE(src, dst, relation),
    FOREIGN KEY(src) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(dst) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL,
    node_refs TEXT
);

CREATE TABLE IF NOT EXISTS thoughts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at REAL NOT NULL,
    node_refs TEXT
);

CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    purpose TEXT NOT NULL,
    code TEXT NOT NULL,
    schedule_seconds REAL NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'idle',
    last_run REAL,
    last_output TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
"""


_lock = threading.RLock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


_conn = _connect()
with _lock:
    _conn.executescript(SCHEMA)
    _conn.commit()


@contextmanager
def tx():
    with _lock:
        try:
            yield _conn
            _conn.commit()
        except Exception:
            _conn.rollback()
            raise


def _vec_to_str(vec: list[float]) -> str:
    return json.dumps([round(x, 6) for x in vec])


def _vec_from_str(s: str | None) -> list[float]:
    if not s:
        return []
    try:
        return json.loads(s)
    except Exception:
        return []


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    keys = set(range(min(len(a), len(b))))
    dot = sum(a[i] * b[i] for i in keys)
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


def upsert_node(label: str, *, kind: str = "concept", summary: str = "",
                detail: str = "", embedding: list[float] | None = None) -> dict:
    label = label.strip()
    if not label:
        raise ValueError("label required")
    now = time.time()
    emb = _vec_to_str(embedding) if embedding else None
    with tx() as c:
        row = c.execute("SELECT * FROM nodes WHERE label = ?", (label,)).fetchone()
        if row:
            new_summary = summary or row["summary"]
            new_detail = detail or row["detail"]
            new_emb = emb or row["embedding"]
            c.execute(
                "UPDATE nodes SET summary=?, detail=?, embedding=?, updated_at=?, "
                "activations = activations + 1 WHERE id=?",
                (new_summary, new_detail, new_emb, now, row["id"]),
            )
            return get_node(row["id"])
        cur = c.execute(
            "INSERT INTO nodes(label, kind, summary, detail, embedding, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (label, kind, summary, detail, emb, now, now),
        )
        return get_node(cur.lastrowid)


def get_node(node_id: int) -> dict | None:
    with _lock:
        row = _conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
    return dict(row) if row else None


def find_node(label: str) -> dict | None:
    with _lock:
        row = _conn.execute("SELECT * FROM nodes WHERE label=?", (label.strip(),)).fetchone()
    return dict(row) if row else None


def all_nodes() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM nodes ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def all_edges() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM edges").fetchall()
    return [dict(r) for r in rows]


def link(src_id: int, dst_id: int, *, relation: str = "related",
         weight: float = 1.0) -> dict:
    if src_id == dst_id:
        return {}
    with tx() as c:
        row = c.execute(
            "SELECT * FROM edges WHERE src=? AND dst=? AND relation=?",
            (src_id, dst_id, relation),
        ).fetchone()
        if row:
            new_w = min(10.0, row["weight"] + weight * 0.5)
            c.execute("UPDATE edges SET weight=? WHERE id=?", (new_w, row["id"]))
            return {**dict(row), "weight": new_w}
        cur = c.execute(
            "INSERT INTO edges(src, dst, relation, weight) VALUES (?,?,?,?)",
            (src_id, dst_id, relation, weight),
        )
        return dict(c.execute("SELECT * FROM edges WHERE id=?", (cur.lastrowid,)).fetchone())


def neighbors(node_id: int) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT n.*, e.relation, e.weight FROM edges e JOIN nodes n "
            "ON n.id = e.dst WHERE e.src = ? "
            "UNION SELECT n.*, e.relation, e.weight FROM edges e JOIN nodes n "
            "ON n.id = e.src WHERE e.dst = ?",
            (node_id, node_id),
        ).fetchall()
    return [dict(r) for r in rows]


def search_similar(embedding: list[float], limit: int = 8) -> list[dict]:
    nodes = all_nodes()
    scored = []
    for n in nodes:
        v = _vec_from_str(n.get("embedding"))
        if not v:
            continue
        scored.append((cosine(embedding, v), n))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [{**n, "score": round(s, 4)} for s, n in scored[:limit] if s > 0.05]


def remember_chat(role: str, content: str, node_refs: Iterable[int] | None = None) -> dict:
    refs = json.dumps(list(node_refs) if node_refs else [])
    now = time.time()
    with tx() as c:
        cur = c.execute(
            "INSERT INTO chats(role, content, created_at, node_refs) VALUES (?,?,?,?)",
            (role, content, now, refs),
        )
        row = c.execute("SELECT * FROM chats WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def recent_chats(limit: int = 50) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM chats ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def all_chats() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM chats ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def record_thought(content: str, node_refs: Iterable[int] | None = None) -> dict:
    refs = json.dumps(list(node_refs) if node_refs else [])
    now = time.time()
    with tx() as c:
        cur = c.execute(
            "INSERT INTO thoughts(content, created_at, node_refs) VALUES (?,?,?)",
            (content, now, refs),
        )
        row = c.execute("SELECT * FROM thoughts WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def recent_thoughts(limit: int = 30) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM thoughts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def save_agent(name: str, purpose: str, code: str,
               schedule_seconds: float = 60.0) -> dict:
    now = time.time()
    with tx() as c:
        row = c.execute("SELECT id FROM agents WHERE name=?", (name,)).fetchone()
        if row:
            c.execute(
                "UPDATE agents SET purpose=?, code=?, schedule_seconds=? WHERE id=?",
                (purpose, code, schedule_seconds, row["id"]),
            )
            aid = row["id"]
        else:
            cur = c.execute(
                "INSERT INTO agents(name, purpose, code, schedule_seconds, created_at) "
                "VALUES (?,?,?,?,?)",
                (name, purpose, code, schedule_seconds, now),
            )
            aid = cur.lastrowid
        return dict(c.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone())


def update_agent_run(agent_id: int, status: str, output: str) -> None:
    with tx() as c:
        c.execute(
            "UPDATE agents SET status=?, last_run=?, last_output=? WHERE id=?",
            (status, time.time(), output[:8000], agent_id),
        )


def all_agents() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM agents ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def get_agent(agent_id: int) -> dict | None:
    with _lock:
        row = _conn.execute("SELECT * FROM agents WHERE id=?", (agent_id,)).fetchone()
    return dict(row) if row else None


def delete_agent(agent_id: int) -> None:
    with tx() as c:
        c.execute("DELETE FROM agents WHERE id=?", (agent_id,))


def stats() -> dict:
    with _lock:
        n = _conn.execute("SELECT COUNT(*) c FROM nodes").fetchone()["c"]
        e = _conn.execute("SELECT COUNT(*) c FROM edges").fetchone()["c"]
        ch = _conn.execute("SELECT COUNT(*) c FROM chats").fetchone()["c"]
        th = _conn.execute("SELECT COUNT(*) c FROM thoughts").fetchone()["c"]
        ag = _conn.execute("SELECT COUNT(*) c FROM agents").fetchone()["c"]
    return {"nodes": n, "edges": e, "chats": ch, "thoughts": th, "agents": ag}
