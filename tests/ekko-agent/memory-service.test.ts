import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  EkkoDatabaseManager,
  MemoryService,
  ModelMemoryExtractor,
  SqliteMemoryStore,
  createMemoryTools,
  normalizeMemoryKey,
  resolveMemoryQuery,
  type MemoryNode,
  type MemoryMessage,
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
  service = new MemoryService({ store, reviewEveryUserMessages: 1 })
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

  it('stores every turn but waits for the user-message review threshold before calling the extractor', async () => {
    const extract = vi.fn().mockResolvedValue({
      summaryPatch: 'Two user turns were reviewed together.',
      nodes: [],
    })
    const gated = new MemoryService({
      store,
      reviewEveryUserMessages: 2,
      extractor: { extract },
    })
    const identity = { sessionId: 'threshold-session', userId: 'u1' }

    gated.scheduleRunCompletion(identity, [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ])
    await gated.drain()

    expect(extract).not.toHaveBeenCalled()
    await expect(store.listMessagesAfter({ sessionId: identity.sessionId, limit: 10 }))
      .resolves.toHaveLength(2)
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toBeUndefined()

    gated.scheduleRunCompletion(identity, [
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ])
    await gated.drain()

    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract.mock.calls[0][0].messages.map((message: MemoryMessage) => message.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
      summary: 'Two user turns were reviewed together.',
    })
  })

  it('allows a manual review to bypass the user-message threshold', async () => {
    const extract = vi.fn().mockResolvedValue({ summaryPatch: 'Manual review.', nodes: [] })
    const gated = new MemoryService({
      store,
      reviewEveryUserMessages: 8,
      extractor: { extract },
    })
    const identity = { sessionId: 'manual-review-session', userId: 'u1' }
    await gated.captureMessages(identity, [{ role: 'user', content: 'one message' }])

    gated.scheduleExtraction(identity)
    await gated.drain()

    expect(extract).toHaveBeenCalledTimes(1)
    await expect(store.getLatestSummary({ sessionId: identity.sessionId })).resolves.toMatchObject({
      summary: 'Manual review.',
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

  it('uses a dedicated model pass with only memory tools to summarize and persist memory', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: 'Main answer' })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'memory-call-1',
          name: 'memory_propose_update',
          arguments: {
            operation: 'create',
            reason: 'The user explicitly requested a durable preference.',
            explicitUserIntent: true,
            node: {
              scope: 'user',
              domain: 'general',
              categoryPath: ['general'],
              type: 'preference',
              key: 'language_preference',
              valueJson: 'TypeScript',
              title: 'Preferred programming language',
              content: 'Prefer TypeScript for code examples.',
              confidence: 0.98,
              importance: 0.9,
            },
          },
        }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'The user asked Ekko to remember a preference for TypeScript examples.',
          currentGoal: 'Remember the TypeScript preference',
          constraints: ['Do not use JavaScript examples'],
          preferences: ['Prefer TypeScript examples'],
          decisions: ['Use TypeScript by default'],
          completedWork: [],
          pendingWork: ['Apply the preference to future examples'],
          knownIssues: [],
        }),
      })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    await runtime.run({
      messages: ['请记住以后代码示例优先使用 TypeScript'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', workspaceId: '/repo', userId: 'u1' },
    })
    await service.drain()

    const summaryRequest = create.mock.calls[1][0] as ModelRequest
    expect(summaryRequest.metadata).toEqual({ purpose: 'ekko-memory-summary' })
    expect(summaryRequest.tools?.map(tool => tool.name)).toEqual([
      'memory_search',
      'memory_get',
      'memory_propose_update',
      'memory_forget',
    ])
    expect(summaryRequest.messages[0].content).toContain('dedicated memory curator')
    expect(summaryRequest.messages[1].content).toContain('请记住以后代码示例优先使用 TypeScript')
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      summary: 'The user asked Ekko to remember a preference for TypeScript examples.',
      currentGoal: 'Remember the TypeScript preference',
      constraints: ['Do not use JavaScript examples'],
      preferences: ['Prefer TypeScript examples'],
      decisions: ['Use TypeScript by default'],
      pendingWork: ['Apply the preference to future examples'],
    })
    const memories = await service.search(
      { sessionId: 's1', workspaceId: '/repo', userId: 'u1' },
      { domain: 'general', key: 'language_preference' },
    )
    expect([...memories.exact, ...memories.relevant]).toMatchObject([{
      scope: 'user',
      userId: 'u1',
      valueJson: 'TypeScript',
    }])
  })

  it('deduplicates recaptured messages when unrelated messages shift their positions', async () => {
    const identity = { sessionId: 's1', workspaceId: '/repo', userId: 'u1' }
    await service.captureMessages(identity, [
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])
    await service.captureMessages(identity, [
      { role: 'assistant', content: 'an earlier inserted message' },
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])

    await expect(store.listMessagesAfter({ sessionId: 's1', limit: 20 })).resolves.toHaveLength(3)
  })

  it('excludes tool payloads from the bounded model summary transcript', async () => {
    const client = modelClient()
    const onUsage = vi.fn()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        summary: 'The user requested a weather lookup, which is now complete.',
        currentGoal: '',
        constraints: [],
        preferences: [],
        decisions: [],
        completedWork: [],
        pendingWork: [],
        knownIssues: [],
      }),
      model: 'summary-model',
      usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service, onUsage })

    await extractor.extract({
      sessionId: 's1',
      messages: [
        memoryMessage('user', '查一下天气', 'm1'),
        memoryMessage('tool', 'secret-tool-payload-with-a-long-weather-table', 'm2'),
        memoryMessage('assistant', '天气已经查好。', 'm3'),
      ],
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[1].content).toContain('查一下天气')
    expect(request.messages[1].content).toContain('天气已经查好。')
    expect(request.messages[1].content).not.toContain('secret-tool-payload')
    expect(onUsage).toHaveBeenCalledWith({
      purpose: 'ekko-memory-summary',
      usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
      model: 'summary-model',
      callIndex: 1,
    })
  })

  it('normalizes common model aliases in memory update tool arguments', async () => {
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!
    const result = await tool.execute({
      operation: 'create',
      node: {
        type: 'user_preference',
        key: 'user_location',
        value: '厦门市',
        summary: '用户是厦门人，常住厦门，查询天气默认以厦门为准。',
      },
      reason: '用户表明自己是厦门人。',
    }, {
      sessionId: 's1',
      workspaceId: '/repo',
      userId: 'u1',
    })

    expect(result.ok).toBe(true)
    const memories = await service.search(
      { sessionId: 's1', workspaceId: '/repo', userId: 'u1' },
      { key: 'user_location', valueJson: '厦门市' },
    )
    expect(memories.exact).toMatchObject([{
      scope: 'workspace',
      type: 'preference',
      valueJson: '厦门市',
      title: 'user location: 厦门市',
      content: '用户是厦门人，常住厦门，查询天气默认以厦门为准。',
    }])
  })

  it('treats a targeted user correction as explicit intent when superseding memory', async () => {
    const identity = { sessionId: 's1', workspaceId: '/repo', userId: 'u1' }
    const original = await service.proposeUpdate({
      operation: 'create',
      explicitUserIntent: true,
      reason: 'The user explicitly asked to remember their location.',
      identity,
      node: {
        scope: 'user',
        type: 'fact',
        key: 'user_location',
        valueJson: '厦门市',
        title: '用户所在地',
        content: '用户常住厦门。',
      },
    })
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!

    const result = await tool.execute({
      operation: 'supersede',
      targetId: original.nodeId,
      node: {
        type: 'correction',
        title: '用户所在地更正：广西南宁',
        content: '用户是广西南宁人，常住南宁。',
        scope: 'user',
        key: 'user-location',
        importance: 0.9,
      },
      reason: '用户主动更正所在地为广西南宁。',
    }, identity)

    expect(result.ok).toBe(true)
    await expect(store.getNode(original.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    await expect(store.getNode((result.data as { nodeId: string }).nodeId)).resolves.toMatchObject({
      scope: 'user',
      type: 'correction',
      key: 'user_location',
      status: 'active',
    })
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

function memoryMessage(role: MemoryMessage['role'], content: string, id: string): MemoryMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
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
