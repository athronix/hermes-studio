import { describe, expect, it } from 'vitest'
import { compileWorkflowGraphPreflight } from '../../packages/server/src/services/workflow-manager'
import { exportWorkflowDefinition, previewWorkflowImport, confirmWorkflowImport } from '../../packages/server/src/services/workflow-portability'

const workflow = {
  id: 'wf-secret-id', name: 'Portable flow', profile: 'private-profile', workspace: '/private/workspace',
  nodes: [
    { id: 'source', type: 'agent', position: { x: 10, y: 20 }, data: { title: 'Source', agent: 'hermes', input: 'go', provider: 'openai', model: 'gpt-test', apiMode: 'chat_completions', token: 'secret' } },
    { id: 'target', type: 'agent', position: { x: 30, y: 40 }, data: { title: 'Target', agent: 'hermes', input: 'finish' } },
  ], edges: [{ id: 'edge-1', source: 'source', target: 'target', data: { orchestration: { route: 'success' } } }],
  viewport: { x: 1, y: 2, zoom: 1 }, created_at: 1, updated_at: 2,
}
const options = (ownerId = 'u1', profile = 'default', now = () => 1000) => ({ ownerId, profile, now, validateGraph: compileWorkflowGraphPreflight })

describe('workflow portability', () => {
  it('round-trips execution identity while excluding credential and runtime state', () => {
    const exported = exportWorkflowDefinition({
      id: 'wf', name: 'Portable identity', profile: 'private', workspace: '/private/path',
      nodes: [{ id: 'n', type: 'agent', position: { x: 0, y: 0 }, data: {
        title: 'N', agent: 'hermes', provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions',
        reasoningEffort: 'high', executionPolicy: { allowedToolsets: [], allowedTools: ['browser_click'], skipMemory: true },
        token: 'secret', session_id: 'runtime',
      } }], edges: [], viewport: null,
    } as any)
    expect(exported.definition.nodes[0].data).toEqual({
      title: 'N', agent: 'hermes', provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions',
      reasoningEffort: 'high', executionPolicy: { allowedToolsets: [], allowedTools: ['browser_click'], skipMemory: true },
    })
    expect(JSON.stringify(exported)).not.toContain('secret')
    expect(JSON.stringify(exported)).not.toContain('/private/path')
  })

  it('exports a versioned credential-free definition without runtime or machine state', () => {
    const envelope = exportWorkflowDefinition(workflow as any)
    expect(envelope).toEqual({ format: 'hermes-studio.workflow', version: 1, definition: {
      name: 'Portable flow', nodes: [
        { id: 'source', type: 'agent', position: { x: 10, y: 20 }, data: { title: 'Source', agent: 'hermes', input: 'go', provider: 'openai', model: 'gpt-test', apiMode: 'chat_completions' } },
        { id: 'target', type: 'agent', position: { x: 30, y: 40 }, data: { title: 'Target', agent: 'hermes', input: 'finish' } },
      ], edges: [{ id: 'edge-1', source: 'source', target: 'target', data: { orchestration: { route: 'success' } } }], viewport: { x: 1, y: 2, zoom: 1 },
    } })
    expect(JSON.stringify(envelope)).not.toMatch(/secret|workspace|private-profile|wf-secret-id|created_at|updated_at/i)
  })
  it('rejects oversized, unsupported, credential-bearing, and non-agent imports', () => {
    const valid = exportWorkflowDefinition(workflow as any)
    expect(() => previewWorkflowImport(JSON.stringify(valid), options())).not.toThrow()
    expect(() => previewWorkflowImport('x'.repeat(1024 * 1024 + 1), options())).toThrow('exceeds 1048576 bytes')
    expect(() => previewWorkflowImport(JSON.stringify({ ...valid, version: 2 }), options())).toThrow('unsupported workflow import version')
    const credential = structuredClone(valid) as any; credential.definition.nodes[0].data.apiKey = 'secret'
    expect(() => previewWorkflowImport(JSON.stringify(credential), options())).toThrow('credential field')
    const shell = structuredClone(valid) as any; shell.definition.nodes[0].type = 'shell'
    expect(() => previewWorkflowImport(JSON.stringify(shell), options())).toThrow('Agent-only')
  })
  it('binds confirmation and remaps all identities', () => {
    let now = 1000
    const preview = previewWorkflowImport(JSON.stringify(exportWorkflowDefinition(workflow as any)), options('u1', 'default', () => now))
    expect(() => confirmWorkflowImport(preview.token, options('u2', 'default', () => now))).toThrow('not available')
    expect(() => confirmWorkflowImport(preview.token, options('u1', 'other', () => now))).toThrow('not available')
    const imported = confirmWorkflowImport(preview.token, options('u1', 'default', () => now))
    expect(imported.nodes.map((node: any) => node.id)).not.toContain('source')
    expect(imported.edges[0].source).toBe(imported.nodes[0].id)
    expect(imported.edges[0].target).toBe(imported.nodes[1].id)
    expect(imported.edges[0].id).not.toBe('edge-1')
    expect(() => confirmWorkflowImport(preview.token, options('u1', 'default', () => now))).toThrow('not available')
    const expired = previewWorkflowImport(JSON.stringify(exportWorkflowDefinition(workflow as any)), options('u1', 'default', () => now))
    now += 5 * 60 * 1000 + 1
    expect(() => confirmWorkflowImport(expired.token, options('u1', 'default', () => now))).toThrow('expired')
  })
})
