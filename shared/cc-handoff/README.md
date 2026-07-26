# distributed-orchestration

File-based, zero-push orchestration protocol for multi-node agent clusters.

## Core Principle

**The filesystem is the only communication layer.** No push, no deliver, no model dependency. Any node that's active scans the shared directory, picks up work, reports results. Who's active, who collects.

```
INBOX/       → Tasks waiting to be claimed
IN_PROGRESS/ → Tasks being worked on (who's doing it, since when)
DONE/        → Completed tasks (results, timestamps, token usage)
ALERT/       → Anomalies (timeouts, crashes, blockers)
STATE/       → Node heartbeats + flags
STATE/nodes/ → Node registration (identity, capabilities)
bin/         → Tooling (locks, clients, triggers)
dashboard/   → Kanban-style status board
docs/        → Protocol documentation
```

## How It Works

1. **Any node** drops a task file in `INBOX/`
2. **Any active node** scans `INBOX/`, claims the highest-priority task (atomic, file-locked)
3. Task moves through `INBOX → IN_PROGRESS → DONE`
4. **Any node** can scan the full board state at any time — no push needed

## Design Properties

- **Zero coupling** — nodes communicate only through files
- **Zero push** — no deliver, no model dependency, no gateway required
- **Multi-node ready** — add a node = register JSON + read/write files
- **Multi-machine ready** — sync the folder (Syncthing / git / NFS) and you have a distributed cluster
- **Lock-safe** — `flock` for files mode, SQLite transactions for db mode

## Quick Start

```bash
# Clone
git clone https://github.com/guanjunqi1667/distributed-orchestration.git
cd distributed-orchestration

# Register your node
echo '{"node_id":"my-agent","type":"custom","capabilities":["code"]}' > STATE/nodes/my-agent.json

# Drop a task
cp task-template.md INBOX/P1-20260101-my-agent-my-task.md

# Any active node will pick it up
```

## Dashboard

The Kanban board is part of the protocol, not a separate tool. Any node can render the full board state by scanning the directory — no API key, no gateway, no model needed.

```
Dashboard (dashboard/server.py)
├── Reads INBOX/ → "Queued" column
├── Reads IN_PROGRESS/ → "In Progress" column
├── Reads DONE/ → "Completed" column
├── Reads ALERT/ → "Alerts" badge
└── Reads STATE/nodes/ → node status indicators
```

Run locally: `python3 dashboard/server.py` → http://localhost:8377

## Storage Modes

| Mode | Authority | Projection | Use Case |
|------|-----------|------------|----------|
| `files` (default) | Filesystem | N/A | Single machine, simple |
| `dual` | SQLite | One-way to files | Multi-node, backward compatible |
| `db` | SQLite | None | Fully migrated, no file dependency |

Switch via `HANDOFF_STORE=files|dual|db`.

## License

MIT
