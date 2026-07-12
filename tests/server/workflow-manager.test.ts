import { describe, expect, it, vi } from 'vitest'

const chatRunMock = vi.hoisted(() => ({
  runAndWait: vi.fn(),
  abortSession: vi.fn(),
}))

vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => chatRunMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/db/hermes/session-store')>()
  return {
    ...actual,
    getSession: vi.fn(() => null),
    getSessionDetail: vi.fn((sessionId: string) => ({
      messages: [{ role: 'assistant', content: `output:${sessionId}` }],
    })),
    deleteSession: vi.fn(),
  }
})

describe('workflow manager', () => {
  it('returns a server-wide singleton instance', async () => {
    const { WorkflowManager, getWorkflowManager } = await import('../../packages/server/src/services/workflow-manager')

    const first = getWorkflowManager()
    const second = getWorkflowManager()

    expect(first).toBe(second)
    expect(first).toBeInstanceOf(WorkflowManager)
  })

  it('stores and emits workflow runtime status updates', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    const updates: unknown[] = []
    const dispose = manager.onRuntimeStatus(status => updates.push(status))

    const status = manager.setRuntimeStatus('workflow-1', {
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
    })

    expect(status).toMatchObject({
      workflowId: 'workflow-1',
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
      completedAt: null,
      error: null,
    })
    expect(manager.getRuntimeStatus('workflow-1')).toBe(status)
    expect(manager.listRuntimeStatuses()).toEqual([status])
    expect(updates).toEqual([status])

    dispose()
    manager.setRuntimeStatus('workflow-1', { status: 'completed', completedAt: 456 })
    expect(updates).toEqual([status])
  })

  it('maps workflow node agents to the existing run backends', async () => {
    const { resolveWorkflowNodeRunTarget } = await import('../../packages/server/src/services/workflow-manager')

    expect(resolveWorkflowNodeRunTarget('hermes')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    })
    expect(resolveWorkflowNodeRunTarget('claude-code')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    })
    expect(resolveWorkflowNodeRunTarget('codex')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    expect(resolveWorkflowNodeRunTarget('unknown')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    })
  })

  it('requires workflow node approval only when explicitly enabled', async () => {
    const { workflowNodeRequiresApproval } = await import('../../packages/server/src/services/workflow-manager')

    expect(workflowNodeRequiresApproval({ data: { approvalRequired: true } })).toBe(true)
    expect(workflowNodeRequiresApproval({ data: { approvalRequired: false } })).toBe(false)
    expect(workflowNodeRequiresApproval({ data: {} })).toBe(false)
  })

  it('normalizes workflow node join mode and rejects malformed explicit values', async () => {
    const { normalizeWorkflowNode } = await import('../../packages/server/src/services/workflow-manager')
    expect(normalizeWorkflowNode({ id: 'legacy', type: 'agent', data: {} })?.data.orchestration).toEqual({ join: 'all' })
    expect(normalizeWorkflowNode({ id: 'any', type: 'agent', data: { orchestration: { join: 'any' } } })?.data.orchestration).toEqual({ join: 'any' })
    expect(() => normalizeWorkflowNode({ id: 'bad', type: 'agent', data: { orchestration: { join: 'some' } } })).toThrow('workflow node bad has invalid orchestration join')
  })

  it('distinguishes pending, ready, and skipped joins without treating unresolved edges as not taken', async () => {
    const { evaluateWorkflowNodeJoin } = await import('../../packages/server/src/services/workflow-manager')
    const taken = { status: 'taken', routeMatched: true } as const
    const notTaken = { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' } as const

    expect(evaluateWorkflowNodeJoin('all', [taken, undefined])).toBe('pending')
    expect(evaluateWorkflowNodeJoin('all', [taken, taken])).toBe('ready')
    expect(evaluateWorkflowNodeJoin('all', [taken, notTaken])).toBe('skipped')
    expect(evaluateWorkflowNodeJoin('any', [taken, undefined])).toBe('ready')
    expect(evaluateWorkflowNodeJoin('any', [notTaken, undefined])).toBe('pending')
    expect(evaluateWorkflowNodeJoin('any', [notTaken, notTaken])).toBe('skipped')
    expect(evaluateWorkflowNodeJoin('all', [])).toBe('ready')
  })

  it('normalizes legacy and declarative workflow edges without changing legacy semantics', async () => {
    const { normalizeWorkflowEdge } = await import('../../packages/server/src/services/workflow-manager')

    expect(normalizeWorkflowEdge({ id: 'legacy', source: 'first', target: 'second' })).toEqual({
      id: 'legacy', source: 'first', target: 'second', orchestration: { route: 'success' },
    })
    expect(normalizeWorkflowEdge({ id: 'conditional', source: 'first', target: 'second', data: { orchestration: { route: 'failure', condition: { path: 'output.status', operator: 'equals', value: 'RETRY' } } } })).toEqual({
      id: 'conditional', source: 'first', target: 'second', orchestration: { route: 'failure', condition: { path: 'output.status', operator: 'equals', value: 'RETRY' } },
    })
  })

  it('rejects malformed explicit workflow edge orchestration instead of falling back to legacy routing', async () => {
    const { normalizeWorkflowEdge } = await import('../../packages/server/src/services/workflow-manager')
    expect(() => normalizeWorkflowEdge({ id: 'invalid-route', source: 'first', target: 'second', data: { orchestration: { route: 'sometimes' } } })).toThrow('workflow edge invalid-route has invalid orchestration route')
    expect(() => normalizeWorkflowEdge({ id: 'missing-value', source: 'first', target: 'second', data: { orchestration: { route: 'success', condition: { path: 'output.status', operator: 'equals' } } } })).toThrow('workflow edge missing-value condition operator equals requires value')
  })

  it('evaluates equals conditions through own properties only', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/services/workflow-manager')

    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: { status: 'RETRY' } },
    )).toEqual({ status: 'matched', actual: 'RETRY' })
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: {} },
    )).toEqual({ status: 'not_matched', reason: 'path_not_found' })

    const inherited = Object.create({ status: 'RETRY' })
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: inherited },
    )).toEqual({ status: 'not_matched', reason: 'path_not_found' })
  })

  it('evaluates the supported declarative condition operators without coercing missing operands', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/services/workflow-manager')
    const evaluate = (operator: string, actual: unknown, value?: unknown) => evaluateWorkflowEdgeCondition(
      value === undefined
        ? { path: 'output.value', operator }
        : { path: 'output.value', operator, value },
      { output: { value: actual } },
    )

    expect(evaluate('not_equals', 'PASS', 'RETRY').status).toBe('matched')
    expect(evaluate('contains', 'build completed', 'complete').status).toBe('matched')
    expect(evaluate('not_contains', ['safe', 'read'], 'write').status).toBe('matched')
    expect(evaluate('greater_than', 4, 3).status).toBe('matched')
    expect(evaluate('greater_than_or_equal', 3, 3).status).toBe('matched')
    expect(evaluate('less_than', 2, 3).status).toBe('matched')
    expect(evaluate('less_than_or_equal', 3, 3).status).toBe('matched')
    expect(evaluate('in', 'PASS', ['PASS', 'BLOCKED']).status).toBe('matched')
    expect(evaluate('not_in', 'RETRY', ['PASS', 'BLOCKED']).status).toBe('matched')
    expect(evaluate('exists', null).status).toBe('matched')
    expect(evaluate('not_exists', null).status).toBe('not_matched')

    expect(() => evaluateWorkflowEdgeCondition(
      { path: 'output.value', operator: 'contains' } as any,
      { output: { value: 'anything' } },
    )).toThrow('workflow condition operator contains requires value')
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.missing', operator: 'not_exists' } as any,
      { output: {} },
    )).toEqual({ status: 'matched', reason: 'path_not_found' })
  })

  it('evaluates edge routes before conditions and returns auditable decisions', async () => {
    const { evaluateWorkflowEdgeRoute } = await import('../../packages/server/src/services/workflow-manager')
    const context = { output: { status: 'PASS' } }
    const condition = { path: 'output.status', operator: 'equals', value: 'PASS' } as const

    expect(evaluateWorkflowEdgeRoute({ route: 'success', condition }, 'success', context)).toMatchObject({ status: 'taken', routeMatched: true, condition: { status: 'matched' } })
    expect(evaluateWorkflowEdgeRoute({ route: 'success', condition }, 'failure', context)).toEqual({ status: 'not_taken', routeMatched: false, reason: 'route_not_matched' })
    expect(evaluateWorkflowEdgeRoute({ route: 'failure' }, 'failure', context)).toEqual({ status: 'taken', routeMatched: true })
    expect(evaluateWorkflowEdgeRoute({ route: 'always' }, 'failure', context)).toEqual({ status: 'taken', routeMatched: true })
    expect(evaluateWorkflowEdgeRoute({ route: 'always', condition: { ...condition, value: 'RETRY' } }, 'success', context)).toMatchObject({ status: 'not_taken', routeMatched: true, reason: 'condition_not_matched' })
  })

  it('rejects dangerous condition paths before evaluation', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/services/workflow-manager')

    for (const path of ['output.__proto__.polluted', 'output.prototype.value', 'output.constructor.name']) {
      expect(() => evaluateWorkflowEdgeCondition(
        { path, operator: 'equals', value: 'anything' },
        { output: {} },
      )).toThrow(`workflow condition path contains forbidden segment: ${path}`)
    }
  })

  it('runs only the matched success branch and skips the unmatched branch without creating a session', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'PASS' })
    const workflow = manager.create({
      name: `Conditional branch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'matched', type: 'agent', data: { title: 'Matched', agent: 'hermes', input: 'matched' } },
        { id: 'unmatched', type: 'agent', data: { title: 'Unmatched', agent: 'hermes', input: 'unmatched' } },
      ],
      edges: [
        { id: 'yes', source: 'source', target: 'matched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'exists' } } } },
        { id: 'no', source: 'source', target: 'unmatched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'RETRY' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(result.nodeSessions.map(session => session.node_id).sort()).toEqual(['matched', 'source'])
      const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).map(item => ({
        edge: item.edge_id, status: item.status, route: item.route, reason: item.reason,
        condition: item.condition_evaluation,
      }))).toEqual([
        { edge: 'yes', status: 'taken', route: 'success', reason: null, condition: { status: 'matched', actual: expect.any(String) } },
        { edge: 'no', status: 'not_taken', route: 'success', reason: 'condition_not_matched', condition: { status: 'not_matched', actual: expect.any(String), reason: 'not_equal' } },
      ])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({ source: 'completed', matched: 'completed', unmatched: 'skipped' })
    } finally { await manager.delete(workflow.id) }
  })

  it('runs an any-join once when at least one incoming edge is taken', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const workflow = manager.create({
      name: `Any join ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'left', type: 'agent', data: { title: 'Left', agent: 'hermes', input: 'left' } },
        { id: 'right', type: 'agent', data: { title: 'Right', agent: 'hermes', input: 'right' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'any' } } },
      ],
      edges: [
        { id: 'left-join', source: 'left', target: 'join', data: { orchestration: { route: 'success' } } },
        { id: 'right-join', source: 'right', target: 'join', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'never' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(result.nodeSessions.filter(session => session.node_id === 'join')).toHaveLength(1)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('completed')
    } finally { await manager.delete(workflow.id) }
  })

  it('starts an any-join after the first taken edge without waiting for another running source', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    initAllStores()
    const manager = new WorkflowManager()
    let releaseSlow!: () => void
    const slow = new Promise<{ ok: true; output: string }>(resolve => { releaseSlow = () => resolve({ ok: true, output: 'slow' }) })
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockImplementation(async (request: { input: string }) => {
      if (request.input.includes('slow')) return slow
      return { ok: true, output: 'done' }
    })
    const workflow = manager.create({
      name: `Completion driven ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'fast', type: 'agent', data: { title: 'Fast', agent: 'hermes', input: 'fast' } },
        { id: 'slow', type: 'agent', data: { title: 'Slow', agent: 'hermes', input: 'slow' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'any' } } },
      ],
      edges: [
        { id: 'fast-join', source: 'fast', target: 'join' },
        { id: 'slow-join', source: 'slow', target: 'join' },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.fast).toBe('completed'))
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.slow).toBe('running')
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('completed'))
      let settled = false
      void runPromise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseSlow()
      await expect(runPromise).resolves.toMatchObject({ run: { status: 'completed' } })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
    } finally { releaseSlow?.(); await manager.delete(workflow.id) }
  })

  it('runs failure and always branches after a failed node while skipping its success branch', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: false, error: 'source failed' })
      .mockResolvedValue({ ok: true, output: 'handled' })
    const workflow = manager.create({
      name: `Failure branch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'on-success', type: 'agent', data: { title: 'Success', agent: 'hermes', input: 'success' } },
        { id: 'on-failure', type: 'agent', data: { title: 'Failure', agent: 'hermes', input: 'failure' } },
        { id: 'always', type: 'agent', data: { title: 'Always', agent: 'hermes', input: 'always' } },
      ],
      edges: [
        { id: 'success', source: 'source', target: 'on-success', data: { orchestration: { route: 'success' } } },
        { id: 'failure', source: 'source', target: 'on-failure', data: { orchestration: { route: 'failure' } } },
        { id: 'always', source: 'source', target: 'always', data: { orchestration: { route: 'always' } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(result.nodeSessions.map(session => session.node_id).sort()).toEqual(['always', 'on-failure', 'source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({
        source: 'failed', 'on-success': 'skipped', 'on-failure': 'completed', always: 'completed',
      })
    } finally { await manager.delete(workflow.id) }
  })

  it('pauses downstream nodes until an approval-required node is approved', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Approval gate ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: {
            title: 'First',
            agent: 'hermes',
            input: 'first task',
            approvalRequired: true,
          },
        },
        {
          id: 'second',
          type: 'agent',
          data: {
            title: 'Second',
            agent: 'hermes',
            input: 'second task',
          },
        },
      ],
      edges: [{ id: 'first-second', source: 'first', target: 'second' }],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.first).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', true)).toBe(true)

      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.second).toBe('completed')
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('keeps parallel pending approvals open after one node is rejected', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Parallel approvals ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: { title: 'First', agent: 'hermes', input: 'first task', approvalRequired: true },
        },
        {
          id: 'second',
          type: 'agent',
          data: { title: 'Second', agent: 'hermes', input: 'second task', approvalRequired: true },
        },
        {
          id: 'join',
          type: 'agent',
          data: { title: 'Join', agent: 'hermes', input: 'join task' },
        },
      ],
      edges: [
        { id: 'first-join', source: 'first', target: 'join' },
        { id: 'second-join', source: 'second', target: 'join' },
      ],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('pending_approval')
        expect(statuses.second).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', false)).toBe(true)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('approval_rejected')
        expect(statuses.second).toBe('pending_approval')
      })

      expect(manager.approveNode(workflow.id, runId!, 'second', true)).toBe(true)
      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'failed' },
      })
      const finalStatuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
      expect(finalStatuses.first).toBe('approval_rejected')
      expect(finalStatuses.second).toBe('completed')
      expect(finalStatuses.join).toBe('canceled')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('fails closed before starting a target node when edge evidence persistence fails', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const { getDb } = await import('../../packages/server/src/db')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_workflow_edge_evidence BEFORE INSERT ON workflow_run_edge_evaluations BEGIN SELECT RAISE(ABORT, 'edge evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const workflow = manager.create({
      name: `Evidence failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'target', type: 'agent', data: { title: 'Target', agent: 'hermes', input: 'target' } },
      ], edges: [{ id: 'source-target', source: 'source', target: 'target' }],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('edge evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.target).toBe('canceled')
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_workflow_edge_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('stores edge evaluations append-only and deletes them atomically with the run', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const {
      createWorkflowRun, createWorkflowRunEdgeEvaluation, deleteWorkflowRun,
      listWorkflowRunEdgeEvaluations,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    initAllStores()
    const run = createWorkflowRun({ workflow_id: `evidence-${Date.now()}`, status: 'running' })
    createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, edge_id: 'edge-a', source_node_id: 'source',
      target_node_id: 'target', source_outcome: 'success', status: 'not_taken', route: 'success',
      reason: 'condition_not_matched', sequence: 2, orchestration: { route: 'success' },
      condition_evaluation: { status: 'not_matched', actual: 'RETRY', reason: 'not_equal' },
    })
    createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, edge_id: 'edge-b', source_node_id: 'source',
      target_node_id: 'other', source_outcome: 'success', status: 'taken', route: 'always',
      sequence: 1, orchestration: { route: 'always' }, condition_evaluation: null,
    })
    expect(listWorkflowRunEdgeEvaluations(run.id).map(item => [item.edge_id, item.sequence, item.status])).toEqual([
      ['edge-b', 1, 'taken'], ['edge-a', 2, 'not_taken'],
    ])
    expect(deleteWorkflowRun(run.id)).toBe(true)
    expect(listWorkflowRunEdgeEvaluations(run.id)).toEqual([])
  })

  it('reruns incomplete external upstream dependencies for downstream joins', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const snapshotNodes = [
      { id: 'entry-a', type: 'agent', data: { title: 'Entry A', agent: 'hermes', input: 'a' } },
      { id: 'entry-b', type: 'agent', data: { title: 'Entry B', agent: 'hermes', input: 'b' } },
      { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join' } },
    ]
    const snapshotEdges = [
      { id: 'entry-a-join', source: 'entry-a', target: 'join' },
      { id: 'entry-b-join', source: 'entry-b', target: 'join' },
    ]
    const workflow = manager.create({
      name: `Rerun dependencies ${Date.now()}`,
      profile: 'default',
      nodes: snapshotNodes,
      edges: snapshotEdges,
    })
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile: 'default',
      status: 'canceled',
      snapshot_nodes: snapshotNodes,
      snapshot_edges: snapshotEdges,
      started_at: Date.now(),
    })
    for (const [sequence, nodeId] of ['entry-a', 'entry-b', 'join'].entries()) {
      createWorkflowRunNodeSession({
        run_id: run.id,
        workflow_id: workflow.id,
        node_id: nodeId,
        session_id: `canceled-${nodeId}`,
        profile: 'default',
        agent: 'hermes',
        status: 'canceled',
        sequence,
        started_at: Date.now(),
        finished_at: Date.now(),
      })
    }

    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'entry-a')).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(listWorkflowRunNodeSessions(run.id).map(session => [session.node_id, session.status])).toEqual([
        ['entry-a', 'completed'],
        ['entry-b', 'completed'],
        ['join', 'completed'],
      ])
    } finally {
      await manager.delete(workflow.id)
    }
  })
})
