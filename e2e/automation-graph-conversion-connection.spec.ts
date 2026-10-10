import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { defineCapability, type AutomationSource, type CapabilitySource, type GraphSource, type NumenValue } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import type {} from '../packages/automation/dist/index.js'
import type {} from '../packages/connections/dist/index.js'
import type {} from '../packages/scheduler/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the production Workbench against real Registry, ConnectionService and Scheduler instances.
const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const connectionType = { id: 'acceptance:account', version: 1, title: 'Acceptance account' }
const adapter = { id: 'acceptance:account-adapter', version: 1, title: 'Acceptance account adapter', type: connectionType,
  config: z.object({ endpoint: z.string().required() }) }
const connectedCapability = defineCapability({ id: 'acceptance:connected', version: 1, kind: 'query', title: 'Connected echo',
  input: z.object({ message: z.string().required(), headers: z.dict(z.string()) }),
  output: z.object({ message: z.string(), account: z.string(), audit: z.string() }),
  connections: [{ name: 'account', required: true, accepts: ['acceptance:account@1'] }, { name: 'audit', required: true, accepts: ['acceptance:account@1'] }],
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})
let application: NumenApplication, directory: string
const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  page.setDefaultTimeout(10_000)
  const messages: string[] = []; errors.set(page, messages)
  page.on('pageerror', error => messages.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') messages.push(`console.error: ${message.text()}`) })
})
test.afterEach(async ({ page }, info) => {
  await writeFile(`/tmp/numen-graph-conversion-connection-${info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 70)}-console.json`, JSON.stringify(errors.get(page), null, 2))
  expect(errors.get(page)).toEqual([])
})
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-graph-return-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: {}, automations: {}, scheduler: { autoDispatch: false },
    triggers: {}, console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  const ctx = application.context
  ctx.connections.defineType(ctx, connectionType)
  ctx.connections.defineAdapter(ctx, adapter)
  ctx.connections.provideAdapter(ctx, adapter, { async open({ connection }) { return { value: { endpoint: connection.config.endpoint } } } })
  ctx.capabilities.define(ctx, connectedCapability)
  ctx.capabilities.provide(ctx, connectedCapability, { async invoke({ input, connections }) {
    return { message: (input as Record<string, NumenValue>).message,
      account: (connections.account as { endpoint: string }).endpoint, audit: (connections.audit as { endpoint: string }).endpoint }
  } })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })
const echo = (id: string, message: string): CapabilitySource => ({ type: 'capability', id, capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: message } } })
const draft = (id: string) => application.context.automations.getDraft(id)!
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
async function openAutomation(page: Page, id: string, name: string) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  const url = new URL('/automations', application.workbenchUrl!); url.searchParams.set('automation', id); url.searchParams.set('tab', 'Editor')
  await page.goto(url.href)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await saved(page)
}
const copyFor = (name: string) => application.context.automations.list().find(item => item.name === `${name} (Graph)`)
function immutableState(id: string, snapshotId: string) {
  const context = application.context
  return { automation: context.automations.get(id), draft: context.automations.getDraft(id), revisions: context.automations.listRevisions(id), snapshot: context.automations.getExecutionSnapshot(snapshotId) }
}

for (const kind of ['block', 'capability'] as const) test(`previews and copies a ${kind} to Graph while preserving Source, snapshots and activation`, async ({ page }) => {
  const context = application.context, name = `Conservative ${kind} conversion`
  const source: AutomationSource = { inputs: { message: { type: 'string', default: 'kept automation input' } }, triggers: [],
    flow: kind === 'block' ? { type: 'block', id: 'original-flow', steps: [echo('first', 'snapshot input'), { ...echo('second', ''), input: { message: { type: 'ref', path: 'steps.first.message' } } }] } : echo('first', 'snapshot input') }
  const { automation } = context.automations.create({ name, source, presentation: { opaque: { annotation: 'preserved presentation' } } })
  const revision = context.automations.publishDraft(automation.id, 1)
  context.automations.activateRevision(automation.id, revision.id)
  context.automations.setEnabled(automation.id, true)
  const run = context.scheduler.startManual(automation.id)
  await context.scheduler.dispatchUntilIdle()
  expect(context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  // The copy must come from the current Draft, not this already accepted historical snapshot.
  const currentSource = structuredClone(source)
  if (currentSource.flow.type === 'block') (currentSource.flow.steps[0] as CapabilitySource).input.message = { type: 'literal', value: 'current draft input' }
  else if (currentSource.flow.type === 'capability') currentSource.flow.input.message = { type: 'literal', value: 'current draft input' }
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: currentSource, presentation: draft(automation.id).presentation })
  const before = structuredClone(immutableState(automation.id, run.revisionId)), beforeCount = context.automations.list().length
  await openAutomation(page, automation.id, name)
  await page.getByRole('button', { name: 'Preview as Graph', exact: true }).click()
  const preview = page.locator('.graph-conversion-preview')
  await expect(preview.locator('.graph-node[data-node-id="first"]')).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Add node', exact: true })).toBeDisabled()
  expect(context.automations.list()).toHaveLength(beforeCount)
  expect(immutableState(automation.id, run.revisionId)).toEqual(before)
  if (kind === 'block') await page.screenshot({ path: '/tmp/numen-graph-conversion-preview-1440.png', fullPage: true })
  await page.getByRole('button', { name: 'Create Graph copy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open saved copy', exact: true })).toBeVisible()
  await expect.poll(() => context.automations.list().length).toBe(beforeCount + 1)
  const copy = copyFor(name)!
  expect(copy).toMatchObject({ enabled: false, activationGeneration: 0 })
  expect(copy.activeRevisionId).toBeUndefined()
  expect(context.automations.listRevisions(copy.id)).toEqual([])
  const copyDraft = draft(copy.id), graph = copyDraft.source.flow as GraphSource
  expect(graph.type).toBe('graph')
  expect(graph.nodes).toEqual(currentSource.flow.type === 'block' ? currentSource.flow.steps : [currentSource.flow])
  expect(graph.edges.map(edge => [edge.from.nodeId, edge.from.port, edge.to.nodeId, edge.to.port])).toEqual(kind === 'block'
    ? [['original-flow', 'start', 'first', 'in'], ['first', 'out', 'second', 'in']] : [[graph.id, 'start', 'first', 'in']])
  expect(copyDraft.source.inputs).toEqual(source.inputs)
  expect(copyDraft.presentation).toEqual(before.draft!.presentation)
  expect(immutableState(automation.id, run.revisionId)).toEqual(before)
  await page.getByRole('button', { name: 'Open saved copy', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${name} (Graph)`, exact: true })).toBeVisible()
  await expect(page.locator('.graph-node[data-node-id="first"]')).toBeVisible()
  await page.locator('.graph-node[data-node-id="first"]').click()
  await page.getByLabel('Message', { exact: true }).fill('edited only in copied graph')
  await page.getByLabel('Message', { exact: true }).press('Tab')
  await saved(page)
  await expect.poll(() => (draft(copy.id).source.flow as GraphSource).nodes[0]).toMatchObject({ input: { message: { type: 'literal', value: 'edited only in copied graph' } } })
  expect(immutableState(automation.id, run.revisionId)).toEqual(before)
})

test('refuses an If conversion without creating a copy or mutating the original', async ({ page }) => {
  const context = application.context, name = 'Conditional conversion refused'
  const source: AutomationSource = { triggers: [], flow: { type: 'if', id: 'decision', condition: { type: 'literal', value: true },
    then: { type: 'block', id: 'then-branch', steps: [echo('true-node', 'yes')] }, else: { type: 'block', id: 'else-branch', steps: [echo('false-node', 'no')] } } }
  const { automation } = context.automations.create({ name, source })
  const original = structuredClone(draft(automation.id)), count = context.automations.list().length
  await openAutomation(page, automation.id, name)
  await page.getByRole('button', { name: 'Preview as Graph', exact: true }).click()
  await expect(page.locator('.graph-conversion-panel')).toContainText('This structure has no proven equivalent Graph conversion.')
  await expect(page.getByRole('button', { name: 'Create Graph copy', exact: true })).toHaveCount(0)
  await expect(page.locator('.graph-conversion-preview')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click()
  await expect(page.locator('.inspector')).not.toBeInViewport()
  await expect(page.locator('.graph-conversion-panel')).toContainText('This structure has no proven equivalent Graph conversion.')
  await page.screenshot({ path: '/tmp/numen-graph-conversion-refused-390.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  expect(context.automations.list()).toHaveLength(count)
  expect(draft(automation.id)).toEqual(original)
})

test('creates and repairs a Connection then returns to the exact Slot with parameters and viewport intact', async ({ page }) => {
  test.setTimeout(90_000)
  const context = application.context
  const audit = context.connections.create({ name: 'Retained audit', adapter, config: { endpoint: 'audit-original' }, enabled: true })
  await context.connections.reconcile()
  const { automation } = context.automations.create({ name: 'Connection return graph', source: { triggers: [], flow: {
    type: 'graph', version: 1, id: 'root', nodes: [{ type: 'capability', id: 'request', capability: { id: connectedCapability.id, version: 1 }, input: { message: { type: 'literal', value: 'before navigation' }, headers: { type: 'literal', value: { retained: 'metadata' } } }, connections: { audit: audit.id } }],
    edges: [{ id: 'start', from: { nodeId: 'root', port: 'start' }, to: { nodeId: 'request', port: 'in' } }], output: { type: 'ref', path: 'steps.request' },
  } } })
  const capability = () => (draft(automation.id).source.flow as GraphSource).nodes[0] as CapabilitySource
  await openAutomation(page, automation.id, automation.name)
  await page.locator('.graph-node[data-node-id="request"]').click()
  await page.locator('.graph-scope-canvas:visible').getByRole('button', { name: 'Zoom in', exact: true }).click()
  const viewportElement = page.locator('.graph-scope-canvas .vue-flow__transformationpane')
  const viewport = await viewportElement.getAttribute('style')
  await page.locator('.graph-toolbar').getByRole('button', { name: 'Focus node', exact: true }).click()
  const workspace = page.getByRole('region', { name: 'Node workspace', exact: true })
  await expect(workspace).toBeVisible()
  const account = workspace.locator('[data-connection-node="request"][data-connection-slot="account"]')
  const auditField = workspace.locator('[data-connection-node="request"][data-connection-slot="audit"]')
  const message = workspace.getByLabel('Message', { exact: true })
  await message.fill('retained after Connection return')
  // Opening the Connection flow must first commit this valid focused field.
  await account.getByRole('button', { name: 'Create compatible Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection configuration', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Adapter', exact: true })).toContainText('Acceptance account adapter')
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Created account')
  await dialog.getByRole('textbox', { name: /^Endpoint/ }).fill('account-created')
  await page.screenshot({ path: '/tmp/numen-graph-connection-create-1440.png', fullPage: true })
  await dialog.getByRole('button', { name: 'Create Connection', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(account.getByRole('button', { name: 'account connection', exact: true })).toBeFocused()
  await saved(page)
  const created = context.connections.list().find(item => item.name === 'Created account')!
  expect(created.config).toEqual({ endpoint: 'account-created' })
  expect(capability().connections).toEqual({ audit: audit.id, account: created.id })
  await expect(message).toHaveValue('retained after Connection return')
  await expect(auditField.getByRole('button', { name: 'audit connection', exact: true })).toContainText('Retained audit')
  expect(await viewportElement.getAttribute('style')).toBe(viewport)

  await page.setViewportSize({ width: 390, height: 844 })
  await account.getByRole('button', { name: 'Repair Connection', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Connection settings', exact: true })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: /^Endpoint/ })).toHaveValue('account-created')
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Repaired account')
  await dialog.getByRole('textbox', { name: /^Endpoint/ }).fill('account-repaired')
  await page.screenshot({ path: '/tmp/numen-graph-connection-repair-390.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(account.getByRole('button', { name: 'account connection', exact: true })).toBeFocused()
  await expect(message).toHaveValue('retained after Connection return')
  await saved(page)
  expect(context.connections.get(created.id)).toMatchObject({ generation: 2, name: 'Repaired account', config: { endpoint: 'account-repaired' } })
  expect(context.connections.get(audit.id)).toEqual(audit)
  expect(capability().connections).toEqual({ audit: audit.id, account: created.id })
  expect(capability().input.headers).toEqual({ type: 'literal', value: { retained: 'metadata' } })
  // Restore the original viewport dimensions before comparing the retained Canvas transform.
  await page.setViewportSize({ width: 1440, height: 960 })
  await workspace.getByRole('button', { name: 'Back to canvas', exact: true }).click()
  expect(await viewportElement.getAttribute('style')).toBe(viewport)
  await expect(page.locator('.graph-node[data-node-id="request"]')).toContainText('account: Repaired account')
  await expect(page.locator('.graph-node[data-node-id="request"]')).toContainText('audit: Retained audit')
  await page.reload()
  await saved(page)
  expect(capability().connections).toEqual({ audit: audit.id, account: created.id })
  expect(capability().input.message).toEqual({ type: 'literal', value: 'retained after Connection return' })
  context.connections.setEnabled(created.id, 2, true)
  await context.connections.reconcile()
  const run = await context.scheduler.startDraftTest(automation.id, draft(automation.id).version, {}, {}, 'connection-return-test')
  await context.scheduler.dispatchUntilIdle()
  expect(context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  expect(context.scheduler.listExecutions(run.id).find(item => item.instructionId === 'request')?.output).toEqual({ message: 'retained after Connection return', account: 'account-repaired', audit: 'audit-original' })
})

test('protects the original saving Draft before opening a previously created Graph copy', async ({ page }) => {
  const context = application.context, name = 'Conversion copy leave protection'
  const { automation } = context.automations.create({ name, source: { triggers: [], flow: { type: 'block', id: 'source-flow', steps: [echo('original', 'fixed conversion value')] } } })
  await openAutomation(page, automation.id, name)
  await page.getByRole('button', { name: 'Preview as Graph', exact: true }).click()
  await page.getByRole('button', { name: 'Create Graph copy', exact: true }).click()
  const openCopy = page.getByRole('button', { name: 'Open saved copy', exact: true })
  await expect(openCopy).toBeVisible()
  const copy = copyFor(name)!, fixedCopy = structuredClone(draft(copy.id))
  await page.locator('.automation-step[data-node-id="original"]').click()
  const message = page.getByLabel('Message', { exact: true })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let intercepted = false, delivered = false, shown = false
  const dismiss = async (dialog: import('@playwright/test').Dialog) => { shown = true; await dialog.dismiss() }
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body?.procedure !== 'numen:automation-save-draft@1' || body.input?.automationId !== automation.id) { await route.continue(); return }
    intercepted = true
    await gate
    await route.continue()
    delivered = true
  })
  try {
    await message.fill('original edit after conversion')
    await message.press('Tab')
    await expect.poll(() => intercepted).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    expect((draft(automation.id).source.flow as import('../packages/core/dist/index.js').BlockSource).steps[0]).toMatchObject({ input: { message: { type: 'literal', value: 'fixed conversion value' } } })
    page.once('dialog', dismiss)
    await openCopy.click()
    await expect.poll(() => shown).toBe(true)
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(message).toHaveValue('original edit after conversion')
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    expect(draft(copy.id)).toEqual(fixedCopy)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
    page.off('dialog', dismiss)
  }
  expect(delivered).toBe(true)
  await saved(page)
  expect((draft(automation.id).source.flow as import('../packages/core/dist/index.js').BlockSource).steps[0]).toMatchObject({ input: { message: { type: 'literal', value: 'original edit after conversion' } } })
  await openCopy.click()
  await expect(page.getByRole('heading', { name: `${name} (Graph)`, exact: true })).toBeVisible()
  await saved(page)
  expect(draft(copy.id)).toEqual(fixedCopy)
  expect((draft(copy.id).source.flow as GraphSource).nodes[0]).toMatchObject({ input: { message: { type: 'literal', value: 'fixed conversion value' } } })
  await page.locator('.graph-node[data-node-id="original"]').click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('fixed conversion value')
})
