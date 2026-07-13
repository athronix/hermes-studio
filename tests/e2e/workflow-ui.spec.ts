import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('workflow canvas exposes orchestration editing and portability controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-1', name: 'Loop workflow', profile: 'research', workspace: null,
    nodes: [
      { id: 'a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: '', skills: [], images: [], approvalRequired: false } },
      { id: 'b', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Agent B', agent: 'hermes', input: '', skills: [], images: [], approvalRequired: false } },
    ], edges: [{ id: 'a-b', source: 'a', target: 'b', type: 'smoothstep' }], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  await expect(page.getByRole('button', { name: 'Import Workflow' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export Workflow' })).toBeVisible()
  const edge = page.locator('.vue-flow__edge').first()
  await edge.click({ force: true })
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByText('Feedback loop').click()
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
  await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('.vue-flow__node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  expect(api.unexpectedRequests).toEqual([])
})
