import { expect, test } from '@playwright/test'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Browser plugin not available. Exercise the built Workbench against a temporary real Runtime.
let application: NumenApplication
let directory: string
let errors: string[]
test.beforeEach(({ page }) => {
  errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`) })
})
test.afterEach(async () => {
  await writeFile('/tmp/numen-graph-inspection-console.json', JSON.stringify(errors, null, 2))
  expect(errors).toEqual([])
})
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-graph-inspection-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

const source = (): AutomationSource => ({ triggers: [], flow: {
  type: 'graph', id: 'saved-graph', version: 1,
  nodes: [
    { type: 'condition', id: 'decision', condition: { type: 'literal', value: true } },
    { type: 'capability', id: 'selected', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'selected result' } } },
    { type: 'capability', id: 'skipped', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'skipped result' } } },
    { type: 'merge', id: 'merge', mode: 'selected', inputs: ['yes', 'no'] },
  ], edges: [
    { id: 'start', from: { nodeId: 'saved-graph', port: 'start' }, to: { nodeId: 'decision', port: 'in' } },
    { id: 'yes-branch', from: { nodeId: 'decision', port: 'true' }, to: { nodeId: 'selected', port: 'in' } },
    { id: 'no-branch', from: { nodeId: 'decision', port: 'false' }, to: { nodeId: 'skipped', port: 'in' } },
    { id: 'selected-merge', from: { nodeId: 'selected', port: 'out' }, to: { nodeId: 'merge', port: 'yes' } },
    { id: 'skipped-merge', from: { nodeId: 'skipped', port: 'out' }, to: { nodeId: 'merge', port: 'no' } },
  ], output: { type: 'ref', path: 'steps.merge' },
} })

test('inspects immutable Graph edges and real member states in Runs and snapshots at desktop and mobile sizes', async ({ page }) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Graph historical browser', source: source() })
  const run = await context.scheduler.startDraftTest(automation.id, 1, {}, {}, 'graph-browser-draft-test')
  await context.scheduler.dispatchUntilIdle()
  expect(context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  const snapshot = structuredClone(context.automations.getExecutionSnapshot(run.revisionId)!)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1,
    source: { triggers: [], flow: { type: 'block', id: 'current-draft-only', steps: [] } } })
  const durable = () => ({ draft: context.automations.getDraft(automation.id), executions: context.scheduler.listExecutions(run.id), snapshot: context.automations.getExecutionSnapshot(run.revisionId) })
  const before = structuredClone(durable())
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.goto(new URL(`/runs/${run.id}/flow`, application.workbenchUrl!).href)
  await expect(page.getByRole('heading', { name: 'Graph historical browser', exact: true })).toBeVisible()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  const graph = page.locator('[data-readonly-graph-id="saved-graph"]')
  await expect(graph).toContainText('Members are listed without execution order.')
  await expect(graph.locator('.readonly-graph-canvas .vue-flow__node')).toHaveCount(5)
  await expect(graph.locator('[data-readonly-node-id="skipped"]')).toHaveAttribute('data-status', 'SKIPPED')
  await expect(graph.locator('[data-readonly-node-id="selected"]')).toHaveAttribute('data-status', 'COMPLETED')
  await expect(graph.locator('.readonly-graph-canvas .vue-flow__edge')).toHaveCount(5)
  await graph.locator('.readonly-graph-canvas').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/numen-graph-readonly-canvas-1440.png', fullPage: true })
  await graph.getByText('Member and connection list', { exact: true }).click()
  await expect(graph.locator('.readonly-graph-members > li')).toHaveCount(4)
  const skipped = graph.locator('.run-flow-node').filter({ has: page.getByRole('button', { name: 'Executions for skipped', exact: true }) })
  await expect(skipped).toHaveAttribute('data-status', 'SKIPPED')
  await expect(graph.locator('[data-graph-edge-id="yes-branch"]')).toContainText('decision.true')
  await expect(graph.locator('[data-graph-edge-id="selected-merge"]')).toContainText('merge.yes')
  await expect(page.locator('.run-flow-view')).not.toContainText('current-draft-only')
  await graph.getByRole('heading', { name: 'Control connections', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/numen-graph-run-desktop-1440.png', fullPage: true })
  await page.getByRole('button', { name: 'Executions for skipped', exact: true }).click()
  await expect(page.locator('.execution-record')).toHaveCount(0)
  await expect(page.getByText('No Executions match the current filter.', { exact: true })).toBeVisible()
  await page.goto(new URL(`/runs/${run.id}/flow`, application.workbenchUrl!).href)
  await graph.getByText('Member and connection list', { exact: true }).click()
  await page.getByRole('button', { name: 'Executions for merge', exact: true }).click()
  await expect(page.locator('.execution-record')).toHaveCount(1)
  await page.getByRole('button', { name: 'Locate source node', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Executions for merge', exact: true })).toBeFocused()

  await page.getByRole('button', { name: 'View snapshot', exact: true }).click()
  await expect(page).toHaveURL(new URL(`/automations/${automation.id}/snapshots/${snapshot.id}?fromRun=${run.id}`, application.workbenchUrl!).href)
  await expect(page.getByRole('heading', { name: 'Snapshot · Draft test · Draft v1', exact: true })).toBeVisible()
  await expect(page.locator('.snapshot-facts')).toContainText('Source 2 · IR 2')
  await expect(graph.locator('.readonly-graph-canvas .vue-flow__node')).toHaveCount(5)
  await graph.getByText('Member and connection list', { exact: true }).click()
  await expect(graph.locator('[data-graph-edge-id]')).toHaveCount(5)
  await page.getByRole('button', { name: 'View details for node decision', exact: true }).click()
  await expect(page.locator('[data-snapshot-node="decision"]')).toBeFocused()
  await expect(page.locator('[data-snapshot-node="decision"]')).toContainText('condition · literal')
  await page.getByRole('button', { name: 'View details for node merge', exact: true }).click()
  await expect(page.locator('[data-snapshot-node="merge"]')).toBeFocused()
  await expect(page.locator('.automation-snapshot-content')).not.toContainText('current-draft-only')
  await page.setViewportSize({ width: 390, height: 844 })
  await graph.getByRole('heading', { name: 'Control connections', exact: true }).scrollIntoViewIfNeeded()
  await expect(graph.locator('[data-graph-edge-id="selected-merge"]')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/numen-graph-snapshot-mobile-390.png', fullPage: true })
  await page.reload()
  await expect(graph.locator('[data-graph-edge-id]')).toHaveCount(5)
  expect(durable()).toEqual(before)
})
