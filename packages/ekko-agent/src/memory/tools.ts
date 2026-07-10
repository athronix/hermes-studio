import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/types'
import type { MemoryForgetInput, MemoryNode, MemoryProposeUpdateInput, MemoryQuery, MemoryRuntimeIdentity } from './types'
import { MemoryService } from './service'

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
    description: 'Search Ekko Agent structured memory using scoped exact fields and optional keyword relevance.',
    parameters: {
      type: 'object',
      properties: {
        queryText: { type: 'string' },
        scope: { type: 'string', enum: ['session', 'workspace', 'user', 'global'] },
        domain: { type: 'string' },
        categoryPathPrefix: { type: 'array', items: { type: 'string' } },
        types: { type: 'array', items: { type: 'string' } },
        key: { type: 'string' },
        valueJson: {},
        tags: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
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
      scopes: optionalString(input.scope) ? [optionalString(input.scope)! as MemoryNode['scope']] : undefined,
      domain: optionalString(input.domain),
      categoryPathPrefix: stringArray(input.categoryPathPrefix),
      types: stringArray(input.types) as MemoryNode['type'][] | undefined,
      key: optionalString(input.key),
      valueJson: input.valueJson,
      tags: stringArray(input.tags),
      entities: stringArray(input.entities),
      limit: optionalNumber(input.limit),
    }
    const result = await this.service.search(identity, query)
    return success(result)
  }
}

class MemoryGetTool implements AgentTool {
  readonly definition = {
    name: 'memory_get',
    description: 'Get one memory by id, or resolve an exact scoped memory query.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['session', 'workspace', 'user', 'global'] },
        domain: { type: 'string' },
        type: { type: 'string' },
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
      scopes: optionalString(input.scope) ? [optionalString(input.scope)! as MemoryNode['scope']] : undefined,
      domain: optionalString(input.domain),
      types: optionalString(input.type) ? [optionalString(input.type)! as MemoryNode['type']] : undefined,
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
    description: 'Propose a validated memory create, update, supersede, expire, or soft delete operation.',
    parameters: {
      type: 'object',
      required: ['operation', 'node', 'reason'],
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'supersede', 'expire', 'delete'] },
        targetId: { type: 'string' },
        node: { type: 'object' },
        reason: { type: 'string' },
        explicitUserIntent: { type: 'boolean' },
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
    const result = await this.service.proposeUpdate({
      operation,
      targetId: optionalString(input.targetId),
      node: input.node as Partial<MemoryNode>,
      reason,
      explicitUserIntent: input.explicitUserIntent === true,
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
        scope: { type: 'string', enum: ['session', 'workspace', 'user', 'global'] },
        domain: { type: 'string' },
        categoryPathPrefix: { type: 'array', items: { type: 'string' } },
        type: { type: 'string' },
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
      scope: optionalString(input.scope) as MemoryNode['scope'] | undefined,
      domain: optionalString(input.domain),
      categoryPathPrefix: stringArray(input.categoryPathPrefix),
      type: optionalString(input.type) as MemoryNode['type'] | undefined,
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
