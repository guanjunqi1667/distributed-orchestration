---
name: agent-team-orchestration
description: "Thin entry for deciding, routing, and planning multi-agent team workflows with roles, lifecycle, handoffs, reviews, and shared artifacts."
---

# Agent Team Orchestration

- **分类**: 多智能体协作编排

Thin entry layer for deciding whether a task needs a multi-agent team, then routing to the right reference file.

Canonical project source:
- `projects/agent-team-orchestration/README.md`

Use this file for invocation, not as the full operating manual.

## Decision Gate

Use team orchestration only when the task has sustained coordination cost:

- Two or more specialized roles are needed.
- Work crosses phases such as spec -> build -> review -> rework -> done.
- Agents must exchange artifacts through shared paths.
- A review or quality gate can reject work before shipping.
- The workflow is recurring or likely to continue across multiple tasks.

Do not use team orchestration for:

- Simple facts, status checks, or one-message answers.
- Single-agent tasks where direct execution is cheaper.
- One-off delegation with no handoff or review loop.
- Cases where the orchestrator would end up doing the build work.

If orchestration is unnecessary, say so directly and use the smallest path.

## Output Contract

When this skill triggers, produce a machine-checkable plan with:

- `team_scope` - why the task does or does not need team workflow
- `roles` - name, responsibility, and model hint for each agent
- `lifecycle` - Inbox, Assigned, In Progress, Review, Done, Failed
- `handoff` - structured summary using `projects/agent-team-orchestration/docs/handoff-protocol-v3.md` template (Short for <=2 CTs, Long for >=3 CTs), including task, purpose, scope, references, verification, deliverables
- `review_gate` - concrete checks that can reject the work
- `artifacts` - exact shared artifact or review paths
- `anti_patterns` - mistakes to avoid for this workflow

For decision-contract V2 execution, also include:

- `decision_contract_verdict` - DONE, PARTIAL, REWORK, or BLOCKED
- `acceptance_evidence` - acceptance target to evidence mapping
- `constraint_compliance` - constraint to compliance mapping
- `blocker_type` - required when verdict is BLOCKED

For opt-out cases, keep the same fields but make `team_scope` clearly state that team workflow is unnecessary.

## Harness Boundary

Use this skill as the coordination layer and `harness-engineer` as the execution reliability layer.

- Team orchestration decides the team boundary, roles, lifecycle, handoffs, and review gates.
- Harness execution governs implementation nodes: plan, implement, test, review, feedback, recovery.
- If both skills trigger, decide the team boundary first, then run harness rules inside Builder, Tester, and Reviewer nodes.
- If delegated execution fails, follow `harness-engineer` fallback and review rules before marking Done.

## Reference Routing

| Need | Read |
|------|------|
| Minimal team loop or first setup | [references/quickstart.md](references/quickstart.md) |
| Agents, roles, models, workspaces | [references/team-setup.md](references/team-setup.md) |
| Task states, transitions, comments | [references/task-lifecycle.md](references/task-lifecycle.md) |
| Handoff protocol V3 (Short/Long template) | `projects/agent-team-orchestration/docs/handoff-protocol-v3.md` |
| Communication channels, artifacts | [references/communication.md](references/communication.md) |
| Workflow patterns: spec-build-review, research, escalation, batch work | [references/patterns.md](references/patterns.md) |
| Failure modes and anti-patterns | [references/pitfalls.md](references/pitfalls.md) |

Only load the reference files needed for the current task.
