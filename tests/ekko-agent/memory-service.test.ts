import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  EkkoDatabaseManager,
  MemoryService,
  SqliteMemoryStore,
  normalizeMemoryKey,
  resolveMemoryQuery,
  type MemoryNode,
  type MemoryStore,
  type ModelClient,
  type ModelRequest,
} from '../../packages/ekko-agent/src'

let webUiHome = ''
let store: SqliteMemoryStore
let service: MemoryService

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-memory-service-'))
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ webUiHome }))
  service = new MemoryService({ store, summaryEveryMessages: 2 })
})

afterEach(async () => {
  service.close()
  await rm(webUiHome, { recursive: true, force: true })
})

describe('MemoryService', () => {
  it('normalizes controlled keys and requires explicit intent for user memory', async () => {
    expect(normalizeMemoryKey('avoid-food')).toBe('avoid_ingredient')
    const rejected = await service.proposeUpdate({
      operation: 'create',
      reason: 'inferred',
      identity: { sessionId: 's1', userId: 'u1' },
      node: userPreference('tofu'),
    })
    expect(rejected).toMatchObject({ accepted: false, reason: 'User-scoped memory requires explicit user intent.' })

    const accepted = await service.proposeUpdate({
      operation: 'create',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', userId: 'u1' },
      node: userPreference('tofu'),
    })
    expect(accepted.accepted).toBe(true)
    const exact = await service.search(
      { sessionId: 's1', userId: 'u1' },
      { domain: '生活技能', key: 'avoid_ingredient', valueJson: 'tofu' },
    )
    expect(exact.exact).toMatchObject([{ valueJson: 'tofu' }])
  })

  it('prefers corrections and narrower scopes when resolving conflicts', () => {
    const nodes = [
      memoryNode('user', { scope: 'user', userId: 'u1' }),
      memoryNode('workspace', { scope: 'workspace', workspaceId: '/repo' }),
      memoryNode('correction', { scope: 'user', userId: 'u1', type: 'correction' }),
    ]
    const result = resolveMemoryQuery([], nodes, undefined, 10)
    expect(result.relevant.map(node => node.id)).toEqual(['correction'])
    expect(result.omitted).toEqual(expect.arrayContaining([
      { nodeId: 'workspace', reason: 'conflict_lost' },
      { nodeId: 'user', reason: 'conflict_lost' },
    ]))
  })

  it('keeps independent multi-value preferences and scopes id access', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', userId: 'u1' },
        node: userPreference(value),
      })
    }
    const result = await service.search({ sessionId: 's1', userId: 'u1' }, { key: 'avoid_ingredient', limit: 10 })
    const nodes = [...result.exact, ...result.relevant]
    expect(nodes.map(node => node.valueJson).sort()).toEqual(['芹菜', '香菜'])
    await expect(service.get(nodes[0].id, { sessionId: 'other', userId: 'u2' })).resolves.toBeUndefined()
    await expect(service.forget({
      id: nodes[0].id,
      reason: 'cross-user attempt',
      identity: { sessionId: 'other', userId: 'u2' },
    })).resolves.toMatchObject({ deletedIds: [], reason: 'No matching memory was found.' })

    await expect(service.proposeUpdate({
      operation: 'create',
      reason: 'cross-user attempt',
      explicitUserIntent: true,
      identity: { sessionId: 's1', userId: 'u1' },
      node: { ...userPreference('葱'), userId: 'u2' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'Memory userId does not match the runtime identity.',
    })
  })

  it('extracts explicit preferences asynchronously and builds chained summaries', async () => {
    const identity = { sessionId: 's1', workspaceId: '/repo', userId: 'u1' }
    service.scheduleRunCompletion(identity, [
      { role: 'user', content: '以后做饭少油少辣' },
      { role: 'assistant', content: '好的，已记住。' },
    ])
    await service.drain()

    const result = await service.search(identity, { domain: '生活技能', key: 'flavor_profile' })
    expect([...result.exact, ...result.relevant]).toMatchObject([{
      scope: 'user',
      userId: 'u1',
      valueJson: { oil: 'low', spicy: 'low' },
    }])
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      currentGoal: '以后做饭少油少辣',
    })
  })

  it('injects retrieved memory and memory tools into runtime requests', async () => {
    await service.proposeUpdate({
      operation: 'create',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', userId: 'u1' },
      node: userPreference('香菜'),
    })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: service })
    const result = await runtime.run({
      messages: ['推荐一道菜'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', userId: 'u1' },
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[0].content).toContain('Retrieved Memory')
    expect(request.messages[0].content).toContain('Avoid 香菜')
    expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'memory_search', 'memory_get', 'memory_propose_update', 'memory_forget',
    ]))
    expect(result.memoryContext?.usedMemoryIds).toHaveLength(1)
  })

  it('requires confirmation for broad or hard deletion', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', userId: 'u1' },
        node: userPreference(value),
      })
    }
    await expect(service.forget({
      scope: 'user', domain: '生活技能', reason: 'clear preferences', identity: { sessionId: 's1', userId: 'u1' },
    })).resolves.toMatchObject({ requiresConfirmation: true, deletedIds: [] })
    const one = await service.search({ sessionId: 's1', userId: 'u1' }, { key: 'avoid_ingredient', limit: 10 })
    const nodeId = [...one.exact, ...one.relevant][0].id
    await expect(service.forget({
      id: nodeId,
      mode: 'hard',
      reason: 'erase',
      confirmed: false,
      identity: { sessionId: 's1', userId: 'u1' },
    }))
      .resolves.toMatchObject({ requiresConfirmation: true, deletedIds: [] })
  })

  it('degrades memory failures without blocking the model response', async () => {
    const failure = async () => { throw new Error('database unavailable') }
    const failingStore = {
      appendMessage: failure,
      listRecentMessages: failure,
      listMessagesAfter: failure,
      appendSummary: failure,
      getLatestSummary: failure,
      getNode: failure,
      upsertNode: failure,
      supersedeNode: failure,
      updateNodeStatus: failure,
      deleteNode: failure,
      queryNodes: failure,
      appendAuditEvent: failure,
      getSessionState: failure,
      setSessionState: failure,
      close() {},
    } as unknown as MemoryStore
    const degraded = new MemoryService({ store: failingStore })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: degraded })

    const result = await runtime.run({ messages: ['hello'], contextKey: 's1' })

    expect(result.output.content).toBe('ok')
    expect(result.memoryContext?.diagnostics).toMatchObject({ storeStatus: 'degraded', enabled: true })
    expect(result.memoryContext?.diagnostics.warnings).toContain('database unavailable')
    degraded.close()
  })
})

function modelClient(): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => ({ content: 'ok' })),
    stream: vi.fn(),
  }
}

function userPreference(value: string): Partial<MemoryNode> {
  return {
    scope: 'user',
    domain: '生活技能',
    categoryPath: ['生活技能', '做饭', '饮食偏好'],
    type: 'preference',
    key: 'avoid_food',
    valueJson: value,
    title: `Avoid ${value}`,
    content: `Avoid ${value} in recommendations.`,
  }
}

function memoryNode(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    sessionId: 's1',
    scope: 'session',
    domain: '生活技能',
    categoryPath: ['生活技能', '做饭'],
    type: 'preference',
    key: 'avoid_ingredient',
    valueJson: '香菜',
    title: id,
    content: id,
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    tags: [],
    entities: [],
    sourceMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
