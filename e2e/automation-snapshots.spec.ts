import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const secret = 'SNAPSHOT_PRIVATE_CANARY_93815'
const publicHtml = '<img id="snapshot-html" src=x onerror="window.__snapshotExecuted=true">'
const query = 'numen:automation-snapshot@1'
let application: NumenApplication
let directory: string

interface BrowserErrors {
  page: string[]
  console: string[]
  expected: Array<{ url: string; message: string; count: number }>
}
const browserErrors = new WeakMap<Page, BrowserErrors>()
function expectNetworkError(page: Page, message: string) {
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
  expect(errors.page).toEqual([])
  expect(errors.console).toEqual([])
  for (const expected of errors.expected) expect(expected.count, expected.message).toBe(1)
})
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-snapshot-e2e-'))
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

const source = (): AutomationSource => ({
  inputs: { payload: { type: 'object', required: true, default: { token: secret } } },
  triggers: [],
  flow: { type: 'block', id: 'saved-root', steps: [
    { type: 'capability', id: 'saved-request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: `https://example.invalid/path?token=${secret}` },
      headers: { type: 'literal', value: { authorization: `Bearer ${secret}` } },
    } },
    { type: 'wait', id: 'saved-wait', durationMs: { type: 'literal', value: 1000 } },
  ] },
})
const snapshotPath = (automationId: string, snapshotId: string) => new URL(`/automations/${automationId}/snapshots/${snapshotId}`, application.workbenchUrl!).href
const content = (page: Page) => page.locator('.automation-snapshot-content')
const draft = (id: string) => application.context.automations.getDraft(id)!
const durable = (id: string) => ({
  automation: structuredClone(application.context.automations.get(id)),
  draft: structuredClone(draft(id)),
  rows: Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table,
    (application.context.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ])),
})
async function bootstrap(page: Page) {
  // The temporary Runtime's startup URL carries its one-time Console authentication token.
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
}
async function openAutomation(page: Page, id: string) {
  await bootstrap(page)
  await page.goto(new URL(`/automations?automation=${id}&tab=Revisions`, application.workbenchUrl!).href)
  await expect(page.getByRole('tab', { name: 'Revisions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
}
async function dismissNext(page: Page, action: () => Promise<unknown>) {
  let shown = false
  page.once('dialog', async dialog => { shown = true; await dialog.dismiss() })
  await action()
  await expect.poll(() => shown).toBe(true)
}

test('views a fixed published snapshot after Draft edits and compiler unload without exposing private values or writing state', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const context = application.context
  let lowerCalls = 0
  const unloadControl = context.controls.defineControl(context, {
    kind: 'extension', id: 'fixture:historical-compiler', version: 1, title: 'Saved compiler title', description: '', input: z.object({}),
    lower: ({ nodeId }: { nodeId: string }) => { lowerCalls += 1; return { type: 'block', id: nodeId, steps: [] } },
  })
  const visible = () => z.string().extra('extra', { numen: { execution: 'public' } })
  const definition = { id: 'fixture:historical-action', version: 1, kind: 'action' as const, title: 'Saved action title',
    input: z.object({ text: visible(), password: visible(), opaque: z.any() }), output: z.object({}),
    semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unloadDefinition = context.capabilities.define(context, definition)
  const saved = source()
  if (saved.flow.type !== 'block') throw new Error('Expected saved block')
  saved.flow.steps.push(
    { type: 'extension', id: 'saved-compiler', control: { id: 'fixture:historical-compiler', version: 1 }, input: {} },
    { type: 'capability', id: 'saved-action', capability: { id: definition.id, version: 1 }, input: {
      text: { type: 'literal', value: publicHtml }, password: { type: 'literal', value: secret }, opaque: { type: 'literal', value: { innocent: secret } },
    } },
  )
  const { automation } = context.automations.create({ name: 'Historical published snapshot', source: saved,
    presentation: { collapsedNodes: ['saved-root'], arbitraryPrivateMetadata: secret } })
  const revision = context.automations.publishDraft(automation.id, 1)
  context.automations.activateRevision(automation.id, revision.id)
  const changed = source()
  changed.flow = { type: 'block', id: 'current-draft-only', steps: [] }
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: draft(automation.id).version, source: changed,
    presentation: { collapsedNodes: [], currentPrivateMetadata: secret } })
  unloadControl()
  unloadDefinition()
  const compileBefore = lowerCalls
  const before = durable(automation.id)
  const requests: unknown[] = [], responses: Array<{ body: string; cache?: string }> = []
  page.on('request', request => { if (request.url().endsWith('/api/console/call') && request.postDataJSON()?.procedure === query) requests.push(request.postDataJSON()) })
  page.on('response', async response => {
    if (response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === query) {
      responses.push({ body: await response.text(), cache: response.headers()['cache-control'] })
    }
  })
  await openAutomation(page, automation.id)
  await page.getByRole('button', { name: 'View Revision 1 snapshot', exact: true }).click()
  await expect(page).toHaveURL(snapshotPath(automation.id, revision.id))
  await expect(page.getByRole('heading', { name: 'Snapshot · Revision 1', exact: true })).toBeVisible()
  await expect(content(page)).toContainText('saved-root')
  await expect(content(page)).toContainText('Saved compiler title')
  await expect(content(page)).toContainText('Saved action title')
  await expect(content(page)).not.toContainText('current-draft-only')
  await expect(content(page)).not.toContainText(secret)
  await content(page).getByRole('button', { name: 'View details for node saved-action', exact: true }).click()
  await expect(content(page).locator('[data-snapshot-node="saved-action"]')).toBeFocused()
  await expect(content(page).locator('[data-snapshot-node="saved-action"] pre')).toContainText(JSON.stringify(publicHtml))
  await expect(content(page).locator('input, textarea, select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Publish|Activate|Enable|Test saved Draft|Save current Draft and test)$/ })).toHaveCount(0)
  await expect(content(page).locator('img, script, iframe')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __snapshotExecuted?: boolean }).__snapshotExecuted)).toBeUndefined()
  await expect.poll(() => responses.length).toBe(1)
  expect(responses[0]!.cache).toBe('no-store')
  expect(responses[0]!.body).not.toContain(secret)
  expect(responses[0]!.body).toContain(JSON.stringify(publicHtml))
  expect(requests).toEqual([expect.objectContaining({ input: { automationId: automation.id, snapshotId: revision.id } })])
  await page.screenshot({ path: testInfo.outputPath('snapshot-source-details-desktop.png'), fullPage: true })
  await page.locator('.automation-snapshot-page').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('snapshot-published-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(content(page)).toContainText('Saved action title')
  await page.locator('.automation-snapshot-page').evaluate(element => { element.scrollTop = 0 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('snapshot-published-mobile-zh.png'), fullPage: true })
  await page.reload()
  await expect(content(page)).toContainText('Saved compiler title')
  await expect.poll(() => responses.length).toBe(2)
  expect(responses.every(response => !response.body.includes(secret) && response.cache === 'no-store')).toBe(true)
  expect(lowerCalls).toBe(compileBefore)
  expect(durable(automation.id)).toEqual(before)
  expect(context.automations.getExecutionSnapshot(revision.id)).toEqual(revision)
})

test('opens the accepted Draft-test snapshot from its Run after edits and archive, and keeps the stable identity on reload', async ({ page }) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Historical Draft-test snapshot', source: source() })
  const run = await context.scheduler.startDraftTest(automation.id, 1, {}, {}, 'snapshot-draft-browser-01')
  const snapshot = structuredClone(context.automations.getExecutionSnapshot(run.revisionId)!)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { triggers: [], flow: { type: 'block', id: 'edited-after-acceptance', steps: [] } } })
  context.automations.archive(automation.id)
  const before = durable(automation.id)
  await bootstrap(page)
  await page.goto(new URL(`/runs/${run.id}/flow`, application.workbenchUrl!).href)
  await expect(page.locator('.run-detail-header')).toContainText('Draft test · Draft v1')
  await page.getByRole('button', { name: 'View snapshot', exact: true }).click()
  await expect(page).toHaveURL(`${snapshotPath(automation.id, snapshot.id)}?fromRun=${run.id}`)
  await expect(page.getByRole('heading', { name: 'Snapshot · Draft test · Draft v1', exact: true })).toBeVisible()
  await expect(content(page)).toContainText('saved-request')
  await expect(content(page)).not.toContainText('edited-after-acceptance')
  await expect(page.getByRole('button', { name: /^(Publish|Activate|Enable|Test saved Draft)$/ })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Snapshot · Draft test · Draft v1', exact: true })).toBeVisible()
  await expect(content(page)).toContainText('saved-request')
  expect(context.automations.getExecutionSnapshot(snapshot.id)).toEqual(snapshot)
  expect(context.automations.listRevisions(automation.id)).toEqual([])
  expect(durable(automation.id)).toEqual(before)
})

test('downgrades an unsupported protocol and rejects another Automation snapshot instead of displaying its contents', async ({ page }) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Future snapshot', source: source() })
  const revision = context.automations.publishDraft(automation.id, 1)
  context.database.db.prepare('UPDATE automation_revisions SET protocol_version = 999 WHERE id = ?').run(revision.id)
  const before = durable(automation.id)
  await bootstrap(page)
  await page.goto(snapshotPath(automation.id, revision.id))
  await expect(page.getByRole('heading', { name: 'Snapshot · Revision 1', exact: true })).toBeVisible()
  await expect(page.locator('.automation-snapshot-page')).toContainText(/unsupported/i)
  await expect(content(page)).not.toContainText('saved-request')
  await expect(content(page)).not.toContainText(secret)
  expect(durable(automation.id)).toEqual(before)
  const other = context.automations.create({ name: 'Another Automation' }).automation
  const otherBefore = durable(other.id)
  expectNetworkError(page, 'Failed to load resource: the server responded with a status of 404 (Not Found)')
  await page.goto(snapshotPath(other.id, revision.id))
  await expect(page.locator('.automation-snapshot-page').getByRole('alert')).toBeVisible()
  await expect(page.locator('.automation-snapshot-page')).not.toContainText('Future snapshot')
  await expect(page.locator('.automation-snapshot-page')).not.toContainText('saved-request')
  expect(durable(other.id)).toEqual(otherBefore)
})

test('preserves invalid focused Draft input when history navigation to a snapshot is cancelled', async ({ page }) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Snapshot navigation protection', source: source() })
  const revision = context.automations.publishDraft(automation.id, 1)
  await bootstrap(page)
  await page.goto(snapshotPath(automation.id, revision.id))
  await expect(page.getByRole('heading', { name: 'Snapshot · Revision 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open Automation', exact: true }).click()
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await page.locator('[data-node-id="saved-request"]').click()
  const headers = page.getByLabel('Headers', { exact: true })
  const pending = '{"unfinished-local":'
  const before = durable(automation.id)
  await headers.fill(pending)
  await expect(headers).toBeFocused()
  const url = page.url()
  await dismissNext(page, () => page.evaluate(() => history.back()))
  await expect.poll(() => page.url()).toBe(url)
  await expect(headers).toHaveValue(pending)
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  expect(durable(automation.id)).toEqual(before)
  page.once('dialog', dialog => dialog.accept())
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL(snapshotPath(automation.id, revision.id))
  await expect(page.getByRole('heading', { name: 'Snapshot · Revision 1', exact: true })).toBeVisible()
  expect(durable(automation.id)).toEqual(before)
})

test('clears a previous snapshot while a different identity fails, then retries that exact identity', async ({ page }) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Snapshot explicit retry', source: source() })
  const first = context.automations.publishDraft(automation.id, 1)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: {
    triggers: [], flow: { type: 'block', id: 'second-snapshot-root', steps: [] },
  } })
  const second = context.automations.publishDraft(automation.id, 2)
  const before = durable(automation.id)
  await bootstrap(page)
  await page.goto(snapshotPath(automation.id, first.id))
  await expect(content(page)).toContainText('saved-request')
  await page.getByRole('button', { name: 'Open Automation', exact: true }).click()
  const attempts: Array<{ automationId: string; snapshotId: string }> = []
  let rejectOnce = true
  expectNetworkError(page, 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)')
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== query) { await route.continue(); return }
    attempts.push(body.input)
    if (rejectOnce) {
      rejectOnce = false
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'SERVICE_UNAVAILABLE', message: 'Snapshot service temporarily unavailable.',
      } }) })
    } else await route.continue()
  })
  try {
    await page.getByRole('button', { name: 'View Revision 2 snapshot', exact: true }).click()
    await expect(page).toHaveURL(snapshotPath(automation.id, second.id))
    await expect(page.locator('.automation-snapshot-page').getByRole('alert')).toBeVisible()
    await expect(content(page)).toHaveCount(0)
    await expect(page.locator('.automation-snapshot-page')).not.toContainText('saved-request')
    await page.locator('.automation-snapshot-page').getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Snapshot · Revision 2', exact: true })).toBeVisible()
    await expect(content(page)).toContainText('second-snapshot-root')
    await expect(content(page)).not.toContainText('saved-request')
    expect(attempts).toEqual([
      { automationId: automation.id, snapshotId: second.id },
      { automationId: automation.id, snapshotId: second.id },
    ])
    expect(durable(automation.id)).toEqual(before)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('keeps the newer identity when an older real response returns after a mounted snapshot route changes', async ({ page }, testInfo) => {
  const context = application.context
  const { automation } = context.automations.create({ name: 'Snapshot response ordering', source: source() })
  const older = context.automations.publishDraft(automation.id, 1)
  context.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: {
    triggers: [], flow: { type: 'block', id: 'newer-only-root', steps: [] },
  } })
  const newer = context.automations.publishDraft(automation.id, 2)
  const before = durable(automation.id)
  await bootstrap(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false, fulfilled = false, aborted = false, received = false
  const identities: string[] = []
  page.on('requestfailed', request => {
    if (request.url().endsWith('/api/console/call') && request.postDataJSON()?.procedure === query && request.postDataJSON().input.snapshotId === older.id) {
      aborted = request.failure()?.errorText === 'net::ERR_ABORTED'
    }
  })
  page.on('response', async response => {
    if (response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === query && response.request().postDataJSON().input.snapshotId === older.id) {
      try { received = await response.finished() === null } catch { /* The superseded browser request can be aborted. */ }
    }
  })
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== query) { await route.continue(); return }
    identities.push(body.input.snapshotId)
    if (body.input.snapshotId !== older.id) { await route.continue(); return }
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    expect((await response.json()).result.identity.id).toBe(older.id)
    captured = true
    await gate
    try { await route.fulfill({ response }) }
    catch (error) {
      // Only suppress the fulfillment error once Chromium confirms this exact obsolete request was cancelled.
      await expect.poll(() => aborted).toBe(true)
    }
    fulfilled = true
  })
  try {
    await page.goto(snapshotPath(automation.id, older.id))
    await expect.poll(() => captured).toBe(true)
    await expect(content(page)).toHaveCount(0)
    await page.locator('.automation-snapshot-page').evaluate(element => { element.setAttribute('data-test-mounted', 'original-snapshot-page') })
    // Simulate an incoming bookmark/history entry without remounting the page or calling component internals.
    await page.evaluate(path => {
      history.pushState(null, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, snapshotPath(automation.id, newer.id))
    await expect(page.getByRole('heading', { name: 'Snapshot · Revision 2', exact: true })).toBeVisible()
    await expect(content(page)).toContainText('newer-only-root')
    await expect(page.locator('.automation-snapshot-page')).toHaveAttribute('data-test-mounted', 'original-snapshot-page')
    release()
    await expect.poll(() => fulfilled).toBe(true)
    await expect.poll(() => aborted || received).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page).toHaveURL(snapshotPath(automation.id, newer.id))
    await expect(page.getByRole('heading', { name: 'Snapshot · Revision 2', exact: true })).toBeVisible()
    await expect(content(page)).toContainText('newer-only-root')
    await expect(content(page)).not.toContainText('saved-request')
    expect(identities).toEqual([older.id, newer.id])
    expect(durable(automation.id)).toEqual(before)
    const outcomePath = testInfo.outputPath('snapshot-request-order.json')
    await writeFile(outcomePath, JSON.stringify({
      identities, mountedPagePreserved: true, obsoleteRequestAborted: aborted, obsoleteResponseReceived: received,
    }))
    await testInfo.attach('snapshot-request-order.json', { contentType: 'application/json', path: outcomePath })
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})
