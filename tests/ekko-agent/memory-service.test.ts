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
  it('normalizes stable keys and stores long-term memory without a scope', async () => {
    expect(normalizeMemoryKey('avoid-food')).toBe('avoid_ingredient')
    const accepted = await service.proposeUpdate({
      operation: 'create',
      reason: 'durable preference',
      identity: { sessionId: 's1', userId: 'u1' },
      node: userPreference('tofu'),
    })
    expect(accepted.accepted).toBe(true)
    const exact = await service.search(
      { sessionId: 's1', userId: 'u1' },
      { key: 'avoid_ingredient', valueJson: 'tofu' },
    )
    expect(exact.exact).toMatchObject([{ valueJson: 'tofu' }])
  })

  it('prefers the newest long-term memory when stable keys conflict', () => {
    const nodes = [
      memoryNode('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      memoryNode('middle', { updatedAt: '2026-01-02T00:00:00.000Z' }),
      memoryNode('new', { updatedAt: '2026-01-03T00:00:00.000Z' }),
    ]
    const result = resolveMemoryQuery([], nodes, undefined, 10)
    expect(result.relevant.map(node => node.id)).toEqual(['new'])
    expect(result.omitted).toEqual(expect.arrayContaining([
      { nodeId: 'middle', reason: 'conflict_lost' },
      { nodeId: 'old', reason: 'conflict_lost' },
    ]))
  })

  it('keeps independent multi-value memories globally accessible', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        reason: 'explicit',
        identity: { sessionId: 's1', userId: 'u1' },
        node: userPreference(value),
      })
    }
    const result = await service.search({ sessionId: 's1', userId: 'u1' }, { key: 'avoid_ingredient', limit: 10 })
    const nodes = [...result.exact, ...result.relevant]
    expect(nodes.map(node => node.valueJson).sort()).toEqual(['芹菜', '香菜'])
    await expect(service.get(nodes[0].id, { sessionId: 'other', userId: 'u2' })).resolves.toMatchObject({ id: nodes[0].id })
  })

  it('promotes durable information and builds a plain temporary summary', async () => {
    const identity = { sessionId: 's1', workspaceId: '/repo', userId: 'u1' }
    service.scheduleRunCompletion(identity, [
      { role: 'user', content: '以后做饭少油少辣' },
      { role: 'assistant', content: '好的，已记住。' },
    ])
    await service.drain()

    const result = await service.search(identity, { key: 'flavor_profile' })
    expect([...result.exact, ...result.relevant]).toMatchObject([{
      valueJson: { oil: 'low', spicy: 'low' },
    }])
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({
      summary: 'User: 以后做饭少油少辣\nAssistant: 好的，已记住。',
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
            node: {
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
          summary: 'Configured TypeScript as the default for future code examples.',
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
      summary: 'Configured TypeScript as the default for future code examples.',
    })
    const memories = await service.search(
      { sessionId: 's1', workspaceId: '/repo', userId: 'u1' },
      { key: 'language_preference' },
    )
    expect([...memories.exact, ...memories.relevant]).toMatchObject([{
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
        summary: 'Weather lookup completed.',
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

  it('retries transient summary model failures before falling back', async () => {
    const client = modelClient()
    vi.mocked(client.create)
      .mockRejectedValueOnce(new Error('temporary capacity error'))
      .mockResolvedValueOnce({
        content: JSON.stringify({
          summary: '讨论记忆系统。',
        }),
      })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'retry-session',
      messages: [
        memoryMessage('user', '我们讨论一下记忆系统', 'm1'),
        memoryMessage('assistant', '好的。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      summaryPatch: '讨论记忆系统。',
    })
    expect(result.fallbackReason).toBeUndefined()
  })

  it('asks the summary model to repair malformed JSON before falling back', async () => {
    const client = modelClient()
    vi.mocked(client.create)
      .mockResolvedValueOnce({ content: 'I summarized the conversation.' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          summary: '讨论记忆系统。',
        }),
      })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'repair-session',
      messages: [
        memoryMessage('user', '我们讨论一下记忆系统', 'm1'),
        memoryMessage('assistant', '好的。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(2)
    const repairRequest = vi.mocked(client.create).mock.calls[1][0] as ModelRequest
    expect(repairRequest.toolChoice).toBe('none')
    expect(repairRequest.tools).toBeUndefined()
    expect(repairRequest.messages.some(message => message.content.includes('not valid JSON'))).toBe(true)
    expect(result.fallbackReason).toBeUndefined()
  })

  it('persists a compact safe summary and the failure reason after retries are exhausted', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockRejectedValue(new Error('summary provider unavailable'))
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'safe-fallback-session',
      messages: [
        memoryMessage('user', '是吗？那你觉得我要怎么做得更好', 'm1'),
        memoryMessage('assistant', '可以从产品定位和社区运营入手。', 'm2'),
      ],
    })

    expect(client.create).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({
      summaryPatch: 'Latest exchange completed. User: 是吗？那你觉得我要怎么做得更好',
      fallbackReason: 'summary provider unavailable',
    })
    expect(result.summaryPatch).not.toContain('Assistant:')
  })

  it('stores one unclassified temporary session summary', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        summary: 'Completed the hermes-web-ui project and GitHub review.',
      }),
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'summary-quality-session',
      messages: [
        memoryMessage('user', '你帮我看下桌面 git/hermes-web-ui 的项目', 'm1'),
        memoryMessage('assistant', '已经查看并介绍了项目。', 'm2'),
        memoryMessage('user', '分析下这个项目 GitHub 的数据', 'm3'),
        memoryMessage('assistant', '已经完成 GitHub 数据分析。', 'm4'),
        memoryMessage('user', '你也觉得很不错吗', 'm5'),
        memoryMessage('assistant', '是的，这个项目表现不错。', 'm6'),
      ],
    })

    expect(result).toMatchObject({
      summaryPatch: 'Completed the hermes-web-ui project and GitHub review.',
    })
    expect(result.summaryPatch).not.toContain('9K')
    expect(result.summaryPatch).not.toContain('v0.6.29')
  })

  it('accepts a plain temporary summary without category fields', async () => {
    const client = modelClient()
    vi.mocked(client.create).mockResolvedValueOnce({
      content: JSON.stringify({
        summary: '正在查看 hermes-web-ui 项目。',
      }),
    })
    const extractor = new ModelMemoryExtractor({ modelClient: client, memory: service })

    const result = await extractor.extract({
      sessionId: 'unsupported-claim-session',
      messages: [memoryMessage('user', '帮我看下 hermes-web-ui 项目', 'm1')],
    })

    expect(result.summaryPatch).toBe('正在查看 hermes-web-ui 项目。')
  })

  it('normalizes common value and summary aliases in memory update tool arguments', async () => {
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_propose_update')!
    const result = await tool.execute({
      operation: 'create',
      node: {
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
      valueJson: '厦门市',
      title: 'user location: 厦门市',
      content: '用户是厦门人，常住厦门，查询天气默认以厦门为准。',
    }])
  })

  it('supersedes a targeted long-term memory', async () => {
    const identity = { sessionId: 's1', workspaceId: '/repo', userId: 'u1' }
    const original = await service.proposeUpdate({
      operation: 'create',
      reason: 'The user explicitly asked to remember their location.',
      identity,
      node: {
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
        title: '用户所在地更正：广西南宁',
        content: '用户是广西南宁人，常住南宁。',
        key: 'user-location',
        importance: 0.9,
      },
      reason: '用户主动更正所在地为广西南宁。',
    }, identity)

    expect(result.ok).toBe(true)
    await expect(store.getNode(original.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    await expect(store.getNode((result.data as { nodeId: string }).nodeId)).resolves.toMatchObject({
      key: 'user_location',
      status: 'active',
    })
  })

  it('requires confirmation for broad or hard deletion', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.proposeUpdate({
        operation: 'create',
        reason: 'explicit',
        identity: { sessionId: 's1', userId: 'u1' },
        node: userPreference(value),
      })
    }
    await expect(service.forget({
      key: 'avoid_ingredient', reason: 'clear memories', identity: { sessionId: 's1', userId: 'u1' },
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
    key: 'avoid_food',
    valueJson: value,
    title: `Avoid ${value}`,
    content: `Avoid ${value} in recommendations.`,
  }
}

function memoryNode(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    key: 'avoid_ingredient',
    valueJson: '香菜',
    title: id,
    content: id,
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    sourceMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
