import { readFile } from 'fs/promises'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('workflow canvas exposes orchestration editing and portability controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run Agent A', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Agent B', agent: 'hermes', input: 'Run Agent B', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [{ id: 'a-b', source: 'a', target: 'b', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' }]
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
  await expect(importButton).toHaveText('')
  await expect(importButton.locator('svg')).toBeVisible()
  const exportButton = page.getByRole('button', { name: 'Export Workflow' })
  await expect(exportButton).toBeVisible()
  await expect(exportButton).toHaveText('')
  await expect(exportButton.locator('svg')).toBeVisible()
  const toolbarLabels = await page.locator('.header-actions button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(toolbarLabels.indexOf('Export Workflow')).toBeLessThan(toolbarLabels.indexOf('Import Workflow'))
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
  await expect(page.getByTestId('workflow-import-summary')).toHaveText('Imported flow · 1 nodes · 0 links')
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
  const joinHelpIcons = page.getByTestId('workflow-node-join-help')
  const joinHelp = page.getByText('All incoming routes must be taken; if one does not match, this node is skipped. Example: wait for both parallel checks.', { exact: true })
  await expect(joinHelpIcons).toHaveCount(2)
  await expect(joinHelp).toHaveCount(0)
  await joinHelpIcons.first().hover()
  await expect(joinHelp).toBeVisible()
  const edge = page.locator('.vue-flow__edge').first()
  await edge.click({ force: true })
  const edgeDialog = page.getByRole('dialog')
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  const routeHelp = page.getByText('First match the source result. success: source succeeded; failure: source failed; always: either result. A condition, when present, must also match.', { exact: true })
  const routeExample = page.getByText('Example: use success for the normal path, failure for error handling, and always for cleanup.', { exact: true })
  await expect(routeHelp).toHaveCount(0)
  await expect(routeExample).toHaveCount(0)
  await page.getByTestId('workflow-edge-route-help').hover()
  await expect(routeHelp).toBeVisible()
  await expect(routeExample).toBeVisible()
  await edgeDialog.locator('.n-select').first().click()
  for (const route of ['Success only (success)', 'Failure only (failure)', 'Always (always)']) {
    await expect(page.getByText(route, { exact: true }).last()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-operator')).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await expect(page.getByText('Route only — no condition', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Successful reply text (output, recommended)', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Failure error text (error)', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Custom path (advanced)', { exact: true }).last()).toBeVisible()
  await page.getByText('Successful reply text (output, recommended)', { exact: true }).last().click()
  const conditionHelp = page.getByText('For success, output is recommended. Choose Route only when no content check is needed.', { exact: true })
  const operatorHelp = page.getByText('Exactly equal, including type. Example: output equals "APPROVED".', { exact: true })
  const valueHelp = page.getByText('Enter valid JSON. Text needs double quotes; numbers and booleans do not. Types are not converted: "42" is different from 42.', { exact: true })
  const feedbackHelp = page.getByText('Marks this backward connection as a bounded loop. It repeats only while the route and condition match, and stops at Maximum iterations.', { exact: true })
  for (const help of [conditionHelp, operatorHelp, valueHelp, feedbackHelp]) await expect(help).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(conditionHelp).toBeVisible()
  await page.getByTestId('workflow-edge-operator-help').hover()
  await expect(operatorHelp).toBeVisible()
  await page.getByTestId('workflow-edge-condition-value-help').hover()
  await expect(valueHelp).toBeVisible()
  await page.getByTestId('workflow-edge-feedback-help').hover()
  await expect(feedbackHelp).toBeVisible()
  await page.getByTestId('workflow-edge-condition-operator').click()
  for (const operator of [
    'Equals (equals)', 'Does not equal (not_equals)', 'Contains (contains)', 'Does not contain (not_contains)',
    'Exists (exists)', 'Does not exist (not_exists)', 'Greater than (greater_than)',
    'Greater than or equal (greater_than_or_equal)', 'Less than (less_than)', 'Less than or equal (less_than_or_equal)',
  ]) {
    await expect(page.getByText(operator, { exact: true }).last()).toBeVisible()
  }
  await page.getByText('Greater than (greater_than)', { exact: true }).last().click()
  const numberOperatorHelp = page.getByText('Both actual value and Value must be JSON numbers; matches when actual is greater.', { exact: true })
  await expect(numberOperatorHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-operator-help').hover()
  await expect(numberOperatorHelp).toBeVisible()
  await page.getByTestId('workflow-edge-condition-value').locator('input').fill('42')
  await page.getByText('Feedback loop').click()
  const maxIterationsHelp = page.getByText('Total loop passes allowed, from 1 to 100. The run also has a global execution safety budget.', { exact: true })
  const loopIdHelp = page.getByText('This only labels the loop in execution history; it does not change when the loop runs. Keep Automatic unless an advanced multi-loop design needs a stable custom ID.', { exact: true })
  await expect(maxIterationsHelp).toHaveCount(0)
  await expect(loopIdHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-max-iterations-help').hover()
  await expect(maxIterationsHelp).toBeVisible()
  await page.getByTestId('workflow-edge-loop-id-help').hover()
  await expect(loopIdHelp).toBeVisible()
  const loopIdSelect = page.getByTestId('workflow-edge-loop-id')
  await expect(loopIdSelect).toBeVisible()
  await loopIdSelect.click()
  await expect(page.getByText('Automatic (recommended) · loop:a-b', { exact: true }).last()).toBeVisible()
  await page.keyboard.press('Escape')
  await loopIdSelect.locator('input').fill('review-loop')
  await loopIdSelect.locator('input').press('Enter')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await edge.click({ force: true })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toContainText('Successful reply text (output, recommended)')
  await expect(page.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('42')
  await expect(page.getByTestId('workflow-edge-loop-id')).toContainText('review-loop')
  await page.getByTestId('workflow-edge-condition-operator').click({ force: true })
  await page.getByText('Exists (exists)', { exact: true }).last().click()
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
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await page.locator('.vue-flow__node.selected input').first().focus()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await canvas.click({ position: { x: 24, y: 24 } })
  await page.keyboard.press('Control+z')
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
  await expect(page.getByText(/unsupported workflow import version/)).toBeVisible()
  expect(api.requests.filter(request => request.pathname === '/api/hermes/workflows/import/confirm')).toHaveLength(0)
  expect(api.unexpectedRequests).toEqual([])
})
