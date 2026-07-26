# Repository Structure Review & Reorg Proposal

**Reviewer:** cc-main · **Date:** 2026-07-26 · **Task:** P1-20260726-repo-structure-review

This document is the structure audit (problems + priority), the proposed target
layout, and a concrete migration plan. It deliberately **separates what is safe
to apply now (Tier 1, already done) from what needs multi-node deploy
coordination (Tier 2, proposal only).**

---

## 1. Audit — current state

The repo tracks 24 files across two trees: `scripts/handoff/` (3 daemons) and
`shared/cc-handoff/` (protocol root: `bin/`, `dashboard/`, `docs/`, plus one
stray runtime file). Everything else under `shared/cc-handoff/` is untracked
runtime state that exists only in the live workspace.

### Findings

| # | Problem | Severity | Evidence |
|---|---------|----------|----------|
| F1 | **Runtime file committed to git.** A completed-task record lives in `DONE/`, which by design is runtime message-board state. | **P0** (constraint violation) | `shared/cc-handoff/DONE/P0-20260726-handoff-symmetric-alignment.md` is tracked; its own frontmatter is `status: done` with `claimed_by`/`done_at`/`tokens`. Constraint #3 says runtime dirs must not be tracked. |
| F2 | **Runtime dirs not guarded by `.gitignore`.** Only specific `STATE/*` files are ignored — the `INBOX/` `IN_PROGRESS/` `DONE/` `ALERT/` `INBOX_ARCHIVE/` dirs are not, so any `git add .` re-commits runtime state (this is exactly how F1 happened). | **P0** | `shared/cc-handoff/.gitignore` lists per-file `STATE/` entries but no dir-level rules for the board dirs. |
| F3 | **Protocol code split across two non-adjacent trees.** The daemons (`scripts/handoff/`) and the implementation they `source` (`shared/cc-handoff/bin/`) are the two halves of one system, separated by the runtime dirs. A newcomer cannot see them as one unit. | **P1** (readability) | `handoff-daemon.sh:32-33` does `. "$HD/bin/handoff-lock.sh"`; the daemon and its libs live in different top-level dirs. |
| F4 | **README references untracked files.** Quick Start tells users to `cp task-template.md …`, but `task-template.md` / `done-template.md` are not tracked — a fresh clone breaks immediately. | **P1** (onboarding) | `git ls-files` shows no `*template.md`; README:47 references it. |
| F5 | **No top-level map of source vs. runtime vs. docs.** A reader landing in `shared/cc-handoff/` sees `INBOX/ DONE/ STATE/ bin/ dashboard/ docs/` flattened together with no signal as to which are code. | **P1** (readability) | Directory listing mixes tracked code with gitignored runtime dirs. |
| F6 | **README claims MIT but no `LICENSE` file exists.** | **P2** (completeness) | `README.md` ends "## License MIT"; `ls LICENSE` → not found. |
| F7 | **Deployed path is hardcoded, not configurable.** 13 tracked files resolve the protocol root as `~/.openclaw/workspace/shared/cc-handoff`. The repo cannot be cloned and run from an arbitrary location. | **P2** (portability — by design, but worth flagging) | See dependency map below; `cc-daemon.sh:18`, `handoff-lock.sh:23`, `dashboard/server.py:11`, `trigger-cc.sh:96-101` (path embedded in the spawn prompt text), etc. |
| F8 | **Design docs buried three levels deep** under `shared/cc-handoff/docs/`, mixed with runtime dirs. | **P2** (readability) | `docs/` is a peer of `INBOX/`/`DONE/` rather than a first-class top-level concern. |

**Summary:** the P0s (F1, F2) are correctness/constraint violations — runtime
state leaking into version control. The P1s (F3–F5) are the readability ask at
the heart of this task. The P2s (F6–F8) are polish.

---

## 2. What was applied now (Tier 1 — zero path-breakage)

These changes improve readability and satisfy the constraints **without touching
any load-bearing path**, so the deployed multi-node system keeps running
unchanged:

- **[F1]** Untracked the stray runtime file
  `shared/cc-handoff/DONE/P0-…md` (`git rm --cached`; the file stays on disk).
- **[F2]** Hardened `shared/cc-handoff/.gitignore` to ignore the runtime board
  dirs wholesale (`INBOX/`, `INBOX_ARCHIVE/`, `IN_PROGRESS/`, `DONE/`, `ALERT/`,
  `STATE/`), so runtime state can never be re-committed.
- **[F4]** Tracked `task-template.md` and `done-template.md` so the Quick Start
  works from a fresh clone.
- **[F5]** Rewrote `README.md` with an explicit source/runtime/docs map and
  per-node deployment + contributing sections.
- **[F6]** Added `LICENSE` (MIT) to match the README's claim.
- **[F3, F7, F8]** Documented here as the Tier-2 proposal below (moving code
  would break deployed paths — see §4).

---

## 3. Proposed target layout (Tier 2 — proposal)

Goal: a newcomer can tell at a glance what is **core protocol**, what is
**runtime state**, and what is **docs**.

```
distributed-orchestration/
├── README.md
├── LICENSE
├── RESTRUCTURE.md
├── .gitignore
│
├── docs/                         # all design docs (promoted from shared/cc-handoff/docs/)
│
├── protocol/                     # core protocol — the "language" of the system
│   ├── bin/                      #   claim-task.sh, finish-task.sh, lock, notify, trigger, client …
│   └── daemons/                  #   handoff-daemon.sh, cc-daemon.sh, dispatch-cc.sh
│                                   (merges scripts/handoff/ + shared/cc-handoff/bin/ → one tree)
│
├── dashboard/                    # Kanban UI (promoted from shared/cc-handoff/dashboard/)
│
├── templates/                    # task-template.md, done-template.md
│
└── runtime/                      # gitignored — the message board
    ├── INBOX/  IN_PROGRESS/  DONE/  ALERT/  INBOX_ARCHIVE/
    └── STATE/  (heartbeats, lock, notify flags, nodes/)
```

Why this shape:

- **`protocol/`** unites the daemons and the `bin/` libs they `source` (fixes
  F3). One tree = one mental model.
- **`runtime/`** isolates *all* generated state under a single gitignored root
  (fixes F2 structurally, not just via `.gitignore` patterns). A reader sees
  "this whole dir is runtime" without reading ignore rules.
- **`docs/`, `dashboard/`, `templates/`** promoted to top level (fixes F8, F4) —
  first-class concerns, not nested under the protocol root.

### Path-constant refactor (prerequisite for Tier 2)

Today every script hardcodes the root. The move only becomes safe once the root
is resolved from **one** place. Proposed:

```sh
# protocol/bin/paths.sh  (single source of truth — sourced by every script)
: "${HANDOFF_ROOT:=${HANDOFF_ROOT:-$HOME/.openclaw/workspace/shared/cc-handoff}}"
WS="$(dirname "$(dirname "$HANDOFF_ROOT")")"   # or an explicit HANDOFF_WS
```

Then each daemon/script does `. "$HERE/paths.sh"` (using its own resolved
location) instead of hardcoding `$HOME/.openclaw/workspace/…`. `HANDOFF_ROOT`
becomes the one knob operators set per deployment. This also fixes F7
(portability).

---

## 4. Migration plan (Tier 2)

**Why this is a proposal, not applied here:** the string
`shared/cc-handoff` (and `~/.openclaw/workspace`) is load-bearing across the
deployed fleet. Touching it without coordination breaks every node's cron and
the CC spawn prompt. Dependency map (tracked files referencing the runtime path):

```
scripts/handoff/{handoff-daemon,cc-daemon,dispatch-cc}.sh   # WS=/HD= constants
shared/cc-handoff/bin/{handoff-lock,claim-task,finish-task,
  cc-heartbeat,notify-openclaw,task-done,trigger-cc}.sh      # constants + spawn-prompt text
shared/cc-handoff/dashboard/server.py                        # HD = expanduser(...)
shared/cc-handoff/bin/README.md  +  README.md                # documented paths
```

Phased rollout (each phase leaves the fleet working):

1. **Introduce `paths.sh`, keep old paths as default.** `HANDOFF_ROOT` defaults
   to today's `~/.openclaw/workspace/shared/cc-handoff`. No behavior change.
2. **Migrate scripts one file at a time** to source `paths.sh`; keep the default
   identical. Verify each node still scans/claims/finishes.
3. **Update cron + spawn prompt** on each node to set `HANDOFF_ROOT` explicitly.
4. **Move the files** (`git mv`) into `protocol/`, `dashboard/`, `docs/`,
   `templates/`, `runtime/`. Because every path now flows through
   `HANDOFF_ROOT`, the moves don't change runtime behavior.
5. **Add a compatibility shim** (or a one-time migration note) for existing
   `~/.openclaw/workspace/shared/cc-handoff` deployments — e.g. a symlink
   `shared/cc-handoff -> runtime/` during the transition, removed once all nodes
   redeploy.

Each phase is independently reversible. **Step 4 must be coordinated with OC
across all live nodes** — that's why it is not done in this task.

---

## 5. Recommendation

Apply Tier 1 now (done). Schedule Tier 2 as a separate P1 once OC confirms a
maintenance window to redeploy crons across nodes. The single highest-leverage
Tier-2 step is the `paths.sh` refactor (§3): it unblocks every later move and
fixes portability (F7) — do that first, before any `git mv`.
