"""Autonomous learning loop.

Atlas reads from a curated bank of code/database knowledge plus any files
placed in the `learning_sources/` directory and continuously absorbs them.
This is the "learns by itself" part: a background thread keeps adding to and
connecting the graph without anyone driving it.
"""

from __future__ import annotations

import random
import threading
import time
from pathlib import Path

from . import brain, memory

SOURCES_DIR = Path(__file__).resolve().parent.parent / "learning_sources"

# Seed lessons. Atlas starts with foundational code/database knowledge so the
# graph isn't empty on first boot.
SEED_LESSONS = [
    ("python-basics",
     "Python is an interpreted high-level language. Code is organized into "
     "modules, packages, and functions. Variables are dynamically typed. "
     "Common data structures include list, dict, set, tuple."),
    ("sql-fundamentals",
     "SQL queries a relational database using SELECT, INSERT, UPDATE, DELETE. "
     "Tables have rows and columns. Indexes speed up lookups. JOIN combines "
     "rows from multiple tables using shared keys."),
    ("rest-apis",
     "A REST API exposes resources over HTTP. Verbs GET, POST, PUT, DELETE "
     "map to read, create, update, delete. JSON is the typical payload. "
     "Endpoints are URLs that identify resources."),
    ("databases",
     "Databases store structured data. Relational databases like Postgres and "
     "SQLite use tables and SQL. Document databases like MongoDB store JSON. "
     "Key-value stores like Redis cache data in memory for fast access."),
    ("git",
     "Git tracks code in commits on branches. Developers clone a repository, "
     "create a branch, commit changes, and push to a remote. Pull requests "
     "merge a branch back into main after review."),
    ("data-structures",
     "Arrays, linked lists, hash maps, trees, and graphs are core data "
     "structures. Hash maps give O(1) average lookup. Trees and graphs model "
     "hierarchical and networked relationships."),
    ("async-programming",
     "Async programming runs many tasks without blocking. Python uses "
     "asyncio with async and await. JavaScript uses Promises and async "
     "functions. The event loop schedules pending work."),
    ("websockets",
     "WebSockets give full-duplex communication over a single TCP "
     "connection, ideal for live UIs, chat, dashboards, and streaming "
     "updates from a server."),
    ("graph-theory",
     "A graph is a set of nodes connected by edges. Edges can be directed or "
     "weighted. Traversals include breadth-first and depth-first search. "
     "Graphs model knowledge, networks, dependencies."),
    ("software-architecture",
     "Software architecture organizes a system into components. Monoliths "
     "keep everything in one process; microservices split it into many. "
     "Layered, hexagonal, and event-driven are common patterns."),
    ("testing",
     "Tests verify code behaves correctly. Unit tests check small pieces, "
     "integration tests check pieces working together, end-to-end tests "
     "exercise the whole system. CI runs tests on every commit."),
    ("vector-embeddings",
     "Embeddings map text or other data to vectors so similarity becomes "
     "cosine distance. Vector databases like FAISS, pgvector, and Chroma "
     "search nearest neighbors at scale."),
    ("knowledge-graphs",
     "A knowledge graph stores entities as nodes and relationships as edges. "
     "Queries traverse paths to answer questions. Triples in subject-"
     "predicate-object form are a common encoding."),
    ("agents",
     "An autonomous agent perceives state, plans, and acts in a loop. "
     "Multi-agent systems coordinate specialised agents that share memory "
     "and goals. Tools let agents reach beyond their own code."),
    ("docker",
     "Docker packages an application with its dependencies into an image. "
     "Containers run images in isolated environments. Compose orchestrates "
     "multi-container apps; Kubernetes scales them across machines."),
]


class Learner:
    def __init__(self, interval_seconds: float = 8.0):
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seeded = False

    def seed_if_empty(self) -> None:
        if self._seeded:
            return
        stats = memory.stats()
        if stats["nodes"] == 0:
            for label, text in SEED_LESSONS:
                brain.learn(text, source=f"seed:{label}")
        self._seeded = True

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        SOURCES_DIR.mkdir(parents=True, exist_ok=True)
        self.seed_if_empty()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="atlas-learner",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as exc:
                memory.record_thought(f"Learner error: {exc}")
            self._stop.wait(self.interval)

    def _tick(self) -> None:
        # 1. Pick up new files dropped into learning_sources/.
        for path in SOURCES_DIR.glob("*"):
            if not path.is_file():
                continue
            marker = SOURCES_DIR / ".seen" / path.name
            marker.parent.mkdir(exist_ok=True)
            if marker.exists():
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            brain.learn(text, source=f"file:{path.name}")
            marker.write_text(str(time.time()))

        # 2. Reflect: pick existing nodes and try to form a new connection.
        brain.think()

        # 3. Occasionally re-process a random older lesson to deepen links.
        if random.random() < 0.3 and SEED_LESSONS:
            label, text = random.choice(SEED_LESSONS)
            brain.learn(text, source=f"seed-reinforce:{label}")
