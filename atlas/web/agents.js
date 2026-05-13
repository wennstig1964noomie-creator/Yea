// Atlas agent runner. Each agent is a JS body with a `run(ctx)` function.
// The body is evaluated inside a fresh AsyncFunction so syntax errors land
// in `last_output` and never break the rest of Atlas.

import * as brain from "./brain.js";

const tickers = new Map();

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
  async teachNext() { return brain.teachNextCurriculum(); }
  async consolidate(n = 6) { return brain.consolidate(n); }
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
  }, 1500);
}

const CURRICULUM_CODE = `// Atlas's autonomous learning engine.
// Each tick pulls the next code/DB lesson from the curriculum and absorbs it.
async function run(ctx) {
  const r = await ctx.teachNext();
  ctx.log("learned:", r.label, "(", r.idx + 1, "/", r.total, ")");
  return r.label;
}
`;

const REFLECT_CODE = `// Forces Atlas to form a new connection every interval.
async function run(ctx) {
  const t = await ctx.think();
  ctx.log("thought:", t.thought);
  return t.thought;
}
`;

const CONSOLIDATE_CODE = `// Closes triangles in the graph: if A-B and B-C exist,
// propose a weaker A-C link so related ideas stay reachable.
async function run(ctx) {
  const r = await ctx.consolidate(6);
  ctx.log("consolidation added", r.added, "transitive edges");
  return r;
}
`;

const HEARTBEAT_CODE = `// Records that Atlas is alive and growing.
async function run(ctx) {
  const s = await ctx.stats();
  ctx.log("heartbeat:", s.nodes, "nodes,", s.edges, "edges,",
          s.thoughts, "thoughts.");
  await ctx.remember("heartbeat",
    \`Atlas alive with \${s.nodes} nodes\`,
    JSON.stringify(s));
  return s;
}
`;

export async function installStarterAgents() {
  const existing = new Map((await brain.allAgents()).map((a) => [a.name, a]));
  const wants = [
    { name: "curriculum",
      purpose: "Pulls the next code/DB lesson and learns it. Never stops.",
      code: CURRICULUM_CODE, schedule_seconds: 8 },
    { name: "reflect",
      purpose: "Forces Atlas to think and form new connections.",
      code: REFLECT_CODE, schedule_seconds: 12 },
    { name: "consolidate",
      purpose: "Closes triangles to make distant ideas reachable.",
      code: CONSOLIDATE_CODE, schedule_seconds: 45 },
    { name: "heartbeat",
      purpose: "Records that Atlas is alive and logs graph stats.",
      code: HEARTBEAT_CODE, schedule_seconds: 60 },
  ];
  for (const w of wants) {
    const prev = existing.get(w.name);
    if (!prev) {
      await brain.saveAgent(w);
    } else if (prev.code !== w.code
              || prev.schedule_seconds !== w.schedule_seconds
              || prev.purpose !== w.purpose) {
      // Keep starter agents fresh when we ship improvements, but never
      // touch agents the user has customised by renaming them.
      await brain.saveAgent({ ...w });
    }
  }
}
