import { expect, test, type Page } from '@playwright/test'
import { loadConfig, writeConfig, type HostConfigMutationRequest, type HostConfigOperation, type HostConfigPreview } from '../packages/config/dist/index.js'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Browser plugin not available. Exercise the production Chromium bundle and real
// Loader, Console, SQLite and Scheduler using only temporary local fixtures.
// Flow: Plugins -> Preview -> same-fingerprint runtime change -> rejected Apply
// -> retained input and evidence -> explicit updated Preview -> reviewed Apply.
let application: NumenApplication, directory: string, configPath: string
let controls: { replaceTarget(): void; replaceUnrelated(): void; calls: number; starts: number }
let errors: string[], expectedConflicts: number, observedConflicts: number, expectedNetworkFailures: number, observedNetworkFailures: number
const capability = { id: 'expiry:task', version: 1 }, adapter = { id: 'expiry:wire', version: 1 }
const unrelatedCapability = { id: 'elsewhere:task', version: 1 }, unrelatedAdapter = { id: 'elsewhere:wire', version: 1 }
const source = (connectionId: string, unrelated = false): AutomationSource => ({ triggers: [], flow: {
  type: 'capability', id: 'call', capability: unrelated ? unrelatedCapability : capability,
  connections: { account: connectionId }, input: {},
} })

test.beforeEach(async ({ page }) => {
  errors = []; expectedConflicts = 0; observedConflicts = 0; expectedNetworkFailures = 0; observedNetworkFailures = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', event => {
    if (event.type() !== 'error') return
    const message = event.text()
    if (message === 'Failed to load resource: the server responded with a status of 409 (Conflict)' && event.location().url === new URL('/api/console/call', application.workbenchUrl!).href && observedConflicts < expectedConflicts) observedConflicts++
    else if (message === 'Failed to load resource: net::ERR_FAILED' && event.location().url === new URL('/api/console/call', application.workbenchUrl!).href && observedNetworkFailures < expectedNetworkFailures) observedNetworkFailures++
    else errors.push(`${message} (${event.location().url})`)
  })
  directory = await mkdtemp(join(tmpdir(), 'numen-preview-expiry-')); configPath = join(directory, 'numen.config.yml')
  const fixture = join(directory, 'fixture.mjs')
  const schemaUrl = pathToFileURL(createRequire(new URL('../packages/core/package.json', import.meta.url)).resolve('schemastery')).href
  await writeFile(fixture, `import z from ${JSON.stringify(schemaUrl)};
export const controls = { calls: 0, starts: 0 };
const type = { id: 'expiry:account', version: 1, title: 'Account' };
const adapter = { id: 'expiry:wire', version: 1, title: 'Wire', type, config: z.object({ privateNote: z.string() }) };
const capability = { id: 'expiry:task', version: 1, kind: 'action', title: 'Action', input: z.object({}), output: z.object({}), semantics: { sideEffect: true, idempotent: false, retrySafe: false }, connections: [{ name: 'account', required: true, accepts: ['expiry:account@1'] }] };
const Config = z.object({ note: z.string() });
export const products = {
 catalog: { name: 'expiry-catalog', inject: ['capabilities', 'connections'], apply(ctx) {
   ctx.capabilities.define(ctx, capability); ctx.connections.defineType(ctx, type); ctx.connections.defineAdapter(ctx, adapter); ctx.provide('expiryDefinitionsReady', true);
 } },
 worker: { name: 'expiry-worker', Config, inject: ['capabilities', 'connections', 'expiryDefinitionsReady'], apply(ctx) {
   controls.starts++;
   const install = () => ctx.capabilities.provide(ctx, capability, { async invoke() { controls.calls++; return {}; } });
   let release = install(); controls.replaceTarget = () => { release(); release = install(); };
   ctx.connections.provideAdapter(ctx, adapter, { async open() { return { value: {} }; } });
 } },
 unrelated: { name: 'expiry-unrelated', inject: ['capabilities', 'connections'], apply(ctx) {
   const otherType = { ...type, id: 'elsewhere:account' };
   const otherAdapter = { ...adapter, id: 'elsewhere:wire', type: otherType };
   const otherCapability = { ...capability, id: 'elsewhere:task', connections: [{ name: 'account', required: true, accepts: ['elsewhere:account@1'] }] };
   ctx.capabilities.define(ctx, otherCapability); ctx.connections.defineType(ctx, otherType); ctx.connections.defineAdapter(ctx, otherAdapter);
   const install = () => ctx.capabilities.provide(ctx, otherCapability, { async invoke() { controls.calls++; return {}; } });
   let release = install(); controls.replaceUnrelated = () => { release(); release = install(); };
   ctx.connections.provideAdapter(ctx, otherAdapter, { async open() { return { value: {} }; } });
 } },
};
`)
  controls = (await import(pathToFileURL(fixture).href)).controls
  const productPaths = Object.fromEntries(await Promise.all(['catalog', 'worker', 'unrelated'].map(async kind => {
    const path = join(directory, `${kind}.mjs`)
    await writeFile(path, `import { products } from './fixture.mjs'; export default products[${JSON.stringify(kind)}];\n`)
    return [kind, path] as const
  })))
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {}, resources: { path: 'data/resources' },
    connections: {}, automations: {}, scheduler: { autoDispatch: false }, triggers: {},
    'group:management': { plugins: { console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {} } },
    catalog: { $package: productPaths.catalog },
    'group:workers': { plugins: { target: { $package: productPaths.worker, note: 'original' } } },
    unrelated: { $package: productPaths.unrelated },
    'group:sleeping': { $if: false, plugins: {} },
  } })
  application = await startRuntime({ configPath })
  const state = await application.context.hostConfig.read()
  expect(state.entries.filter(entry => ['catalog', 'target', 'unrelated'].includes(entry.id)).map(entry => entry.actualState), JSON.stringify(application.context.logs.query({ maxLevel: 1, limit: 30 }).records)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE'])
  expect(application.context.capabilities.get(capability)?.providerAvailable).toBe(true)
})
test.afterEach(async () => {
  try { expect(errors).toEqual([]); expect(observedConflicts).toBe(expectedConflicts); expect(observedNetworkFailures).toBe(expectedNetworkFailures) }
  finally { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) }
})

async function plugins(page: Page) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-entry-id="target"]')).toBeVisible()
  await expect(page).toHaveURL(/\/plugins\/installed(?:\?|$)/)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
}
async function preview(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === 'numen:plugin-preview@1')
  await action()
  const received = await response
  expect(received.ok()).toBe(true)
  const result = (await received.json()).result as HostConfigPreview
  expect(result.previewToken).toEqual(expect.any(String))
  await expect(page.locator('.plugin-preview')).toBeVisible()
  return result
}
async function rejectStale(page: Page) {
  expectedConflicts++
  const response = page.waitForResponse(response => response.request().postDataJSON()?.procedure === 'numen:plugin-apply@1')
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  const received = await response
  expect(received.status()).toBe(409)
  expect(await received.json()).toMatchObject({ error: { code: 'PREVIEW_STALE', details: { saved: false } } })
  await expect(page.locator('.plugin-preview')).toHaveAttribute('data-preview-expired', 'true')
  await expect(page.getByRole('button', { name: 'Save and apply this change', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Review updated preview', exact: true })).toBeVisible()
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
}
async function account(unrelated = false) {
  const result = application.context.connections.create({ name: unrelated ? 'Elsewhere' : 'Related', adapter: unrelated ? unrelatedAdapter : adapter, enabled: true, config: { privateNote: 'PRIVATE_CONNECTION_NOT_IN_PREVIEW' } })
  await application.context.connections.reconcile()
  return result
}
function publish(connectionId: string, unrelated = false) {
  const { automation } = application.context.automations.create({ name: unrelated ? 'Unrelated automation' : 'Related automation', source: source(connectionId, unrelated) })
  const revision = application.context.automations.publishDraft(automation.id, 1)
  application.context.automations.activateRevision(automation.id, revision.id)
  return { automation, revision }
}
function recordCalls(page: Page) {
  const calls: Array<{ procedure: string; input: HostConfigMutationRequest & { previewToken?: string } }> = []
  page.on('request', request => {
    if (!request.url().endsWith('/api/console/call') || request.method() !== 'POST') return
    const call = request.postDataJSON()
    if (call.procedure === 'numen:plugin-preview@1' || call.procedure === 'numen:plugin-apply@1') calls.push(call)
  })
  return calls
}

test('retains edited input and old evidence after Provider replacement until an explicit updated review', async ({ page }, testInfo) => {
  const connection = await account(); publish(connection.id)
  await plugins(page)
  const before = await readFile(configPath, 'utf8'), baseline = await application.context.hostConfig.read(), starts = controls.starts
  const calls = recordCalls(page), pending = { note: 'Keep this local input', extra: { preserved: true } }
  await page.locator('[data-entry-id="target"]').getByRole('button', { name: 'Edit instance', exact: true }).click()
  const editor = page.locator('.plugin-editor')
  await editor.getByRole('button', { name: 'Advanced JSON', exact: true }).click()
  const config = editor.getByLabel('Plugin configuration (JSON)', { exact: true })
  await config.fill(JSON.stringify(pending, null, 2))
  const first = await preview(page, () => editor.getByRole('button', { name: 'Preview change', exact: true }).click())
  controls.replaceTarget()
  expect((await application.context.hostConfig.read()).fingerprint).toBe(baseline.fingerprint)
  await rejectStale(page)
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(controls.starts).toBe(starts); expect(controls.calls).toBe(0)
  await expect(config).toHaveValue(JSON.stringify(pending, null, 2))
  await expect(page.locator('[data-impact-node-kind="registration"]')).toHaveCount(first.impact.nodes.filter(node => node.kind === 'registration').length)
  await page.locator('.plugin-preview').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('preview-expired-desktop.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('preview-expired-mobile.png'), fullPage: false })
  await page.getByRole('button', { name: 'Review updated preview', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('preview-expired-mobile-actions.png'), fullPage: false })
  // A failed renewed observation must not discard the expired quick/form intent.
  expectedNetworkFailures++
  const abortPreview = async (route: import('@playwright/test').Route) => {
    if (route.request().postDataJSON()?.procedure === 'numen:plugin-preview@1') await route.abort('failed')
    else await route.continue()
  }
  await page.route('**/api/console/call', abortPreview)
  const rejected = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/console/call') && request.postDataJSON()?.procedure === 'numen:plugin-preview@1')
  await page.getByRole('button', { name: 'Review updated preview', exact: true }).click()
  await rejected
  await expect(page.getByText('Failed to fetch', { exact: true })).toBeVisible()
  await expect(page.locator('.plugin-preview')).toHaveAttribute('data-preview-expired', 'true')
  await expect(page.getByRole('button', { name: 'Review updated preview', exact: true })).toBeEnabled()
  await expect(config).toHaveValue(JSON.stringify(pending, null, 2))
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toHaveLength(1)
  await page.unroute('**/api/console/call', abortPreview)
  const reviewed = await preview(page, () => page.getByRole('button', { name: 'Review updated preview', exact: true }).click())
  expect(reviewed.previewToken).not.toBe(first.previewToken)
  expect(reviewed.operation).toEqual(first.operation)
  expect(reviewed.fingerprint).toBe(first.fingerprint)
  expect(await readFile(configPath, 'utf8')).toBe(before)
  await expect(config).toHaveValue(JSON.stringify(pending, null, 2))
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toHaveLength(1)
  await expect(page.getByRole('button', { name: 'Save and apply this change', exact: true })).toBeEnabled()
  await apply(page)
  expect((await loadConfig(configPath)).config.plugins['group:workers']!.plugins!.target).toMatchObject(pending)
  expect(controls.calls).toBe(0); expect(controls.starts).toBe(starts + 1)
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1').map(call => call.input.previewToken)).toEqual([first.previewToken, reviewed.previewToken])
  await testInfo.attach('expired-preview-review-cycle', { body: JSON.stringify({ first, reviewed, calls }, null, 2), contentType: 'application/json' })
})

for (const change of ['Connection configuration', 'new related Run'] as const) {
  test(`rejects the old review after ${change} changes under the same configuration fingerprint`, async ({ page }, testInfo) => {
    const connection = await account(), linked = publish(connection.id)
    await plugins(page)
    const baseline = await application.context.hostConfig.read(), before = await readFile(configPath, 'utf8')
    const first = await preview(page, () => page.locator('[data-entry-id="target"]').getByRole('button', { name: 'Disable', exact: true }).click())
    let newRunId: string | undefined
    if (change === 'Connection configuration') application.context.connections.update({ id: connection.id, expectedGeneration: connection.generation, config: { privateNote: 'ROTATED_PRIVATE_CONNECTION' } })
    else newRunId = application.context.scheduler.startManual(linked.automation.id).id
    expect((await application.context.hostConfig.read()).fingerprint).toBe(baseline.fingerprint)
    await rejectStale(page)
    expect(await readFile(configPath, 'utf8')).toBe(before)
    expect(controls.calls).toBe(0)
    const reviewed = await preview(page, () => page.getByRole('button', { name: 'Review updated preview', exact: true }).click())
    if (newRunId) expect(reviewed.impact.nodes).toContainEqual(expect.objectContaining({ kind: 'run', id: newRunId, condition: 'not-started' }))
    for (const result of [first, reviewed]) expect(JSON.stringify(result)).not.toContain('PRIVATE_CONNECTION')
    expect(reviewed.previewToken).not.toBe(first.previewToken)
    await apply(page)
    expect((await application.context.hostConfig.read()).entries.find(entry => entry.id === 'target')?.selfEnabled).toBe(false)
    expect(controls.calls).toBe(0)
    await testInfo.attach('same-fingerprint-observation-change', { body: JSON.stringify({ change, baseline: baseline.fingerprint, first, reviewed }, null, 2), contentType: 'application/json' })
  })
}

test('allows the reviewed change when only unrelated registrations, Connections and Runs change', async ({ page }) => {
  const connection = await account(), otherConnection = await account(true)
  publish(connection.id); const other = publish(otherConnection.id, true)
  await plugins(page)
  const first = await preview(page, () => page.locator('[data-entry-id="target"]').getByRole('button', { name: 'Disable', exact: true }).click())
  controls.replaceUnrelated()
  application.context.connections.update({ id: otherConnection.id, expectedGeneration: otherConnection.generation, config: { privateNote: 'UNRELATED_ROTATION' } })
  const otherRun = application.context.scheduler.startManual(other.automation.id)
  expect((await application.context.hostConfig.read()).fingerprint).toBe(first.fingerprint)
  await apply(page)
  expect((await application.context.hostConfig.read()).entries.find(entry => entry.id === 'target')?.selfEnabled).toBe(false)
  expect(application.context.scheduler.getRun(otherRun.id)?.status).toBe('QUEUED')
  expect(controls.calls).toBe(0)
})

test('requires the exact reviewed operation and keeps management providers and ancestor groups protected at the endpoint', async ({ page }) => {
  await plugins(page)
  const baseline = await application.context.hostConfig.read(), before = await readFile(configPath, 'utf8')
  const operation: HostConfigOperation = { kind: 'setLabel', id: 'target', label: 'Reviewed label' }
  const legitimate = await application.context.hostConfig.preview({ fingerprint: baseline.fingerprint, operation })
  expect(legitimate.previewToken).toEqual(expect.any(String))
  const endpoint = new URL('/api/console/call', application.serverUrl!).href
  const call = async (input: unknown) => page.request.post(endpoint, { headers: { origin: new URL(endpoint).origin }, data: { kind: 'action', procedure: 'numen:plugin-apply@1', input } })
  const forged = await call({ fingerprint: baseline.fingerprint, operation: { ...operation, label: 'Unreviewed label' }, previewToken: legitimate.previewToken })
  expect(forged.status()).toBe(409)
  expect(await forged.json()).toMatchObject({ error: { code: 'PREVIEW_STALE', details: { saved: false } } })
  const missing = await call({ fingerprint: baseline.fingerprint, operation })
  expect(missing.status()).toBe(422)
  expect(await missing.json()).toMatchObject({ error: { code: 'PROCEDURE_VALIDATION_FAILED' } })
  for (const id of ['group-management', 'console', 'server', 'workbench']) {
    expect(baseline.entries.find(entry => entry.id === id)?.protected).toBe(true)
    for (const blocked of [{ kind: 'setEnabled', id, enabled: false }, { kind: 'move', id, parentId: 'group-sleeping' }] as HostConfigOperation[]) {
      const deniedPreview = await application.context.hostConfig.preview({ fingerprint: baseline.fingerprint, operation: blocked })
      expect(deniedPreview.blockedReason).toContain('management')
      expect(deniedPreview.previewToken).toBeUndefined()
      const denied = await call({ fingerprint: baseline.fingerprint, operation: blocked, previewToken: legitimate.previewToken })
      expect(denied.ok()).toBe(false)
      expect(await denied.json()).toMatchObject({ error: { code: 'MANAGEMENT_CHANNEL_PROTECTED', details: { saved: false } } })
    }
  }
  expect(await readFile(configPath, 'utf8')).toBe(before)
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  expect((await application.context.hostConfig.read()).fingerprint).toBe(baseline.fingerprint)
  expect(controls.calls).toBe(0)
})
