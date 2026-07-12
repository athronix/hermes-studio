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

  it('rejects dangerous condition paths before evaluation', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/services/workflow-manager')

    for (const path of ['output.__proto__.polluted', 'output.prototype.value', 'output.constructor.name']) {
      expect(() => evaluateWorkflowEdgeCondition(
        { path, operator: 'equals', value: 'anything' },
        { output: {} },
      )).toThrow(`workflow condition path contains forbidden segment: ${path}`)
    }
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
