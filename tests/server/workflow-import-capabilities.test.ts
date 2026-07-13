import { describe, expect, it } from 'vitest'
import { assertWorkflowImportCapabilities, assertWorkflowImportToolCapabilities, workflowImportEnvironmentRevision, workflowImportRequestedToolsetGroups } from '../../packages/server/src/services/workflow-import-capabilities'

const node = (data: Record<string, unknown>) => ({ id: 'agent', type: 'agent', data: { agent: 'hermes', ...data } })

describe('workflow import capabilities', () => {
  it('requires an exact configured provider, model, and api mode tuple', () => {
    const groups = [{ provider: 'custom:test', models: ['model-a'], api_mode: 'codex_responses' }]
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' })], groups)).not.toThrow()
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-b', apiMode: 'codex_responses' })], groups)).toThrow('unavailable')
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions' })], groups)).toThrow('unavailable')
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions' })], [{ provider: 'custom:test', models: ['model-a'] }])).toThrow('unavailable')
  })

  it('allows runtime-default nodes and revisions change with any target capability', () => {
    expect(() => assertWorkflowImportCapabilities([node({})], [])).not.toThrow()
    const one = workflowImportEnvironmentRevision([{ provider: 'p', models: ['a'], api_mode: 'chat_completions' }])
    const reordered = workflowImportEnvironmentRevision([{ provider: 'p', models: ['a'], api_mode: 'chat_completions' }])
    const changed = workflowImportEnvironmentRevision([{ provider: 'p', models: ['b'], api_mode: 'chat_completions' }])
    expect(one).toBe(reordered)
    expect(changed).not.toBe(one)
  })

  it('binds execution policies to the exact requested toolset snapshot and required tools', () => {
    const policies = [
      node({ executionPolicy: { allowedTools: ['terminal'] } }),
      node({ executionPolicy: { allowedToolsets: ['web', 'terminal'], allowedTools: ['browser'] } }),
    ]
    expect(workflowImportRequestedToolsetGroups(policies)).toEqual([null, ['terminal', 'web']])
    const groups = [
      { toolsets: null, tool_names: ['terminal', 'read_file'] },
      { toolsets: ['terminal', 'web'], tool_names: ['browser', 'terminal'] },
    ]
    expect(() => assertWorkflowImportToolCapabilities(policies, groups)).not.toThrow()
    expect(() => assertWorkflowImportToolCapabilities(
      [node({ executionPolicy: { allowedTools: ['missing-tool'] } })], groups,
    )).toThrow('tool capability is unavailable')
    expect(() => assertWorkflowImportToolCapabilities(
      [node({ executionPolicy: { allowedToolsets: ['unknown'] } })], groups,
    )).toThrow('toolset capability is unavailable')
  })

  it('includes resolved tool capability changes in the environment revision without exposing credentials', () => {
    const models = [{ provider: 'p', models: ['m'], api_mode: 'chat_completions' }]
    const first = workflowImportEnvironmentRevision(models, [{ toolsets: null, tool_names: ['terminal'] }])
    const reordered = workflowImportEnvironmentRevision(models, [{ toolsets: null, tool_names: ['terminal'] }])
    const changed = workflowImportEnvironmentRevision(models, [{ toolsets: null, tool_names: ['terminal', 'browser'] }])
    expect(first).toBe(reordered)
    expect(changed).not.toBe(first)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('terminal')
  })

})
