---
date: 2026-07-13
pr: 11
feature: Workflow execution identity and policy
impact: Workflow runs preserve the exact model target, reasoning effort, and Hermes tool/memory/context policy through queueing and Agent Bridge execution.
---

Workflow Agent executions now preserve an exact `provider` / `model` / `apiMode` / `reasoningEffort` tuple and an optional Hermes-only execution policy through Workflow snapshots, queued chat runs, Agent Bridge context estimation, and Agent construction. The execution policy can restrict toolsets and individual tools and can disable memory and context-file loading. Explicit malformed or unsupported policies fail closed before a Workflow Run is persisted.
