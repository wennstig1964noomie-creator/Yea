# Atlas — Self-Learning AI Brain

Atlas is a living knowledge brain. It learns by itself, connects new ideas to
old ones, remembers every chat and every thought, and runs a fleet of agents
that automate work on its behalf. A 3D UI shows the brain as a graph of
glowing nodes and the connections between them.

## What's inside

```
atlas/
  backend/
    memory.py    persistent knowledge graph + chat/thought history (SQLite)
    brain.py     embedding, learning, thinking, idea connection, answering
    learner.py   autonomous learning loop (background thread)
    agents.py    agent manager: defines, schedules, runs, repairs agents
    server.py    HTTP + WebSocket server (Python stdlib only)
  frontend/
    index.html   single-page 3D UI
    atlas.js     Three.js graph, chat, agent panel, live WebSocket
    styles.css   the look
  learning_sources/   drop any .txt/.md/.py here -- Atlas absorbs it
  data/        SQLite database lives here
  run.py       entrypoint
```

## Quick start

```bash
python -m atlas.run
```

Then open <http://localhost:8765>.

No `pip install` is required — Atlas uses only the Python standard library on
the server and loads Three.js from a CDN in the browser.

## How it learns

1. On first boot Atlas seeds itself with foundational lessons about code,
   databases, APIs, git, async, data structures, graphs, agents, etc.
2. A background thread runs continuously:
   - Scans `learning_sources/` for new files and absorbs them.
   - Picks active nodes and forms new `inferred` edges between related
     concepts — this is autonomous thinking.
   - Reinforces older lessons so connections deepen over time.
3. Every chat message also becomes a learning event. If Atlas can't answer
   a question, it stores it as a node so it grows toward what's being asked.

## How it remembers

Everything goes into SQLite (`data/atlas.db`):

- `nodes`, `edges` — the knowledge graph
- `chats` — every message ever sent
- `thoughts` — every autonomous reflection
- `agents` — agent definitions, code, and last output

Restart Atlas; nothing is lost.

## How it thinks

Each thought picks a focus node, walks its neighborhood, and forms a new
hypothesis edge with relation `inferred`. Embeddings are a deterministic
hashed bag-of-words so the system runs offline. The more Atlas learns, the
denser the graph and the richer the answers.

## Agents

Atlas controls its own agents. Each agent is a small Python program with a
`run(ctx)` function. The manager:

- Schedules agents at a configurable interval.
- Captures stdout + logs + return value as `last_output`.
- Marks agents `ok` or `error` so Atlas knows when one breaks.
- Lets you edit the agent's code from the UI.

A starter `heartbeat` agent ships pre-installed. Create more from the **Agents**
tab — name, purpose, schedule, code body.

Agents can:

```python
def run(ctx):
    ctx.log("anything")                                # captured into last_output
    ctx.remember("label", summary="…", detail="…")     # add a node
    ctx.teach("long text to absorb")                   # learn like the brain
    return "any result string"
```

## 3D UI

- Drag to orbit, scroll to zoom.
- Click a node to inspect it: kind, activations, summary, detail, neighbors.
- Edge colors:
  - cyan = similar
  - purple = inferred (Atlas's own thought)
  - orange = document → concept mention
  - blue = generic relation
- Node size and brightness grow with how often a concept has been activated.

## API

| method | path                       | purpose                            |
|--------|----------------------------|------------------------------------|
| GET    | `/api/stats`               | counts of nodes/edges/chats/etc.   |
| GET    | `/api/graph`               | full 3D layout snapshot            |
| GET    | `/api/node/:id`            | node detail + neighbors            |
| GET    | `/api/chats`               | chat history                       |
| GET    | `/api/thoughts`            | recent autonomous thoughts         |
| POST   | `/api/learn`               | `{ text, source }` → ingest        |
| POST   | `/api/think`               | `{ focus? }` → form a thought      |
| POST   | `/api/chat`                | `{ message }` → reply              |
| GET    | `/api/agents`              | list agents                        |
| POST   | `/api/agents`              | create an agent                    |
| POST   | `/api/agents/:id/run`      | run an agent right now             |
| POST   | `/api/agents/:id/code`     | replace an agent's code            |
| DELETE | `/api/agents/:id`          | remove an agent                    |
| WS     | `/ws`                      | live graph + stats + thought feed  |

## Teach Atlas faster

- Paste text or schemas into the **Teach** tab.
- Drop files into `atlas/learning_sources/`. They are picked up automatically
  within a few seconds and never re-processed twice.
