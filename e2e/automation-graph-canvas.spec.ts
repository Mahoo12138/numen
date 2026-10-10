import { expect, test, type Page } from '@playwright/test'
import type { GraphSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Browser plugin unavailable: test the production bundle against a real local Runtime.
let application: NumenApplication, directory: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-graph-canvas-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: true }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
async function select(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function connect(page: Page, from: string, to: string) {
  if (!await page.locator('.graph-connection-form').isVisible()) await page.locator('.graph-toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  await select(page, 'From port', from)
  await select(page, 'To port', to)
  await page.locator('.graph-connection-form').getByRole('button', { name: 'Connect', exact: true }).click()
  await saved(page)
}

test('authors, reconnects, lays out and tests a real graph without editing Source JSON', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const context = application.context
  const { automation } = context.automations.create({ name: 'Canvas multi-source', source: { triggers: [], flow: { type: 'block', id: 'flow', steps: [] } } })
  const draft = () => context.automations.getDraft(automation.id)!
  const graph = () => draft().source.flow as GraphSource
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: 'Canvas multi-source' }).click()
  await page.getByRole('button', { name: 'Create Graph flow', exact: true }).click()
  await expect(page.locator('.graph-node[data-node-id="graph"]')).toBeVisible()
  await saved(page)
  expect(graph()).toEqual({ type: 'graph', version: 1, id: 'graph', nodes: [], edges: [] })
  for (const [index, message] of ['weather', 'calendar'].entries()) {
    await page.getByRole('button', { name: 'Add node', exact: true }).click()
    await page.locator('.graph-flyout').getByRole('button', { name: 'Echo', exact: true }).click()
    await expect(page.locator(`.graph-node[data-node-id="capability-${index + 1}"]`)).toBeVisible()
    await page.getByLabel('Message', { exact: true }).fill(message)
    await page.getByLabel('Message', { exact: true }).press('Tab')
    await saved(page)
  }
  await page.getByRole('button', { name: 'Add node', exact: true }).click()
  await page.locator('.graph-flyout').getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(page.getByLabel('Named input ports', { exact: true })).toHaveValue('first, second')
  await page.getByLabel('Named input ports', { exact: true }).fill('weather, calendar')
  await page.getByLabel('Named input ports', { exact: true }).press('Tab')
  await saved(page)
  await connect(page, 'graph · start', 'capability-1 · in')
  await connect(page, 'graph · start', 'capability-2 · in')
  await connect(page, 'capability-1 · out', 'merge-1 · weather')
  await connect(page, 'capability-2 · out', 'merge-1 · calendar')
  await page.locator('.graph-connection-form').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Auto layout', exact: true }).click()
  await saved(page)
  expect(graph().edges).toHaveLength(4)
  expect(draft().presentation.graphPositions).toBeTruthy()
  const semanticBeforeDrag = structuredClone(draft().source)
  const positionsBeforeDrag = structuredClone(draft().presentation)
  const node = page.locator('.graph-node[data-node-id="capability-1"]')
  const bounds = (await node.boundingBox())!
  await page.mouse.move(bounds.x + 70, bounds.y + 20)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 95, bounds.y + 58, { steps: 12 })
  await page.mouse.up()
  await saved(page)
  expect(draft().source).toEqual(semanticBeforeDrag)
  expect(draft().presentation).not.toEqual(positionsBeforeDrag)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(draft().presentation).toEqual(positionsBeforeDrag)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await saved(page)

  // Start is protected; deleting a member and all incident edges is one undo item.
  await page.locator('.vue-flow__node[data-id="graph"]').click()
  await page.locator('.vue-flow__node[data-id="graph"]').press('Delete')
  expect(graph().edges).toHaveLength(4)
  expect(graph().nodes).toHaveLength(3)
  await page.locator('.vue-flow__node[data-id="capability-1"]').click()
  await page.locator('.vue-flow__node[data-id="capability-1"]').press('Delete')
  await saved(page)
  expect(graph().nodes).toHaveLength(2)
  expect(graph().edges).toHaveLength(2)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(graph().nodes).toHaveLength(3)
  expect(graph().edges).toHaveLength(4)

  // An explicit disconnect leaves the node and its parameters intact and blocks execution.
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.locator('.graph-flyout').getByText('Control connections', { exact: true }).click()
  await page.locator('.graph-flyout').getByRole('button', { name: 'graph.start → capability-1.in', exact: true }).click()
  await page.locator('.graph-connection-form').getByRole('button', { name: 'Disconnect', exact: true }).click()
  await saved(page)
  expect(graph().nodes).toHaveLength(3)
  expect(graph().nodes.find(node => node.id === 'capability-1')).toMatchObject({ input: { message: { type: 'literal', value: 'weather' } } })
  expect(() => context.automations.prepareDraftTestSnapshot(automation.id, draft().version)).toThrow()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(graph().edges).toHaveLength(4)
  await page.locator('.graph-connection-form').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  await page.screenshot({ path: '/tmp/numen-graph-canvas-desktop-1440.png', fullPage: true })
  await page.reload()
  await expect(page.locator('.graph-editor')).toBeVisible()
  await saved(page)
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await page.getByRole('button', { name: 'Test saved Draft', exact: true }).click()
  await expect.poll(() => context.scheduler.listRuns().find(run => run.automationId === automation.id)?.status).toBe('COMPLETED')
  const run = context.scheduler.listRuns().find(run => run.automationId === automation.id)!
  expect(context.scheduler.listExecutions(run.id).filter(execution => ['capability-1', 'capability-2', 'merge-1'].includes(execution.instructionId))).toHaveLength(3)
  expect(context.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'merge-1')?.output).toEqual({ weather: { message: 'weather' }, calendar: { message: 'calendar' } })
  expect(context.automations.listRevisions(automation.id)).toHaveLength(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/numen-graph-canvas-mobile-390.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

async function openAutomation(page: Page, name: string) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.locator('.graph-editor')).toBeVisible()
  await saved(page)
}
const echo = (id: string, message: import('../packages/core/dist/index.js').ValueExpr) => ({ type: 'capability' as const, id, capability: { id: 'demo:echo', version: 1 }, input: { message } })
const edge = (id: string, from: string, to: string, port = 'out') => ({ id, from: { nodeId: from, port }, to: { nodeId: to, port: 'in' } })

test('edits explicit loop parameters and preserves the canvas viewport through node focus', async ({ page }) => {
  test.setTimeout(60_000)
  const { automation } = application.context.automations.create({ name: 'Graph loop workspace', source: { triggers: [], flow: {
    type: 'graph', id: 'root', version: 1, nodes: [{ type: 'foreach', id: 'each', items: { type: 'literal', value: ['first', 'second'] }, concurrency: 1,
      body: { type: 'graph', id: 'body', version: 1, nodes: [echo('inner', { type: 'ref', path: 'loop.item' })], edges: [edge('body-start', 'body', 'inner', 'start')], output: { type: 'ref', path: 'steps.inner' } } }],
    edges: [edge('start', 'root', 'each', 'start')], output: { type: 'ref', path: 'steps.each' },
  } } })
  await openAutomation(page, automation.name)
  await page.locator('.graph-node[data-node-id="each"]').click()
  await expect(page.getByLabel('Concurrent items', { exact: true })).toHaveValue('1')
  await expect(page.getByText('No Literal renderer is registered for json.', { exact: false })).toHaveCount(0)
  await page.getByLabel('Concurrent items', { exact: true }).fill('2')
  await page.getByLabel('Concurrent items', { exact: true }).press('Tab')
  await saved(page)
  await page.locator('.graph-toolbar').getByRole('button', { name: 'Open loop', exact: true }).click()
  await expect(page.locator('.graph-scope-path')).toContainText('body')
  await page.locator('.graph-scope-canvas:visible .graph-node[data-node-id="inner"]').click()
  await page.locator('.graph-scope-canvas:visible').getByRole('button', { name: 'Zoom in', exact: true }).click()
  const viewport = await page.locator('.graph-scope-canvas:visible .vue-flow__transformationpane').getAttribute('style')
  await page.locator('.graph-scope-canvas:visible .graph-toolbar').getByRole('button', { name: 'Focus node', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Node workspace', exact: true })).toBeVisible()
  await expect(page.locator('.focus-parameters').getByLabel('Message', { exact: true })).toHaveValue('loop.item')
  await page.screenshot({ path: '/tmp/numen-graph-focus-desktop-1440.png', fullPage: true })
  await page.getByRole('button', { name: 'Back to canvas', exact: true }).click()
  expect(await page.locator('.graph-scope-canvas:visible .vue-flow__transformationpane').getAttribute('style')).toBe(viewport)
  await page.locator('.graph-scope-path').getByRole('button', { name: 'root', exact: true }).click()
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await page.getByRole('button', { name: 'Test saved Draft', exact: true }).click()
  await expect.poll(() => application.context.scheduler.listRuns().find(run => run.automationId === automation.id)?.status).toBe('COMPLETED')
  const run = application.context.scheduler.listRuns().find(run => run.automationId === automation.id)!
  expect(application.context.scheduler.listExecutions(run.id).find(item => item.instructionId === 'each')?.output).toEqual([{ message: 'first' }, { message: 'second' }])
  expect(application.context.scheduler.listExecutions(run.id).filter(item => item.instructionId === 'inner')).toHaveLength(2)
})

test('pins a manual upstream output and runs only the reviewed node through the real Console API', async ({ page }) => {
  test.setTimeout(60_000)
  const ctx = application.context
  const { automation } = ctx.automations.create({ name: 'Graph scoped test', source: { triggers: [], flow: {
    type: 'graph', id: 'root', version: 1, nodes: [echo('upstream', { type: 'literal', value: 'real upstream' }), echo('target', { type: 'ref', path: 'steps.upstream.message' }), echo('after', { type: 'ref', path: 'steps.target.message' })],
    edges: [edge('start', 'root', 'upstream', 'start'), edge('first', 'upstream', 'target'), edge('last', 'target', 'after')], output: { type: 'ref', path: 'steps.after' },
  } } })
  await openAutomation(page, automation.name)
  await page.locator('.graph-node[data-node-id="target"]').click()
  await page.locator('.graph-toolbar').getByRole('button', { name: 'Focus node', exact: true }).click()
  await expect(page.locator('.focus-input')).toContainText('steps.upstream.message')
  await page.getByRole('button', { name: 'Local test and samples', exact: true }).click()
  await page.getByText('Create or import a complete sample', { exact: true }).click()
  await select(page, 'Sample source node', 'upstream')
  await page.getByLabel('Complete output sample (JSON)', { exact: true }).fill('{"message":"fixed sample"}')
  await page.getByRole('button', { name: 'Save manual sample', exact: true }).click()
  await expect(page.locator('.local-test-samples article')).toHaveCount(1)
  await page.locator('.local-test-samples input[type="checkbox"]').check()
  await page.getByRole('button', { name: 'Preview local test', exact: true }).click()
  await expect(page.locator('.local-test-preview')).toContainText('Fixed input validated')
  await expect(page.locator('.local-test-preview')).toContainText('target')
  await expect(page.locator('.local-test-preview')).not.toContainText('after')
  await page.locator('.local-test-preview').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/numen-graph-local-test-preview.png', fullPage: true })
  await page.getByRole('button', { name: 'Run reviewed local test', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open test Run', exact: true })).toBeVisible()
  await expect.poll(() => ctx.scheduler.listRuns().find(run => run.automationId === automation.id)?.status).toBe('COMPLETED')
  const local = ctx.scheduler.listRuns().find(run => run.automationId === automation.id)!
  const executions = ctx.scheduler.listExecutions(local.id)
  expect(executions.find(item => item.instructionId === 'upstream')?.sampleId).toMatch(/^sample_/)
  expect(executions.find(item => item.instructionId === 'target')?.output).toEqual({ message: 'fixed sample' })
  expect(executions.find(item => item.instructionId === 'after')).toBeUndefined()
  expect(ctx.automations.listRevisions(automation.id)).toHaveLength(0)
  expect(ctx.automations.get(automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Local test and samples', exact: true }).click()
  await page.getByRole('button', { name: 'Output', exact: true }).click()
  await page.screenshot({ path: '/tmp/numen-graph-focus-mobile-390.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const count of [100, 300]) test(`locates and edits node ${count} and reads its immutable Run and Source after a Draft change`, async ({ page }) => {
  test.setTimeout(60_000)
  const ctx = application.context
  const graph: GraphSource = { type: 'graph', id: 'root', version: 1,
    nodes: Array.from({ length: count }, (_, i) => echo(`node-${i + 1}`, { type: 'literal', value: `original-${i + 1}` })),
    edges: Array.from({ length: count }, (_, i) => edge(`edge-${i + 1}`, 'root', `node-${i + 1}`, 'start')),
    output: { type: 'ref', path: `steps.node-${count}` } }
  const { automation } = ctx.automations.create({ name: `Graph ${count} nodes`, source: { triggers: [], flow: graph } })
  const run = await ctx.scheduler.startDraftTest(automation.id, 1, {}, null, `graph-large-${count}-request`)
  await expect.poll(() => ctx.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  const fixed = structuredClone(ctx.automations.getExecutionSnapshot(run.revisionId))
  await openAutomation(page, automation.name)
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.getByLabel('Find a node', { exact: true }).fill(`node-${count}`)
  await page.locator('.graph-flyout').getByRole('button').filter({ hasText: `node-${count}` }).click()
  const tail = page.locator(`.graph-node[data-node-id="node-${count}"]`)
  await expect(tail).toBeInViewport()
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('current draft changed')
  await page.getByLabel('Message', { exact: true }).press('Tab')
  await saved(page)
  expect(ctx.automations.getExecutionSnapshot(run.revisionId)).toEqual(fixed)
  await page.screenshot({ path: `/tmp/numen-graph-${count}-tail.png`, fullPage: true })
  await page.goto(new URL(`/automations/${automation.id}/snapshots/${run.revisionId}`, application.workbenchUrl!).href)
  await page.getByLabel('Node ID', { exact: true }).fill(`node-${count}`)
  await page.getByRole('button', { name: 'Locate node', exact: true }).click()
  await expect(page.locator(`[data-snapshot-node="node-${count}"]`)).toBeVisible()
  await expect(page.locator('.snapshot-source-nodes > article')).toHaveCount(1)
  await page.goto(new URL(`/runs/${run.id}/flow`, application.workbenchUrl!).href)
  await page.getByLabel('Node ID', { exact: true }).fill(`node-${count}`)
  await page.getByRole('button', { name: 'Locate node', exact: true }).click()
  await page.getByRole('button', { name: `Executions for node-${count}`, exact: true }).click()
  await expect(page.locator('.execution-record')).toHaveCount(1)
  await expect(page.locator('.execution-record')).toContainText(`node-${count}`)
  await page.locator('.execution-record').getByRole('button', { name: 'Inspect input / output', exact: true }).click()
  await expect(page.locator('.run-data-panel')).toBeVisible()
  expect(ctx.scheduler.listExecutions(run.id).filter(item => item.instructionId.startsWith('node-'))).toHaveLength(count)
  if (count === 300) {
    const current = ctx.automations.getDraft(automation.id)!
    const changed = structuredClone(current.source)
    for (const node of (changed.flow as GraphSource).nodes) if (node.type === 'capability') node.input = { message: { type: 'literal', value: 'updated all nodes' } }
    const next = ctx.automations.saveDraft({ automationId: automation.id, expectedVersion: current.version, source: changed, presentation: current.presentation })
    const url = new URL(`/automations/${automation.id}/compare`, application.workbenchUrl!)
    url.searchParams.set('left', run.revisionId); url.searchParams.set('right', 'draft'); url.searchParams.set('draftVersion', String(next.version))
    await page.goto(url.href)
    await expect(page.locator('.comparison-change')).toHaveCount(250)
    await page.getByRole('button', { name: 'Next changes', exact: true }).click()
    await expect(page.locator('.comparison-change')).toHaveCount(50)
    await expect(page.getByRole('button', { name: 'Next changes', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Previous changes', exact: true }).click()
    await expect(page.locator('.comparison-change')).toHaveCount(250)
    await page.goto(new URL(`/automations/${automation.id}/snapshots/${run.revisionId}`, application.workbenchUrl!).href)
    await page.getByRole('button', { name: 'Restore to Draft', exact: true }).click()
    await page.locator('.automation-restoration-panel').getByRole('button', { name: 'Restore to Draft', exact: true }).click()
    await saved(page)
    expect(ctx.automations.getDraft(automation.id)?.source).toEqual(fixed!.source)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await saved(page)
    expect(ctx.automations.getDraft(automation.id)?.source).toEqual(changed)
    expect(ctx.automations.listRevisions(automation.id)).toHaveLength(0)
    expect(ctx.automations.get(automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
    expect(ctx.automations.getExecutionSnapshot(run.revisionId)).toEqual(fixed)
  }
})

test('preserves graph history through offline saves, competing tabs and Workbench Entry remount', async ({ page, context: browser }) => {
  test.setTimeout(60_000)
  const ctx = application.context
  const { automation } = ctx.automations.create({ name: 'Graph lifecycle', source: { triggers: [], flow: { type: 'graph', id: 'root', version: 1,
    nodes: [echo('one', { type: 'literal', value: 'original' })], edges: [edge('start', 'root', 'one', 'start')],
  } } })
  await openAutomation(page, automation.name)
  await page.locator('.graph-node[data-node-id="one"]').click()
  await browser.setOffline(true)
  await page.getByLabel('Message', { exact: true }).fill('offline edit')
  await page.getByLabel('Message', { exact: true }).press('Tab')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'ERROR')
  expect((ctx.automations.getDraft(automation.id)!.source.flow as GraphSource).nodes[0]).toMatchObject({ input: { message: { value: 'original' } } })
  await browser.setOffline(false)
  await page.getByRole('button', { name: 'Retry autosave', exact: true }).click()
  await saved(page)
  const second = await browser.newPage()
  await second.goto(page.url())
  await expect(second.locator('.graph-editor')).toBeVisible()
  await second.locator('.graph-node[data-node-id="one"]').click()
  // Hold the first tab's write while the second tab wins the saved Draft CAS.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure === 'numen:automation-save-draft@1') await gate
    await route.continue()
  })
  await page.getByLabel('Message', { exact: true }).fill('first tab pending')
  await page.getByLabel('Message', { exact: true }).press('Tab')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
  await second.getByLabel('Message', { exact: true }).fill('second tab wins')
  await second.getByLabel('Message', { exact: true }).press('Tab')
  await saved(second)
  release()
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('first tab pending')
  expect((ctx.automations.getDraft(automation.id)!.source.flow as GraphSource).nodes[0]).toMatchObject({ input: { message: { value: 'second tab wins' } } })
  await page.unroute('**/api/console/call')
  await page.close()
  const before = structuredClone(ctx.automations.getDraft(automation.id))
  await ctx.loader.update('workbench', { disabled: true }); await ctx.loader.await()
  await expect(second.locator('.graph-editor')).toHaveCount(0)
  await ctx.loader.update('workbench', { disabled: false }); await ctx.loader.await()
  await expect(second.locator('.graph-editor')).toBeVisible()
  expect(ctx.automations.getDraft(automation.id)).toEqual(before)
  await second.locator('.graph-node[data-node-id="one"]').click()
  await expect(second.getByLabel('Message', { exact: true })).toHaveValue('second tab wins')
  await second.close()
})

test('protects invalid graph parameters and makes reconnect and insert atomic undo operations', async ({ page }) => {
  const ctx = application.context
  const { automation } = ctx.automations.create({ name: 'Graph atomic edits', source: { triggers: [], flow: { type: 'graph', id: 'root', version: 1,
    nodes: [echo('a', { type: 'literal', value: 'a' }), echo('b', { type: 'literal', value: 'b' }), { type: 'merge', id: 'merge', mode: 'all', inputs: ['first', 'second'] }],
    edges: [edge('start-a', 'root', 'a', 'start'), edge('start-b', 'root', 'b', 'start'),
      { id: 'a-merge', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'merge', port: 'first' } },
      { id: 'b-merge', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'merge', port: 'second' } }],
  } } })
  const source = () => ctx.automations.getDraft(automation.id)!.source
  const original = structuredClone(source())
  await openAutomation(page, automation.name)
  await page.locator('.graph-node[data-node-id="merge"]').click()
  await page.getByLabel('Named input ports', { exact: true }).fill('same, same')
  await page.getByLabel('Named input ports', { exact: true }).press('Tab')
  await expect(page.getByLabel('Named input ports', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  const dialog = page.waitForEvent('dialog')
  const changeNode = page.locator('.graph-node[data-node-id="a"]').click()
  await (await dialog).dismiss()
  await changeNode
  await expect(page.locator('.graph-node[data-node-id="merge"]')).toHaveAttribute('data-active', 'true')
  await expect(page.getByLabel('Named input ports', { exact: true })).toHaveValue('same, same')
  expect(source()).toEqual(original)
  await page.getByLabel('Named input ports', { exact: true }).fill('first, second')
  await page.getByLabel('Named input ports', { exact: true }).press('Tab')
  await saved(page)
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.locator('.graph-flyout summary').click()
  await page.locator('.graph-flyout').getByRole('button', { name: 'a.out → merge.first', exact: true }).click()
  await select(page, 'From port', 'b · out')
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await saved(page)
  expect((source().flow as GraphSource).edges.find(item => item.id === 'a-merge')?.from.nodeId).toBe('b')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(source()).toEqual(original)
  await page.getByRole('button', { name: 'Add node', exact: true }).click()
  await page.locator('.graph-flyout').getByRole('button', { name: 'Echo', exact: true }).click()
  await saved(page)
  expect((source().flow as GraphSource).nodes).toHaveLength(4)
  expect((source().flow as GraphSource).edges).toHaveLength(5)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(source()).toEqual(original)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await saved(page)
  expect((source().flow as GraphSource).nodes).toHaveLength(4)
})
