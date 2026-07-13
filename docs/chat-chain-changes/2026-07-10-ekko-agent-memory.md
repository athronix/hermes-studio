---
date: 2026-07-10
pr: pending
feature: Ekko Agent chained memory
impact: Ekko Agent retrieves scoped SQLite memory before model calls and asynchronously extracts auditable memory after each completed run.
---

Ekko Agent owns a generic database through its dedicated database manager.
Development uses `packages/ekko-agent/sql-data/ekko-agent.db` with the same
single-file SQLite/DELETE journal layout as the server development database;
production uses `HERMES_WEB_UI_HOME/ekko/ekko.db`. Memory initialization
failures degrade the memory feature without blocking the existing chat run.
