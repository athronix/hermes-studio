---
date: 2026-07-13
pr: 11
feature: Workflow orchestration evidence, portability, and recursive scheduling hardening
impact: Workflow execution, rerun, history, import/export, and live status now share one fail-closed persisted-evidence and capability contract.
---

# Workflow orchestration evidence, portability, and recursive scheduling hardening

- Fresh runs and reruns use the same completion-driven DAG and recursive laminar-loop schedulers over a normalized frozen graph.
- Reruns preserve append-only Node, Edge, and Loop history under a unique execution scope; preserved upstream inputs are accepted only when the latest source execution has matching persisted taken-edge evidence.
- Node executions record the exact Edge evidence IDs consumed by their prompt. Node, Edge, and Loop records share one monotonic Run sequence.
- HTTP Run detail, Run lists, WorkflowSocket live status, and client History use one hydrated persisted-evidence contract. Read failures return no partial history.
- Workflow import/export uses a versioned Agent-only definition allowlist, strips runtime state and credentials, validates exact model/API/tool capabilities in the target profile at preview and confirmation, binds one-shot preview tokens to owner/profile/environment revision, and creates a new Workflow without running it.
- Edge conditions use typed JSON operands, forbidden property paths fail during preflight, and explicit Feedback Edges have bounded stable Loop identities.
- Execution-policy and reasoning overrides fail closed when the target runtime cannot apply them; they are not treated as advisory UI metadata.
