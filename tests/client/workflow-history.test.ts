import { describe, expect, it } from 'vitest'
import { buildWorkflowEvidenceRows, formatIterationPath } from '../../packages/client/src/utils/workflow-history'

const path = [{ loopId: 'outer', iteration: 1 }, { loopId: 'inner', iteration: 2 }]

describe('workflow history evidence', () => {
  it('formats canonical nested iteration paths without losing hierarchy', () => {
    expect(formatIterationPath(path)).toBe('outer#2 / inner#3')
    expect(formatIterationPath([])).toBe('—')
  })

  it('merges node, edge, and loop evidence in deterministic sequence order', () => {
    const rows = buildWorkflowEvidenceRows({
      node_sessions: [{ execution_id: 'agent@2', node_id: 'agent', status: 'completed', sequence: 3, iteration_path: path }],
      edge_evaluations: [{ edge_id: 'retry', status: 'taken', reason: 'condition_matched', source_node_id: 'agent', target_node_id: 'agent', source_execution_id: 'agent@2', route: 'success', source_outcome: 'success', sequence: 2, iteration_path: path }],
      loop_epochs: [{ loop_id: 'loop:retry', iteration: 1, status: 'completed', exit_reason: 'feedback_taken', sequence: 1, iteration_path: path }],
    } as any)
    expect(rows.map(row => `${row.kind}:${row.sequence}:${row.title}`)).toEqual([
      'loop:1:loop:retry',
      'edge:2:retry',
      'node:3:agent@2',
    ])
    expect(rows.every(row => row.iterationPath === 'outer#2 / inner#3')).toBe(true)
  })
})
