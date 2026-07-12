import type { WorkflowRunRecord } from '@/api/hermes/workflows'

export type WorkflowEvidenceKind = 'node' | 'edge' | 'loop'
export interface WorkflowEvidenceRow {
  kind: WorkflowEvidenceKind
  sequence: number
  title: string
  status: string
  detail: string
  iterationPath: string
}

export function formatIterationPath(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '—'
  return raw.map(item => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const loopId = typeof value.loopId === 'string' ? value.loopId : '?'
    const iteration = Number.isInteger(value.iteration) ? Number(value.iteration) + 1 : '?'
    return `${loopId}#${iteration}`
  }).join(' / ')
}

export function buildWorkflowEvidenceRows(run: Pick<WorkflowRunRecord, 'node_sessions' | 'edge_evaluations' | 'loop_epochs'>): WorkflowEvidenceRow[] {
  const rows: WorkflowEvidenceRow[] = []
  for (const node of run.node_sessions || []) rows.push({
    kind: 'node', sequence: node.sequence, title: node.execution_id, status: node.status,
    detail: node.error || node.node_id, iterationPath: formatIterationPath(node.iteration_path),
  })
  for (const edge of run.edge_evaluations || []) rows.push({
    kind: 'edge', sequence: edge.sequence, title: edge.edge_id, status: edge.status,
    detail: `${edge.source_execution_id} → ${edge.target_node_id} · ${edge.route}${edge.reason ? ` · ${edge.reason}` : ''}`,
    iterationPath: formatIterationPath(edge.iteration_path),
  })
  for (const loop of run.loop_epochs || []) rows.push({
    kind: 'loop', sequence: loop.sequence, title: loop.loop_id, status: loop.status,
    detail: `#${loop.iteration + 1}${loop.exit_reason ? ` · ${loop.exit_reason}` : ''}`,
    iterationPath: formatIterationPath(loop.iteration_path),
  })
  return rows.sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
}
