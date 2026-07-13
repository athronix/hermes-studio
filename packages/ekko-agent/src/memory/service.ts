import { createHash, randomUUID } from 'node:crypto'
import { buildMemoryContextPrompt } from './context'
import { RuleBasedMemoryExtractor } from './extraction'
import { resolveMemoryQuery } from './retrieval'
import { memoryConflictKey, normalizeMemoryNode } from './schema'
import { stableJson } from './store'
import type {
  MemoryAuditEvent,
  MemoryContext,
  MemoryExtraction,
  MemoryExtractor,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryMessage,
  MemoryMessageRole,
  MemoryNode,
  MemoryProposeUpdateInput,
  MemoryProposeUpdateResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRuntimeIdentity,
  MemoryStore,
  MemorySummary,
} from './types'

export interface MemoryServiceOptions {
  store?: MemoryStore
  extractor?: MemoryExtractor
  enabled?: boolean
  warning?: string
  recentMessageLimit?: number
  nodeLimit?: number
  reviewEveryUserMessages?: number
  /** @deprecated Use reviewEveryUserMessages. */
  summaryEveryMessages?: number
}

export interface MemoryCaptureMessage {
  id?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export class MemoryService {
  private readonly store?: MemoryStore
  private readonly extractor: MemoryExtractor
  private readonly enabled: boolean
  private readonly recentMessageLimit: number
  private readonly nodeLimit: number
  private readonly reviewEveryUserMessages: number
  private readonly warnings = new Set<string>()
  private extractionQueue: Promise<void> = Promise.resolve()

  constructor(options: MemoryServiceOptions = {}) {
    this.store = options.store
    this.extractor = options.extractor ?? new RuleBasedMemoryExtractor()
    this.enabled = options.enabled ?? Boolean(options.store)
    this.recentMessageLimit = options.recentMessageLimit ?? 6
    this.nodeLimit = options.nodeLimit ?? 12
    this.reviewEveryUserMessages = Math.max(
      1,
      Math.floor(options.reviewEveryUserMessages ?? options.summaryEveryMessages ?? 8),
    )
    if (options.warning) this.warnings.add(options.warning)
  }

  get isEnabled(): boolean {
    return this.enabled && Boolean(this.store)
  }

  async captureMessages(identity: MemoryRuntimeIdentity, messages: MemoryCaptureMessage[]): Promise<string[]> {
    if (!this.isEnabled || !this.store) return []
    const ids: string[] = []
    try {
      let parentId: string | undefined
      const occurrences = new Map<string, number>()
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        const signature = messageSignature(message)
        const occurrence = occurrences.get(signature) || 0
        occurrences.set(signature, occurrence + 1)
        const id = message.id || deterministicMessageId(identity.sessionId, occurrence, message)
        await this.store.appendMessage({
          id,
          sessionId: identity.sessionId,
          parentId,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
          createdAt: message.createdAt || new Date().toISOString(),
        })
        ids.push(id)
        parentId = id
      }
    } catch (error) {
      this.recordWarning(error)
    }
    return ids
  }

  async retrieve(
    identity: MemoryRuntimeIdentity,
    queryText?: string,
    overrides: Partial<MemoryQuery> = {},
  ): Promise<MemoryContext> {
    if (!this.isEnabled || !this.store) return this.disabledContext()
    try {
      const baseQuery = { ...overrides }
      const [latestSummary, recentMessages, relevantCandidates] = await Promise.all([
        this.store.getLatestSummary({ sessionId: identity.sessionId }),
        this.store.listRecentMessages({ sessionId: identity.sessionId, limit: this.recentMessageLimit }),
        this.store.queryNodes({ ...baseQuery, limit: 100 }),
      ])
      const exactCandidates = overrides.key || overrides.valueJson !== undefined
        ? await this.store.queryNodes({ ...baseQuery, queryText: undefined, limit: 100 })
        : []
      const result = resolveMemoryQuery(
        exactCandidates,
        relevantCandidates,
        queryText || overrides.queryText,
        overrides.limit ?? this.nodeLimit,
      )
      const nodes = [...result.exact, ...result.relevant]
      return {
        latestSummary,
        recentMessages,
        relevantNodes: nodes,
        usedMemoryIds: nodes.map(node => node.id),
        diagnostics: {
          enabled: true,
          storeStatus: this.warnings.size ? 'degraded' : 'ok',
          warnings: [...this.warnings],
          retrievedNodeCount: nodes.length,
          omittedNodeCount: result.omitted.length,
        },
      }
    } catch (error) {
      this.recordWarning(error)
      return this.degradedContext()
    }
  }

  async search(identity: MemoryRuntimeIdentity, query: MemoryQuery): Promise<MemoryQueryResult> {
    if (!this.isEnabled || !this.store) return { exact: [], relevant: [], omitted: [] }
    void identity
    const candidates = await this.store.queryNodes({ ...query, queryText: undefined, limit: 150 })
    const exactCandidates = query.key || query.valueJson !== undefined ? candidates : []
    return resolveMemoryQuery(exactCandidates, candidates, query.queryText, query.limit ?? this.nodeLimit)
  }

  async get(id: string, identity?: Partial<MemoryRuntimeIdentity>): Promise<MemoryNode | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    void identity
    return this.store.getNode(id)
  }

  async proposeUpdate(input: MemoryProposeUpdateInput): Promise<MemoryProposeUpdateResult> {
    if (!this.isEnabled || !this.store) return { accepted: false, reason: 'Memory store is disabled.' }
    const actor = input.actor || 'ekko-agent'
    if (input.operation === 'expire') {
      if (!input.targetId) return { accepted: false, reason: 'expire requires targetId.' }
      if (!await this.get(input.targetId, input.identity)) return { accepted: false, reason: 'Memory node not found.' }
      const changed = await this.store.updateNodeStatus({
        nodeId: input.targetId,
        status: 'expired',
        reason: input.reason,
        actor,
      })
      return changed ? { accepted: true, nodeId: input.targetId } : { accepted: false, reason: 'Memory node not found.' }
    }
    if (input.operation === 'delete') {
      if (!input.targetId) return { accepted: false, reason: 'delete requires targetId.' }
      if (!await this.get(input.targetId, input.identity)) return { accepted: false, reason: 'Memory node not found.' }
      const changed = await this.store.deleteNode({ nodeId: input.targetId, mode: 'soft', reason: input.reason, actor })
      return changed ? { accepted: true, nodeId: input.targetId } : { accepted: false, reason: 'Memory node not found.' }
    }
    const normalized = normalizeMemoryNode({
      draft: input.node,
    })
    if (!normalized.accepted) return normalized
    const now = new Date().toISOString()
    const node: MemoryNode = { id: randomUUID(), ...normalized.node, updatedAt: now }

    const candidates = node.key
      ? await this.store.queryNodes({
          key: node.key,
          includeExpired: false,
          limit: 20,
        })
      : []
    const conflictingCandidates = candidates.filter(candidate => memoryConflictKey(candidate) === memoryConflictKey(node))
    const exactExisting = conflictingCandidates.find(candidate => stableJson(candidate.valueJson) === stableJson(node.valueJson))
    if (input.operation === 'create' && exactExisting) return { accepted: true, nodeId: exactExisting.id }

    let targetId = input.targetId
    if (!targetId && (input.operation === 'update' || input.operation === 'supersede')) {
      if (conflictingCandidates.length !== 1) {
        return {
          accepted: false,
          reason: conflictingCandidates.length ? 'Memory update matched multiple active nodes.' : 'Memory update target was not found.',
        }
      }
      targetId = conflictingCandidates[0].id
    }
    if (!targetId && input.operation === 'create' && conflictingCandidates.length) {
      return { accepted: false, reason: 'Conflicting long-term memory requires an explicit supersede operation.' }
    }

    if (targetId) {
      const target = await this.get(targetId, input.identity)
      if (!target) return { accepted: false, reason: 'Memory node not found.' }
      if (memoryConflictKey(node) && memoryConflictKey(target) !== memoryConflictKey(node)) {
        return { accepted: false, reason: 'Memory update target does not match the proposed memory key.' }
      }
      node.parentId = targetId
      node.supersedesId = targetId
      await this.store.supersedeNode({ oldNodeId: targetId, newNode: node, reason: input.reason, actor })
      return { accepted: true, nodeId: node.id }
    }

    await this.store.upsertNode(node, {
      eventType: 'create',
      sessionId: input.identity?.sessionId,
      workspaceId: input.identity?.workspaceId,
      userId: input.identity?.userId,
      actor,
      reason: input.reason,
      payload: { key: node.key },
    })
    return { accepted: true, nodeId: node.id }
  }

  async forget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
    const mode = input.mode || 'soft'
    if (!this.isEnabled || !this.store) {
      return { deletedIds: [], mode, reason: 'Memory store is disabled.' }
    }
    if (!input.id && !input.key && input.valueJson === undefined) {
      return { deletedIds: [], mode, reason: 'A memory selector is required.' }
    }
    const candidates = input.id
      ? [await this.get(input.id, input.identity)].filter((node): node is MemoryNode => Boolean(node))
      : await this.store.queryNodes({
          key: input.key,
          valueJson: input.valueJson,
          includeExpired: true,
          limit: 100,
        })
    if (!candidates.length) return { deletedIds: [], mode, reason: 'No matching memory was found.' }
    if ((!input.confirmed && candidates.length > 1) || (mode === 'hard' && !input.confirmed)) {
      return {
        deletedIds: [],
        mode,
        requiresConfirmation: true,
        reason: mode === 'hard' ? 'Hard delete requires confirmation.' : 'Multiple memories matched; confirmation is required.',
      }
    }
    const deletedIds: string[] = []
    for (const node of candidates) {
      const deleted = await this.store.deleteNode({
        nodeId: node.id,
        mode,
        reason: input.reason,
        actor: input.actor || 'ekko-agent',
      })
      if (deleted) deletedIds.push(node.id)
    }
    return { deletedIds, mode }
  }

  scheduleExtraction(identity: MemoryRuntimeIdentity): void {
    if (!this.isEnabled || !this.store) return
    this.extractionQueue = this.extractionQueue
      .then(() => this.extractAndPersist(identity, this.extractor, true))
      .catch(error => this.recordWarning(error))
  }

  scheduleRunCompletion(
    identity: MemoryRuntimeIdentity,
    messages: MemoryCaptureMessage[],
    extractor: MemoryExtractor = this.extractor,
  ): void {
    if (!this.isEnabled || !this.store) return
    this.extractionQueue = this.extractionQueue
      .then(async () => {
        await this.captureMessages(identity, messages)
        await this.extractAndPersist(identity, extractor)
      })
      .catch(error => this.recordWarning(error))
  }

  async drain(): Promise<void> {
    await this.extractionQueue
  }

  close(): void {
    this.store?.close()
  }

  contextPrompt(context: MemoryContext): string {
    return buildMemoryContextPrompt(context)
  }

  private async extractAndPersist(
    identity: MemoryRuntimeIdentity,
    extractor: MemoryExtractor = this.extractor,
    forceReview = false,
  ): Promise<void> {
    if (!this.store) return
    const state = await this.store.getSessionState(identity.sessionId)
    const messages = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastExtractedMessageId,
      limit: 100,
    })
    if (!messages.length) return
    const newUserMessageCount = messages.filter(message => message.role === 'user').length
    if (!forceReview && newUserMessageCount < this.reviewEveryUserMessages) return

    const previousSummary = await this.store.getLatestSummary({ sessionId: identity.sessionId })
    const extraction = await extractor.extract({ ...identity, previousSummary, messages })
    for (const operation of extraction.nodes) {
      if (operation.operation === 'ignore') continue
      await this.proposeUpdate({
        operation: operation.operation,
        targetId: operation.targetId,
        node: {
          ...operation.node,
          sourceMessageIds: operation.node.sourceMessageIds?.length
            ? operation.node.sourceMessageIds
            : messages.map(message => message.id),
        },
        reason: operation.reason,
        actor: 'memory-extractor',
        identity,
      })
    }

    const sinceSummary = await this.store.listMessagesAfter({
      sessionId: identity.sessionId,
      messageId: state?.lastSummaryMessageId,
      limit: 500,
    })
    let lastSummaryMessageId = state?.lastSummaryMessageId
    if (extraction.summaryPatch) {
      const summary = buildSummary(identity.sessionId, previousSummary, sinceSummary, extraction)
      await this.store.appendSummary(summary)
      await this.store.appendAuditEvent({
        id: randomUUID(),
        eventType: 'summary',
        sessionId: identity.sessionId,
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        actor: 'memory-extractor',
        reason: extraction.fallbackReason ? 'Periodic chained summary (safe fallback)' : 'Periodic chained summary',
        payload: {
          summaryId: summary.id,
          fromMessageId: summary.fromMessageId,
          toMessageId: summary.toMessageId,
          ...(extraction.fallbackReason ? { fallbackReason: extraction.fallbackReason } : {}),
        },
        createdAt: summary.createdAt,
      })
      lastSummaryMessageId = sinceSummary.at(-1)?.id
    }
    const lastExtractedMessageId = messages.at(-1)?.id
    await this.store.setSessionState({
      sessionId: identity.sessionId,
      lastExtractedMessageId,
      lastSummaryMessageId,
      updatedAt: new Date().toISOString(),
    })
    await this.store.appendAuditEvent({
      id: randomUUID(),
      eventType: 'extract',
      sessionId: identity.sessionId,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      actor: 'memory-extractor',
      reason: extraction.fallbackReason
        ? 'Processed new conversation messages using safe fallback'
        : 'Processed new conversation messages',
      payload: {
        fromMessageId: messages[0].id,
        toMessageId: lastExtractedMessageId,
        operations: extraction.nodes.length,
        ...(extraction.fallbackReason ? { fallbackReason: extraction.fallbackReason } : {}),
      },
      createdAt: new Date().toISOString(),
    })
  }

  private disabledContext(): MemoryContext {
    return emptyContext({
      enabled: false,
      storeStatus: 'disabled',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private degradedContext(): MemoryContext {
    return emptyContext({
      enabled: true,
      storeStatus: 'degraded',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private recordWarning(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.warnings.add(message)
  }
}

function deterministicMessageId(sessionId: string, occurrence: number, message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(occurrence))
    .update('\0')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

function messageSignature(message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

function buildSummary(
  sessionId: string,
  previous: MemorySummary | undefined,
  messages: MemoryMessage[],
  extraction: MemoryExtraction,
): MemorySummary {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    sessionId,
    parentSummaryId: previous?.id,
    fromMessageId: messages[0].id,
    toMessageId: messages.at(-1)!.id,
    summary: extraction.summaryPatch!,
    createdAt: now,
  }
}

function emptyContext(diagnostics: MemoryContext['diagnostics']): MemoryContext {
  return {
    recentMessages: [],
    relevantNodes: [],
    usedMemoryIds: [],
    diagnostics,
  }
}
