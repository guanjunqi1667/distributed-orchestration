# Distributed Orchestration

Symmetric multi-node handoff protocol for distributed agent orchestration.

## Design Principles

- **Symmetric** — All nodes are equal peers (OC, CC, any worker). No master.
- **File-based** — Directory protocol with `INBOX → IN_PROGRESS → DONE` state machine. Filesystem is the only communication layer.
- **Lock-free reads** — `flock` for state transitions, shared locks for scanning.
- **Join/leave freely** — Any node can join via `HANDOFF_NODE=xxx` environment variable, no registration needed.
- **No central delivery** — Notifications via `notify.<target>.flag` files, not push/WebSocket.

## Quick Start

```bash
# Run the handoff daemon on any node
HANDOFF_NODE=my-worker ./scripts/handoff/handoff-daemon.sh

# The daemon will:
# 1. Write heartbeat to STATE/<node>.heartbeat
# 2. Scan INBOX for tasks with node=my-node or node=any
# 3. Auto-claim matching tasks (INBOX → IN_PROGRESS)
# 4. Detect new DONE/ALERT entries
```

## Architecture

```
shared/cc-handoff/
├── INBOX/           # Task queue (any node can submit)
├── IN_PROGRESS/     # Claimed tasks (exclusive per node)
├── DONE/            # Completed tasks
├── ALERT/           # Failure notifications
├── INBOX_ARCHIVE/   # Historical records
├── STATE/           # Heartbeat, lock, notify flags
├── bin/             # Protocol implementation
│   ├── handoff-lock.sh      # flock-based mutex
│   ├── frontmatter.sh       # YAML frontmatter reader
│   ├── notify-openclaw.sh   # Notify target node
│   ├── trigger-cc.sh        # CC spawn prompt
│   ├── claim-task.sh        # INBOX → IN_PROGRESS
│   ├── finish-task.sh       # Done + notify
│   ├── handoff_client.py    # Python API client
│   └── ...
├── dashboard/       # Kanban UI
│   ├── server.py    # REST API + dashboard
│   ├── app.js       # Client-side renderer
│   └── index.html
└── docs/            # Design documents
scripts/handoff/
├── handoff-daemon.sh  # Symmetric node daemon
├── cc-daemon.sh       # CC node daemon
└── dispatch-cc.sh     # Task dispatcher
```

## Task Lifecycle

1. **Submit**: Write `INBOX/<task-id>.md` with YAML frontmatter (`node`, `priority`, `created_by`, etc.)
2. **Claim**: Target node's daemon auto-moves `INBOX → IN_PROGRESS` (atomically, under flock)
3. **Complete**: Write `DONE/<task-id>.md`, notify target via `notify.<target>.flag`
4. **Route**: `node` field determines responsibility:
   - `node: any` — first available node claims
   - `node: oc-main` — OpenClaw agent processes
   - `node: cc-main` — Codex agent processes
   - `node: <custom>` — any configured worker
