import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/types'
import type { MemoryForgetInput, MemoryNode, MemoryProposeUpdateInput, MemoryQuery, MemoryRuntimeIdentity } from './types'
import type { MemoryService } from './service'

export function createMemoryTools(service: MemoryService): AgentTool[] {
  return [
    new MemorySearchTool(service),
    new MemoryGetTool(service),
    new MemoryProposeUpdateTool(service),
    new MemoryForgetTool(service),
  ]
}

class MemorySearchTool implements AgentTool {
  readonly definition = {
    name: 'memory_search',
    description: 'Search Ekko Agent long-term memory by exact fields or keyword relevance.',
    parameters: {
      type: 'object',
      properties: {
        queryText: { type: 'string' },
        key: { type: 'string' },
        valueJson: {},
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_search requires a sessionId.')
    const query: MemoryQuery = {
      queryText: optionalString(input.queryText),
      key: optionalString(input.key),
      valueJson: input.valueJson,
      limit: optionalNumber(input.limit),
    }
    const result = await this.service.search(identity, query)
    return success(result)
  }
}

class MemoryGetTool implements AgentTool {
  readonly definition = {
    name: 'memory_get',
    description: 'Get one long-term memory by id, or resolve an exact key/value query.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        key: { type: 'string' },
        valueJson: {},
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const id = optionalString(input.id)
    const identity = runtimeIdentity(context)
    if (id) {
      if (!identity) return failure('memory_get requires a sessionId.')
      return success(await this.service.get(id, identity))
    }
    if (!identity) return failure('memory_get requires a sessionId when id is not provided.')
    const result = await this.service.search(identity, {
      key: optionalString(input.key),
      valueJson: input.valueJson,
      limit: 2,
    })
    const matches = [...result.exact, ...result.relevant]
    return success(matches.length === 1 ? matches[0] : undefined, matches.length > 1 ? 'Multiple memories matched.' : undefined)
  }
}

class MemoryProposeUpdateTool implements AgentTool {
  readonly definition = {
    name: 'memory_propose_update',
    description: 'Create, update, supersede, expire, or soft-delete a long-term memory.',
    parameters: {
      type: 'object',
      required: ['operation', 'node', 'reason'],
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'supersede', 'expire', 'delete'] },
        targetId: { type: 'string' },
        node: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            valueJson: { description: 'Optional structured or scalar value. Use this exact field name, not value.' },
            title: { type: 'string', description: 'Short human-readable memory title.' },
            content: { type: 'string', description: 'Complete durable memory statement.' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            sourceMessageIds: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', description: 'Optional ISO-8601 expiration timestamp.' },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_propose_update requires a sessionId.')
    if (!input.node || typeof input.node !== 'object' || Array.isArray(input.node)) return failure('node must be an object.')
    const operation = optionalString(input.operation) as MemoryProposeUpdateInput['operation'] | undefined
    const reason = optionalString(input.reason)
    if (!operation || !reason) return failure('operation and reason are required.')
    const node = normalizeToolMemoryNode(input.node as Record<string, unknown>)
    const result = await this.service.proposeUpdate({
      operation,
      targetId: optionalString(input.targetId),
      node,
      reason,
      identity,
      actor: 'ekko-agent-tool',
    })
    return result.accepted ? success(result) : failure(result.reason || 'Memory update was rejected.', result)
  }
}

class MemoryForgetTool implements AgentTool {
  readonly definition = {
    name: 'memory_forget',
    description: 'Soft-delete or confirmed hard-delete matching Ekko Agent memories.',
    parameters: {
      type: 'object',
      required: ['reason'],
      properties: {
        id: { type: 'string' },
        key: { type: 'string' },
        valueJson: {},
        mode: { type: 'string', enum: ['soft', 'hard'] },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  }

  constructor(private readonly service: MemoryService) {}

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const identity = runtimeIdentity(context)
    if (!identity) return failure('memory_forget requires a sessionId.')
    const reason = optionalString(input.reason)
    if (!reason) return failure('reason is required.')
    const request: MemoryForgetInput = {
      id: optionalString(input.id),
      key: optionalString(input.key),
      valueJson: input.valueJson,
      mode: optionalString(input.mode) as 'soft' | 'hard' | undefined,
      reason,
      confirmed: input.confirmed === true,
      identity,
      actor: 'ekko-agent-tool',
    }
    const result = await this.service.forget(request)
    if (result.requiresConfirmation) return failure(result.reason || 'Confirmation required.', result)
    return success(result)
  }
}

function runtimeIdentity(context?: AgentToolContext): MemoryRuntimeIdentity | undefined {
  if (!context?.sessionId) return undefined
  return {
    sessionId: context.sessionId,
    workspaceId: context.workspaceId || context.workspaceRoot || context.cwd,
    userId: context.userId,
  }
}

function success(data: unknown, note?: string): AgentToolResult {
  return { ok: true, content: note || JSON.stringify(data ?? null), data }
}

function failure(message: string, data?: unknown): AgentToolResult {
  return { ok: false, content: message, error: message, data }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(item => String(item).trim()).filter(Boolean)
}

function normalizeToolMemoryNode(input: Record<string, unknown>): Partial<MemoryNode> {
  const node = { ...input }
  if (node.valueJson === undefined && Object.prototype.hasOwnProperty.call(node, 'value')) {
    node.valueJson = node.value
  }
  const summary = optionalString(node.summary) || optionalString(node.description)
  if (!optionalString(node.content) && summary) node.content = summary
  if (!optionalString(node.title)) {
    const key = optionalString(node.key)?.replaceAll('_', ' ')
    const value = typeof node.valueJson === 'string' ? node.valueJson : undefined
    node.title = truncateTitle([key, value].filter(Boolean).join(': ') || summary || optionalString(node.content) || 'Memory')
  }
  return node as Partial<MemoryNode>
}

function truncateTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 79)}…`
}
