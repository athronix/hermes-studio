import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowCreateInput,
  type WorkflowRecord,
  type WorkflowUpdateInput,
} from '../db/hermes/workflow-store'
import { getExactSessionDetailFromDbWithProfile } from '../db/hermes/sessions-db'
import {
  createWorkflowRun,
  createWorkflowRunEdgeEvaluation,
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  deleteWorkflowRunNodeSessions,
  getWorkflowRun,
  listWorkflowRunNodeSessions,
  listWorkflowRuns,
  updateWorkflowRun,
  updateWorkflowRunNodeSession,
  type WorkflowRunNodeSessionRecord,
  type WorkflowRunRecord,
} from '../db/hermes/workflow-run-store'
import { deleteSession, getSession, getSessionDetail } from '../db/hermes/session-store'
import { getChatRunServer } from '../routes/hermes/chat-run'
import type { ContentBlock } from './hermes/run-chat'
import type { AuthenticatedUser } from '../middleware/user-auth'
import { resolveWorkflowSkillContent } from './workflow-skill-resolver'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { deleteSessionForProfile } from './hermes/hermes-cli'
import { listProfileNamesFromDisk } from './hermes/hermes-profile'
import { logger } from './logger'

export type { WorkflowCreateInput, WorkflowRecord, WorkflowUpdateInput }

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled'
export type WorkflowRunType = 'workflow'
export type WorkflowNodeAgent = 'hermes' | 'claude-code' | 'codex'

export interface WorkflowNodeRunTarget {
  type: WorkflowRunType
  source: 'workflow'
  agent: 'hermes' | 'claude' | 'codex'
  codingAgentId?: 'claude-code' | 'codex'
}

export interface WorkflowRuntimeStatus {
  workflowId: string
  status: WorkflowRuntimeState
  runId: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
  nodeStatuses: Record<string, WorkflowRuntimeState>
}

export interface WorkflowRunNowInput {
  profile?: string | null
  startNodeIds?: string[]
  input?: string | null
  user?: AuthenticatedUser
  timeoutMs?: number
}

export interface WorkflowRerunFromNodeInput {
  profile?: string | null
  preserveStartNode?: boolean
  user?: AuthenticatedUser
  timeoutMs?: number
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
}

interface WorkflowNodeSnapshot {
  id: string
  type: string
  data: {
    title: string
    agent: string
    provider: string
    model: string
    apiMode: string
    input: string
    skills: string[]
    images: string[]
    approvalRequired: boolean
    orchestration: { join: 'all' | 'any' }
  }
}

type WorkflowEdgeRoute = 'success' | 'failure' | 'always'
type WorkflowConditionOperator =
  | 'exists' | 'not_exists'
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal'
  | 'in' | 'not_in'

interface WorkflowEdgeCondition {
  path: string
  operator: WorkflowConditionOperator
  value?: unknown
}

export const DEFAULT_WORKFLOW_LOOP_ITERATIONS = 3
export const MAX_WORKFLOW_LOOP_ITERATIONS = 100

interface WorkflowEdgeOrchestration {
  route: WorkflowEdgeRoute
  condition?: WorkflowEdgeCondition
  feedback?: { maxIterations: number }
}

interface WorkflowEdgeSnapshot {
  id?: string
  source: string
  target: string
  orchestration: WorkflowEdgeOrchestration
}

type WorkflowManagerEvents = {
  status: [WorkflowRuntimeStatus]
}

type WorkflowStatusListener = (status: WorkflowRuntimeStatus) => void

type PendingNodeApproval = {
  workflowId: string
  runId: string
  nodeId: string
  resolve: (approved: boolean) => void
}

function idleStatus(workflowId: string): WorkflowRuntimeStatus {
  return {
    workflowId,
    status: 'idle',
    runId: null,
    startedAt: null,
    updatedAt: Date.now(),
    completedAt: null,
    error: null,
    nodeStatuses: {},
  }
}

export function resolveWorkflowNodeRunTarget(agent?: string | null): WorkflowNodeRunTarget {
  if (agent === 'claude-code') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    }
  }
  if (agent === 'codex') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    }
  }
  return {
    type: 'workflow',
    source: 'workflow',
    agent: 'hermes',
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []
}

export function normalizeWorkflowNode(raw: unknown): WorkflowNodeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : ''
  if (!id) return null
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
  let join: 'all' | 'any' = 'all'
  if (Object.prototype.hasOwnProperty.call(data, 'orchestration')) {
    const orchestration = data.orchestration
    if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)
      || (orchestration.join !== 'all' && orchestration.join !== 'any')) {
      throw new Error(`workflow node ${id} has invalid orchestration join`)
    }
    join = orchestration.join
  }
  return {
    id,
    type: typeof record.type === 'string' && record.type ? record.type : 'agent',
    data: {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id,
      agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : 'hermes',
      provider: typeof data.provider === 'string' ? data.provider.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : '',
      apiMode: typeof data.apiMode === 'string' ? data.apiMode.trim() : '',
      input: typeof data.input === 'string' ? data.input : '',
      skills: stringArray(data.skills),
      images: stringArray(data.images),
      approvalRequired: data.approvalRequired === true,
      orchestration: { join },
    },
  }
}

export function workflowNodeRequiresApproval(node: { data?: { approvalRequired?: unknown } }): boolean {
  return node.data?.approvalRequired === true
}

function isUnfinishedWorkflowNodeStatus(status: WorkflowRuntimeState | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'pending_approval'
}

export type WorkflowConditionEvaluation =
  | { status: 'matched'; actual?: unknown; reason?: 'path_not_found' }
  | { status: 'not_matched'; actual?: unknown; reason?: 'path_not_found' | 'not_equal' }

const FORBIDDEN_WORKFLOW_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export function evaluateWorkflowEdgeCondition(
  condition: WorkflowEdgeCondition,
  context: unknown,
): WorkflowConditionEvaluation {
  const segments = condition.path.split('.')
  for (const segment of segments) {
    if (FORBIDDEN_WORKFLOW_PATH_SEGMENTS.has(segment)) {
      throw new Error(`workflow condition path contains forbidden segment: ${condition.path}`)
    }
  }

  let current: unknown = context
  for (const segment of segments) {
    if (!segment || (typeof current !== 'object' && typeof current !== 'function') || current === null) {
      return condition.operator === 'not_exists'
        ? { status: 'matched', reason: 'path_not_found' }
        : { status: 'not_matched', reason: 'path_not_found' }
    }
    const record = current as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return condition.operator === 'not_exists'
        ? { status: 'matched', reason: 'path_not_found' }
        : { status: 'not_matched', reason: 'path_not_found' }
    }
    current = record[segment]
  }

  const operator = condition.operator
  const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value')
  if (operator === 'exists') return { status: 'matched', actual: current }
  if (operator === 'not_exists') return { status: 'not_matched', actual: current }
  if (!hasValue) throw new Error(`workflow condition operator ${operator} requires value`)

  let matched: boolean
  switch (operator) {
    case 'equals': matched = Object.is(current, condition.value); break
    case 'not_equals': matched = !Object.is(current, condition.value); break
    case 'contains':
      matched = typeof current === 'string'
        ? typeof condition.value === 'string' && current.includes(condition.value)
        : Array.isArray(current) && current.some(item => Object.is(item, condition.value))
      break
    case 'not_contains':
      matched = typeof current === 'string'
        ? typeof condition.value === 'string' && !current.includes(condition.value)
        : Array.isArray(current) && !current.some(item => Object.is(item, condition.value))
      break
    case 'greater_than': matched = typeof current === 'number' && typeof condition.value === 'number' && current > condition.value; break
    case 'greater_than_or_equal': matched = typeof current === 'number' && typeof condition.value === 'number' && current >= condition.value; break
    case 'less_than': matched = typeof current === 'number' && typeof condition.value === 'number' && current < condition.value; break
    case 'less_than_or_equal': matched = typeof current === 'number' && typeof condition.value === 'number' && current <= condition.value; break
    case 'in': matched = Array.isArray(condition.value) && condition.value.some(item => Object.is(item, current)); break
    case 'not_in': matched = Array.isArray(condition.value) && !condition.value.some(item => Object.is(item, current)); break
    default: throw new Error(`unsupported workflow condition operator: ${operator}`)
  }
  return matched
    ? { status: 'matched', actual: current }
    : { status: 'not_matched', actual: current, reason: 'not_equal' }
}

export type WorkflowEdgeDecision =
  | { status: 'taken'; routeMatched: true; condition?: WorkflowConditionEvaluation }
  | { status: 'not_taken'; routeMatched: false; reason: 'route_not_matched' }
  | { status: 'not_taken'; routeMatched: true; reason: 'condition_not_matched'; condition: WorkflowConditionEvaluation }

export function evaluateWorkflowEdgeRoute(
  orchestration: WorkflowEdgeOrchestration,
  sourceOutcome: 'success' | 'failure',
  context: unknown,
): WorkflowEdgeDecision {
  const routeMatched = orchestration.route === 'always' || orchestration.route === sourceOutcome
  if (!routeMatched) return { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' }
  if (!orchestration.condition) return { status: 'taken', routeMatched: true }
  const condition = evaluateWorkflowEdgeCondition(orchestration.condition, context)
  return condition.status === 'matched'
    ? { status: 'taken', routeMatched: true, condition }
    : { status: 'not_taken', routeMatched: true, reason: 'condition_not_matched', condition }
}

export type WorkflowNodeJoinDecision = 'pending' | 'ready' | 'skipped'

export function evaluateWorkflowNodeJoin(
  join: 'all' | 'any',
  decisions: Array<WorkflowEdgeDecision | undefined>,
): WorkflowNodeJoinDecision {
  if (decisions.length === 0) return 'ready'
  if (join === 'any') {
    if (decisions.some(decision => decision?.status === 'taken')) return 'ready'
    return decisions.every(Boolean) ? 'skipped' : 'pending'
  }
  if (decisions.some(decision => decision?.status === 'not_taken')) return 'skipped'
  return decisions.every(decision => decision?.status === 'taken') ? 'ready' : 'pending'
}

export function normalizeWorkflowEdge(raw: unknown): WorkflowEdgeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const source = typeof record.source === 'string' && record.source.trim() ? record.source.trim() : ''
  const target = typeof record.target === 'string' && record.target.trim() ? record.target.trim() : ''
  if (!source || !target) return null

  const id = typeof record.id === 'string' ? record.id : undefined
  const edgeLabel = id || `${source}->${target}`
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : null
  const hasExplicitOrchestration = Boolean(data && Object.prototype.hasOwnProperty.call(data, 'orchestration'))
  if (!hasExplicitOrchestration) {
    return { id, source, target, orchestration: { route: 'success' } }
  }

  const rawOrchestration = data!.orchestration
  if (!rawOrchestration || typeof rawOrchestration !== 'object' || Array.isArray(rawOrchestration)) {
    throw new Error(`workflow edge ${edgeLabel} has invalid orchestration`)
  }
  const orchestrationRecord = rawOrchestration as Record<string, any>
  const route = orchestrationRecord.route
  if (route !== 'success' && route !== 'failure' && route !== 'always') {
    throw new Error(`workflow edge ${edgeLabel} has invalid orchestration route`)
  }

  const orchestration: WorkflowEdgeOrchestration = { route }
  if (Object.prototype.hasOwnProperty.call(orchestrationRecord, 'feedback')) {
    const rawFeedback = orchestrationRecord.feedback
    if (rawFeedback === true) {
      orchestration.feedback = { maxIterations: DEFAULT_WORKFLOW_LOOP_ITERATIONS }
    } else if (rawFeedback && typeof rawFeedback === 'object' && !Array.isArray(rawFeedback)) {
      const maxIterations = (rawFeedback as Record<string, unknown>).maxIterations
      if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > MAX_WORKFLOW_LOOP_ITERATIONS) {
        throw new Error(`workflow edge ${edgeLabel} has invalid feedback maxIterations`)
      }
      orchestration.feedback = { maxIterations: maxIterations as number }
    } else {
      throw new Error(`workflow edge ${edgeLabel} has invalid feedback`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(orchestrationRecord, 'condition')) {
    const rawCondition = orchestrationRecord.condition
    if (!rawCondition || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
      throw new Error(`workflow edge ${edgeLabel} has invalid condition`)
    }
    const conditionRecord = rawCondition as Record<string, any>
    const path = typeof conditionRecord.path === 'string' ? conditionRecord.path.trim() : ''
    const operator = conditionRecord.operator
    if (!path) throw new Error(`workflow edge ${edgeLabel} condition requires path`)
    const supportedOperators: WorkflowConditionOperator[] = [
      'exists', 'not_exists', 'equals', 'not_equals', 'contains', 'not_contains',
      'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'in', 'not_in',
    ]
    if (!supportedOperators.includes(operator)) throw new Error(`workflow edge ${edgeLabel} has invalid condition operator`)
    const hasValue = Object.prototype.hasOwnProperty.call(conditionRecord, 'value')
    if (operator !== 'exists' && operator !== 'not_exists' && !hasValue) {
      throw new Error(`workflow edge ${edgeLabel} condition operator ${operator} requires value`)
    }
    orchestration.condition = hasValue
      ? { path, operator, value: conditionRecord.value }
      : { path, operator }
  }

  return { id, source, target, orchestration }
}

export interface CompiledWorkflowLoop {
  id: string
  feedbackEdgeId: string
  headerNodeId: string
  latchNodeId: string
  bodyNodeIds: string[]
  maxIterations: number
  parentLoopId: string | null
}

export function compileWorkflowLoops(nodeIds: string[], edges: WorkflowEdgeSnapshot[]): CompiledWorkflowLoop[] {
  const nodeSet = new Set(nodeIds)
  const forwardEdges = edges.filter(edge => !edge.orchestration.feedback)
  const outgoing = new Map(nodeIds.map(id => [id, [] as string[]]))
  const incoming = new Map(nodeIds.map(id => [id, [] as string[]]))
  const indegree = new Map(nodeIds.map(id => [id, 0]))
  for (const edge of forwardEdges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
  }
  const queue = nodeIds.filter(id => indegree.get(id) === 0)
  const topological: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    topological.push(id)
    for (const target of outgoing.get(id) || []) {
      indegree.set(target, indegree.get(target)! - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  if (topological.length !== nodeIds.length) throw new Error('workflow forward graph must be acyclic')

  const walk = (starts: string[], adjacency: Map<string, string[]>): Set<string> => {
    const visited = new Set<string>()
    const stack = [...starts]
    while (stack.length) {
      const id = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const next of adjacency.get(id) || []) stack.push(next)
    }
    return visited
  }
  const starts = nodeIds.filter(id => (incoming.get(id) || []).length === 0)
  const dominators = new Map<string, Set<string>>()
  for (const id of topological) {
    const predecessors = incoming.get(id) || []
    if (starts.includes(id) || predecessors.length === 0) dominators.set(id, new Set([id]))
    else {
      const intersection = new Set(dominators.get(predecessors[0]) || [])
      for (const predecessor of predecessors.slice(1)) {
        const candidate = dominators.get(predecessor) || new Set<string>()
        for (const value of [...intersection]) if (!candidate.has(value)) intersection.delete(value)
      }
      intersection.add(id)
      dominators.set(id, intersection)
    }
  }

  return edges.filter(edge => edge.orchestration.feedback).map(edge => {
    const edgeId = edge.id || `${edge.source}->${edge.target}`
    const reachableFromHeader = walk([edge.target], outgoing)
    if (!reachableFromHeader.has(edge.source)) {
      throw new Error(`feedback edge ${edgeId} has no forward path from ${edge.target} to ${edge.source}`)
    }
    if (!dominators.get(edge.source)?.has(edge.target)) {
      throw new Error(`feedback edge ${edgeId} does not form a single-entry natural loop`)
    }
    const canReachLatch = walk([edge.source], incoming)
    const bodyNodeIds = nodeIds.filter(id => reachableFromHeader.has(id) && canReachLatch.has(id))
    return {
      id: `loop:${edgeId}`, feedbackEdgeId: edgeId, headerNodeId: edge.target, latchNodeId: edge.source,
      bodyNodeIds, maxIterations: edge.orchestration.feedback!.maxIterations, parentLoopId: null,
    }
  })
}

function imageMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

function lastAssistantOutput(sessionId: string, fallback?: string | null): string {
  const detail = getSessionDetail(sessionId)
  const messages = detail?.messages || []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && String(message.content || '').trim()) return String(message.content || '')
  }
  return String(fallback || '')
}

function isWorkflowCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  const agent = String(session?.agent || '').trim()
  return agent === 'claude' || agent === 'codex' || Boolean(session?.agent_session_id)
}

async function deleteHermesSessionIfPresent(sessionId: string, profile: string): Promise<void> {
  const targetProfile = profile || 'default'
  if (!listProfileNamesFromDisk().includes(targetProfile)) return
  try {
    const hermesSession = await getExactSessionDetailFromDbWithProfile(sessionId, targetProfile)
    if (!hermesSession) return
    const deleted = await deleteSessionForProfile(sessionId, targetProfile)
    if (!deleted) {
      logger.warn({ sessionId, profile: targetProfile }, '[workflow] failed to delete Hermes session for workflow run node')
    }
  } catch (err) {
    logger.warn({ err, sessionId, profile: targetProfile }, '[workflow] skipped Hermes session delete for workflow run node')
  }
}

function reachableFrom(startIds: string[], outgoing: Map<string, WorkflowEdgeSnapshot[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of outgoing.get(id) || []) stack.push(edge.target)
  }
  return visited
}

export class WorkflowManager extends EventEmitter<WorkflowManagerEvents> {
  private readonly runtimeStatuses = new Map<string, WorkflowRuntimeStatus>()
  private readonly canceledRunIds = new Set<string>()
  private readonly pendingNodeApprovals = new Map<string, PendingNodeApproval>()

  list(profile?: string | null): WorkflowRecord[] {
    return listWorkflows(profile)
  }

  get(id: string): WorkflowRecord | null {
    return getWorkflow(id)
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    return createWorkflow(input)
  }

  update(id: string, input: WorkflowUpdateInput): WorkflowRecord | null {
    return updateWorkflow(id, input)
  }

  async delete(id: string): Promise<boolean> {
    const workflow = getWorkflow(id)
    if (!workflow) return false
    const runs = listWorkflowRuns(id, 500)
    for (const run of runs) {
      await this.deleteRun(id, run.id)
    }
    const deleted = deleteWorkflow(id)
    if (deleted) this.runtimeStatuses.delete(id)
    return deleted
  }

  async stopRun(workflowId: string, runId: string, reason = 'Workflow run canceled'): Promise<WorkflowRunRecord | null> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return null
    this.canceledRunIds.add(runId)
    this.cancelPendingNodeApprovals(runId)
    const finishedAt = Date.now()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const session of nodeSessions) {
      const status = session.status === 'completed' || session.status === 'failed'
        ? session.status
        : 'canceled'
      nodeStatuses[session.node_id] = status
      if (status === 'canceled') {
        updateWorkflowRunNodeSession(session.id, {
          status: 'canceled',
          finished_at: finishedAt,
          error: reason,
        })
      }
      if (session.status === 'queued' || session.status === 'running') {
        await getChatRunServer()?.abortSession?.(session.session_id, reason)
      }
    }
    const stopped = updateWorkflowRun(runId, {
      status: 'canceled',
      finished_at: finishedAt,
      error: reason,
    }) || run
    this.setRuntimeStatus(workflowId, {
      status: 'canceled',
      runId,
      completedAt: finishedAt,
      error: reason,
      nodeStatuses,
    })
    return stopped
  }

  approveNode(workflowId: string, runId: string, nodeId: string, approved = true): boolean {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    const pending = this.pendingNodeApprovals.get(this.nodeApprovalKey(runId, nodeId))
    if (!pending || pending.workflowId !== workflowId || pending.nodeId !== nodeId) return false
    this.pendingNodeApprovals.delete(this.nodeApprovalKey(runId, nodeId))
    pending.resolve(approved)
    return true
  }

  async deleteRun(workflowId: string, runId: string): Promise<boolean> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    if (run.status === 'queued' || run.status === 'running') {
      await this.stopRun(workflowId, runId, 'Workflow run deleted')
    }
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const nodeSession of nodeSessions) {
      await this.deleteNodeSessionArtifacts(nodeSession.session_id, nodeSession.profile, nodeSession.agent)
    }
    this.canceledRunIds.delete(runId)
    return deleteWorkflowRun(runId)
  }

  private async deleteNodeSessionArtifacts(sessionId: string, profile: string, agent: string): Promise<void> {
    if (!sessionId) return
    const existing = getSession(sessionId)
    if (isWorkflowCodingAgentSession(existing)) {
      codingAgentRunManager.stop(sessionId, { reportClosed: false })
    } else if (agent === 'hermes') {
      await deleteHermesSessionIfPresent(sessionId, profile || existing?.profile || 'default')
    }
    if (existing) {
      deleteSession(sessionId)
    }
  }

  getRuntimeStatus(workflowId: string): WorkflowRuntimeStatus {
    return this.runtimeStatuses.get(workflowId) || idleStatus(workflowId)
  }

  listRuntimeStatuses(): WorkflowRuntimeStatus[] {
    return [...this.runtimeStatuses.values()]
  }

  setRuntimeStatus(
    workflowId: string,
    patch: Partial<Omit<WorkflowRuntimeStatus, 'workflowId' | 'updatedAt'>>,
  ): WorkflowRuntimeStatus {
    const previous = this.getRuntimeStatus(workflowId)
    const status: WorkflowRuntimeStatus = {
      ...previous,
      ...patch,
      nodeStatuses: patch.nodeStatuses || previous.nodeStatuses || {},
      workflowId,
      updatedAt: Date.now(),
    }
    this.runtimeStatuses.set(workflowId, status)
    this.emit('status', status)
    return status
  }

  onRuntimeStatus(listener: WorkflowStatusListener): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  private nodeApprovalKey(runId: string, nodeId: string): string {
    return `${runId}:${nodeId}`
  }

  private cancelPendingNodeApprovals(runId: string): void {
    for (const [key, pending] of this.pendingNodeApprovals) {
      if (pending.runId !== runId) continue
      this.pendingNodeApprovals.delete(key)
      pending.resolve(false)
    }
  }

  private async waitForNodeApproval(args: {
    workflowId: string
    runId: string
    node: WorkflowNodeSnapshot
    nodeStatuses: Record<string, WorkflowRuntimeState>
  }): Promise<boolean> {
    if (!workflowNodeRequiresApproval(args.node)) return true
    if (this.canceledRunIds.has(args.runId) || getWorkflowRun(args.runId)?.status === 'canceled') return false

    args.nodeStatuses[args.node.id] = 'pending_approval'
    this.setRuntimeStatus(args.workflowId, {
      status: 'running',
      runId: args.runId,
      nodeStatuses: { ...args.nodeStatuses },
    })

    let resolveApproval: (approved: boolean) => void = () => {}
    const approval = new Promise<boolean>((resolve) => {
      resolveApproval = resolve
    })
    const key = this.nodeApprovalKey(args.runId, args.node.id)
    this.pendingNodeApprovals.set(key, {
      workflowId: args.workflowId,
      runId: args.runId,
      nodeId: args.node.id,
      resolve: resolveApproval,
    })

    try {
      const approved = await approval
      return approved && !this.canceledRunIds.has(args.runId) && getWorkflowRun(args.runId)?.status !== 'canceled'
    } finally {
      this.pendingNodeApprovals.delete(key)
    }
  }

  async runNow(workflowId: string, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || workflow.profile || 'default'
    const nodes = workflow.nodes.map(normalizeWorkflowNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const edges = workflow.edges.map(normalizeWorkflowEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
    if (nodes.length === 0) {
      const err = new Error('workflow has no nodes')
      ;(err as any).status = 400
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) {
      incoming.set(node.id, [])
      outgoing.set(node.id, [])
    }
    for (const edge of edges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }
    const defaultStartIds = nodes.filter(node => (incoming.get(node.id) || []).length === 0).map(node => node.id)
    const requestedStartIds = (input.startNodeIds || []).filter(id => nodeById.has(id))
    const startNodeIds = requestedStartIds.length > 0 ? requestedStartIds : defaultStartIds
    if (startNodeIds.length === 0) {
      const err = new Error('workflow has no start nodes')
      ;(err as any).status = 400
      throw err
    }
    const activeIds = reachableFrom(startNodeIds, outgoing)
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const activeIncoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const activeOutgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of activeNodes) {
      activeIncoming.set(node.id, [])
      activeOutgoing.set(node.id, [])
    }
    for (const edge of activeEdges) {
      activeIncoming.get(edge.target)!.push(edge)
      activeOutgoing.get(edge.source)!.push(edge)
    }

    const startedAt = Date.now()
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile,
      workspace: workflow.workspace,
      start_node_ids: startNodeIds,
      status: 'running',
      snapshot_nodes: workflow.nodes,
      snapshot_edges: workflow.edges,
      started_at: startedAt,
    })
    this.canceledRunIds.delete(run.id)
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const])),
    })

    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const edgeDecisions = new Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>()
    const outputs = new Map<string, string>()
    const nodeSessionIds = new Map<string, string>()
    const nodeSessionRecordIds = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))
    let sequence = 0
    let edgeEvidenceSequence = 0
    const recordEdgeDecision = (
      edge: WorkflowEdgeSnapshot,
      sourceOutcome: 'success' | 'failure' | 'skipped',
      decision: WorkflowEdgeDecision,
    ) => {
      createWorkflowRunEdgeEvaluation({
        run_id: run.id,
        workflow_id: workflow.id,
        edge_id: edge.id || `${edge.source}->${edge.target}`,
        source_node_id: edge.source,
        target_node_id: edge.target,
        source_outcome: sourceOutcome,
        status: decision.status,
        route: edge.orchestration.route,
        reason: 'reason' in decision ? decision.reason : null,
        sequence: edgeEvidenceSequence++,
        orchestration: edge.orchestration,
        condition_evaluation: 'condition' in decision ? decision.condition : null,
      })
      edgeDecisions.set(edge, decision)
    }
    const inFlight = new Map<string, Promise<any>>()
    let firstNodeFailure: { node: WorkflowNodeSnapshot; error: string } | null = null

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || run
        this.setRuntimeStatus(workflow.id, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || run
      this.setRuntimeStatus(workflow.id, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        let propagatedSkip = true
        while (propagatedSkip) {
          propagatedSkip = false
          for (const node of activeNodes) {
            if (runningOrDone.has(node.id)) continue
            const dependencies = activeIncoming.get(node.id) || []
            const joinDecision = evaluateWorkflowNodeJoin(
              node.data.orchestration.join,
              dependencies.map(edge => edgeDecisions.get(edge)),
            )
            if (joinDecision === 'skipped') {
              runningOrDone.add(node.id)
              completed.add(node.id)
              nodeStatuses[node.id] = 'skipped'
              for (const edge of activeOutgoing.get(node.id) || []) {
                recordEdgeDecision(edge, 'skipped', { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' })
              }
              propagatedSkip = true
            }
          }
        }
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          const dependencies = activeIncoming.get(node.id) || []
          return evaluateWorkflowNodeJoin(
            node.data.orchestration.join,
            dependencies.map(edge => edgeDecisions.get(edge)),
          ) === 'ready'
        })
        if (ready.length === 0 && inFlight.size === 0) {
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        for (const node of ready) {
          const execution = (async () => {
          const nodeSessionId = randomUUID()
          nodeSessionIds.set(node.id, nodeSessionId)
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflow.id,
            node_id: node.id,
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : 'scoped',
            status: 'running',
            sequence: sequence++,
            started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const assembledInput = await this.buildNodeUserMessage({
            node,
            incomingEdges: activeIncoming.get(node.id) || [],
            nodeById,
            outputs,
            overrideInput: startNodeIds.includes(node.id) ? input.input : undefined,
            profile,
          })
          const runResult = await chatRun.runAndWait({
            session_id: nodeSessionId,
            source: 'workflow',
            session_source: 'workflow',
            input: assembledInput,
            profile,
            workspace: workflow.workspace,
            model: node.data.model || undefined,
            provider: node.data.provider || undefined,
            mode: node.data.agent === 'hermes' ? undefined : 'scoped',
            coding_agent_id: target.codingAgentId,
            agent_id: target.codingAgentId,
            apiMode: node.data.apiMode || undefined,
          }, {
            profile,
            user: input.user,
            timeoutMs: input.timeoutMs,
            approvalChoice: 'once',
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflow.id, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            completed.add(node.id)
            if (!firstNodeFailure) firstNodeFailure = { node, error }
            for (const edge of activeOutgoing.get(node.id) || []) {
              recordEdgeDecision(edge, 'failure', evaluateWorkflowEdgeRoute(edge.orchestration, 'failure', { error }))
            }
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, handledFailure: true, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          const approved = await this.waitForNodeApproval({
            workflowId: workflow.id,
            runId: run.id,
            node,
            nodeStatuses,
          })
          if (!approved) {
            const error = 'Workflow node approval rejected'
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'approval_rejected', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'approval_rejected'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              error,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, approvalRejected: true, error }
          }
          outputs.set(node.id, output)
          for (const edge of activeOutgoing.get(node.id) || []) {
            recordEdgeDecision(edge, 'success', evaluateWorkflowEdgeRoute(edge.orchestration, 'success', { output }))
          }
          completed.add(node.id)
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflow.id, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
          })()
          inFlight.set(node.id, execution)
        }
        if (inFlight.size === 0) continue
        const settled = await Promise.race(inFlight.values())
        inFlight.delete(settled.node.id)
        const results = [settled]

        const failed = results.find(result => !result.ok && !('handledFailure' in result && result.handledFailure))
        if (failed) {
          if ('approvalRejected' in failed && failed.approvalRejected && inFlight.size > 0) {
            await Promise.allSettled(inFlight.values())
            inFlight.clear()
          }
          for (const node of activeNodes) {
            if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('approvalRejected' in failed && failed.approvalRejected) {
            const message = `Node ${failed.node.data.title || failed.node.id} approval rejected`
            const failedRun = failRun(message)
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
      }

      if (firstNodeFailure) {
        const failure = firstNodeFailure as { node: WorkflowNodeSnapshot; error: string }
        const message = `Node ${failure.node.data.title || failure.node.id} failed: ${failure.error}`
        const failedRun = failRun(message)
        return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
      }
      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || run
      this.setRuntimeStatus(workflow.id, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [nodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(nodeId)) {
          nodeStatuses[nodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  async rerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) {
      const err = new Error('workflow run not found')
      ;(err as any).status = 404
      throw err
    }
    if (run.status === 'queued' || run.status === 'running') {
      const err = new Error('workflow run is still active')
      ;(err as any).status = 409
      throw err
    }

    const chatRun = getChatRunServer()
    if (!chatRun?.runAndWait) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || run.profile || workflow.profile || 'default'
    const nodes = run.snapshot_nodes.map(normalizeWorkflowNode).filter(Boolean) as WorkflowNodeSnapshot[]
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const targetNodeId = nodeId.trim()
    if (!targetNodeId || !nodeById.has(targetNodeId)) {
      const err = new Error('workflow node not found in run snapshot')
      ;(err as any).status = 404
      throw err
    }
    const edges = run.snapshot_edges.map(normalizeWorkflowEdge).filter((edge): edge is WorkflowEdgeSnapshot =>
      Boolean(edge && nodeById.has(edge.source) && nodeById.has(edge.target)),
    )
    if (nodes.length === 0) {
      const err = new Error('workflow run snapshot has no nodes')
      ;(err as any).status = 400
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) {
      incoming.set(node.id, [])
      outgoing.set(node.id, [])
    }
    for (const edge of edges) {
      incoming.get(edge.target)!.push(edge)
      outgoing.get(edge.source)!.push(edge)
    }

    const existingNodeSessions = listWorkflowRunNodeSessions(run.id)
    const existingSessionByNode = new Map(existingNodeSessions.map(session => [session.node_id, session]))
    const preserveStartNode = Boolean(input.preserveStartNode)
    if (preserveStartNode) {
      const startSession = existingSessionByNode.get(targetNodeId)
      if (!startSession || startSession.status !== 'completed') {
        const err = new Error('workflow node has no completed output to preserve')
        ;(err as any).status = 409
        throw err
      }
    }
    const downstreamStartIds = (outgoing.get(targetNodeId) || []).map(edge => edge.target)
    const activeIds = preserveStartNode
      ? reachableFrom(downstreamStartIds, outgoing)
      : reachableFrom([targetNodeId], outgoing)
    let expandedActiveIds = true
    while (expandedActiveIds) {
      expandedActiveIds = false
      for (const activeNodeId of [...activeIds]) {
        for (const edge of incoming.get(activeNodeId) || []) {
          if (activeIds.has(edge.source)) continue
          const upstreamSession = existingSessionByNode.get(edge.source)
          if (upstreamSession?.status === 'completed') continue
          activeIds.add(edge.source)
          expandedActiveIds = true
        }
      }
    }
    if (activeIds.size === 0) {
      const err = new Error('workflow node has no downstream nodes to rerun')
      ;(err as any).status = 400
      throw err
    }
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const outputs = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    for (const session of existingNodeSessions) {
      if (activeIds.has(session.node_id)) continue
      nodeStatuses[session.node_id] = session.status === 'blocked' ? 'failed' : session.status
      if (session.status === 'completed') {
        outputs.set(session.node_id, lastAssistantOutput(session.session_id))
      }
    }

    for (const node of activeNodes) {
      for (const edge of incoming.get(node.id) || []) {
        if (activeIds.has(edge.source)) continue
        const upstreamSession = existingSessionByNode.get(edge.source)
        if (!upstreamSession || upstreamSession.status !== 'completed') {
          const upstream = nodeById.get(edge.source)
          const err = new Error(`Upstream node ${upstream?.data.title || edge.source} has no completed output`)
          ;(err as any).status = 409
          throw err
        }
      }
    }

    for (const session of existingNodeSessions.filter(item => activeIds.has(item.node_id))) {
      await this.deleteNodeSessionArtifacts(session.session_id, session.profile, session.agent)
    }
    deleteWorkflowRunNodeSessions(run.id, [...activeIds])

    const startedAt = Date.now()
    const updatedRun = updateWorkflowRun(run.id, {
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      error: null,
    }) || run
    this.canceledRunIds.delete(run.id)
    for (const node of activeNodes) nodeStatuses[node.id] = 'queued'
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: { ...nodeStatuses },
    })

    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const nodeSessionRecordIds = new Map<string, string>()
    let sequence = existingNodeSessions
      .filter(session => !activeIds.has(session.node_id))
      .reduce((max, session) => Math.max(max, session.sequence), -1) + 1

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || updatedRun
        this.setRuntimeStatus(workflow.id, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          return (incoming.get(node.id) || []).every(edge => (
            activeIds.has(edge.source) ? completed.has(edge.source) : outputs.has(edge.source)
          ))
        })
        if (ready.length === 0) {
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflow.id, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        const results = await Promise.all(ready.map(async node => {
          const nodeSessionId = randomUUID()
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflow.id,
            node_id: node.id,
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : 'scoped',
            status: 'running',
            sequence: sequence++,
            started_at: Date.now(),
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const assembledInput = await this.buildNodeUserMessage({
            node,
            incomingEdges: incoming.get(node.id) || [],
            nodeById,
            outputs,
            profile,
          })
          const runResult = await chatRun.runAndWait({
            session_id: nodeSessionId,
            source: 'workflow',
            session_source: 'workflow',
            input: assembledInput,
            profile,
            workspace: run.workspace,
            model: node.data.model || undefined,
            provider: node.data.provider || undefined,
            mode: node.data.agent === 'hermes' ? undefined : 'scoped',
            coding_agent_id: target.codingAgentId,
            agent_id: target.codingAgentId,
            apiMode: node.data.apiMode || undefined,
          }, {
            profile,
            user: input.user,
            timeoutMs: input.timeoutMs,
            approvalChoice: 'once',
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflow.id, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          const approved = await this.waitForNodeApproval({
            workflowId: workflow.id,
            runId: run.id,
            node,
            nodeStatuses,
          })
          if (!approved) {
            const error = 'Workflow node approval rejected'
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'approval_rejected', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'approval_rejected'
            this.setRuntimeStatus(workflow.id, {
              status: 'running',
              runId: run.id,
              error,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, approvalRejected: true, error }
          }
          outputs.set(node.id, output)
          completed.add(node.id)
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflow.id, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
        }))

        const failed = results.find(result => !result.ok)
        if (failed) {
          for (const node of activeNodes) {
            if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('approvalRejected' in failed && failed.approvalRejected) {
            const message = `Node ${failed.node.data.title || failed.node.id} approval rejected`
            const failedRun = failRun(message)
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
      }

      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || updatedRun
      this.setRuntimeStatus(workflow.id, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [rerunNodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(rerunNodeId)) {
          nodeStatuses[rerunNodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  private async buildNodeUserMessage(args: {
    node: WorkflowNodeSnapshot
    incomingEdges: WorkflowEdgeSnapshot[]
    nodeById: Map<string, WorkflowNodeSnapshot>
    outputs: Map<string, string>
    overrideInput?: string | null
    profile: string
  }): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    if (args.incomingEdges.length > 0) {
      parts.push('[Workflow upstream results]')
      for (const edge of args.incomingEdges) {
        const upstream = args.nodeById.get(edge.source)
        parts.push(`\n[Upstream: ${upstream?.data.title || edge.source}]\n${args.outputs.get(edge.source) || ''}`)
      }
    }

    if (args.node.data.skills.length > 0) {
      parts.push('\n[Workflow selected skills]')
      for (const skillName of args.node.data.skills) {
        const skill = await resolveWorkflowSkillContent({
          agent: args.node.data.agent,
          profile: args.profile,
          skillName,
        })
        if (!skill) throw new Error(`Skill "${skillName}" not found for ${args.node.data.agent || 'hermes'}`)
        parts.push(`\n[Skill: ${skill.name}]\n${skill.content}`)
      }
    }

    const currentTask = args.overrideInput ?? args.node.data.input
    parts.push(`\n[Current task]\n${currentTask || 'Execute the current workflow node.'}`)
    const text = parts.join('\n').trim()
    if (args.node.data.images.length === 0) return text
    return [
      { type: 'text', text },
      ...args.node.data.images.map(path => ({
        type: 'image' as const,
        name: path.split(/[\\/]/).pop() || path,
        path,
        media_type: imageMediaType(path),
      })),
    ]
  }
}

let singleton: WorkflowManager | null = null

export function getWorkflowManager(): WorkflowManager {
  if (!singleton) singleton = new WorkflowManager()
  return singleton
}
