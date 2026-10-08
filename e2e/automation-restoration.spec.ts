import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import type { AutomationSource, NumenValue } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const query = 'numen:automation-restore-content@1'
const saveAction = 'numen:automation-save-draft@1'
const secret = 'RESTORATION_PRIVATE_CANARY_75193'
let application: NumenApplication
let directory: string

interface BrowserErrors { page: string[]; console: string[]; expected: Array<{ url: string; message: string; count: number }> }
const browserErrors = new WeakMap<Page, BrowserErrors>()
function expectNetworkError(page: Page, kind: '404' | '409' | '503' | 'failed') {
  const message = kind === 'failed' ? 'Failed to load resource: net::ERR_FAILED'
    : `Failed to load resource: the server responded with a status of ${kind} ${kind === '404' ? '(Not Found)' : kind === '409' ? '(Conflict)' : '(Service Unavailable)'}`
  browserErrors.get(page)!.expected.push({ url: new URL('/api/console/call', application.workbenchUrl!).href, message, count: 0 })
}
test.beforeEach(({ page }) => {
  const errors: BrowserErrors = { page: [], console: [], expected: [] }
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.page.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const expected = errors.expected.find(item => !item.count && item.url === message.location().url && item.message === message.text())
    if (expected) expected.count += 1
    else errors.console.push(`${message.text()} (${message.location().url})`)
  })
})
test.afterEach(({ page }) => {
  const errors = browserErrors.get(page)!
  expect(errors.page).toEqual([]); expect(errors.console).toEqual([])
  for (const expected of errors.expected) expect(expected.count, expected.message).toBe(1)
})
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-restoration-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {}, schedule: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

const panel = (page: Page) => page.locator('.automation-restoration-panel')
const draft = (id: string) => application.context.automations.getDraft(id)!
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const source = (version: number): AutomationSource => ({
  inputs: { message: { type: 'string', title: 'Message', default: `version-${version}` } },
  triggers: [{ id: 'annual', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
  flow: { type: 'block', id: `root-r${version}`, steps: [
    { type: 'wait', id: `hold-r${version}`, durationMs: { type: 'literal', value: 90_000 } },
    { type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: `https://example.invalid/version-${version}` },
      headers: { type: 'literal', value: { Authorization: `Bearer ${secret}-r${version}` } },
    } },
  ] },
})
const presentation = (version: number): Record<string, NumenValue> => ({ collapsedNodes: [], opaque: { marker: `${secret}-presentation-${version}`, nested: ['keep', version] } })
function createFixture(name: string, firstSource = source(1)) {
  const context = application.context
  ;(firstSource as unknown as Record<string, NumenValue>).opaqueSource = { marker: `${secret}-source-1`, enabled: true }
  const { automation } = context.automations.create({ name, source: firstSource, presentation: presentation(1) })
  const first = context.automations.publishDraft(automation.id, 1)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: source(2), presentation: presentation(2) })
  const second = context.automations.publishDraft(automation.id, 2)
  return { context, automation, first, second }
}
const records = () => Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table,
  (application.context.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
]))
const activation = (id: string) => {
  const value = application.context.automations.get(id)!
  return { activeRevisionId: value.activeRevisionId, enabled: value.enabled, activationGeneration: value.activationGeneration, archivedAt: value.archivedAt }
}
const automationPath = (id: string, tab = 'Revisions', snapshotId?: string) => {
  const url = new URL('/automations', application.workbenchUrl!)
  url.searchParams.set('automation', id); url.searchParams.set('tab', tab)
  if (snapshotId) url.searchParams.set('restoreSnapshot', snapshotId)
  return url.href
}
async function bootstrap(page: Page) { await page.goto(application.workbenchUrl!); await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible() }
async function openAutomation(page: Page, id: string, tab = 'Revisions') {
  await bootstrap(page); await page.goto(automationPath(id, tab))
  await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
  await saved(page)
}
async function prepare(page: Page, number = 1) {
  await page.getByRole('button', { name: `Restore Revision ${number} to Draft`, exact: true }).click()
  await expect(panel(page).getByRole('heading', { name: 'Restore to Draft', exact: true })).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
}
async function confirm(page: Page) {
  await panel(page).getByRole('button', { name: 'Restore to Draft', exact: true }).click()
  await saved(page)
  await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute('aria-selected', 'true')
}
async function remoteSave(page: Page, id: string, changed: AutomationSource, atVersion = draft(id).version) {
  const response = await page.request.post(new URL('/api/console/call', application.workbenchUrl!).href, {
    headers: { origin: new URL(application.workbenchUrl!).origin }, data: { kind: 'action', procedure: saveAction,
      input: { automationId: id, expectedVersion: atVersion, source: changed, presentation: presentation(atVersion + 1) } },
  })
  expect(response.ok()).toBe(true)
  return { automationId: id, ...(await response.json()).result.draft }
}
async function recoverLatest(page: Page) {
  await page.getByRole('button', { name: 'Compare and recover', exact: true }).click()
  const discard = page.getByRole('button', { name: 'Discard local and reload latest', exact: true })
  await expect(discard).toBeEnabled(); await discard.click(); await saved(page)
}

test('restores exact Source and Presentation through one reversible Draft edit while the active Run and Cron subscription stay fixed', async ({ page }, testInfo) => {
  const { context, automation, first, second } = createFixture('Exact reversible restoration')
  context.automations.activateRevision(automation.id, first.id)
  context.automations.setEnabled(automation.id, true)
  await expect.poll(() => context.triggers.automationHealth(automation.id)?.active).toBe(1)
  const run = context.scheduler.startManual(automation.id, {}, {}, first.id, 'restoration-active-run-01')
  await context.scheduler.dispatchUntilIdle()
  const runBefore = structuredClone(context.scheduler.getRun(run.id))
  const activationBefore = activation(automation.id), subscriptionBefore = structuredClone(context.triggers.automationHealth(automation.id))
  const recordBefore = records(), before = structuredClone(draft(automation.id))
  const requests: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) requests.push(request.postDataJSON().input) })
  await openAutomation(page, automation.id)
  expect(requests).toEqual([])
  await prepare(page)
  await expect(panel(page)).toContainText('Revision 1'); await expect(panel(page)).toContainText('Draft v2')
  await expect(panel(page)).not.toContainText(secret)
  expect(draft(automation.id)).toEqual(before); expect(records()).toEqual(recordBefore)
  await page.screenshot({ path: testInfo.outputPath('restoration-preview-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('restoration-preview-mobile-zh.png'), fullPage: true })
  await page.getByRole('button', { name: '语言', exact: true }).click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })
  await confirm(page)
  expect(draft(automation.id)).toMatchObject({ version: 3, source: first.source, presentation: first.presentation, baseRevisionId: second.id })
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await saved(page)
  expect(draft(automation.id)).toMatchObject({ version: 4, source: before.source, presentation: before.presentation, baseRevisionId: second.id })
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await saved(page)
  expect(draft(automation.id)).toMatchObject({ version: 5, source: first.source, presentation: first.presentation, baseRevisionId: second.id })
  await page.reload(); await saved(page)
  expect(draft(automation.id)).toMatchObject({ version: 5, source: first.source, presentation: first.presentation, baseRevisionId: second.id })
  expect(context.automations.getRevision(first.id)).toEqual(first); expect(context.automations.getRevision(second.id)).toEqual(second)
  expect(activation(automation.id)).toEqual(activationBefore); expect(context.triggers.automationHealth(automation.id)).toEqual(subscriptionBefore)
  expect(context.scheduler.getRun(run.id)).toEqual(runBefore); expect(records()).toEqual(recordBefore)
  expect(requests).toEqual([{ automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 2 }])
})

test('stages the fixed Draft-test snapshot from its read-only view without restoring until confirmation', async ({ page }) => {
  const { context, automation, first, second } = createFixture('Draft-test restoration intent')
  const run = await context.scheduler.startDraftTest(automation.id, 2, {}, {}, 'restoration-draft-snapshot-01')
  const snapshot = structuredClone(context.automations.getExecutionSnapshot(run.revisionId)!)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: source(3), presentation: presentation(3) })
  const before = structuredClone(draft(automation.id)), recordBefore = records(), requests: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) requests.push(request.postDataJSON().input) })
  await bootstrap(page)
  await page.goto(new URL(`/automations/${automation.id}/snapshots/${snapshot.id}`, application.workbenchUrl!).href)
  await expect(page.getByRole('heading', { name: 'Snapshot · Draft test · Draft v2', exact: true })).toBeVisible()
  expect(requests).toEqual([]); expect(draft(automation.id)).toEqual(before)
  await page.getByRole('button', { name: 'Restore to Draft', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
  await expect(panel(page)).toContainText('Draft test · Draft v2'); await expect(panel(page)).toContainText('Draft v3')
  expect(draft(automation.id)).toEqual(before); expect(records()).toEqual(recordBefore)
  expect(page.url()).toContain(`restoreSnapshot=${snapshot.id}`); expect(page.url()).not.toContain(secret)
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.goto(new URL(`/automations/${automation.id}/compare?left=${first.id}&right=${second.id}`, application.workbenchUrl!).href)
  const comparison = page.locator('.automation-comparison-result')
  await expect(comparison).toContainText('Revision 1'); await expect(comparison).toContainText('Revision 2')
  await page.getByLabel('Left version', { exact: true }).selectOption(second.id)
  await comparison.getByRole('button', { name: 'Restore Revision 1 to Draft', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
  await expect(panel(page)).toContainText('Revision 1')
  expect(draft(automation.id)).toEqual(before); expect(records()).toEqual(recordBefore)
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.goto(new URL(`/automations/${automation.id}/snapshots/${snapshot.id}`, application.workbenchUrl!).href)
  await page.getByRole('button', { name: 'Restore to Draft', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
  await confirm(page)
  expect(draft(automation.id)).toMatchObject({ version: 4, source: snapshot.source, presentation: snapshot.presentation, baseRevisionId: second.id })
  expect(records()).toEqual(recordBefore); expect(context.automations.getExecutionSnapshot(snapshot.id)).toEqual(snapshot)
  expect(context.automations.listRevisions(automation.id)).toEqual([second, first])
  expect(requests).toEqual([
    { automationId: automation.id, snapshotId: snapshot.id, expectedDraftVersion: 3 },
    { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 3 },
    { automationId: automation.id, snapshotId: snapshot.id, expectedDraftVersion: 3 },
  ])
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(JSON.stringify(storage)).not.toContain(secret)
})

test('restores immutable Source after the authored extension compiler unloads and keeps opaque fields intact', async ({ page }) => {
  const context = application.context
  let lowerCalls = 0
  const unload = context.controls.defineControl(context, { kind: 'extension', id: 'restoration:temporary', version: 1, title: 'Temporary restoration compiler', description: '', input: z.object({}),
    lower: ({ nodeId }: { nodeId: string }) => { lowerCalls += 1; return { type: 'block', id: nodeId, steps: [] } } })
  const historical = source(1)
  if (historical.flow.type !== 'block') throw new Error('Fixture')
  historical.flow.steps.push({ type: 'extension', id: 'historical-control', control: { id: 'restoration:temporary', version: 1 }, input: {} })
  const { automation, first, second } = createFixture('Unloaded compiler restoration', historical)
  unload()
  const beforeCalls = lowerCalls, recordBefore = records()
  await openAutomation(page, automation.id)
  await prepare(page); await confirm(page)
  expect(draft(automation.id)).toMatchObject({ version: 3, source: first.source, presentation: first.presentation, baseRevisionId: second.id })
  await expect(page.locator('[data-node-id="historical-control"]')).toBeVisible()
  expect(lowerCalls).toBe(beforeCalls); expect(records()).toEqual(recordBefore)
})

test('preserves invalid focused fields and waits for a valid focused field save before preparing restoration', async ({ page }) => {
  const { automation, first } = createFixture('Restoration focused inputs')
  const attempts: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) attempts.push(request.postDataJSON().input) })
  await openAutomation(page, automation.id, 'Editor')
  await page.locator('[data-node-id="request"]').click()
  const headers = page.getByLabel('Headers', { exact: true }), pending = '{"unfinished":'
  const before = structuredClone(draft(automation.id))
  await headers.fill(pending)
  let dialogShown = false
  page.once('dialog', async dialog => { dialogShown = true; await dialog.dismiss() })
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await expect.poll(() => dialogShown).toBe(true)
  await expect(headers).toHaveValue(pending); await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(attempts).toEqual([]); expect(draft(automation.id)).toEqual(before)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let accepted = false, delivered = false
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== saveAction || accepted) { await route.continue(); return }
    const response = await route.fetch(); expect(response.ok()).toBe(true)
    accepted = true; await gate; await route.fulfill({ response }); delivered = true
  })
  try {
    await headers.fill('{"Accept":"focused-restoration"}')
    await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Revisions', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Restore Revision 1 to Draft', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    expect(attempts).toEqual([])
    release(); await expect.poll(() => delivered).toBe(true)
    await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
    expect(attempts).toEqual([{ automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 3 }])
    await expect(panel(page)).toContainText('Draft v3')
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await saved(page)
    expect(draft(automation.id).version).toBe(3)
    const flow = draft(automation.id).source.flow
    if (flow.type !== 'block' || flow.steps[1]?.type !== 'capability') throw new Error('Fixture')
    expect(flow.steps[1].input.headers).toEqual({ type: 'literal', value: { Accept: 'focused-restoration' } })
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('rejects a preparation race with another Console client and requires an explicit new baseline', async ({ page }) => {
  const { automation, first } = createFixture('Restoration preparation race')
  await openAutomation(page, automation.id)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false, delivered = false
  const attempts: unknown[] = []
  expectNetworkError(page, '409')
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== query) { await route.continue(); return }
    attempts.push(body.input)
    if (!captured) {
      captured = true; await gate
      const response = await route.fetch(); expect(response.status()).toBe(409)
      await route.fulfill({ response }); delivered = true
    } else await route.continue()
  })
  try {
    await page.getByRole('button', { name: 'Restore Revision 1 to Draft', exact: true }).click()
    await expect.poll(() => captured).toBe(true)
    const winner = await remoteSave(page, automation.id, source(3), 2)
    release(); await expect.poll(() => delivered).toBe(true)
    await expect(panel(page).getByRole('alert')).toBeVisible()
    await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeDisabled()
    expect(draft(automation.id)).toEqual(winner)
    expect(attempts).toEqual([{ automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 2 }])
    await panel(page).getByRole('button', { name: 'Prepare again', exact: true }).click()
    await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
    expect(attempts).toEqual([
      { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 2 },
      { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 3 },
    ])
    expect(draft(automation.id)).toEqual(winner)
    await confirm(page)
    expect(draft(automation.id)).toMatchObject({ version: 4, source: first.source, presentation: first.presentation })
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('makes a prepared preview stale after a remote save and lets the final autosave CAS protect a later winner', async ({ page }) => {
  const { automation, first } = createFixture('Restoration confirmation race')
  await openAutomation(page, automation.id); await prepare(page)
  const winner3 = await remoteSave(page, automation.id, source(3), 2)
  await expect(panel(page).getByRole('alert')).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeDisabled()
  expect(draft(automation.id)).toEqual(winner3)
  await panel(page).getByRole('button', { name: 'Prepare again', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeEnabled()
  await expect(panel(page)).toContainText('Draft v3')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false, delivered = false
  const writes: unknown[] = []
  expectNetworkError(page, '409')
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== saveAction) { await route.continue(); return }
    writes.push(body.input)
    captured = true; await gate
    const response = await route.fetch(); expect(response.status()).toBe(409)
    await route.fulfill({ response }); delivered = true
  })
  try {
    await panel(page).getByRole('button', { name: 'Restore to Draft', exact: true }).click()
    await expect.poll(() => captured).toBe(true)
    const winner4 = await remoteSave(page, automation.id, source(4), 3)
    release(); await expect.poll(() => delivered).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    expect(draft(automation.id)).toEqual(winner4)
    expect(writes).toEqual([expect.objectContaining({ automationId: automation.id, expectedVersion: 3, source: first.source, presentation: first.presentation })])
    await recoverLatest(page)
    expect(draft(automation.id)).toEqual(winner4)
    await expect(page.locator('[data-node-id="hold-r4"]')).toBeVisible()
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('keeps an accepted restoration after a lost save response without automatic write retries, then reconciles through existing conflict recovery', async ({ page }) => {
  const { automation, first } = createFixture('Restoration lost save response')
  await openAutomation(page, automation.id); await prepare(page)
  let accepted = false
  const writes: unknown[] = []
  expectNetworkError(page, 'failed')
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== saveAction) { await route.continue(); return }
    writes.push(body.input)
    if (!accepted) {
      const response = await route.fetch(); expect(response.ok()).toBe(true)
      accepted = true; await route.abort('failed')
    } else await route.continue()
  })
  try {
    await panel(page).getByRole('button', { name: 'Restore to Draft', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'ERROR')
    expect(draft(automation.id)).toMatchObject({ version: 3, source: first.source, presentation: first.presentation })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(writes).toHaveLength(1)
    expectNetworkError(page, '409')
    await page.getByRole('button', { name: 'Retry autosave', exact: true }).click()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    expect(writes).toHaveLength(2)
    expect(draft(automation.id).version).toBe(3)
    await recoverLatest(page)
    await expect(page.locator('[data-node-id="hold-r1"]')).toBeVisible()
    expect(draft(automation.id)).toMatchObject({ version: 3, source: first.source, presentation: first.presentation })
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('cancels a delayed real preparation when selection changes and never applies its obsolete content to another Automation', async ({ page }, testInfo) => {
  const firstFixture = createFixture('Restoration delayed first')
  const secondFixture = createFixture('Restoration delayed second')
  const firstBefore = structuredClone(draft(firstFixture.automation.id)), secondBefore = structuredClone(draft(secondFixture.automation.id))
  const recordBefore = records()
  await openAutomation(page, firstFixture.automation.id)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false, fulfilled = false, aborted = false, received = false
  page.on('requestfailed', request => { if (request.postDataJSON()?.procedure === query) aborted = request.failure()?.errorText === 'net::ERR_ABORTED' })
  page.on('response', async response => {
    if (response.request().postDataJSON()?.procedure === query) {
      try { received = await response.finished() === null } catch { /* This exact cancelled preparation can be aborted. */ }
    }
  })
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== query) { await route.continue(); return }
    const response = await route.fetch(); expect(response.ok()).toBe(true)
    captured = true; await gate
    try { await route.fulfill({ response }) } catch { await expect.poll(() => aborted).toBe(true) }
    fulfilled = true
  })
  try {
    await page.getByRole('button', { name: 'Restore Revision 1 to Draft', exact: true }).click()
    await expect.poll(() => captured).toBe(true)
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.locator('.automation-row').filter({ hasText: 'Restoration delayed second' }).click()
    await expect(page.getByRole('heading', { name: 'Restoration delayed second', exact: true })).toBeVisible()
    release(); await expect.poll(() => fulfilled).toBe(true); await expect.poll(() => aborted || received).toBe(true)
    await expect(panel(page)).toHaveCount(0)
    expect(draft(firstFixture.automation.id)).toEqual(firstBefore); expect(draft(secondFixture.automation.id)).toEqual(secondBefore); expect(records()).toEqual(recordBefore)
    const outcomePath = testInfo.outputPath('restoration-request-order.json')
    await writeFile(outcomePath, JSON.stringify({ obsoleteRequestAborted: aborted, obsoleteResponseReceived: received, noWrites: true }))
    await testInfo.attach('restoration-request-order.json', { path: outcomePath, contentType: 'application/json' })
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('rejects archived and foreign snapshot restoration intents without changing any Draft or history', async ({ page }) => {
  const first = createFixture('Restoration rejected first')
  const other = createFixture('Restoration rejected other')
  const recordBefore = records(), before = structuredClone(draft(first.automation.id)), otherBefore = structuredClone(draft(other.automation.id))
  await bootstrap(page)
  expectNetworkError(page, '404')
  await page.goto(automationPath(first.automation.id, 'Revisions', other.first.id))
  await expect(panel(page).getByRole('alert')).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Restore to Draft', exact: true })).toBeDisabled()
  expect(draft(first.automation.id)).toEqual(before); expect(draft(other.automation.id)).toEqual(otherBefore)
  first.context.automations.archive(first.automation.id)
  const archived = activation(first.automation.id)
  const archivedQuery = await page.request.post(new URL('/api/console/call', application.workbenchUrl!).href, {
    headers: { origin: new URL(application.workbenchUrl!).origin }, data: { kind: 'query', procedure: query,
      input: { automationId: first.automation.id, snapshotId: first.first.id, expectedDraftVersion: before.version } },
  })
  expect(archivedQuery.status()).toBe(409)
  expect(archivedQuery.headers()['cache-control']).toBe('no-store')
  expect(await archivedQuery.json()).toMatchObject({ error: { code: 'AUTOMATION_ARCHIVED' } })
  await page.goto(automationPath(first.automation.id, 'Revisions', first.first.id))
  await expect(page.locator('.authoring-notice')).toContainText(/archived/i)
  await expect(page.getByRole('button', { name: 'Restore Revision 1 to Draft', exact: true })).toBeDisabled()
  await expect(panel(page)).toHaveCount(0)
  expect(activation(first.automation.id)).toEqual(archived)
  expect(draft(first.automation.id)).toEqual(before); expect(draft(other.automation.id)).toEqual(otherBefore); expect(records()).toEqual(recordBefore)
})
