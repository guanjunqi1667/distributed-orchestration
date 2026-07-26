# Distributed Orchestration

File-based, zero-push orchestration protocol for multi-node agent clusters.

The filesystem is the only communication layer. No push, no deliver, no model
dependency. Any node that is active scans the shared directory, picks up work,
and reports results. **Whoever is active, collects.**

> Looking for the structure review & reorg proposal? See **[RESTRUCTURE.md](RESTRUCTURE.md)**.

---

## Repository Structure

Two top-level trees — **daemons** (entry points you run) and **protocol root**
(the shared directory the daemons operate on):

```
distributed-orchestration/
├── README.md                         # you are here
├── RESTRUCTURE.md                    # structure review + reorg proposal
├── LICENSE                           # MIT
│
├── scripts/handoff/                  # 🟢 NODE DAEMONS (entry points — run these)
│   ├── handoff-daemon.sh             #   symmetric multi-node daemon (any node)
│   ├── cc-daemon.sh                  #   CC-side heartbeat guardian (cron-driven)
│   └── dispatch-cc.sh                #   OC → CC task dispatcher
│
└── shared/cc-handoff/                # 🟦 PROTOCOL ROOT (the shared directory)
    ├── bin/                          #   protocol implementation
    │   ├── handoff-lock.sh             #   flock mutex primitive (sourced)
    │   ├── frontmatter.sh              #   YAML frontmatter reader
    │   ├── claim-task.sh               #   INBOX → IN_PROGRESS (atomic, locked)
    │   ├── finish-task.sh              #   write DONE + archive (atomic, locked)
    │   ├── task-done.sh                #   DONE writer (db mode)
    │   ├── notify-openclaw.sh          #   drop a notify.<target>.flag
    │   ├── trigger-cc.sh               #   spawn a CC session to drain INBOX
    │   ├── cc-heartbeat.sh             #   refresh CC heartbeat mid-session
    │   └── handoff_client.py           #   Python client for the HTTP API
    ├── dashboard/                    #   Kanban status board
    │   ├── server.py                   #   REST API + dashboard (port 8377)
    │   ├── app.js                      #   client renderer
    │   └── index.html
    ├── docs/                         #   design documents (v2 → v4)
    ├── task-template.md              #   copy to INBOX/ to author a task
    ├── done-template.md              #   copy to DONE/ to report results
    │
    └── ── 🟡 RUNTIME STATE (gitignored, created at first use) ──
        ├── INBOX/          → tasks waiting to be claimed
        ├── IN_PROGRESS/    → tasks being worked on (who, since when)
        ├── DONE/           → completed tasks (results, timestamps, tokens)
        ├── ALERT/          → anomalies (timeouts, crashes, blockers)
        ├── INBOX_ARCHIVE/  → historical records
        └── STATE/          → heartbeats, lock, notify flags, node registrations
```

**Conventions:**

| Marker | Meaning |
|--------|---------|
| 🟢 | Source code — tracked in git, safe to read and edit |
| 🟦 | Protocol root — tracked code + (at runtime) the shared message board |
| 🟡 | Runtime state — **never** committed; each node generates its own |

The runtime directories (`INBOX/`, `IN_PROGRESS/`, `DONE/`, `ALERT/`,
`INBOX_ARCHIVE/`, `STATE/`) are generated on first use and ignored by git
(see `shared/cc-handoff/.gitignore`). They are the message board, not the
software — they must not be version-controlled.

---

## How It Works

```
INBOX/       → Tasks waiting to be claimed
IN_PROGRESS/ → Tasks being worked on (who's doing it, since when)
DONE/        → Completed tasks (results, timestamps, token usage)
ALERT/       → Anomalies (timeouts, crashes, blockers)
STATE/       → Node heartbeats + notify flags
STATE/nodes/ → Node registrations (identity, capabilities)
```

1. **Any node** drops a task file in `INBOX/`.
2. **Any active node** scans `INBOX/`, claims the highest-priority task
   (atomic, file-locked).
3. The task moves through `INBOX → IN_PROGRESS → DONE`.
4. **Any node** can scan the full board state at any time — no push needed.

### Task routing

The `node:` field in a task's YAML frontmatter decides who picks it up:

- `node: any` — first available node claims it
- `node: oc-main` — the OpenClaw agent processes it
- `node: cc-main` — the Codex/Claude agent processes it
- `node: <custom>` — any registered worker matching that id

### Design properties

- **Zero coupling** — nodes communicate only through files.
- **Zero push** — no deliver, no model dependency, no gateway required.
- **Multi-node ready** — add a node = register JSON + read/write files.
- **Multi-machine ready** — sync the folder (Syncthing / git / NFS) and you have
  a distributed cluster.
- **Lock-safe** — `flock` for `files` mode, SQLite transactions for `db` mode.

---

## Quick Start

```bash
# Clone
git clone https://github.com/guanjunqi1667/distributed-orchestration.git
cd distributed-orchestration

# Deploy into the runtime location the scripts expect:
#   ~/.openclaw/workspace/   (the daemons hardcode this path — see Deployment)

# 1. Register your node
mkdir -p shared/cc-handoff/STATE/nodes
echo '{"node_id":"my-agent","type":"custom","capabilities":["code"]}' \
  > shared/cc-handoff/STATE/nodes/my-agent.json

# 2. Drop a task (copy the template, fill the frontmatter, place in INBOX/)
cp shared/cc-handoff/task-template.md shared/cc-handoff/INBOX/P1-my-first-task.md
$EDITOR shared/cc-handoff/INBOX/P1-my-first-task.md

# 3. Any active node will pick it up (see Deployment to run a daemon)
```

---

## Deployment (per node)

Every node runs one daemon on a cron tick. The node identity is set with the
`HANDOFF_NODE` environment variable; all nodes are symmetric peers.

```bash
# OpenClaw node (default identity = oc-main)
*/3 * * * * ~/.openclaw/workspace/scripts/handoff/handoff-daemon.sh >> /tmp/handoff-daemon.log 2>&1

# CC / Codex node
HANDOFF_NODE=cc-main */3 * * * * ~/.openclaw/workspace/scripts/handoff/handoff-daemon.sh >> /tmp/handoff-daemon.log 2>&1

# CC-specific heartbeat guardian (spawns a CC session to drain INBOX when idle)
* * * * * ~/.openclaw/workspace/scripts/handoff/cc-daemon.sh >> /tmp/cc-daemon.log 2>&1
```

> **Path note:** the daemons and `bin/` scripts resolve the protocol root as
> `~/.openclaw/workspace/shared/cc-handoff`. This path is load-bearing across
> the protocol (see `RESTRUCTURE.md` for why, and the plan to make it
> configurable). For now, deploy the repo content under that location.

---

## Dashboard

The Kanban board is part of the protocol, not a separate tool. Any node can
render the full board state by scanning the directory — no API key, no gateway,
no model needed.

```
dashboard/server.py
├── reads INBOX/        → "Queued" column
├── reads IN_PROGRESS/  → "In Progress" column
├── reads DONE/         → "Completed" column
├── reads ALERT/        → "Alerts" badge
└── reads STATE/nodes/  → node status indicators
```

Run locally:

```bash
python3 shared/cc-handoff/dashboard/server.py   # → http://localhost:8377
```

---

## Storage Modes

| Mode | Authority | Projection | Use Case |
|------|-----------|------------|----------|
| `files` (default) | Filesystem | N/A | Single machine, simple |
| `dual` | SQLite | One-way to files | Multi-node, backward compatible |
| `db` | SQLite | None | Fully migrated, no file dependency |

Switch via `HANDOFF_STORE=files|dual|db`.

---

## Contributing

- **Protocol code** lives in `shared/cc-handoff/bin/` (implementation) and
  `scripts/handoff/` (daemons). Keep the two in sync — daemons `source` the
  `bin/` lock and frontmatter helpers.
- **Don't commit runtime state.** Never `git add` anything under `INBOX/`,
  `IN_PROGRESS/`, `DONE/`, `ALERT/`, `INBOX_ARCHIVE/`, or `STATE/`. The
  `.gitignore` guards these; respect it.
- **Documents** go in `shared/cc-handoff/docs/`.
- **Backward compatibility matters:** every daemon and `bin/` script is deployed
  across multiple nodes. Changes to paths or interfaces need a migration plan
  (see `RESTRUCTURE.md`).

## License

MIT — see [LICENSE](LICENSE).
