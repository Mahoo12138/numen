import { applyFreshHostConfig } from './helpers/host-config.js'
import { expect, test, type Page } from '@playwright/test'
import { writeConfig, type HostConfigPreview, type HostConfigImpact, type HostConfigOperation } from '../packages/config/dist/index.js'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Browser plugin unavailable: use the production bundle with isolated real Loader, SQLite and Scheduler.
// Product entry names deliberately do not resemble the registrations they own.
let application: NumenApplication, directory: string, configPath: string
let observations: { calls: string[]; releases: Array<() => void>; opens: number; closes: number }
let pendingDispatch: Promise<number> | undefined
let errors: string[]
const capability = { id: 'impact:task', version: 1 }
const adapter = { id: 'impact:wire', version: 1 }
const source = (connectionId: string, value = 'PRIVATE_INPUT_NOT_IMPACT_EVIDENCE'): AutomationSource => ({ triggers: [], flow: {
  type: 'capability', id: 'perform', capability, connections: { account: connectionId }, input: { value: { type: 'literal', value } },
} })

test.beforeEach(async ({ page }) => {
  errors = []; pendingDispatch = undefined
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', event => { if (event.type() === 'error') errors.push(`${event.text()} (${event.location().url})`) })
  directory = await mkdtemp(join(tmpdir(), 'numen-plugin-impact-e2e-'))
  configPath = join(directory, 'numen.config.yml')
  const pluginPath = join(directory, 'impact-fixture.mjs')
  const schemaUrl = pathToFileURL(createRequire(new URL('../packages/core/package.json', import.meta.url)).resolve('schemastery')).href
  await writeFile(pluginPath, `import z from ${JSON.stringify(schemaUrl)};
export const observations = { calls: [], releases: [], opens: 0, closes: 0 };
const type = { id: 'impact:account', version: 1, title: 'Account contract' };
const adapter = { id: 'impact:wire', version: 1, title: 'Account wire', type, config: z.object({ privateNote: z.string() }) };
const capability = { id: 'impact:task', version: 1, kind: 'action', title: 'External action',
 input: z.object({ value: z.string() }), output: z.object({ value: z.string() }),
 semantics: { sideEffect: true, idempotent: false, retrySafe: false },
 connections: [{ name: 'account', required: true, accepts: ['impact:account@1'] }] };
const Config = z.object({ kind: z.string() });
export const products = {
 catalog: { name: 'impact-catalogue', Config, inject: ['capabilities'], apply(ctx) {
   ctx.capabilities.define(ctx, capability); ctx.provide('impactCatalogueReady', capability);
 } },
 type: { name: 'impact-shape', Config, inject: ['connections'], apply(ctx) {
   ctx.connections.defineType(ctx, type); ctx.provide('impactTypeReady', type);
 } },
 adapter: { name: 'impact-protocol', Config, inject: ['connections', 'impactTypeReady'], apply(ctx) {
   ctx.connections.defineAdapter(ctx, adapter); ctx.provide('impactAdapterReady', adapter);
 } },
 engine: { name: 'impact-engine', Config, inject: ['capabilities', 'impactCatalogueReady'], apply(ctx) {
 ctx.capabilities.provide(ctx, capability, { async invoke({ input }) {
   observations.calls.push(input.value);
   if (input.value === 'hold') await new Promise(resolve => observations.releases.push(resolve));
   return input;
 } }); } },
 transport: { name: 'impact-socket', Config, inject: ['connections', 'impactAdapterReady'], apply(ctx) {
 ctx.connections.provideAdapter(ctx, adapter, { async open() {
   observations.opens++; return { value: { safe: true }, close() { observations.closes++; } };
 } }); } },
 unrelated: { name: 'impact-unrelated', Config, inject: ['capabilities', 'connections'], apply(ctx) {
   const other = { id: 'other:task', version: 1, kind: 'query', input: z.object({}), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } };
   ctx.capabilities.define(ctx, other); ctx.capabilities.provide(ctx, other, { async invoke() { return {}; } });
   const otherType = { id: 'other:account', version: 1, title: 'Other account' };
   const otherAdapter = { id: 'other:wire', version: 1, title: 'Other wire', type: otherType, config: z.object({}) };
   ctx.connections.defineType(ctx, otherType); ctx.connections.defineAdapter(ctx, otherAdapter);
   ctx.connections.provideAdapter(ctx, otherAdapter, { async open() { return { value: {} }; } });
 } },
 secret: { name: 'impact-secret', Config, apply() {} },
};
`)
  observations = (await import(pathToFileURL(pluginPath).href)).observations
  // Loader starts sibling Entries concurrently. Use explicit Definition readiness
  // dependencies, including Type -> Adapter, rather than relying on YAML key order.
  const productPaths = Object.fromEntries(await Promise.all(['catalog', 'type', 'adapter', 'engine', 'transport', 'unrelated', 'secret'].map(async kind => {
    const path = join(directory, `${kind}.mjs`)
    await writeFile(path, `import { products } from './impact-fixture.mjs'; export default products[${JSON.stringify(kind)}];\n`)
    return [kind, path] as const
  })))
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, automations: {}, scheduler: { autoDispatch: false }, triggers: {},
    console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
    'catalog:blue': { $package: productPaths.catalog, $label: 'Definition catalogue', kind: 'catalog' },
    'shape:amber': { $package: productPaths.type, kind: 'type' },
    'protocol:violet': { $package: productPaths.adapter, kind: 'adapter' },
    'group:workers': { $label: 'Independent workers', plugins: {
      'engine:green': { $package: productPaths.engine, $label: 'Action provider', kind: 'engine' },
      'socket:orange': { $package: productPaths.transport, $label: 'Adapter provider', kind: 'transport' },
    } },
    'group:destination': { $label: 'Destination', plugins: {} },
    'other:silver': { $package: productPaths.unrelated, kind: 'unrelated' },
    secret: { $package: productPaths.secret, kind: 'secret', password: 'SECRET_CONFIG_MUST_NOT_ENTER_IMPACT' },
    '~never:loaded': { $package: join(directory, 'never-installed.mjs'), password: 'UNLOADED_SECRET_MUST_NOT_ENTER_IMPACT' },
  } })
  application = await startRuntime({ configPath })
  await assertFixtureRegistrations()
})
test.afterEach(async () => {
  try { expect(errors).toEqual([]) }
  finally {
    for (const release of observations?.releases ?? []) release()
    await pendingDispatch
    await application?.stop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

async function assertFixtureRegistrations() {
  const snapshot = await application.context.hostConfig.read()
  const products = snapshot.entries.filter(entry => ['catalog-blue', 'shape-amber', 'protocol-violet', 'engine-green', 'socket-orange'].includes(entry.id))
  expect(products.map(entry => ({ id: entry.id, state: entry.actualState })), JSON.stringify(application.context.logs.query({ maxLevel: 1, limit: 30 }).records, null, 2)).toEqual([
    { id: 'catalog-blue', state: 'ACTIVE' }, { id: 'shape-amber', state: 'ACTIVE' }, { id: 'protocol-violet', state: 'ACTIVE' },
    { id: 'engine-green', state: 'ACTIVE' }, { id: 'socket-orange', state: 'ACTIVE' },
  ])
  expect(application.context.capabilities.get(capability)?.providerAvailable).toBe(true)
  expect(application.context.connections.resolveAdapterProvider(adapter)).toBeDefined()
}

async function plugins(page: Page) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-entry-id="catalog-blue"]')).toBeVisible()
  await expect(page).toHaveURL(/\/plugins\/installed(?:\?|$)/)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
}
async function preview(page: Page, action: () => Promise<unknown>): Promise<HostConfigPreview> {
  const response = page.waitForResponse(response => response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === 'numen:plugin-preview@1')
  await action()
  const received = await response
  expect(received.ok()).toBe(true)
  const result = (await received.json()).result as HostConfigPreview
  await expect(page.locator('.plugin-impact')).toBeVisible()
  return result
}
async function previewEnabled(page: Page, id: string, enabled = false) {
  await cancelPreview(page)
  return preview(page, () => page.locator(`[data-entry-id="${id}"]`).getByRole('button', { name: enabled ? 'Enable' : 'Disable', exact: true }).click())
}
async function cancelPreview(page: Page) {
  const panel = page.locator('.plugin-preview')
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
}
async function hostChange(operation: HostConfigOperation) {
  const result = await applyFreshHostConfig(application.context.hostConfig, { fingerprint: (await application.context.hostConfig.read()).fingerprint, operation })
  expect(result.runtimeApplied).toBe(true)
}
function publish(name: string, input: AutomationSource) {
  const ctx = application.context
  const { automation } = ctx.automations.create({ name, source: input })
  const revision = ctx.automations.publishDraft(automation.id, 1)
  ctx.automations.activateRevision(automation.id, revision.id)
  return { automation, revision }
}
async function account(enabled = true) {
  const connection = application.context.connections.create({ name: enabled ? 'Linked account' : 'Disabled account', adapter, enabled, config: { privateNote: 'PRIVATE_CONNECTION_NOT_IMPACT_EVIDENCE' } })
  await application.context.connections.reconcile()
  return connection
}
function node(impact: HostConfigImpact, kind: string, id: string) { return impact.nodes.find(item => item.kind === kind && item.id === id) }
function expectChain(impact: HostConfigImpact, role: 'definition' | 'provider', entryId: string, registrationId: string) {
  const entry = node(impact, 'entry', entryId)!
  const registration = impact.nodes.find(item => item.kind === 'registration' && item.id === registrationId && item.role === role)!
  expect(entry).toBeDefined(); expect(registration).toBeDefined()
  expect(impact.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: entry.key, to: registration.key, relation: `owns-${role}`, source: 'ownership' })]))
}
async function interruptedUnsafeRun() {
  const connection = await account(false)
  const linked = publish('Unsafe interrupted task', source(connection.id))
  const run = application.context.scheduler.startManual(linked.automation.id)
  await application.context.scheduler.dispatchUntilIdle()
  const execution = application.context.scheduler.listExecutions(run.id)[0]!
  expect(execution.status).toBe('BLOCKED')
  const now = new Date().toISOString()
  // Reproduce a durable process interruption before restart, as the Scheduler recovery regression does.
  application.context.database.db.prepare("UPDATE executions SET status = 'RUNNING', blocked_reason = NULL, updated_at = ? WHERE id = ?").run(now, execution.id)
  application.context.database.db.prepare("INSERT INTO attempts (id, execution_id, number, status, provider_ref, started_at) VALUES ('attempt_unsafe_browser', ?, 1, 'RUNNING', 'impact:task@1', ?)").run(execution.id, now)
  await application.stop(); application = await startRuntime({ configPath })
  await assertFixtureRegistrations()
  expect(application.context.scheduler.listExecutions(run.id)[0]).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
  expect(application.context.scheduler.listAttempts(run.id)[0]?.status).toBe('OUTCOME_UNKNOWN')
  return { ...linked, run, connection }
}

test('proves separate Definition and Provider ownership and excludes unrelated and Draft-only objects', async ({ page }, testInfo) => {
  const connection = await account()
  const linked = publish('Active linked revision', source(connection.id))
  const queued = application.context.scheduler.startManual(linked.automation.id)
  const draftOnly = application.context.automations.create({ name: 'Draft only future edit', source: source(connection.id) }).automation
  const unrelatedConnection = application.context.connections.create({ name: 'Unrelated account', adapter: { id: 'other:wire', version: 1 }, enabled: true, config: {} })
  const other = publish('Unrelated active revision', { triggers: [], flow: { type: 'capability', id: 'other', capability: { id: 'other:task', version: 1 }, input: {} } })
  const unrelatedRun = application.context.scheduler.startManual(other.automation.id)
  await plugins(page)
  const definition = await previewEnabled(page, 'catalog-blue')
  expect(definition.impact.status).toBe('known-impacts')
  expectChain(definition.impact, 'definition', 'catalog-blue', capability.id)
  expect(definition.impact.nodes.filter(item => item.kind === 'registration').every(item => item.kind === 'registration' && item.role === 'definition')).toBe(true)
  await expect(page.locator('[data-impact-node-kind="registration"]')).toContainText('Owns the declaration')
  expect(node(definition.impact, 'revision', linked.revision.id)).toBeDefined()
  expect(node(definition.impact, 'run', queued.id)).toMatchObject({ condition: 'not-started' })
  await expect(page.locator(`[data-impact-node-kind="run"][data-impact-id="${queued.id}"]`)).toBeVisible()
  const provider = await previewEnabled(page, 'engine-green')
  expectChain(provider.impact, 'provider', 'engine-green', capability.id)
  expect(provider.impact.nodes.filter(item => item.kind === 'registration').every(item => item.kind === 'registration' && item.role === 'provider')).toBe(true)
  await expect(page.locator('[data-impact-node-kind="registration"]')).toContainText('Owns the live implementation')
  const wire = await previewEnabled(page, 'socket-orange')
  expectChain(wire.impact, 'provider', 'socket-orange', adapter.id)
  expect(node(wire.impact, 'connection', connection.id)).toBeDefined()
  expect(node(wire.impact, 'revision', linked.revision.id)).toBeDefined()
  expect(node(wire.impact, 'run', queued.id)).toBeDefined()
  const wireDefinition = await previewEnabled(page, 'protocol-violet')
  expectChain(wireDefinition.impact, 'definition', 'protocol-violet', adapter.id)
  expect(wireDefinition.impact.edges.some(edge => edge.relation === 'uses-adapter')).toBe(true)
  const typeDefinition = await previewEnabled(page, 'shape-amber')
  expectChain(typeDefinition.impact, 'definition', 'shape-amber', 'impact:account')
  expect(typeDefinition.impact.edges.some(edge => edge.relation === 'uses-type')).toBe(true)
  for (const result of [definition, provider, wire, wireDefinition, typeDefinition]) {
    expect(result.impact.truncated).toBe(false)
    expect(Number.isNaN(Date.parse(result.impact.computedAt))).toBe(false)
    expect(result.impact.coverage).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'drafts', status: 'excluded' })]))
    for (const id of [draftOnly.id, unrelatedConnection.id, other.revision.id, unrelatedRun.id]) expect(JSON.stringify(result.impact)).not.toContain(id)
    for (const secret of ['PRIVATE_INPUT_NOT_IMPACT_EVIDENCE', 'PRIVATE_CONNECTION_NOT_IMPACT_EVIDENCE', 'SECRET_CONFIG_MUST_NOT_ENTER_IMPACT']) expect(JSON.stringify(result)).not.toContain(secret)
  }
  await page.locator('.plugin-impact-edges > summary').click()
  await expect(page.locator('[data-impact-relation="uses-type"]')).toContainText(connection.id)
  await page.locator('.plugin-impact-coverage > summary').click()
  await expect(page.locator('[data-impact-source="drafts"]')).toHaveAttribute('data-impact-coverage', 'excluded')
  await page.locator('.plugin-impact').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('plugin-impact-desktop.png'), fullPage: false })
  await testInfo.attach('independent-definition-provider-evidence', { body: JSON.stringify({ definition, provider, wire, wireDefinition, typeDefinition }, null, 2), contentType: 'application/json' })
  const inspect = page.locator(`[data-impact-node-kind="connection"][data-impact-id="${connection.id}"]`).getByRole('button')
  let discarded = false
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); discarded = true; await dialog.dismiss() })
  await inspect.click()
  expect(discarded).toBe(true)
  await expect(page).toHaveURL(/\/plugins\/installed(?:\?|$)/)
  await expect(page.locator('.plugin-impact')).toBeVisible()
  let confirmed = false
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); confirmed = true; await dialog.accept() })
  await inspect.click()
  expect(confirmed).toBe(true)
  await expect(page).toHaveURL(new RegExp(`connectionId=${connection.id}`))
  await expect(page.locator('.connections-table tr[data-selected="true"]')).toContainText('Linked account')
})

test('distinguishes queued, blocked, waiting, external-running and uncertain outcomes without invoking or retrying', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const uncertain = await interruptedUnsafeRun()
  const ready = await account(), unavailable = await account(false)
  const completed = publish('Finished task', source(ready.id, 'completed'))
  const completedRun = application.context.scheduler.startManual(completed.automation.id)
  await application.context.scheduler.dispatchUntilIdle()
  expect(application.context.scheduler.getRun(completedRun.id)?.status).toBe('COMPLETED')
  const blocked = publish('Blocked account task', source(unavailable.id))
  const blockedRun = application.context.scheduler.startManual(blocked.automation.id)
  const waiting = publish('Timer before task', { triggers: [], flow: { type: 'block', id: 'sequence', steps: [
    { type: 'wait', id: 'timer', durationMs: { type: 'literal', value: 3_600_000 } }, source(ready.id).flow,
  ] } })
  const waitingRun = application.context.scheduler.startManual(waiting.automation.id)
  await application.context.scheduler.dispatchUntilIdle()
  expect(application.context.scheduler.listExecutions(blockedRun.id)[0]?.status).toBe('BLOCKED')
  expect(application.context.scheduler.listExecutions(waitingRun.id).some(execution => execution.status === 'WAITING')).toBe(true)
  const running = publish('Held external task', source(ready.id, 'hold'))
  const runningRun = application.context.scheduler.startManual(running.automation.id)
  pendingDispatch = application.context.scheduler.dispatchUntilIdle()
  await expect.poll(() => observations.calls).toContain('hold')
  const queuedRun = application.context.scheduler.startManual(completed.automation.id)
  expect(application.context.scheduler.getRun(queuedRun.id)?.status).toBe('QUEUED')
  await plugins(page)
  const before = [...observations.calls]
  const result = await previewEnabled(page, 'engine-green')
  const expected: Record<string, string> = { [uncertain.run.id]: 'outcome-unknown', [blockedRun.id]: 'blocked', [waitingRun.id]: 'waiting', [runningRun.id]: 'executing-external-action', [queuedRun.id]: 'not-started' }
  for (const [id, condition] of Object.entries(expected)) {
    expect(node(result.impact, 'run', id)).toMatchObject({ condition })
    const row = page.locator(`[data-impact-node-kind="run"][data-impact-id="${id}"]`)
    await expect(row).toBeVisible()
    await expect(row.locator('.plugin-impact-run-condition')).toHaveAttribute('data-impact-run-condition', condition)
  }
  expect(node(result.impact, 'run', completedRun.id)).toBeUndefined()
  expect(observations.calls).toEqual(before)
  await previewEnabled(page, 'engine-green')
  expect(observations.calls).toEqual(before)
  const descriptions = await page.locator('.plugin-impact-run-condition').allTextContents()
  expect(new Set(descriptions).size).toBe(descriptions.length)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await page.locator('[data-impact-node-kind="run"]').first().evaluate(element => element.closest('section')!.scrollIntoView({ block: 'start' }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-impact-mobile-zh.png'), fullPage: false })
  await testInfo.attach('run-conditions', { body: JSON.stringify(result.impact, null, 2), contentType: 'application/json' })
})

test('keeps group history separate, restores without replaying uncertain work and retains ownership after a move', async ({ page }) => {
  test.setTimeout(90_000)
  const uncertain = await interruptedUnsafeRun()
  const ready = await account()
  const linked = publish('Worker restore task', source(ready.id, 'after-restore'))
  await plugins(page)
  const before = await previewEnabled(page, 'group-workers')
  expectChain(before.impact, 'provider', 'engine-green', capability.id)
  expectChain(before.impact, 'provider', 'socket-orange', adapter.id)
  expect(before.impact.edges.some(edge => edge.relation === 'contains')).toBe(true)
  await apply(page)
  expect(observations.calls).toEqual([])
  const blocked = application.context.scheduler.startManual(linked.automation.id)
  await application.context.scheduler.dispatchUntilIdle()
  expect(application.context.scheduler.listExecutions(blocked.id)[0]?.status).toBe('BLOCKED')
  const restore = await previewEnabled(page, 'group-workers', true)
  expect(restore.impact.status).toBe('unknown')
  expect(restore.impact.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ entryId: 'engine-green', role: 'provider', registration: { kind: 'capability', ...capability } }),
    expect.objectContaining({ entryId: 'socket-orange', role: 'provider', registration: { kind: 'connection-adapter', ...adapter } }),
  ]))
  expect(restore.impact.nodes.some(item => item.kind === 'run' || item.kind === 'connection' || item.kind === 'revision')).toBe(false)
  expect(restore.impact.edges.some(edge => edge.relation === 'owns-provider')).toBe(false)
  await page.locator('.plugin-impact-history > summary').click()
  await expect(page.locator('.plugin-impact-history')).toContainText('engine-green')
  await expect(page.locator('.plugin-impact-history')).toContainText('socket-orange')
  await expect(page.locator('[data-impact-node-kind="run"]')).toHaveCount(0)
  await apply(page)
  expect(observations.calls).toEqual([])
  expect(application.context.scheduler.listAttempts(uncertain.run.id).map(attempt => attempt.status)).toEqual(['OUTCOME_UNKNOWN'])
  await application.context.connections.reconcile()
  await application.context.scheduler.dispatchUntilIdle()
  expect(observations.calls).toEqual(['after-restore'])
  expect(application.context.scheduler.getRun(blocked.id)?.status).toBe('COMPLETED')
  expect(application.context.scheduler.getRun(uncertain.run.id)?.status).toBe('RUNNING')
  await page.locator('[data-entry-id="engine-green"]').getByRole('button', { name: 'Edit instance', exact: true }).click()
  const editor = page.locator('.plugin-editor')
  await editor.getByLabel('Operation', { exact: true }).selectOption('move')
  await editor.getByLabel('Parent group', { exact: true }).selectOption('group-destination')
  await preview(page, () => editor.getByRole('button', { name: 'Preview change', exact: true }).click())
  await apply(page)
  const moved = await previewEnabled(page, 'engine-green')
  expectChain(moved.impact, 'provider', 'engine-green', capability.id)
  expect((await application.context.hostConfig.read()).entries.find(entry => entry.id === 'engine-green')?.parentId).toBe('group-destination')
  expect(application.context.connections.get(ready.id)).toMatchObject({ id: ready.id, generation: ready.generation })
  expect(observations.calls).toEqual(['after-restore'])
})

test('shows never-loaded and post-restart missing observations as unknown while preserving read-only secrets', async ({ page }) => {
  await account()
  await hostChange({ kind: 'setEnabled', id: 'group-workers', enabled: false })
  const previous = await application.context.hostConfig.preview({ fingerprint: (await application.context.hostConfig.read()).fingerprint, operation: { kind: 'setEnabled', id: 'group-workers', enabled: true } })
  expect(previous.impact.history.length).toBeGreaterThan(0)
  await application.stop(); application = await startRuntime({ configPath })
  await plugins(page)
  const restarted = await previewEnabled(page, 'group-workers', true)
  expect(restarted.impact.history).toEqual([])
  expect(restarted.impact.status).toBe('unknown')
  expect(restarted.impact.unknownReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'entry-not-observed', entryId: 'engine-green' })]))
  await expect(page.locator('[data-impact-unknown="entry-not-observed"]').filter({ hasText: 'engine-green' })).toBeVisible()
  const never = await previewEnabled(page, 'never-loaded', true)
  expect(never.impact.status).toBe('unknown')
  expect(never.impact.history).toEqual([])
  expect(never.impact.nodes.some(item => item.kind !== 'entry')).toBe(false)
  expect(never.impact.unknownReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'entry-not-observed', entryId: 'never-loaded' })]))
  await cancelPreview(page)
  await page.locator('[data-entry-id="secret"]').getByRole('button', { name: 'Edit instance', exact: true }).click()
  await expect(page.locator('.plugin-editor').getByLabel('Operation', { exact: true }).locator('option[value="setConfig"]')).toHaveAttribute('disabled', '')
  expect((await application.context.hostConfig.read()).entries.find(entry => entry.id === 'secret')).toMatchObject({ configEditable: false, config: {} })
  await expect(page.locator('[data-entry-id="workbench"]').getByRole('button', { name: 'Disable', exact: true })).toBeDisabled()
  for (const canary of ['SECRET_CONFIG_MUST_NOT_ENTER_IMPACT', 'UNLOADED_SECRET_MUST_NOT_ENTER_IMPACT']) {
    expect(await page.locator('body').textContent()).not.toContain(canary)
    expect(JSON.stringify([restarted, never])).not.toContain(canary)
  }
  const before = await readFile(configPath, 'utf8')
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  const editor = page.locator('.plugin-editor')
  await editor.getByLabel('Stable group identifier', { exact: true }).fill('future')
  const metadata = await preview(page, () => editor.getByRole('button', { name: 'Preview change', exact: true }).click())
  expect(metadata.impact.operationEffect).toBe('metadata-only')
  expect(metadata.impact.status).toBe('no-known-impacts')
  expect(await readFile(configPath, 'utf8')).toBe(before)
})

test('labels a bounded partial source without presenting omitted Connections as unaffected', async ({ page }) => {
  for (let index = 0; index < 130; index++) application.context.connections.create({
    name: `Bounded account ${index}`, adapter, enabled: false, config: { privateNote: 'BOUND_PRIVATE_CONFIG' },
  })
  await plugins(page)
  const result = await previewEnabled(page, 'socket-orange')
  expect(result.impact.status).toBe('known-impacts')
  expect(result.impact.truncated).toBe(true)
  const coverage = result.impact.coverage.find(item => item.source === 'connections')!
  expect(coverage).toMatchObject({ status: 'partial', truncated: true })
  expect(result.impact.nodes.filter(item => item.kind === 'connection')).toHaveLength(coverage.limit)
  expect(result.impact.unknownReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-incomplete', source: 'connections' })]))
  await expect(page.locator('.plugin-impact-notice[role="status"]')).toBeVisible()
  await expect(page.locator('[data-impact-source="connections"]')).toHaveAttribute('data-impact-coverage', 'partial')
  await expect(page.locator('[data-impact-unknown="source-incomplete"]')).toBeVisible()
  expect(JSON.stringify(result)).not.toContain('BOUND_PRIVATE_CONFIG')
})
