import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------- state ---------------------------------------------------------

const state = {
  nodes: new Map(), // id -> { data, mesh, pos: Vector3, vel: Vector3 }
  edges: [],        // [{ src, dst, relation, line }]
  selectedId: null,
};

const COLORS = {
  concept: 0x7df9ff,
  "code-concept": 0xffb56b,
  document: 0xb07cff,
  agent: 0x7dff9b,
  "agent-output": 0x7dff9b,
  thought: 0xb07cff,
};

function colorFor(kind) {
  if (!kind) return COLORS.concept;
  if (kind.startsWith("document")) return COLORS.document;
  if (kind.startsWith("code")) return COLORS["code-concept"];
  if (kind.startsWith("agent")) return COLORS.agent;
  return COLORS[kind] || COLORS.concept;
}

// ---------- scene setup ---------------------------------------------------

const canvas = document.getElementById("scene");
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050810, 0.0025);

const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 4000,
);
camera.position.set(0, 80, 220);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true,
  alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 30;
controls.maxDistance = 1200;

scene.add(new THREE.AmbientLight(0x8aa0c8, 0.6));
const light = new THREE.PointLight(0x7df9ff, 1.5, 1000);
light.position.set(0, 200, 200);
scene.add(light);

// starfield backdrop
{
  const starsGeo = new THREE.BufferGeometry();
  const verts = [];
  for (let i = 0; i < 1400; i++) {
    verts.push(
      (Math.random() - 0.5) * 3000,
      (Math.random() - 0.5) * 3000,
      (Math.random() - 0.5) * 3000,
    );
  }
  starsGeo.setAttribute("position",
    new THREE.Float32BufferAttribute(verts, 3));
  const stars = new THREE.Points(
    starsGeo,
    new THREE.PointsMaterial({ color: 0x4a5a7a, size: 1.2 }),
  );
  scene.add(stars);
}

const nodeRoot = new THREE.Group();
const edgeRoot = new THREE.Group();
scene.add(edgeRoot, nodeRoot);

// raycasting for selection
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("pointerdown", (ev) => {
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(
    [...state.nodes.values()].map((n) => n.mesh),
  );
  if (hits.length > 0) {
    const id = hits[0].object.userData.id;
    selectNode(id);
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- graph rendering -----------------------------------------------

function applyGraph(graph) {
  // remove old that are gone
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const [id, item] of [...state.nodes]) {
    if (!ids.has(id)) {
      nodeRoot.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mesh.material.dispose();
      state.nodes.delete(id);
    }
  }
  // add or update nodes
  for (const n of graph.nodes) {
    let item = state.nodes.get(n.id);
    if (!item) {
      const size = 1.6 + Math.log(1 + (n.activations || 1)) * 0.7;
      const geo = new THREE.SphereGeometry(size, 18, 18);
      const mat = new THREE.MeshStandardMaterial({
        color: colorFor(n.kind),
        emissive: colorFor(n.kind),
        emissiveIntensity: 0.6,
        roughness: 0.4,
        metalness: 0.2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { id: n.id, label: n.label };
      mesh.position.set(n.x, n.y, n.z);
      nodeRoot.add(mesh);

      // soft halo
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(size * 2.4, 14, 14),
        new THREE.MeshBasicMaterial({
          color: colorFor(n.kind),
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
        }),
      );
      mesh.add(halo);

      item = {
        data: n,
        mesh,
        pos: mesh.position,
        vel: new THREE.Vector3(),
      };
      state.nodes.set(n.id, item);
    } else {
      item.data = n;
      const newColor = colorFor(n.kind);
      item.mesh.material.color.setHex(newColor);
      item.mesh.material.emissive.setHex(newColor);
    }
  }

  // rebuild edges
  for (const e of state.edges) edgeRoot.remove(e.line);
  state.edges = [];
  for (const e of graph.edges) {
    const a = state.nodes.get(e.src);
    const b = state.nodes.get(e.dst);
    if (!a || !b) continue;
    const positions = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: e.relation === "inferred" ? 0xb07cff
           : e.relation === "similar"  ? 0x7df9ff
           : e.relation === "mentions" ? 0xffb56b
           :                              0x4a6da3,
      transparent: true,
      opacity: Math.min(0.18 + e.weight * 0.08, 0.7),
    });
    const line = new THREE.Line(geo, mat);
    edgeRoot.add(line);
    state.edges.push({ a, b, relation: e.relation, weight: e.weight, line });
  }
}

// simple force layout to push things apart so big graphs stay readable
function physicsStep() {
  const nodes = [...state.nodes.values()];
  const REPEL = 280;
  const SPRING = 0.0015;
  const CENTER = 0.001;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    a.vel.multiplyScalar(0.88);
    a.vel.addScaledVector(a.pos, -CENTER);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const dz = a.pos.z - b.pos.z;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) d2 = 1;
      const f = REPEL / d2;
      a.vel.x += dx * f * 0.01;
      a.vel.y += dy * f * 0.01;
      a.vel.z += dz * f * 0.01;
      b.vel.x -= dx * f * 0.01;
      b.vel.y -= dy * f * 0.01;
      b.vel.z -= dz * f * 0.01;
    }
  }
  for (const e of state.edges) {
    const dx = e.b.pos.x - e.a.pos.x;
    const dy = e.b.pos.y - e.a.pos.y;
    const dz = e.b.pos.z - e.a.pos.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const target = 35;
    const f = (len - target) * SPRING * (1 + e.weight * 0.2);
    e.a.vel.x += (dx / len) * f * 30;
    e.a.vel.y += (dy / len) * f * 30;
    e.a.vel.z += (dz / len) * f * 30;
    e.b.vel.x -= (dx / len) * f * 30;
    e.b.vel.y -= (dy / len) * f * 30;
    e.b.vel.z -= (dz / len) * f * 30;
  }
  for (const a of nodes) {
    a.pos.x += a.vel.x;
    a.pos.y += a.vel.y;
    a.pos.z += a.vel.z;
  }
  // update edge geometry
  for (const e of state.edges) {
    const pos = e.line.geometry.attributes.position.array;
    pos[0] = e.a.pos.x; pos[1] = e.a.pos.y; pos[2] = e.a.pos.z;
    pos[3] = e.b.pos.x; pos[4] = e.b.pos.y; pos[5] = e.b.pos.z;
    e.line.geometry.attributes.position.needsUpdate = true;
  }
}

function animate() {
  requestAnimationFrame(animate);
  physicsStep();
  nodeRoot.rotation.y += 0.0005;
  edgeRoot.rotation.y += 0.0005;
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- selection -----------------------------------------------------

async function selectNode(id) {
  state.selectedId = id;
  for (const [nid, item] of state.nodes) {
    item.mesh.material.emissiveIntensity = nid === id ? 1.6 : 0.6;
    item.mesh.scale.setScalar(nid === id ? 1.6 : 1.0);
  }
  switchTab("node");
  const info = document.getElementById("nodeinfo");
  info.innerHTML = "<em>loading...</em>";
  try {
    const res = await fetch(`/api/node/${id}`);
    const data = await res.json();
    info.innerHTML = renderNodeInfo(data);
  } catch (e) {
    info.textContent = "Failed to load node.";
  }
}

function renderNodeInfo(node) {
  const neigh = (node.neighbors || []).map((n) =>
    `<li><a href="#" data-id="${n.id}">${escapeHtml(n.label)}</a>
     <span class="kind">(${escapeHtml(n.relation || "")},
     w=${(n.weight || 0).toFixed(2)})</span></li>`,
  ).join("");
  return `
    <h2>${escapeHtml(node.label)}</h2>
    <div class="kind">${escapeHtml(node.kind)} · activations
      ${node.activations}</div>
    <p>${escapeHtml(node.summary || "(no summary)")}</p>
    ${node.detail ? `<details><summary>detail</summary>
      <pre>${escapeHtml(node.detail)}</pre></details>` : ""}
    <h3>connected to (${(node.neighbors || []).length})</h3>
    <ul>${neigh || "<li><em>nothing yet</em></li>"}</ul>
  `;
}

document.getElementById("nodeinfo").addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-id]");
  if (a) { ev.preventDefault(); selectNode(parseInt(a.dataset.id, 10)); }
});

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------- tabs ----------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".pane").forEach((p) =>
    p.classList.toggle("active", p.dataset.pane === name));
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------- chat ----------------------------------------------------------

const chatlog = document.getElementById("chatlog");

function appendMsg(role, text, refs = []) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = escapeHtml(text);
  if (refs.length) {
    const rd = document.createElement("div");
    rd.className = "refs";
    rd.textContent = "refs: " + refs.join(", ");
    div.appendChild(rd);
  }
  chatlog.appendChild(div);
  chatlog.scrollTop = chatlog.scrollHeight;
}

document.getElementById("chatform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("chatinput");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  appendMsg("user", msg);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
    const data = await res.json();
    appendMsg("atlas", data.reply, data.refs || []);
  } catch (e) {
    appendMsg("atlas", "I couldn't reach my brain. Try again.");
  }
});

// load chat history on first paint
fetch("/api/chats").then((r) => r.json()).then((rows) => {
  for (const row of rows) {
    let refs = [];
    try { refs = JSON.parse(row.node_refs || "[]"); } catch {}
    appendMsg(row.role === "user" ? "user" : "atlas", row.content, refs);
  }
});

// ---------- teach ---------------------------------------------------------

document.getElementById("teach-btn").addEventListener("click", async () => {
  const text = document.getElementById("teach-text").value;
  if (!text.trim()) return;
  const res = await fetch("/api/learn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source: "user" }),
  });
  const data = await res.json();
  document.getElementById("teach-result").textContent =
    `Learned. ${data.nodes?.length || 0} nodes touched, ` +
    `${data.edges || 0} edges, keywords: ${(data.keywords || []).join(", ")}`;
  document.getElementById("teach-text").value = "";
  refreshGraph();
});

document.getElementById("think-btn").addEventListener("click", async () => {
  const res = await fetch("/api/think", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await res.json();
  document.getElementById("teach-result").textContent =
    `Thought: ${data.thought}`;
  refreshGraph();
});

// ---------- thoughts ------------------------------------------------------

function renderThoughts(thoughts) {
  const ul = document.getElementById("thoughtlist");
  ul.innerHTML = "";
  for (const t of thoughts.slice().reverse()) {
    const li = document.createElement("li");
    const when = new Date(t.created_at * 1000).toLocaleTimeString();
    li.innerHTML = `<small style="color:#6a7ba3">${when}</small><br>` +
      escapeHtml(t.content);
    ul.appendChild(li);
  }
}

// ---------- agents --------------------------------------------------------

async function loadAgents() {
  const res = await fetch("/api/agents");
  const list = await res.json();
  const root = document.getElementById("agentlist");
  root.innerHTML = "";
  for (const a of list) {
    const div = document.createElement("div");
    div.className = "agent-card";
    div.innerHTML = `
      <h3>${escapeHtml(a.name)}</h3>
      <div class="hint">${escapeHtml(a.purpose)}</div>
      <div class="hint">schedule: every ${a.schedule_seconds}s ·
        <span class="status ${a.status}">${a.status}</span>
        ${a.last_run ? "· last " + new Date(a.last_run * 1000).toLocaleTimeString() : ""}
      </div>
      <pre>${escapeHtml(a.last_output || "(no output yet)")}</pre>
      <div class="row">
        <button data-act="run" data-id="${a.id}">Run now</button>
        <button data-act="del" data-id="${a.id}">Delete</button>
      </div>
    `;
    root.appendChild(div);
  }
}

document.getElementById("agentlist").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-act]");
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === "run") {
    await fetch(`/api/agents/${id}/run`, { method: "POST" });
  } else if (b.dataset.act === "del") {
    if (!confirm("Delete this agent?")) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
  }
  loadAgents();
});

document.getElementById("agent-create").addEventListener("click", async () => {
  const name = document.getElementById("agent-name").value.trim();
  const purpose = document.getElementById("agent-purpose").value.trim();
  const code = document.getElementById("agent-code").value;
  const schedule_seconds = parseFloat(
    document.getElementById("agent-schedule").value);
  if (!name || !purpose) { alert("name and purpose required"); return; }
  await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, purpose, code, schedule_seconds }),
  });
  document.getElementById("agent-name").value = "";
  document.getElementById("agent-purpose").value = "";
  loadAgents();
});

setInterval(loadAgents, 5000);
loadAgents();

// ---------- live websocket ------------------------------------------------

let ws;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.graph) applyGraph(payload.graph);
    if (payload.stats) {
      document.getElementById("stat-nodes").textContent = payload.stats.nodes;
      document.getElementById("stat-edges").textContent = payload.stats.edges;
      document.getElementById("stat-thoughts").textContent =
        payload.stats.thoughts;
      document.getElementById("stat-chats").textContent = payload.stats.chats;
      document.getElementById("stat-agents").textContent = payload.stats.agents;
    }
    if (payload.recent_thoughts) renderThoughts(payload.recent_thoughts);
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}
connectWs();

async function refreshGraph() {
  const res = await fetch("/api/graph");
  const graph = await res.json();
  applyGraph(graph);
}
