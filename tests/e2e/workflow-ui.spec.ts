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
  await page.locator('.vue-flow__edge').first().click({ force: true })
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByText('Feedback loop').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  expect(api.unexpectedRequests).toEqual([])
})
