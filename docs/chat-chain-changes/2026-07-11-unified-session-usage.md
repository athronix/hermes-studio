---
date: 2026-07-11
pr: pending
feature: Unified local session usage recording
impact: Hermes Bridge, Coding Agent, Ekko Agent, Group Chat, and context-engine runs persist per-run token usage through one normalized session_usage recorder without changing the usage dashboard data source.
---

Provider-reported usage is preferred. Scoped Coding Agents record one exact row per model call observed by the local proxy, including provider-reported cache usage, and skip the Claude/Codex turn aggregate to avoid double counting. Global Coding Agents only persist complete CLI-reported usage and do not estimate missing token fields. Other runtimes may use estimates scoped to the current run instead of inserting cumulative session totals.

Ekko Agent normalizes its runtime so every successful model API response emits exactly one `model.usage` event. The Web UI persists those events as `model_call` rows, including available cache and reasoning tokens, and does not persist the turn-level aggregate or local fallback estimate.
