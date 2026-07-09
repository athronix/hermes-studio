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
})
