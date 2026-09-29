import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import type { TriggerActivation } from '../packages/core/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real Loader-owned fixtures: no external account, network service, or user configuration.
let application: NumenApplication, directory: string, configPath: string
let observations: { active: number; opens: number; closes: number; unused: number; activations: TriggerActivation[] }
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-product-acceptance-'))
  configPath = join(directory, 'numen.config.yml')
  const pluginPath = join(directory, 'integration.mjs')
  const entryPath = join(directory, 'entry.js')
  const schemaUrl = pathToFileURL(createRequire(new URL('../packages/core/package.json', import.meta.url)).resolve('schemastery')).href
  await writeFile(entryPath, `export default function (ctx) {
    ctx.effect(() => { document.documentElement.dataset.acceptanceEntry = 'loaded';
      return () => { delete document.documentElement.dataset.acceptanceEntry } })
  }`)
  await writeFile(pluginPath, `
    import z from ${JSON.stringify(schemaUrl)}
    export const observations = { active: 0, opens: 0, closes: 0, unused: 0, activations: [] }
    export default function integration(ctx, config) {
      if (config.kind === 'unused') { observations.unused++; return }
      const type = { id: 'acceptance:account', version: 1, title: 'Fixture account' }
      if (config.kind === 'adapter') {
        const adapter = { id: 'acceptance:adapter', version: 1, title: 'Fixture adapter', type, config: z.object({}) }
        ctx.connections.defineType(ctx, type)
        ctx.connections.defineAdapter(ctx, adapter)
        ctx.connections.provideAdapter(ctx, adapter, { async open() {
          observations.opens++
          return { value: { name: 'fixture' }, close() { observations.closes++ } }
        } })
        return
      }
      const contract = { version: 1, input: z.object({ message: z.string() }), output: z.object({ message: z.string() }),
        semantics: { sideEffect: false, idempotent: true, retrySafe: true },
        connections: [{ name: 'account', required: true, accepts: ['acceptance:account@1'] }] }
      const echo = { ...contract, id: 'acceptance:echo', kind: 'query', title: 'Fixture echo' }
      const event = { ...contract, id: 'acceptance:event', kind: 'trigger', title: 'Fixture event' }
      ctx.capabilities.define(ctx, echo)
      ctx.capabilities.provide(ctx, echo, { async invoke({ input }) { return input } })
      ctx.capabilities.define(ctx, event)
      ctx.capabilities.provideTrigger(ctx, event, { activate(activation) {
        observations.activations.push(activation); observations.active++
        return () => { observations.active-- }
      } })
      ctx.consoleEntries.addEntry(ctx, { id: 'acceptance:entry', prod: ${JSON.stringify(entryPath)} })
    }
    integration.inject = ['capabilities', 'connections', 'consoleEntries']
  `)
  observations = (await import(pathToFileURL(pluginPath).href)).observations
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
    'group:dependencies': { $label: 'Fixture dependencies', $collapsed: true, plugins: {
      'fixture:adapter': { $package: pluginPath, kind: 'adapter' },
      'fixture:events': { $package: pluginPath, kind: 'events' },
      '~fixture:unused': { $package: pluginPath, kind: 'unused' },
    } },
    'group:destination': { plugins: {} },
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

async function apply(page: Page) {
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
}

test('recovers grouped dependencies while a disconnected editor has an in-flight save, conflict and pending input', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000)
  const admin = await context.newPage()
  const errors: string[] = []
  const expectedErrors = new Map<Page, string[]>([
    [page, ['Failed to load resource: the server responded with a status of 409 (Conflict)']],
    [admin, ['Failed to load resource: net::ERR_FAILED']],
  ])
  for (const browser of [page, admin]) {
    browser.on('pageerror', error => errors.push(error.message))
    browser.on('console', event => {
      if (event.type() !== 'error') return
      const allowed = expectedErrors.get(browser)!
      const index = allowed.indexOf(event.text())
      if (index >= 0 && event.location().url === new URL('/api/console/call', application.serverUrl).href) allowed.splice(index, 1)
      else errors.push(event.text())
    })
  }
  const ctx = application.context
  const connection = ctx.connections.create({ name: 'Acceptance account', adapter: { id: 'acceptance:adapter', version: 1 }, config: {}, enabled: true })
  await ctx.connections.reconcile()
  const { automation } = ctx.automations.create({ name: 'Dependency recovery', source: {
    triggers: [{ id: 'event', capability: { id: 'acceptance:event', version: 1 }, connections: { account: connection.id }, config: {} }],
    flow: { type: 'block', id: 'flow', steps: [{ type: 'capability', id: 'echo', capability: { id: 'acceptance:echo', version: 1 },
      connections: { account: connection.id }, input: { message: { type: 'literal', value: 'recovered' } } }] },
  } })
  const revision = ctx.automations.publishDraft(automation.id, 1)
  ctx.automations.activateRevision(automation.id, revision.id)
  ctx.automations.setEnabled(automation.id, true)
  await expect.poll(() => observations.active).toBe(1)
  const originalSubscription = observations.activations[0]!
  const { automation: editing } = ctx.automations.create({ name: 'Protected editor', source: { triggers: [], flow: {
    type: 'block', id: 'flow', steps: [{ type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: 'http://127.0.0.1:1/original' }, headers: { type: 'literal', value: {} },
    } }],
  } } })
  const originalDraft = structuredClone(ctx.automations.getDraft(editing.id)!)
  let socket: { close(): void } | undefined, sockets = 0
  await page.routeWebSocket('**/api/console/subscribe', route => { sockets++; socket = route.connectToServer() })
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.locator('html')).toHaveAttribute('data-acceptance-entry', 'loaded')
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: 'Protected editor' }).click()
  await page.locator('[data-node-id="request"]').click()
  let release!: () => void, captured = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== 'numen:automation-save-draft@1') return route.continue()
    captured = true
    await gate
    await route.fulfill({ response: await route.fetch() })
  })
  try {
    await page.getByLabel('URL', { exact: true }).fill('http://127.0.0.1:1/local-loser')
    await page.getByLabel('URL', { exact: true }).press('Tab')
    await expect.poll(() => captured).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    const headers = page.getByLabel('Headers', { exact: true })
    await headers.fill('{"unfinished":')
    await headers.press('Tab')
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: 'Runs', exact: true }).click()
    await expect(headers).toHaveValue('{"unfinished":')
    const previousSockets = sockets
    socket!.close()

    await admin.goto(application.workbenchUrl!)
    await admin.getByRole('button', { name: 'Plugins', exact: true }).click()
    const group = admin.locator('[data-entry-id="group-dependencies"]')
    await group.getByRole('button', { name: 'Disable', exact: true }).click()
    let writes = 0
    await admin.route('**/api/console/call', async route => {
      if (route.request().postDataJSON()?.procedure !== 'numen:plugin-apply@1') return route.continue()
      writes++; await route.fetch(); await route.abort('failed')
    })
    await admin.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
    await expect(admin.getByText(/The response did not confirm the outcome/)).toBeVisible()
    await admin.unroute('**/api/console/call')
    expect(writes).toBe(1)
    await expect(group.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()
    expect((await ctx.hostConfig.read()).entries.find(entry => entry.id === 'fixture-events')).toMatchObject({ selfEnabled: true, effectiveEnabled: false })
    await expect.poll(() => observations.active).toBe(0)
    await expect.poll(() => observations.closes).toBe(1)
    expect(originalSubscription.signal.aborted).toBe(true)
    await expect(page.locator('html')).not.toHaveAttribute('data-acceptance-entry', 'loaded')
    expect(await originalSubscription.emit({ data: { message: 'stale' }, eventId: 'stale' })).toEqual({ status: 'stale' })
    expect(ctx.connections.get(connection.id)).toMatchObject({ enabled: true, adapterAvailable: false, generation: connection.generation })
    const run = ctx.scheduler.startManual(automation.id)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.listExecutions(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })]))

    await admin.getByRole('button', { name: 'Home', exact: true }).click()
    await admin.getByRole('button', { name: 'Inspect Connections that need attention', exact: true }).click()
    await expect(admin.locator('[data-connection-status="UNAVAILABLE"]')).toBeVisible()
    await admin.locator('.plugin-ownership > summary').click()
    await expect(admin.locator('.plugin-ownership-content')).toContainText('Last observed owner')
    await admin.getByRole('button', { name: 'Open instance: fixture-adapter', exact: true }).first().click()
    await expect(admin).toHaveURL(/entryId=fixture-adapter/)
    await expect(admin.locator('[data-entry-id="fixture-adapter"]')).toHaveAttribute('data-selected', 'true')
    await expect(admin.locator('[data-entry-id="fixture-adapter"]')).toBeFocused()
    await expect(admin.locator('[data-entry-id="fixture-adapter"]')).toContainText('Disabled by parent group')
    expect((await ctx.hostConfig.read()).entries.find(entry => entry.id === 'group-dependencies')?.collapsed).toBe(true)
    await admin.reload()
    await expect(admin.locator('[data-entry-id="fixture-adapter"]')).toBeFocused()
    await admin.screenshot({ path: testInfo.outputPath('located-instance-desktop.png'), fullPage: true })
    const commandCenter = admin.getByRole('button', { name: 'Command center', exact: true })
    await commandCenter.focus()
    await ctx.hostConfig.apply({ fingerprint: (await ctx.hostConfig.read()).fingerprint,
      operation: { kind: 'setLabel', id: 'group-destination', label: 'Destination renamed' } })
    await expect(admin.locator('[data-entry-id="group-destination"]')).toContainText('Destination renamed')
    await expect(commandCenter).toBeFocused()
    await admin.getByRole('button', { name: 'Back to diagnostic source', exact: true }).click()
    await expect(admin).toHaveURL(new RegExp(`connectionId=${connection.id}`))
    await expect(admin.locator('.connections-table tr[data-selected="true"]')).toContainText('Acceptance account')
    await admin.getByRole('button', { name: 'Runs', exact: true }).click()
    await admin.getByLabel('Status', { exact: true }).selectOption('RUNNING')
    await admin.getByRole('button', { name: `Open Run ${run.id}`, exact: true }).click()
    await admin.getByRole('button', { name: 'Timeline', exact: true }).click()
    await expect(admin.locator('.execution-warning').first()).toBeVisible()
    await admin.locator('.plugin-ownership > summary').click()
    await expect(admin.locator('.plugin-ownership-content')).toContainText('acceptance:echo@1')
    const runDiagnosticUrl = admin.url()
    await admin.getByRole('button', { name: 'Open instance: fixture-events', exact: true }).first().click()
    await expect(admin.locator('[data-entry-id="fixture-events"]')).toBeFocused()
    await admin.getByRole('button', { name: 'Back to diagnostic source', exact: true }).click()
    await expect(admin).toHaveURL(runDiagnosticUrl)
    await admin.locator('.plugin-ownership > summary').click()
    await expect(admin.locator('.plugin-ownership-content')).toContainText('Last observed owner')
    await admin.locator('.plugin-ownership').scrollIntoViewIfNeeded()
    await admin.screenshot({ path: testInfo.outputPath('blocked-run-desktop.png'), fullPage: true })
    await admin.setViewportSize({ width: 390, height: 844 })
    await admin.getByRole('button', { name: 'Language', exact: true }).click()
    await admin.getByRole('option', { name: '简体中文', exact: true }).click()
    await expect(admin.locator('.plugin-ownership-content')).toContainText('上次观察到的归属')
    await admin.locator('.plugin-ownership').scrollIntoViewIfNeeded()
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await admin.screenshot({ path: testInfo.outputPath('ownership-mobile-zh.png'), fullPage: true })
    await admin.getByRole('button', { name: '语言', exact: true }).click()
    await admin.getByRole('option', { name: 'English', exact: true }).click()
    await admin.setViewportSize({ width: 1440, height: 960 })
    await admin.getByRole('button', { name: 'Fixture dependencies', exact: true }).first().click()
    await expect(group).toHaveAttribute('data-selected', 'true')
    await group.getByRole('button', { name: 'Enable', exact: true }).click()
    await apply(admin)
    await expect.poll(() => ctx.connections.getRuntimeState(connection.id)?.status).toBe('READY')
    await expect.poll(() => observations.active).toBe(1)
    expect(observations.activations).toHaveLength(2)
    expect(observations.unused).toBe(0)
    await ctx.scheduler.dispatchUntilIdle()
    expect(ctx.scheduler.getRun(run.id)).toMatchObject({ status: 'COMPLETED', revisionId: revision.id })
    await expect.poll(() => sockets).toBeGreaterThan(previousSockets)
    await expect(page.locator('html')).toHaveAttribute('data-acceptance-entry', 'loaded')
    await expect(headers).toHaveValue('{"unfinished":')
    await expect(headers).toHaveAttribute('aria-invalid', 'true')
    expect(ctx.automations.getDraft(editing.id)).toEqual(originalDraft)

    // An already-open diagnosis must follow unload/reload events from another client.
    await admin.getByRole('button', { name: 'Connections', exact: true }).click()
    await admin.locator('.plugin-ownership > summary').click()
    await expect(admin.locator('.plugin-ownership-content')).toContainText('Currently registered')
    const setAdapterEnabled = async (enabled: boolean) => ctx.hostConfig.apply({
      fingerprint: (await ctx.hostConfig.read()).fingerprint,
      operation: { kind: 'setEnabled', id: 'fixture-adapter', enabled },
    })
    expect((await setAdapterEnabled(false)).runtimeApplied).toBe(true)
    await expect(admin.locator('.plugin-ownership-content')).toContainText('Last observed owner')
    await expect(admin.locator('.plugin-ownership-content')).not.toContainText('Currently registered')
    expect((await setAdapterEnabled(true)).runtimeApplied).toBe(true)
    await expect(admin.locator('.plugin-ownership-content')).toContainText('Currently registered')
    await expect(admin.locator('.plugin-ownership-content')).not.toContainText('Last observed owner')

    // Independent authenticated client wins while this tab's save is still withheld.
    const winner = await admin.request.post(new URL('/api/console/call', application.serverUrl).href, {
      headers: { origin: new URL(application.serverUrl!).origin },
      data: { kind: 'action', procedure: 'numen:automation-save-draft@1', input: {
        automationId: editing.id, expectedVersion: originalDraft.version, source: originalDraft.source, presentation: originalDraft.presentation,
      } },
    })
    expect(winner.ok()).toBe(true)
    release()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    await expect(headers).toHaveValue('{"unfinished":')
    await expect(page.getByLabel('URL', { exact: true })).toHaveValue('http://127.0.0.1:1/local-loser')
    await page.screenshot({ path: testInfo.outputPath('protected-conflict-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('protected-conflict-mobile.png'), fullPage: true })

    const fingerprint = (await ctx.hostConfig.read()).fingerprint
    const moved = await ctx.hostConfig.apply({ fingerprint, operation: { kind: 'move', id: 'fixture-adapter', parentId: 'group-destination' } })
    expect(moved.runtimeApplied).toBe(true)
    await expect.poll(() => observations.active).toBe(1)
    expect(ctx.connections.get(connection.id)).toMatchObject({ id: connection.id, generation: connection.generation, enabled: true })
    await admin.getByRole('button', { name: 'Plugins', exact: true }).click()
    const missingInstanceUrl = new URL(admin.url())
    missingInstanceUrl.search = new URLSearchParams({ entryId: 'missing-instance', from: '/connections' }).toString()
    await admin.goto(missingInstanceUrl.href)
    await expect(admin.getByText('Instance missing-instance is no longer configured. No alternative instance was selected.', { exact: true })).toBeVisible()
    await expect(admin.locator('[data-entry-id][data-selected="true"]')).toHaveCount(0)
    await admin.getByRole('button', { name: 'Back to diagnostic source', exact: true }).click()
    await expect(admin).toHaveURL(/\/connections$/)
    await page.close(); await admin.close()
    await application.stop()
    expect(observations.active).toBe(0)
    expect(observations.opens).toBe(observations.closes)
    application = await startRuntime({ configPath })
    const restarted = application.context
    await expect.poll(() => observations.active).toBe(1)
    const state = await restarted.hostConfig.read()
    expect(state.restartRequired).toBe(false)
    expect(state.entries.find(entry => entry.id === 'fixture-adapter')).toMatchObject({ parentId: 'group-destination', actualState: 'ACTIVE' })
    expect(state.entries.find(entry => entry.id === 'fixture-unused')).toMatchObject({ selfEnabled: false, actualState: 'DISABLED' })
    expect(restarted.connections.get(connection.id)).toMatchObject({ id: connection.id, generation: connection.generation })
    expect(restarted.automations.getDraft(editing.id)?.source).toEqual(originalDraft.source)
    expect(restarted.scheduler.getRun(run.id)).toMatchObject({ status: 'COMPLETED', revisionId: revision.id })
    const live = observations.activations.at(-1)!
    const event = { data: { message: 'after restart' }, eventId: 'once-after-restart' }
    const accepted = await live.emit(event)
    expect(accepted.status).toBe('accepted')
    const duplicate = await live.emit(event)
    expect(duplicate.status).toBe('duplicate')
    expect(duplicate.runId).toBe(accepted.runId)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(accepted.runId!)?.status).toBe('COMPLETED')
    expect(observations.unused).toBe(0)
    expect(errors).toEqual([])
    expect([...expectedErrors.values()].flat()).toEqual([])
  } finally { release(); if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' }) }
})
