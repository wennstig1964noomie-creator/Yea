// Atlas browser brain. All knowledge lives in IndexedDB. The "embedding"
// is a deterministic hashed bag-of-words so this whole thing runs offline
// with no API key. The more you teach, the denser the graph and the better
// the answers get.

const DB_NAME = "atlas";
const DB_VERSION = 1;
const EMBED_DIM = 64;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","for","to","of","in",
  "on","at","by","with","is","are","was","were","be","been","being","this",
  "that","these","those","it","its","as","from","into","about","can","could",
  "should","would","will","we","you","your","our","they","their","i","me",
  "my","not","do","does","did","has","have","had","so","than","such","also",
  "when","what","which","who","how","why","where",
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
  "indexeddb","localstorage","react","vue","svelte",
]);

// ---------- tokens / embedding ------------------------------------------

function tokens(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().match(/[a-z_][a-z0-9_+#\-]{1,}/g) || [];
  return raw.filter((t) => !STOPWORDS.has(t) && t.length > 2);
}

// FNV-1a 32-bit hash — deterministic and fast.
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

export function keywords(text, k = 6) {
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

export function summarise(text, max = 220) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastDot = cut.lastIndexOf(".");
  if (lastDot > 60) return cut.slice(0, lastDot + 1);
  return cut.trimEnd() + "...";
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

// ---------- public memory API -------------------------------------------

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
    existing.detail = opts.detail || existing.detail || "";
    existing.embedding = opts.embedding || existing.embedding;
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
  if (srcId === dstId) return null;
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

export async function neighbors(nodeId) {
  const edges = await allEdges();
  const ids = new Map(); // otherId -> {relation, weight}
  for (const e of edges) {
    if (e.src === nodeId) ids.set(e.dst, { relation: e.relation,
      weight: e.weight });
    else if (e.dst === nodeId) ids.set(e.src, { relation: e.relation,
      weight: e.weight });
  }
  const out = [];
  for (const [oid, meta] of ids) {
    const n = await getNode(oid);
    if (n) out.push({ ...n, relation: meta.relation, weight: meta.weight });
  }
  return out;
}

export async function searchSimilar(vec, limit = 8) {
  const nodes = await allNodes();
  const scored = [];
  for (const n of nodes) {
    if (!n.embedding || !n.embedding.length) continue;
    const s = cosine(vec, n.embedding);
    if (s > 0.05) scored.push([s, n]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([s, n]) => ({ ...n, score: +s.toFixed(4) }));
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

// ---------- learn / think / answer --------------------------------------

export async function learn(text, source = "user") {
  text = String(text || "").trim();
  if (!text) return { nodes: [], edges: 0, summary: "", keywords: [] };

  const summary = summarise(text);
  const fullVec = embed(text);
  const kws = keywords(text, 8);
  const created = [];

  const parent = await upsertNode({
    label: `doc::${Date.now()}::${kws[0] || "note"}`,
    kind: `document:${source}`,
    summary, detail: text, embedding: fullVec,
  });
  created.push(parent);

  const conceptIds = [];
  for (const kw of kws) {
    const node = await upsertNode({
      label: kw,
      kind: CODE_HINTS.has(kw) ? "code-concept" : "concept",
      summary: `Concept extracted from learning (${source}).`,
      embedding: embed(kw),
    });
    conceptIds.push(node.id);
    await link(parent.id, node.id, { relation: "mentions", weight: 1.2 });
    created.push(node);
  }

  let edgeCount = 0;
  for (let i = 0; i < conceptIds.length; i++) {
    for (let j = i + 1; j < conceptIds.length; j++) {
      await link(conceptIds[i], conceptIds[j],
        { relation: "co-occurs", weight: 0.8 });
      edgeCount++;
    }
  }

  const similar = await searchSimilar(fullVec, 5);
  for (const s of similar) {
    if (s.id === parent.id) continue;
    await link(parent.id, s.id, { relation: "similar",
      weight: Math.max(0.3, s.score) });
    edgeCount++;
  }

  return { summary, nodes: created.map((n) => ({ id: n.id, label: n.label })),
    edges: edgeCount, keywords: kws };
}

function bestMatch(query, nodes) {
  const q = embed(query);
  let best = null, bestS = 0;
  for (const n of nodes) {
    if (!n.embedding) continue;
    const s = cosine(q, n.embedding);
    if (s > bestS) { bestS = s; best = n; }
  }
  return best;
}

export async function think(focus) {
  const nodes = await allNodes();
  if (!nodes.length) {
    return { thought: "Atlas is still empty. Teach me something.",
      node_refs: [] };
  }
  let start = null;
  if (focus) {
    start = await findNode(focus) || bestMatch(focus, nodes);
  }
  if (!start) {
    nodes.sort((a, b) =>
      (b.activations || 0) - (a.activations || 0) ||
      (b.updated_at || 0) - (a.updated_at || 0));
    const top = nodes.slice(0, Math.max(5, nodes.length >> 2));
    start = top[Math.floor(Math.random() * top.length)];
  }
  const neigh = await neighbors(start.id);
  let thought, refs;
  if (neigh.length) {
    const partner = neigh[Math.floor(Math.random() * neigh.length)];
    await link(start.id, partner.id, { relation: "inferred", weight: 0.6 });
    thought = `Atlas connects '${start.label}' with '${partner.label}' ` +
      `(${partner.relation || "related"}). They likely share structure ` +
      "because they keep appearing together.";
    refs = [start.id, partner.id];
  } else {
    const sim = (await searchSimilar(start.embedding || embed(start.label), 3))
      .filter((s) => s.id !== start.id);
    if (sim.length) {
      const partner = sim[0];
      await link(start.id, partner.id, { relation: "inferred", weight: 0.4 });
      thought = `Atlas suspects '${start.label}' and '${partner.label}' are ` +
        `related (similarity ${partner.score}).`;
      refs = [start.id, partner.id];
    } else {
      thought = `Atlas is reflecting on '${start.label}' but has not yet ` +
        "found anything to link it to. More learning needed.";
      refs = [start.id];
    }
  }
  await recordThought(thought, refs);
  return { thought, node_refs: refs };
}

export async function answer(question) {
  const q = String(question || "").trim();
  if (!q) return { reply: "Ask me anything.", refs: [] };
  const qv = embed(q);
  const matches = await searchSimilar(qv, 5);
  if (!matches.length) {
    await learn(q, "question");
    return {
      reply: "I don't have anything connected to that yet, but I just stored " +
        "the question so I can grow toward it. Try teaching me something " +
        "related.",
      refs: [],
    };
  }
  const top = matches[0];
  const related = (await neighbors(top.id)).slice(0, 6);
  const parts = [`Based on what I know about '${top.label}':`];
  if (top.summary) parts.push(top.summary);
  if (related.length) {
    parts.push("It connects to " + related.map((r) => r.label).join(", ") +
      ".");
  } else parts.push("I haven't linked this to anything else yet.");
  const others = matches.slice(1).map((m) => m.label);
  if (others.length) {
    parts.push("Other relevant memories: " + others.join(", ") + ".");
  }
  return {
    reply: parts.join(" "),
    refs: [top.id, ...related.map((r) => r.id)],
  };
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
    const scale = 30 + Math.log((node.activations || 1) + 1) * 8;
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

// ---------- seed lessons -------------------------------------------------

const SEED = [
  ["python-basics", "Python is an interpreted high-level language. Code is organized into modules, packages, and functions. Variables are dynamically typed. Common data structures include list, dict, set, tuple."],
  ["sql-fundamentals", "SQL queries a relational database using SELECT, INSERT, UPDATE, DELETE. Tables have rows and columns. Indexes speed up lookups. JOIN combines rows from multiple tables using shared keys."],
  ["rest-apis", "A REST API exposes resources over HTTP. Verbs GET, POST, PUT, DELETE map to read, create, update, delete. JSON is the typical payload. Endpoints are URLs that identify resources."],
  ["databases", "Databases store structured data. Relational databases like Postgres and SQLite use tables and SQL. Document databases like MongoDB store JSON. Key-value stores like Redis cache data in memory for fast access."],
  ["indexeddb", "IndexedDB is the browser's local database. It stores structured records in object stores indexed by keys. Reads and writes happen inside transactions."],
  ["git", "Git tracks code in commits on branches. Developers clone a repository, create a branch, commit changes, and push to a remote. Pull requests merge a branch back into main after review."],
  ["data-structures", "Arrays, linked lists, hash maps, trees, and graphs are core data structures. Hash maps give O(1) average lookup. Trees and graphs model hierarchical and networked relationships."],
  ["async-programming", "Async programming runs many tasks without blocking. JavaScript uses Promises and async functions. The event loop schedules pending work."],
  ["websockets", "WebSockets give full-duplex communication over a single TCP connection, ideal for live UIs, chat, dashboards, and streaming updates from a server."],
  ["graph-theory", "A graph is a set of nodes connected by edges. Edges can be directed or weighted. Traversals include breadth-first and depth-first search. Graphs model knowledge, networks, dependencies."],
  ["software-architecture", "Software architecture organizes a system into components. Monoliths keep everything in one process; microservices split it into many. Layered, hexagonal, and event-driven are common patterns."],
  ["testing", "Tests verify code behaves correctly. Unit tests check small pieces, integration tests check pieces working together, end-to-end tests exercise the whole system. CI runs tests on every commit."],
  ["vector-embeddings", "Embeddings map text or other data to vectors so similarity becomes cosine distance. Vector databases like FAISS, pgvector, and Chroma search nearest neighbors at scale."],
  ["knowledge-graphs", "A knowledge graph stores entities as nodes and relationships as edges. Queries traverse paths to answer questions. Triples in subject-predicate-object form are a common encoding."],
  ["agents", "An autonomous agent perceives state, plans, and acts in a loop. Multi-agent systems coordinate specialised agents that share memory and goals. Tools let agents reach beyond their own code."],
  ["docker", "Docker packages an application with its dependencies into an image. Containers run images in isolated environments. Compose orchestrates multi-container apps; Kubernetes scales them across machines."],
  ["javascript", "JavaScript runs in browsers and Node.js. It uses prototype-based objects, first-class functions, closures, async/await, and a single-threaded event loop."],
  ["threejs", "Three.js is a JavaScript library that renders 3D graphics in the browser using WebGL. Scenes contain meshes, lights, and a camera; the renderer draws them every frame."],
];

export async function seedIfEmpty() {
  const s = await stats();
  if (s.nodes > 0) return false;
  for (const [label, text] of SEED) {
    await learn(text, `seed:${label}`);
  }
  return true;
}

export async function wipe() {
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction(
      ["nodes","edges","chats","thoughts","agents"], "readwrite");
    t.oncomplete = res; t.onerror = () => rej(t.error);
    for (const s of ["nodes","edges","chats","thoughts","agents"]) {
      t.objectStore(s).clear();
    }
  });
}
