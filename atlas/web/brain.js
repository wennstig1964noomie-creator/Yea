// Atlas browser brain. All knowledge lives in IndexedDB. The "embedding"
// is a deterministic hashed bag-of-words so this whole thing runs offline
// with no API key. The more you teach, the denser the graph and the better
// the answers get.

import { CURRICULUM } from "./curriculum.js";

const DB_NAME = "atlas";
const DB_VERSION = 1;
const EMBED_DIM = 96;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","for","to","of","in",
  "on","at","by","with","is","are","was","were","be","been","being","this",
  "that","these","those","it","its","as","from","into","about","can","could",
  "should","would","will","we","you","your","our","they","their","i","me",
  "my","not","do","does","did","has","have","had","so","than","such","also",
  "when","what","which","who","how","why","where","tell","me","know","much",
  "really","very","quite","just","only",
]);

const CODE_HINTS = new Set([
  "function","class","method","variable","loop","array","list","object",
  "string","integer","boolean","database","table","query","index","schema",
  "sql","join","select","insert","update","delete","api","endpoint","http",
  "request","response","json","yaml","python","javascript","typescript",
  "rust","go","java","kotlin","compile","runtime","thread","process","memory",
  "cache","queue","stack","heap","pointer","reference","async","await",
  "promise","callback","closure","module","package","import","export",
  "framework","library","container","docker","kubernetes","deploy","test",
  "unit","integration","ci","cd","git","commit","branch","merge","rebase",
  "pull","push","fork","node","edge","graph","tree","hash","encryption",
  "token","auth","oauth","jwt","rest","graphql","websocket","tcp","udp",
  "dns","proxy","balancer","microservice","monolith","serverless","lambda",
  "indexeddb","localstorage","react","vue","svelte","fetch","webgl","threejs",
  "postgres","mysql","mongo","redis","kafka","grpc","ssl","tls",
]);

// ---------- tokens / embedding ------------------------------------------

export function tokens(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().match(/[a-z_][a-z0-9_+#\-]{1,}/g) || [];
  return raw.filter((t) => !STOPWORDS.has(t) && t.length > 2);
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function embed(text) {
  const vec = new Float32Array(EMBED_DIM);
  const toks = tokens(text);
  if (!toks.length) return Array.from(vec);
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  for (const [tok, c] of counts) {
    const h = hash32(tok);
    const idx = h % EMBED_DIM;
    const sign = ((h >>> 8) & 1) === 0 ? 1 : -1;
    vec[idx] += sign * (1 + Math.log(c));
    // bigram hash to keep some structure
    const idx2 = ((h >>> 16) ^ (h * 2654435761)) % EMBED_DIM;
    vec[idx2] += sign * 0.4 * (1 + Math.log(c));
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

export function keywords(text, k = 8) {
  const toks = tokens(text);
  if (!toks.length) return [];
  const scored = new Map();
  for (const t of toks) {
    const boost = CODE_HINTS.has(t) ? 2.0 : 1.0;
    scored.set(t, (scored.get(t) || 0) + boost);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([w]) => w);
}

export function summarise(text, max = 240) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastDot = cut.lastIndexOf(".");
  if (lastDot > 60) return cut.slice(0, lastDot + 1);
  return cut.trimEnd() + "...";
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- IndexedDB ----------------------------------------------------

let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const nodes = db.createObjectStore("nodes", { keyPath: "id",
        autoIncrement: true });
      nodes.createIndex("label", "label", { unique: true });
      const edges = db.createObjectStore("edges", { keyPath: "id",
        autoIncrement: true });
      edges.createIndex("src", "src");
      edges.createIndex("dst", "dst");
      edges.createIndex("pair", ["src", "dst", "relation"], { unique: true });
      db.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("thoughts", { keyPath: "id",
        autoIncrement: true });
      const ag = db.createObjectStore("agents", { keyPath: "id",
        autoIncrement: true });
      ag.createIndex("name", "name", { unique: true });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode = "readonly") {
  return openDB().then((db) => db.transaction(stores, mode));
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getAll(store) {
  const t = await tx([store]);
  return wrap(t.objectStore(store).getAll());
}
async function getOne(store, key) {
  const t = await tx([store]);
  return wrap(t.objectStore(store).get(key));
}
async function getByIndex(store, index, value) {
  const t = await tx([store]);
  return wrap(t.objectStore(store).index(index).get(value));
}
async function put(store, value) {
  const t = await tx([store], "readwrite");
  return wrap(t.objectStore(store).put(value));
}
async function add(store, value) {
  const t = await tx([store], "readwrite");
  return wrap(t.objectStore(store).add(value));
}

// ---------- meta key-value (for curriculum cursor, etc) ------------------

export async function metaGet(key) {
  const row = await getOne("meta", key);
  return row ? row.value : undefined;
}
export async function metaSet(key, value) {
  await put("meta", { key, value });
}

// ---------- core memory API ---------------------------------------------

export async function stats() {
  const t = await tx(["nodes", "edges", "chats", "thoughts", "agents"]);
  const [n, e, c, th, ag] = await Promise.all([
    wrap(t.objectStore("nodes").count()),
    wrap(t.objectStore("edges").count()),
    wrap(t.objectStore("chats").count()),
    wrap(t.objectStore("thoughts").count()),
    wrap(t.objectStore("agents").count()),
  ]);
  return { nodes: n, edges: e, chats: c, thoughts: th, agents: ag };
}

export async function allNodes() { return getAll("nodes"); }
export async function allEdges() { return getAll("edges"); }
export async function getNode(id) { return getOne("nodes", id); }
export async function findNode(label) {
  return getByIndex("nodes", "label", String(label).trim());
}

export async function upsertNode(opts) {
  const label = String(opts.label || "").trim();
  if (!label) throw new Error("label required");
  const existing = await findNode(label);
  const now = Date.now();
  if (existing) {
    existing.summary = opts.summary || existing.summary || "";
    if (opts.detail) {
      // accumulate detail rather than overwrite
      const prev = existing.detail || "";
      if (!prev.includes(opts.detail)) {
        existing.detail = (prev ? prev + "\n" : "") + opts.detail;
      }
    }
    if (opts.embedding) existing.embedding = opts.embedding;
    existing.updated_at = now;
    existing.activations = (existing.activations || 1) + 1;
    await put("nodes", existing);
    return existing;
  }
  const row = {
    label,
    kind: opts.kind || "concept",
    summary: opts.summary || "",
    detail: opts.detail || "",
    embedding: opts.embedding || embed(label),
    created_at: now,
    updated_at: now,
    activations: 1,
  };
  row.id = await add("nodes", row);
  return row;
}

export async function link(srcId, dstId, opts = {}) {
  if (srcId === dstId || !srcId || !dstId) return null;
  const relation = opts.relation || "related";
  const weight = opts.weight || 1.0;
  const t = await tx(["edges"], "readwrite");
  const idx = t.objectStore("edges").index("pair");
  const existing = await wrap(idx.get([srcId, dstId, relation]));
  if (existing) {
    existing.weight = Math.min(10, existing.weight + weight * 0.5);
    await wrap(t.objectStore("edges").put(existing));
    return existing;
  }
  const row = { src: srcId, dst: dstId, relation, weight };
  row.id = await wrap(t.objectStore("edges").add(row));
  return row;
}

// Index of every edge keyed by node, for fast graph traversal.
async function buildAdjacency() {
  const edges = await allEdges();
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src).push({ other: e.dst, relation: e.relation,
      weight: e.weight });
    adj.get(e.dst).push({ other: e.src, relation: e.relation,
      weight: e.weight });
  }
  return adj;
}

export async function neighbors(nodeId) {
  const adj = await buildAdjacency();
  const list = adj.get(nodeId) || [];
  const seen = new Map();
  for (const n of list) {
    if (!seen.has(n.other) || seen.get(n.other).weight < n.weight) {
      seen.set(n.other, n);
    }
  }
  const out = [];
  for (const [oid, meta] of seen) {
    const node = await getNode(oid);
    if (node) out.push({ ...node, relation: meta.relation,
      weight: meta.weight });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

export async function searchSimilar(vec, limit = 8, queryText = "") {
  const nodes = await allNodes();
  const qTokens = new Set(tokens(queryText));
  const scored = [];
  for (const n of nodes) {
    if (!n.embedding || !n.embedding.length) continue;
    let s = cosine(vec, n.embedding);
    // Label-overlap boost: when a node's label is literally a word in the
    // question, ranking it above near-by words is almost always correct.
    if (qTokens.size) {
      const labelToks = tokens(n.label);
      let hit = 0;
      for (const t of labelToks) if (qTokens.has(t)) hit++;
      if (hit > 0) s += 0.25 + 0.05 * hit;
    }
    // Slightly prefer concept nodes over giant document nodes for answers.
    if (n.kind && !n.kind.startsWith("document")) s += 0.02;
    if (s > 0.05) scored.push([s, n]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit)
    .map(([s, n]) => ({ ...n, score: +s.toFixed(4) }));
}

// BFS shortest path between two node ids (undirected).
export async function shortestPath(srcId, dstId, maxDepth = 6) {
  if (srcId === dstId) return [srcId];
  const adj = await buildAdjacency();
  const prev = new Map([[srcId, null]]);
  let frontier = [srcId];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const cur of frontier) {
      for (const { other } of (adj.get(cur) || [])) {
        if (prev.has(other)) continue;
        prev.set(other, cur);
        if (other === dstId) {
          const path = [];
          let n = other;
          while (n != null) { path.push(n); n = prev.get(n); }
          return path.reverse();
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

export async function rememberChat(role, content, refs = []) {
  const row = { role, content, created_at: Date.now(), node_refs: refs };
  row.id = await add("chats", row);
  return row;
}
export async function recentChats(limit = 200) {
  const all = await getAll("chats");
  return all.slice(-limit);
}
export async function recordThought(content, refs = []) {
  const row = { content, created_at: Date.now(), node_refs: refs };
  row.id = await add("thoughts", row);
  return row;
}
export async function recentThoughts(limit = 30) {
  const all = await getAll("thoughts");
  return all.slice(-limit);
}

// agents -----------------------------------------------------------------
export async function allAgents() { return getAll("agents"); }
export async function getAgent(id) { return getOne("agents", id); }
export async function saveAgent({ name, purpose, code,
                                  schedule_seconds = 60 }) {
  name = String(name).trim().replace(/\s+/g, "_");
  const t = await tx(["agents"], "readwrite");
  const idx = t.objectStore("agents").index("name");
  const existing = await wrap(idx.get(name));
  if (existing) {
    Object.assign(existing, { purpose, code, schedule_seconds });
    await wrap(t.objectStore("agents").put(existing));
    return existing;
  }
  const row = {
    name, purpose, code, schedule_seconds,
    status: "idle", last_run: null, last_output: null,
    created_at: Date.now(),
  };
  row.id = await wrap(t.objectStore("agents").add(row));
  return row;
}
export async function updateAgentRun(id, status, output) {
  const row = await getAgent(id);
  if (!row) return;
  row.status = status;
  row.last_run = Date.now();
  row.last_output = String(output || "").slice(0, 8000);
  await put("agents", row);
}
export async function deleteAgent(id) {
  const t = await tx(["agents"], "readwrite");
  await wrap(t.objectStore("agents").delete(id));
}

// ---------- learn --------------------------------------------------------

export async function learn(text, source = "user") {
  text = String(text || "").trim();
  if (!text) return { nodes: [], edges: 0, summary: "", keywords: [] };

  const summary = summarise(text);
  const fullVec = embed(text);
  const kws = keywords(text, 10);
  const created = [];

  // Each learn() makes a "document" node carrying the raw detail and a set
  // of concept nodes. Concept nodes are stable across calls so the same
  // keyword reused over time accumulates activations and detail.
  const parent = await upsertNode({
    label: `doc::${Date.now()}::${kws[0] || "note"}`,
    kind: `document:${source}`,
    summary, detail: text, embedding: fullVec,
  });
  created.push(parent);

  const conceptNodes = [];
  for (const kw of kws) {
    const node = await upsertNode({
      label: kw,
      kind: CODE_HINTS.has(kw) ? "code-concept" : "concept",
      summary: `Concept extracted from learning (${source}).`,
      detail: summary,
      embedding: embed(kw + " " + summary),
    });
    conceptNodes.push(node);
    await link(parent.id, node.id, { relation: "mentions", weight: 1.2 });
    created.push(node);
  }

  let edgeCount = 0;
  // Co-occurrence between every pair of concepts in the same lesson.
  for (let i = 0; i < conceptNodes.length; i++) {
    for (let j = i + 1; j < conceptNodes.length; j++) {
      await link(conceptNodes[i].id, conceptNodes[j].id,
        { relation: "co-occurs", weight: 0.8 });
      edgeCount++;
    }
  }

  // Bind each concept to the most similar existing concepts (across all
  // prior lessons) so the graph develops a strong "evokes" backbone --
  // this is where Atlas's idea-connection power comes from.
  for (const c of conceptNodes) {
    const sim = (await searchSimilar(c.embedding, 4))
      .filter((s) => s.id !== c.id
        && !s.kind.startsWith("document"));
    for (const s of sim) {
      if (s.score < 0.25) continue;
      await link(c.id, s.id, { relation: "evokes",
        weight: Math.max(0.4, s.score) });
      edgeCount++;
    }
  }

  // Bind the parent doc to similar existing docs.
  const docSim = (await searchSimilar(fullVec, 5))
    .filter((s) => s.id !== parent.id);
  for (const s of docSim) {
    await link(parent.id, s.id, { relation: "similar",
      weight: Math.max(0.3, s.score) });
    edgeCount++;
  }

  return {
    summary,
    nodes: created.map((n) => ({ id: n.id, label: n.label })),
    edges: edgeCount,
    keywords: kws,
  };
}

// ---------- think + consolidate -----------------------------------------

function pickWeighted(nodes, weightFn) {
  if (!nodes.length) return null;
  let total = 0;
  const weights = nodes.map((n) => Math.max(0.0001, weightFn(n)));
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < nodes.length; i++) {
    r -= weights[i];
    if (r <= 0) return nodes[i];
  }
  return nodes[nodes.length - 1];
}

export async function think(focus) {
  const nodes = await allNodes();
  if (!nodes.length) {
    return { thought: "Atlas is still empty. Teach me something.",
      node_refs: [] };
  }
  let start = null;
  if (focus) {
    start = await findNode(focus);
    if (!start) {
      const sims = await searchSimilar(embed(focus), 3);
      start = sims[0] || null;
    }
  }
  if (!start) {
    // Pick by a blend of recency and activations -- highly-used and freshly-
    // touched nodes are most likely to be productive starting points.
    const recent = nodes.filter((n) =>
      Date.now() - (n.updated_at || 0) < 1000 * 60 * 60 * 24 * 14);
    const pool = recent.length > 8 ? recent : nodes;
    start = pickWeighted(pool, (n) =>
      Math.log(1 + (n.activations || 1)) + Math.random() * 0.4);
  }

  const adj = await buildAdjacency();
  const startNeigh = adj.get(start.id) || [];

  const mode = Math.random();
  let thought, refs;

  if (mode < 0.55 && startNeigh.length) {
    // Multi-hop inference: find a 2-hop node that shares >=2 neighbors with
    // start but isn't already linked. Linking them is a real new idea.
    const oneHop = new Map();
    for (const e of startNeigh) oneHop.set(e.other, e);
    const candidates = new Map(); // id -> overlap count
    for (const e of startNeigh) {
      for (const e2 of (adj.get(e.other) || [])) {
        if (e2.other === start.id || oneHop.has(e2.other)) continue;
        candidates.set(e2.other, (candidates.get(e2.other) || 0) + 1);
      }
    }
    let best = null, bestScore = 0;
    for (const [oid, c] of candidates) {
      if (c > bestScore) { bestScore = c; best = oid; }
    }
    if (best && bestScore >= 1) {
      const partner = await getNode(best);
      await link(start.id, partner.id, { relation: "inferred",
        weight: 0.5 + bestScore * 0.2 });
      thought = `Atlas inferred '${start.label}' and '${partner.label}' are related — ` +
        `they share ${bestScore} common connections, so they likely belong ` +
        `to the same area.`;
      refs = [start.id, partner.id];
    }
  }

  if (!thought && mode < 0.85 && startNeigh.length) {
    // Reinforce: pick a neighbor and explain why it relates.
    const e = startNeigh[Math.floor(Math.random() * startNeigh.length)];
    const partner = await getNode(e.other);
    await link(start.id, partner.id, { relation: "inferred", weight: 0.4 });
    thought = `Atlas connects '${start.label}' with '${partner.label}' ` +
      `(${e.relation}). They keep co-occurring so the bond strengthens.`;
    refs = [start.id, partner.id];
  }

  if (!thought) {
    // Similarity-based jump for sparsely connected nodes.
    const sim = (await searchSimilar(start.embedding || embed(start.label), 5))
      .filter((s) => s.id !== start.id);
    if (sim.length) {
      const partner = sim[0];
      await link(start.id, partner.id, { relation: "evokes",
        weight: Math.max(0.3, partner.score) });
      thought = `Atlas suspects '${start.label}' relates to '${partner.label}' ` +
        `by similarity (${partner.score}).`;
      refs = [start.id, partner.id];
    } else {
      thought = `Atlas is reflecting on '${start.label}' but has nothing ` +
        `nearby to link it to yet.`;
      refs = [start.id];
    }
  }

  await recordThought(thought, refs);
  return { thought, node_refs: refs };
}

// Find triangles (A-B, B-C) where A-C is missing and create a weaker
// inferred A-C link. Caps the number of edges added per pass to avoid
// runaway growth.
export async function consolidate(maxNew = 8) {
  const adj = await buildAdjacency();
  const ids = [...adj.keys()];
  if (ids.length < 3) return { added: 0 };

  // Precompute neighbor sets and edge weights.
  const nbrSet = new Map();
  const wMap = new Map();
  for (const [id, list] of adj) {
    const s = new Set();
    for (const e of list) {
      s.add(e.other);
      wMap.set(`${id}->${e.other}`, e.weight);
    }
    nbrSet.set(id, s);
  }

  // Pick a random subset of nodes to consider each pass so we keep it cheap.
  const sample = [...ids].sort(() => Math.random() - 0.5)
    .slice(0, Math.min(50, ids.length));

  const proposals = [];
  for (const b of sample) {
    const neigh = [...(nbrSet.get(b) || [])];
    for (let i = 0; i < neigh.length; i++) {
      for (let j = i + 1; j < neigh.length; j++) {
        const a = neigh[i], c = neigh[j];
        if (a === c) continue;
        if ((nbrSet.get(a) || new Set()).has(c)) continue;
        const wab = wMap.get(`${a}->${b}`) || wMap.get(`${b}->${a}`) || 0.5;
        const wbc = wMap.get(`${b}->${c}`) || wMap.get(`${c}->${b}`) || 0.5;
        proposals.push([a, c, Math.min(wab, wbc) * 0.4]);
      }
    }
  }
  proposals.sort((x, y) => y[2] - x[2]);
  let added = 0;
  for (const [a, c, w] of proposals) {
    if (added >= maxNew) break;
    await link(a, c, { relation: "inferred", weight: w });
    added++;
  }
  if (added) {
    await recordThought(`Consolidation pass added ${added} transitive ` +
      `connections by closing triangles in the graph.`);
  }
  return { added };
}

// ---------- answer (multi-hop, intent-aware composition) ----------------

function classifyIntent(q) {
  const s = q.toLowerCase();
  if (/^(how do|how to|how can|how should)/.test(s)) return "how";
  if (/^why/.test(s)) return "why";
  if (/connect|relate|relationship|link|between/.test(s)
      && /(.+)\s+(and|with|to)\s+(.+)/.test(s)) return "connect";
  if (/(difference|vs\.?|versus|compare)/.test(s)) return "compare";
  if (/^(list|name|give me|show me)/.test(s)) return "list";
  if (/^(what|tell|explain|describe|define|who)/.test(s)) return "what";
  return "what";
}

function extractEntities(q) {
  // Try to pull two entities from "X and Y" / "X vs Y" / "between X and Y".
  const s = q.toLowerCase();
  let m = s.match(/(?:between|connect|relate|relation(?:ship)?)\s+(.+?)\s+(?:and|with|to)\s+(.+?)[?.!]?$/);
  if (m) return [m[1].trim(), m[2].trim()];
  m = s.match(/(.+?)\s+(?:vs\.?|versus)\s+(.+?)[?.!]?$/);
  if (m) return [m[1].trim(), m[2].trim()];
  m = s.match(/difference\s+between\s+(.+?)\s+and\s+(.+?)[?.!]?$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return null;
}

async function describeNode(node) {
  // Pull one tight sentence summarising what we know about a node, blending
  // the stored summary with the first sentence of its accumulated detail.
  const pieces = [];
  if (node.summary && !node.summary.startsWith("Concept extracted")) {
    pieces.push(node.summary);
  }
  if (node.detail) {
    const first = splitSentences(node.detail)[0];
    if (first && !pieces.some((p) => p.includes(first))) pieces.push(first);
  }
  return pieces.join(" ");
}

export async function answer(question) {
  const q = String(question || "").trim();
  if (!q) return { reply: "Ask me anything.", refs: [] };

  const intent = classifyIntent(q);
  const ents = extractEntities(q);

  // CONNECT mode: find shortest path between two entities.
  if (intent === "connect" && ents) {
    const a = (await findNode(ents[0])) ||
      (await searchSimilar(embed(ents[0]), 1))[0];
    const b = (await findNode(ents[1])) ||
      (await searchSimilar(embed(ents[1]), 1))[0];
    if (a && b) {
      const path = await shortestPath(a.id, b.id, 6);
      if (path && path.length) {
        const labels = await Promise.all(path.map(async (id) =>
          (await getNode(id))?.label || `#${id}`));
        const reply = `Atlas connects them via: ${labels.join(" → ")}. ` +
          `Each hop is an edge it has learned over time.`;
        return { reply, refs: path };
      }
      return { reply: `I know '${a.label}' and '${b.label}' but haven't ` +
        `linked them yet. Teach me more about either and I'll connect them.`,
        refs: [a.id, b.id] };
    }
  }

  const qv = embed(q);
  let matches = await searchSimilar(qv, 8, q);

  // Topic-aware direct lookup. Pull a candidate noun from the question and
  // try every plausible node label for it, including the head word alone
  // (e.g. "list things about sql" -> try "sql"). Promote the first hit.
  const cleaned = q.toLowerCase()
    .replace(/^(what (is|are) (a |an |the )?|how (do|to|can|should) (i |you )?|tell me about |tell me |explain |describe |define |list (me )?(of |things (related |about )?(to |of )?)?|give me|show me|name )/, "")
    .replace(/[?.!]+$/, "")
    .replace(/\s+(in|with|for|about|of)\s+(python|javascript|js|sql|rust|go)$/, "")
    .trim();
  const headTokens = tokens(cleaned).filter((t) => !STOPWORDS.has(t));
  const candidates = new Set();
  if (cleaned) {
    candidates.add(cleaned);
    candidates.add(cleaned.replace(/s$/, ""));
    candidates.add(cleaned + "s");
  }
  for (const tok of headTokens) {
    candidates.add(tok);
    candidates.add(tok.replace(/s$/, ""));
    candidates.add(tok + "s");
  }
  for (const c of candidates) {
    if (!c) continue;
    const direct = await findNode(c);
    if (direct) {
      matches = [{ ...direct, score: 1.0 },
        ...matches.filter((m) => m.id !== direct.id)];
      break;
    }
  }

  // Honest "I don't know" path. Trigger if there are no matches, the top
  // score is weak, or no top match shares any token with the question.
  const qToks = new Set(tokens(q));
  const topShares = matches.length
    ? tokens(matches[0].label).some((t) => qToks.has(t))
    : false;
  if (!matches.length
      || matches[0].score < 0.25
      || (!topShares && matches[0].score < 0.45)) {
    await learn(q, "question");
    return {
      reply: "I don't have anything strongly connected to that yet, but I " +
        "just stored the question as a seed and my curriculum agent will " +
        "keep filling in. Use the Teach tab to give me material about it " +
        "and I'll grow toward it.",
      refs: matches.slice(0, 3).map((m) => m.id),
    };
  }

  // Drop document-style nodes when a real concept matched well.
  const concepts = matches.filter((m) => !m.kind.startsWith("document"));
  if (concepts.length && concepts[0].score > 0.2) matches = concepts;

  const top = matches[0];
  const topDesc = await describeNode(top);
  const adj = await buildAdjacency();
  const neighIds = [...new Set((adj.get(top.id) || [])
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 8).map((e) => e.other))];
  const neighNodes = (await Promise.all(neighIds.map((id) => getNode(id))))
    .filter(Boolean);

  // Pull two interesting connected facts.
  const facts = [];
  for (const n of neighNodes) {
    if (n.kind.startsWith("document")) continue;
    const d = await describeNode(n);
    if (d && !facts.some((f) => f.text === d)) facts.push({ node: n, text: d });
    if (facts.length >= 3) break;
  }
  if (facts.length < 2) {
    for (const n of neighNodes) {
      const d = await describeNode(n);
      if (d && !facts.some((f) => f.text === d)) facts.push({ node: n, text: d });
      if (facts.length >= 3) break;
    }
  }

  const otherMatches = matches.slice(1, 4).map((m) => m.label);

  const refs = [top.id, ...facts.map((f) => f.node.id)];
  const parts = [];

  // Lead with intent-appropriate framing.
  if (intent === "what") {
    parts.push(`'${top.label}': ${topDesc || "I have this concept but no full summary yet."}`);
  } else if (intent === "how") {
    parts.push(`Here's what I know about doing this. '${top.label}': ${topDesc}`);
  } else if (intent === "why") {
    parts.push(`The reason traces back to '${top.label}'. ${topDesc}`);
  } else if (intent === "compare" && ents) {
    parts.push(`Comparing '${ents[0]}' and '${ents[1]}', the closest match I have is '${top.label}'. ${topDesc}`);
  } else if (intent === "list") {
    parts.push(`Top related concepts to '${top.label}':`);
  } else {
    parts.push(`'${top.label}': ${topDesc}`);
  }

  // Weave in connected facts as real prose.
  if (facts.length) {
    if (intent === "list") {
      parts.push(facts.map((f) => `• ${f.node.label} — ${f.text}`).join("\n"));
    } else {
      const f0 = facts[0];
      parts.push(`This connects to '${f0.node.label}': ${f0.text}`);
      if (facts[1]) {
        parts.push(`It also relates to '${facts[1].node.label}': ${facts[1].text}`);
      }
    }
  } else {
    parts.push("I haven't built strong connections from this yet -- " +
      "the more lessons I absorb, the richer this answer gets.");
  }

  if (otherMatches.length) {
    parts.push(`Other relevant memories: ${otherMatches.join(", ")}.`);
  }

  // Reinforce activations on everything we used so future thoughts gravitate
  // toward this region of the graph.
  for (const id of refs) {
    const n = await getNode(id);
    if (n) {
      n.activations = (n.activations || 1) + 1;
      n.updated_at = Date.now();
      await put("nodes", n);
    }
  }

  return { reply: parts.join("\n\n"), refs };
}

// ---------- graph snapshot for the 3D view ------------------------------

export async function graphSnapshot() {
  const nodes = await allNodes();
  const edges = await allEdges();
  const n = Math.max(nodes.length, 1);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const y = 1 - (i / Math.max(n - 1, 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const scale = 30 + Math.log((node.activations || 1) + 1) * 10;
    out.push({
      id: node.id, label: node.label, kind: node.kind, summary: node.summary,
      activations: node.activations || 1,
      x: Math.cos(theta) * radius * scale,
      y: y * scale,
      z: Math.sin(theta) * radius * scale,
    });
  }
  return {
    nodes: out,
    edges: edges.map((e) => ({ src: e.src, dst: e.dst,
      relation: e.relation, weight: e.weight })),
  };
}

// ---------- continuous curriculum ---------------------------------------

const SEED_LIMIT = 18; // how many lessons to seed before async loop kicks in
const CURRICULUM_KEY = "curriculum_cursor";

export async function seedIfEmpty() {
  const s = await stats();
  if (s.nodes > 0) return false;
  for (let i = 0; i < Math.min(SEED_LIMIT, CURRICULUM.length); i++) {
    await learn(CURRICULUM[i][1], `seed:${CURRICULUM[i][0]}`);
  }
  await metaSet(CURRICULUM_KEY, Math.min(SEED_LIMIT, CURRICULUM.length));
  return true;
}

// Pull the next curriculum lesson Atlas hasn't seen yet. Once it has seen
// them all, it cycles back through them so older lessons keep reinforcing.
export async function teachNextCurriculum() {
  const cursor = (await metaGet(CURRICULUM_KEY)) || 0;
  const idx = cursor % CURRICULUM.length;
  const [label, text] = CURRICULUM[idx];
  await learn(text, `curriculum:${label}`);
  await metaSet(CURRICULUM_KEY, cursor + 1);
  return { label, idx, total: CURRICULUM.length };
}

export async function wipe() {
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction(
      ["nodes","edges","chats","thoughts","agents","meta"], "readwrite");
    t.oncomplete = res; t.onerror = () => rej(t.error);
    for (const s of ["nodes","edges","chats","thoughts","agents","meta"]) {
      t.objectStore(s).clear();
    }
  });
}

// ---------- export / import (full memory backup) ------------------------

export async function exportAll() {
  const [nodes, edges, chats, thoughts, agents] = await Promise.all([
    allNodes(), allEdges(), getAll("chats"), getAll("thoughts"),
    allAgents(),
  ]);
  return {
    version: 1,
    exported_at: Date.now(),
    nodes, edges, chats, thoughts, agents,
  };
}

export async function importAll(blob) {
  if (!blob || typeof blob !== "object") throw new Error("invalid backup");
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction(
      ["nodes","edges","chats","thoughts","agents"], "readwrite");
    t.oncomplete = res; t.onerror = () => rej(t.error);
    for (const s of ["nodes","edges","chats","thoughts","agents"]) {
      t.objectStore(s).clear();
    }
    for (const n of blob.nodes  || []) t.objectStore("nodes").put(n);
    for (const e of blob.edges  || []) t.objectStore("edges").put(e);
    for (const c of blob.chats  || []) t.objectStore("chats").put(c);
    for (const x of blob.thoughts || []) t.objectStore("thoughts").put(x);
    for (const a of blob.agents || []) t.objectStore("agents").put(a);
  });
}
