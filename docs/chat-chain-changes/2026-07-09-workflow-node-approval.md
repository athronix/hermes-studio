---
date: 2026-07-09
pr: pending
feature: Workflow node approval
impact: Workflow runs can pause after a node completes until the user approves or rejects that node in the node chat panel.
---

Workflow node definitions now persist an `approvalRequired` flag in node JSON.
Missing flags default to `false`, so existing workflow definitions keep running
without a node-level approval gate.

Workflow manager still passes `approvalChoice: 'once'` to chat runs so existing
tool-call approval behavior is unchanged. Node approval happens after a node chat
run succeeds: the manager marks that node `pending_approval`, waits for the
workflow node approval API response, then either releases downstream nodes or
cancels the workflow run.
