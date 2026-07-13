import { readFile } from 'fs/promises'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('workflow canvas exposes orchestration editing and portability controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: '', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Agent B', agent: 'hermes', input: '', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [{ id: 'a-b', source: 'a', target: 'b', type: 'smoothstep' }]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-1', name: 'Loop workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowImportDocument: { name: 'Imported flow', nodes: [{ id: 'imported', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'Imported', agent: 'hermes' } }], edges: [], viewport: null }, workflowRuns: [{
    id: 'run-1', workflow_id: 'wf-1', profile: 'research', workspace: null, start_node_ids: [], status: 'completed',
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [{ id: 'node-1', run_id: 'run-1', workflow_id: 'wf-1', node_id: 'a', execution_id: 'rerun:2:a', iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 1 }], consumed_edge_evaluation_ids: [], session_id: 'session-a', profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 3, started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null }],
    edge_evaluations: [{ id: 'edge-1', run_id: 'run-1', workflow_id: 'wf-1', edge_id: 'a-b', source_node_id: 'a', source_execution_id: 'rerun:2:a', iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 1 }], target_node_id: 'b', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 4, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 2 }],
    loop_epochs: [{ id: 'loop-1', run_id: 'run-1', workflow_id: 'wf-1', loop_id: 'loop:a', iteration: 1, iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 1 }], status: 'completed', exit_reason: 'feedback_not_taken', sequence: 5, started_at: 1, finished_at: 2 }],
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  const importButton = page.getByRole('button', { name: 'Import Workflow' })
  await expect(importButton).toBeVisible()
  const exportButton = page.getByRole('button', { name: 'Export Workflow' })
  await expect(exportButton).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await exportButton.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Loop-workflow.workflow.json')
  const downloadPath = await download.path()
  expect(downloadPath).toBeTruthy()
  const exported = JSON.parse(await readFile(downloadPath!, 'utf8'))
  expect(exported).toMatchObject({ format: 'hermes-studio.workflow', version: 1, definition: { name: 'Loop workflow' } })
  expect(JSON.stringify(exported)).not.toMatch(/workspace|session_id|run_id|token|api[_-]?key/i)
  const chooser = page.waitForEvent('filechooser')
  await importButton.click()
  const fileChooser = await chooser
  await fileChooser.setFiles({ name: 'import.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toHaveText('Imported flow · 1 nodes · 0 edges')
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(0)
  await page.getByTestId('workflow-import-confirm').click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Imported flow')
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(1)
  const cancelChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const cancelChooser = await cancelChooserPromise
  await cancelChooser.setFiles({ name: 'cancel.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('workflow-import-summary')).toHaveCount(0)
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/cancel')).toHaveLength(1)
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(1)
  await page.locator('.workflow-list-item').filter({ hasText: 'Loop workflow' }).click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution evidence')
  await expect(evidence.getByText('rerun:2:a', { exact: true })).toBeVisible()
  await expect(evidence.getByText('a-b', { exact: true })).toBeVisible()
  await expect(evidence.getByText('loop:a', { exact: true })).toBeVisible()
  await expect(evidence.getByText('rerun:2 · loop:a#2', { exact: true })).toHaveCount(3)
  await page.locator('.workflow-run-item').click()
  const edge = page.locator('.vue-flow__edge').first()
  await edge.click({ force: true })
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByTestId('workflow-edge-condition-path').fill('score')
  await page.getByTestId('workflow-edge-condition-operator').click()
  await page.getByText('greater_than', { exact: true }).last().click()
  await page.getByTestId('workflow-edge-condition-value').fill('42')
  await page.getByText('Feedback loop').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await edge.click({ force: true })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-value')).toHaveValue('42')
  await page.getByTestId('workflow-edge-condition-operator').click({ force: true })
  await page.getByText('exists', { exact: true }).last().click()
  await expect(page.getByTestId('workflow-edge-condition-value')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()

  await edge.dispatchEvent('contextmenu', { clientX: 300, clientY: 180, button: 2 })
  await page.getByText('Edit Connection', { exact: true }).click()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  const sourceHandle = page.locator('.vue-flow__node[data-id="a"] .vue-flow__handle.source')
  const canvas = page.locator('.vue-flow__pane')
  await page.getByRole('button', { name: 'Hide run records' }).click()
  const handleBox = await sourceHandle.boundingBox()
  const canvasBox = await canvas.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvasBox!.x + canvasBox!.width * .72, canvasBox!.y + canvasBox!.height * .82, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await expect(page.locator('.vue-flow__node.selected')).toHaveCount(1)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('.vue-flow__node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  expect(api.unexpectedRequests).toEqual([])
})


test('workflow import reports an unsupported version without confirming or creating a workflow', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflows: [],
    workflowImportPreviewError: 'unsupported workflow import version',
  })
  await page.goto('/#/hermes/workflow')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const fileChooser = await chooser
  await fileChooser.setFiles({
    name: 'future.workflow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'hermes-studio.workflow', version: 2, definition: {} })),
  })
  await expect(page.getByText('unsupported workflow import version', { exact: true })).toBeVisible()
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(0)
  expect(api.unexpectedRequests).toEqual([])
})
