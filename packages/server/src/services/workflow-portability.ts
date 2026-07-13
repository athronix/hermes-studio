import { createHash, randomUUID } from 'crypto'
import type { WorkflowRecord } from '../db/hermes/workflow-store'

export const WORKFLOW_EXPORT_FORMAT = 'hermes-studio.workflow'
export const WORKFLOW_EXPORT_VERSION = 1
export const MAX_WORKFLOW_IMPORT_BYTES = 1024 * 1024
export const MAX_WORKFLOW_IMPORT_DEPTH = 20
export const MAX_WORKFLOW_IMPORT_NODES = 500
export const MAX_WORKFLOW_IMPORT_EDGES = 2000
const PREVIEW_TTL_MS = 5 * 60 * 1000
const CREDENTIAL_KEYS = new Set(['token', 'apikey', 'api_key', 'password', 'secret', 'authorization', 'cookie'])
const NODE_DATA_KEYS = ['title', 'agent', 'provider', 'model', 'apiMode', 'reasoningEffort', 'executionPolicy', 'input', 'skills', 'images', 'approvalRequired', 'orchestration']
const EDGE_KEYS = ['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'type', 'animated', 'markerEnd', 'style', 'data']
const EDGE_DATA_KEYS = ['orchestration']

type GraphValidator = (nodes: unknown[], edges: unknown[], starts?: string[]) => unknown
export interface WorkflowExportEnvelope { format: typeof WORKFLOW_EXPORT_FORMAT; version: 1; definition: { name: string; nodes: any[]; edges: any[]; viewport: Record<string, unknown> | null } }
export interface WorkflowImportOptions { ownerId: string; profile: string; now?: () => number; validateGraph: GraphValidator }
interface PendingPreview { ownerId: string; profile: string; digest: string; expiresAt: number; definition: WorkflowExportEnvelope['definition'] }
const pendingPreviews = new Map<string, PendingPreview>()

function cloneAllowed(record: Record<string, any>, keys: string[]): Record<string, any> {
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, structuredClone(record[key])]))
}
function exportNode(raw: any): any {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data : {}
  return { ...cloneAllowed(node, ['id', 'type', 'position']), data: cloneAllowed(data, NODE_DATA_KEYS) }
}
function exportEdge(raw: any): any {
  const edge = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const exported = cloneAllowed(edge, EDGE_KEYS)
  if (exported.data && typeof exported.data === 'object' && !Array.isArray(exported.data)) exported.data = cloneAllowed(exported.data, EDGE_DATA_KEYS)
  return exported
}
export function exportWorkflowDefinition(workflow: WorkflowRecord): WorkflowExportEnvelope {
  return { format: WORKFLOW_EXPORT_FORMAT, version: WORKFLOW_EXPORT_VERSION, definition: {
    name: workflow.name, nodes: workflow.nodes.map(exportNode), edges: workflow.edges.map(exportEdge),
    viewport: workflow.viewport ? structuredClone(workflow.viewport) : null,
  } }
}
function assertDepthAndCredentials(value: unknown, depth = 0): void {
  if (depth > MAX_WORKFLOW_IMPORT_DEPTH) throw new Error(`workflow import exceeds maximum depth ${MAX_WORKFLOW_IMPORT_DEPTH}`)
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) assertDepthAndCredentials(item, depth + 1); return }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) throw new Error(`workflow import contains credential field: ${key}`)
    assertDepthAndCredentials(child, depth + 1)
  }
}
function parseAndValidate(raw: string, validateGraph: GraphValidator): WorkflowExportEnvelope['definition'] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKFLOW_IMPORT_BYTES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_BYTES} bytes`)
  let envelope: any
  try { envelope = JSON.parse(raw) } catch { throw new Error('workflow import is not valid JSON') }
  assertDepthAndCredentials(envelope)
  if (!envelope || envelope.format !== WORKFLOW_EXPORT_FORMAT) throw new Error('unsupported workflow import format')
  if (envelope.version !== WORKFLOW_EXPORT_VERSION) throw new Error('unsupported workflow import version')
  const definition = envelope.definition
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('workflow import definition is required')
  if (typeof definition.name !== 'string' || !definition.name.trim()) throw new Error('workflow import name is required')
  if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error('workflow import nodes and edges must be arrays')
  if (definition.nodes.length > MAX_WORKFLOW_IMPORT_NODES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_NODES} nodes`)
  if (definition.edges.length > MAX_WORKFLOW_IMPORT_EDGES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_EDGES} edges`)
  for (const node of definition.nodes) if (!node || node.type !== 'agent') throw new Error('workflow import is Agent-only')
  validateGraph(definition.nodes, definition.edges)
  return { name: definition.name.trim(), nodes: definition.nodes.map(exportNode), edges: definition.edges.map(exportEdge), viewport: definition.viewport && typeof definition.viewport === 'object' && !Array.isArray(definition.viewport) ? structuredClone(definition.viewport) : null }
}
export function previewWorkflowImport(raw: string, options: WorkflowImportOptions) {
  const definition = parseAndValidate(raw, options.validateGraph)
  const digest = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  const token = randomUUID(), now = (options.now || Date.now)()
  pendingPreviews.set(token, { ownerId: options.ownerId, profile: options.profile, digest, expiresAt: now + PREVIEW_TTL_MS, definition })
  return { token, digest, expiresAt: now + PREVIEW_TTL_MS, summary: { name: definition.name, nodes: definition.nodes.length, edges: definition.edges.length } }
}
export function confirmWorkflowImport(token: string, options: WorkflowImportOptions) {
  const preview = pendingPreviews.get(token)
  if (!preview || preview.ownerId !== options.ownerId || preview.profile !== options.profile) throw new Error('workflow import preview is not available')
  if ((options.now || Date.now)() > preview.expiresAt) { pendingPreviews.delete(token); throw new Error('workflow import preview expired') }
  options.validateGraph(preview.definition.nodes, preview.definition.edges)
  const digest = createHash('sha256').update(JSON.stringify(preview.definition)).digest('hex')
  if (digest !== preview.digest) throw new Error('workflow import preview digest mismatch')
  pendingPreviews.delete(token)
  const nodeIds = new Map<string, string>()
  const nodes = preview.definition.nodes.map(node => { const id = randomUUID(); nodeIds.set(node.id, id); return { ...structuredClone(node), id } })
  const edges = preview.definition.edges.map(edge => ({ ...structuredClone(edge), id: randomUUID(), source: nodeIds.get(edge.source), target: nodeIds.get(edge.target) }))
  options.validateGraph(nodes, edges)
  return { name: preview.definition.name, profile: options.profile, nodes, edges, viewport: structuredClone(preview.definition.viewport) }
}
