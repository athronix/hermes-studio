# Ekko Agent memory design

## Goal

Keep the memory model intentionally small. The system distinguishes only between temporary conversation memory and long-term memory.

## Temporary memory

Temporary memory belongs to one conversation and is not promoted automatically merely because it appeared in chat.

It consists of:

- append-only conversation messages in `memory_messages`;
- the rolling session summary in `memory_summaries`;
- extraction cursors in `memory_session_state`.

Temporary memory helps continue the current conversation. It is not part of the cross-session long-term memory pool.

## Long-term memory

Long-term memory is a single flat pool stored in `memory_nodes`.

There are no scopes, owners, domains, category paths, or memory types. A node contains only the information needed to store, find, update, and audit a durable memory:

```ts
interface MemoryNode {
  id: string
  parentId?: string
  supersedesId?: string
  key?: string
  valueJson?: unknown
  title: string
  content: string
  status: 'active' | 'superseded' | 'expired' | 'deleted'
  confidence: number
  importance: number
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}
```

`key` is optional. Use it only when a stable identifier helps deduplicate or replace a memory. It is not a category.

## Promotion rule

The curator makes one decision: will this information remain useful in future conversations?

- If yes, write it to `memory_nodes` as long-term memory.
- If no, leave it in temporary conversation memory.

Do not store secrets, transient chat, tool output, weather, prices, news, or facts useful only for the current reply as long-term memory.

## Retrieval and context injection

For each model request:

1. load the current session's recent messages and rolling summary;
2. search the flat long-term memory pool using the latest user message;
3. resolve duplicate or superseded nodes;
4. inject relevant active long-term memories under `Retrieved Memory`.

Long-term retrieval supports:

- exact `id` lookup;
- exact `key` and `valueJson` lookup;
- keyword relevance over title and content.

## Updates and deletion

- Creating an exact duplicate returns the existing node.
- A conflicting value with the same stable key must use an explicit supersede operation.
- Superseding marks the old node `superseded` and creates the replacement atomically.
- Soft deletion marks a node `deleted`.
- Hard deletion requires confirmation and removes the node and embedding.

## Tools

The memory tools operate only on long-term memory:

- `memory_search`
- `memory_get`
- `memory_propose_update`
- `memory_forget`

They do not expose scope, user, workspace, domain, category, or type parameters.

## Non-goals

The current design intentionally does not provide:

- per-session, per-workspace, per-user, or global scopes;
- memory categories or type taxonomies;
- domain-specific schemas;
- compatibility migrations for the unreleased previous design.
