// Atlas agent runner. Each agent is a JS body with a `run(ctx)` function.
// The body is evaluated inside a fresh AsyncFunction so syntax errors land
// in `last_output` and never break the rest of Atlas. The scheduler ticks
// every two seconds and runs whichever agents are due.

import * as brain from "./brain.js";

const tickers = new Map(); // id -> last run timestamp

class AgentContext {
  constructor(row, logSink) {
    this.id = row.id;
    this.name = row.name;
    this.purpose = row.purpose;
    this._logs = [];
    this._sink = logSink;
  }
  log(...parts) {
    const line = parts.map((p) =>
      typeof p === "object" ? JSON.stringify(p) : String(p)).join(" ");
    this._logs.push(line);
    if (this._sink) this._sink(line);
  }
  async stats()  { return brain.stats(); }
  async think(focus) { return brain.think(focus); }
  async learn(text) { return brain.learn(text, `agent:${this.name}`); }
  async remember(label, summary = "", detail = "") {
    return brain.upsertNode({
      label: `agent::${this.name}::${label}`,
      kind: "agent-output",
      summary, detail,
      embedding: brain.embed(label + " " + summary + " " + detail),
    });
  }
}

export async function runAgent(row) {
  const ctx = new AgentContext(row);
  let status = "ok", output = "";
  try {
    // eslint-disable-next-line no-new-func
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const factory = new AsyncFn("ctx",
      `${row.code}\n;return typeof run === "function" ? run(ctx) : null;`);
    const result = await factory(ctx);
    output = ctx._logs.join("\n");
    if (result !== undefined && result !== null) {
      output += `\nresult: ${typeof result === "object"
        ? JSON.stringify(result) : result}`;
    }
  } catch (err) {
    status = "error";
    output = ctx._logs.join("\n") + "\n" + (err && err.stack
      ? err.stack : String(err));
    await brain.recordThought(
      `Agent '${row.name}' failed: ${String(err).slice(0, 200)}`);
  }
  await brain.updateAgentRun(row.id, status, output);
  return { status, output };
}

export async function runNow(id) {
  const row = await brain.getAgent(id);
  if (!row) throw new Error("agent not found");
  tickers.set(row.id, Date.now());
  return runAgent(row);
}

export function startScheduler() {
  setInterval(async () => {
    const list = await brain.allAgents();
    const now = Date.now();
    for (const row of list) {
      const last = tickers.get(row.id) || 0;
      if (now - last >= (row.schedule_seconds || 60) * 1000) {
        tickers.set(row.id, now);
        runAgent(row).catch(() => {});
      }
    }
  }, 2000);
}

const HEARTBEAT_CODE = `// Records that Atlas is alive and grows over time.
async function run(ctx) {
  const s = await ctx.stats();
  ctx.log("Heartbeat:", s.nodes, "nodes,", s.edges, "edges,",
          s.thoughts, "thoughts logged.");
  await ctx.remember("heartbeat",
    \`Atlas alive with \${s.nodes} nodes\`,
    JSON.stringify(s));
  return s;
}
`;

const REFLECT_CODE = `// Pushes Atlas to think every interval.
async function run(ctx) {
  const t = await ctx.think();
  ctx.log("Thought:", t.thought);
  return t.thought;
}
`;

export async function installStarterAgents() {
  const existing = new Set((await brain.allAgents()).map((a) => a.name));
  if (!existing.has("heartbeat")) {
    await brain.saveAgent({
      name: "heartbeat",
      purpose: "Records that Atlas is alive and logs graph stats.",
      code: HEARTBEAT_CODE,
      schedule_seconds: 30,
    });
  }
  if (!existing.has("reflect")) {
    await brain.saveAgent({
      name: "reflect",
      purpose: "Forces Atlas to think and form new connections.",
      code: REFLECT_CODE,
      schedule_seconds: 20,
    });
  }
}
