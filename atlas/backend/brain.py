"""Atlas brain: learning, thinking, and idea-connection logic.

The brain doesn't depend on any external LLM. It uses lightweight, deterministic
text analysis (token co-occurrence, hashed embeddings, keyword extraction) so
the system runs anywhere. Where an LLM would normally generate language, Atlas
composes responses from its own graph -- the more it learns, the better the
answers get.
"""

from __future__ import annotations

import hashlib
import math
import random
import re
import time
from collections import Counter
from typing import Iterable

from . import memory

EMBED_DIM = 64

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to",
    "of", "in", "on", "at", "by", "with", "is", "are", "was", "were", "be",
    "been", "being", "this", "that", "these", "those", "it", "its", "as",
    "from", "into", "about", "can", "could", "should", "would", "will",
    "we", "you", "your", "our", "they", "their", "i", "me", "my", "not",
    "do", "does", "did", "has", "have", "had", "so", "than", "such", "also",
    "when", "what", "which", "who", "how", "why", "where",
}

CODE_HINTS = {
    "function", "class", "method", "variable", "loop", "array", "list",
    "object", "string", "integer", "boolean", "database", "table", "query",
    "index", "schema", "sql", "join", "select", "insert", "update", "delete",
    "api", "endpoint", "http", "request", "response", "json", "yaml",
    "python", "javascript", "typescript", "rust", "go", "java", "kotlin",
    "compile", "runtime", "thread", "process", "memory", "cache", "queue",
    "stack", "heap", "pointer", "reference", "async", "await", "promise",
    "callback", "closure", "module", "package", "import", "export",
    "framework", "library", "container", "docker", "kubernetes", "deploy",
    "test", "unit", "integration", "ci", "cd", "git", "commit", "branch",
    "merge", "rebase", "pull", "push", "fork", "node", "edge", "graph",
    "tree", "hash", "encryption", "token", "auth", "oauth", "jwt", "rest",
    "graphql", "websocket", "tcp", "udp", "dns", "proxy", "balancer",
    "microservice", "monolith", "serverless", "lambda", "function",
}


def _tokens(text: str) -> list[str]:
    text = text.lower()
    raw = re.findall(r"[a-zA-Z_][a-zA-Z0-9_+#\-]{1,}", text)
    return [t for t in raw if t not in STOPWORDS and len(t) > 2]


def embed(text: str) -> list[float]:
    """Hashed bag-of-words embedding. Deterministic, no network needed."""
    vec = [0.0] * EMBED_DIM
    tokens = _tokens(text)
    if not tokens:
        return vec
    counts = Counter(tokens)
    for tok, c in counts.items():
        h = int(hashlib.sha1(tok.encode()).hexdigest(), 16)
        idx = h % EMBED_DIM
        sign = 1.0 if (h >> 8) % 2 == 0 else -1.0
        vec[idx] += sign * (1.0 + math.log(c))
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def keywords(text: str, k: int = 6) -> list[str]:
    toks = _tokens(text)
    if not toks:
        return []
    boosted = Counter()
    for t in toks:
        boost = 2.0 if t in CODE_HINTS else 1.0
        boosted[t] += boost
    return [w for w, _ in boosted.most_common(k)]


def summarise(text: str, max_chars: int = 220) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    last_dot = cut.rfind(".")
    if last_dot > 60:
        return cut[: last_dot + 1]
    return cut.rstrip() + "..."


def learn(text: str, *, source: str = "manual") -> dict:
    """Ingest a chunk of knowledge.

    Splits the text into concepts, creates nodes, and links co-occurring
    concepts so the graph grows organically.
    """
    text = (text or "").strip()
    if not text:
        return {"nodes": [], "edges": [], "summary": ""}

    summary = summarise(text)
    full_vec = embed(text)
    kws = keywords(text, k=8)
    created_nodes: list[dict] = []

    parent = memory.upsert_node(
        label=f"doc::{int(time.time()*1000)}::{(kws[0] if kws else 'note')}",
        kind=f"document:{source}",
        summary=summary,
        detail=text,
        embedding=full_vec,
    )
    created_nodes.append(parent)

    concept_ids: list[int] = []
    for kw in kws:
        node = memory.upsert_node(
            label=kw,
            kind="code-concept" if kw in CODE_HINTS else "concept",
            summary=f"Concept extracted from learning ({source}).",
            embedding=embed(kw),
        )
        concept_ids.append(node["id"])
        memory.link(parent["id"], node["id"], relation="mentions", weight=1.2)
        created_nodes.append(node)

    edges = []
    for i, a in enumerate(concept_ids):
        for b in concept_ids[i + 1:]:
            edges.append(memory.link(a, b, relation="co-occurs", weight=0.8))

    # Connect to existing similar memories so old + new knowledge bind.
    similar = memory.search_similar(full_vec, limit=5)
    for s in similar:
        if s["id"] == parent["id"]:
            continue
        edges.append(memory.link(parent["id"], s["id"], relation="similar",
                                 weight=float(s.get("score", 0.5))))

    return {
        "summary": summary,
        "nodes": [{"id": n["id"], "label": n["label"]} for n in created_nodes],
        "edges": len(edges),
        "keywords": kws,
    }


def think(focus: str | None = None) -> dict:
    """Generate an autonomous thought.

    Picks a starting node (focus or a random recent/active one), walks its
    neighborhood, and forms a new hypothesis by combining concepts. New edges
    of relation `inferred` are created so thinking actually grows the graph.
    """
    nodes = memory.all_nodes()
    if not nodes:
        return {"thought": "Atlas is still empty. Teach me something.", "node_refs": []}

    start = None
    if focus:
        start = memory.find_node(focus.strip()) or _best_match(focus, nodes)
    if not start:
        # Bias toward highly-activated, recent nodes.
        candidates = sorted(
            nodes,
            key=lambda n: (n["activations"], n["updated_at"]),
            reverse=True,
        )[: max(5, len(nodes) // 4)]
        start = random.choice(candidates)

    neigh = memory.neighbors(start["id"])
    if neigh:
        partner = random.choice(neigh)
        new_edge = memory.link(start["id"], partner["id"],
                               relation="inferred", weight=0.6)
        thought = (
            f"Atlas connects '{start['label']}' with '{partner['label']}' "
            f"({partner.get('relation', 'related')}). "
            f"They likely share structure because they keep appearing together."
        )
        refs = [start["id"], partner["id"]]
    else:
        # Find a similar node by embedding instead.
        sim = memory.search_similar(
            memory._vec_from_str(start["embedding"]) or embed(start["label"]),
            limit=3,
        )
        sim = [s for s in sim if s["id"] != start["id"]]
        if sim:
            partner = sim[0]
            memory.link(start["id"], partner["id"], relation="inferred",
                        weight=0.4)
            thought = (
                f"Atlas suspects '{start['label']}' and '{partner['label']}' "
                f"are related (similarity {partner['score']})."
            )
            refs = [start["id"], partner["id"]]
        else:
            thought = (
                f"Atlas is reflecting on '{start['label']}' but has not yet "
                f"found anything to link it to. More learning needed."
            )
            refs = [start["id"]]

    memory.record_thought(thought, node_refs=refs)
    return {"thought": thought, "node_refs": refs}


def _best_match(query: str, nodes: list[dict]) -> dict | None:
    q = embed(query)
    best = None
    best_s = 0.0
    for n in nodes:
        v = memory._vec_from_str(n.get("embedding"))
        if not v:
            continue
        s = memory.cosine(q, v)
        if s > best_s:
            best_s, best = s, n
    return best


def answer(question: str) -> dict:
    """Compose an answer from Atlas's memory.

    Pulls the most relevant nodes, their neighbors, and recent thoughts, then
    builds a response. No external LLM -- Atlas speaks from what it knows.
    """
    q = (question or "").strip()
    if not q:
        return {"reply": "Ask me anything.", "refs": []}

    qv = embed(q)
    matches = memory.search_similar(qv, limit=5)
    if not matches:
        # Always store the question; Atlas learns from being asked.
        learn(q, source="question")
        return {
            "reply": (
                "I don't have anything connected to that yet, but I just "
                "stored the question so I can grow toward it. Try teaching "
                "me something related."
            ),
            "refs": [],
        }

    top = matches[0]
    related = memory.neighbors(top["id"])[:6]

    parts = [f"Based on what I know about '{top['label']}':"]
    if top.get("summary"):
        parts.append(top["summary"])
    if related:
        names = ", ".join(r["label"] for r in related)
        parts.append(f"It connects to {names}.")
    else:
        parts.append("I haven't linked this to anything else yet.")

    other_matches = [m["label"] for m in matches[1:]]
    if other_matches:
        parts.append("Other relevant memories: " + ", ".join(other_matches) + ".")

    refs = [top["id"]] + [r["id"] for r in related]
    return {"reply": " ".join(parts), "refs": refs}


def graph_snapshot() -> dict:
    """Shape the graph for the 3D UI."""
    nodes = memory.all_nodes()
    edges = memory.all_edges()
    # Place nodes on a 3D fibonacci sphere scaled by activations so the UI has
    # a stable initial layout even before forces kick in.
    out_nodes = []
    n = max(len(nodes), 1)
    golden = math.pi * (3 - math.sqrt(5))
    for i, node in enumerate(nodes):
        y = 1 - (i / float(n - 1 if n > 1 else 1)) * 2
        radius = math.sqrt(max(0.0, 1 - y * y))
        theta = golden * i
        scale = 30 + math.log(node["activations"] + 1) * 8
        out_nodes.append({
            "id": node["id"],
            "label": node["label"],
            "kind": node["kind"],
            "summary": node["summary"],
            "activations": node["activations"],
            "x": math.cos(theta) * radius * scale,
            "y": y * scale,
            "z": math.sin(theta) * radius * scale,
        })
    out_edges = [
        {"src": e["src"], "dst": e["dst"], "relation": e["relation"],
         "weight": e["weight"]}
        for e in edges
    ]
    return {"nodes": out_nodes, "edges": out_edges}
