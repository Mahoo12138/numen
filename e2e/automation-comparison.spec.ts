import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import type { AutomationSource, CapabilitySource, ControlSource } from '../packages/core/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const secret = 'COMPARISON_PRIVATE_CANARY_68419'
const publicHtml = '<img id="comparison-html" src=x onerror="window.__comparisonExecuted=true">'
const query = 'numen:automation-comparison@1'
const stateQuery = 'numen:automation-comparison-state@1'
let application: NumenApplication
let directory: string

interface BrowserErrors { page: string[]; console: string[]; expected: Array<{ url: string; message: string; count: number }> }
const browserErrors = new WeakMap<Page, BrowserErrors>()
function expectNetworkError(page: Page, status: '404' | '409' | '503') {
  const suffix = status === '404' ? '(Not Found)' : status === '409' ? '(Conflict)' : '(Service Unavailable)'
  browserErrors.get(page)!.expected.push({ url: new URL('/api/console/call', application.workbenchUrl!).href, message: `Failed to load resource: the server responded with a status of ${status} ${suffix}`, count: 0 })
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
  directory = await mkdtemp(join(tmpdir(), 'numen-comparison-e2e-'))
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

const draft = (id: string) => application.context.automations.getDraft(id)!
const result = (page: Page) => page.locator('.automation-comparison-result')
const change = (page: Page, category: string, nodeId?: string) => {
  const rows = page.locator(`.comparison-change[data-category="${category}"]`)
  return nodeId ? rows.filter({ hasText: nodeId }) : rows
}
const comparisonPath = (automationId: string, left: string, right: string, draftVersion?: number) => {
  const url = new URL(`/automations/${automationId}/compare`, application.workbenchUrl!)
  url.searchParams.set('left', left); url.searchParams.set('right', right)
  if (draftVersion !== undefined) url.searchParams.set('draftVersion', String(draftVersion))
  // BrowserRouter encodes query keys in deterministic alphabetical order.
  url.searchParams.sort()
  return url.href
}
const durable = (id: string) => ({
  automation: structuredClone(application.context.automations.get(id)), draft: structuredClone(draft(id)),
  rows: Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table,
    (application.context.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ])),
})
async function bootstrap(page: Page) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
}
async function openComparison(page: Page, automationId: string, left: string, right: string, version?: number) {
  await bootstrap(page)
  await page.goto(comparisonPath(automationId, left, right, version))
  await expect(page.getByRole('heading', { name: 'Compare versions', exact: true })).toBeVisible()
}
const source = (): AutomationSource => ({
  inputs: { payload: { type: 'object', default: { token: secret } } },
  triggers: [{ id: 'fixed-trigger', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
  flow: { type: 'block', id: 'root', steps: [
    { type: 'block', id: 'moved-container', steps: [
      { type: 'wait', id: 'kept-child', durationMs: { type: 'literal', value: 1000 } },
      { type: 'capability', id: 'parameter-step', capability: { id: 'http:request', version: 1 }, input: {
        url: { type: 'literal', value: `https://example.invalid/${secret}` }, headers: { type: 'literal', value: { authorization: `Bearer ${secret}` } },
      }, policy: { timeoutMs: 3000 } },
    ] },
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then-container', steps: [] } },
    { type: 'wait', id: 'removed-node', durationMs: { type: 'literal', value: 2000 } },
  ] }, policy: { maxActive: 3, overflow: 'queue' },
})
function createFixture(name: string, saved = source(), presentation: Record<string, string | string[]> = { collapsedNodes: ['moved-container'], privateMetadata: secret }) {
  const context = application.context
  const { automation } = context.automations.create({ name, source: saved, presentation })
  const first = context.automations.publishDraft(automation.id, 1)
  return { context, automation, first, saved }
}
function save(id: string, changed: AutomationSource, presentation: Record<string, string | string[]> = { collapsedNodes: [], privateMetadata: `${secret}-new` }) {
  return application.context.automations.saveDraft({ automationId: id, expectedVersion: draft(id).version, source: changed, presentation })
}
function complexChange(saved: AutomationSource): AutomationSource {
  const changed = structuredClone(saved)
  if (changed.flow.type !== 'block') throw new Error('Fixture root must be a block')
  const moved = changed.flow.steps[0]!
  const condition = changed.flow.steps[1]!
  if (moved.type !== 'block' || condition.type !== 'if' || moved.steps[1]?.type !== 'capability') throw new Error('Fixture structure changed')
  const action = moved.steps[1] as CapabilitySource
  action.input.url = { type: 'literal', value: `https://example.invalid/changed/${secret}` }
  action.connections = { default: `${secret}-connection` }
  action.policy = { timeoutMs: 4000 }
  condition.then.steps.push(moved)
  changed.flow.steps = [condition, { type: 'wait', id: 'added-node', durationMs: { type: 'literal', value: 10 } }]
  changed.inputs!.payload!.default = { token: `${secret}-changed` }
  changed.triggers[0]!.config.cron = '0 0 2 1 *'
  changed.policy = { maxActive: 4, overflow: 'queue', groupBy: { type: 'literal', value: `${secret}-group` } }
  ;(changed as unknown as Record<string, unknown>)[`${secret}-unknown-extension`] = { value: secret }
  return changed
}

test('compares a complex saved Draft semantically, reports the moved parent once and keeps every value opaque', async ({ page }, testInfo) => {
  const { context, automation, first, saved } = createFixture('Complex semantic comparison')
  context.automations.activateRevision(automation.id, first.id)
  context.automations.setEnabled(automation.id, true)
  const activeRun = context.scheduler.startRevisionTest(automation.id, first.id, {}, {}, 'comparison-preserved-run-01')
  save(automation.id, complexChange(saved))
  const before = durable(automation.id)
  const requests: unknown[] = [], responses: Array<{ body: string; cache?: string }> = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) requests.push(request.postDataJSON()) })
  page.on('response', async response => {
    if (response.request().postDataJSON()?.procedure === query) responses.push({ body: await response.text(), cache: response.headers()['cache-control'] })
  })
  await openComparison(page, automation.id, first.id, 'draft', 2)
  await expect(result(page)).toContainText('Revision 1'); await expect(result(page)).toContainText('Draft v2')
  await expect(change(page, 'structure', 'moved-container')).toHaveCount(1)
  await expect(change(page, 'structure', 'moved-container')).toContainText(/moved/i)
  await expect(change(page, 'structure', 'kept-child')).toHaveCount(0)
  await expect(change(page, 'structure', 'parameter-step')).toHaveCount(0)
  await expect(change(page, 'structure', 'added-node')).toContainText(/added/i)
  await expect(change(page, 'structure', 'removed-node')).toContainText(/removed/i)
  for (const category of ['parameters', 'bindings', 'policies', 'triggers', 'inputs', 'presentation', 'extensions']) await expect(change(page, category).first()).toBeVisible()
  await expect(change(page, 'parameters', 'parameter-step')).toContainText(/input/i)
  await expect(change(page, 'bindings', 'parameter-step')).toContainText(/bindings/i)
  await expect(result(page)).not.toContainText(secret)
  await expect(result(page).locator('img, script, iframe, input, textarea, select')).toHaveCount(0)
  await expect.poll(() => responses.length).toBe(1)
  expect(responses[0]!.cache).toBe('no-store'); expect(responses[0]!.body).not.toContain(secret)
  expect(requests).toEqual([expect.objectContaining({ input: { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 2 } } })])
  expect(page.url()).not.toContain(secret)
  expect(durable(automation.id)).toEqual(before)
  expect(context.scheduler.getRun(activeRun.id)).toEqual(activeRun)
  await page.screenshot({ path: testInfo.outputPath('semantic-comparison-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(result(page)).not.toContainText(secret)
  await page.screenshot({ path: testInfo.outputPath('semantic-comparison-mobile-zh.png'), fullPage: true })
})

test('compares two fixed published versions after their compiler unload without recompiling or revealing public HTML', async ({ page }) => {
  const context = application.context
  let lowerCalls = 0
  const unloadControl = context.controls.defineControl(context, { kind: 'extension', id: 'comparison:compiler', version: 1, title: 'Comparison compiler', description: '', input: z.object({}),
    lower: ({ nodeId }: { nodeId: string }) => { lowerCalls += 1; return { type: 'block', id: nodeId, steps: [] } } })
  const unloadAction = context.capabilities.define(context, { id: 'comparison:public', version: 1, kind: 'action', title: 'Comparison public value',
    input: z.object({ text: z.string().extra('extra', { numen: { execution: 'public' } }) }), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
  const saved: AutomationSource = { triggers: [], flow: { type: 'block', id: 'fixed-root', steps: [
    { type: 'extension', id: 'fixed-compiler', control: { id: 'comparison:compiler', version: 1 }, input: {} },
    { type: 'capability', id: 'public-step', capability: { id: 'comparison:public', version: 1 }, input: { text: { type: 'literal', value: 'old public value' } } },
  ] } }
  const { automation, first } = createFixture('Fixed published comparison', saved)
  const changed = structuredClone(saved)
  if (changed.flow.type !== 'block' || changed.flow.steps[1]?.type !== 'capability') throw new Error('Fixture')
  changed.flow.steps[1].input.text = { type: 'literal', value: publicHtml }
  save(automation.id, changed)
  const second = context.automations.publishDraft(automation.id, 2)
  unloadControl(); unloadAction()
  const beforeCalls = lowerCalls, before = durable(automation.id)
  const responses: string[] = []
  page.on('response', async response => { if (response.request().postDataJSON()?.procedure === query) responses.push(await response.text()) })
  await openComparison(page, automation.id, first.id, second.id)
  await expect(result(page)).toContainText('Revision 1'); await expect(result(page)).toContainText('Revision 2')
  await expect(change(page, 'parameters', 'public-step')).toContainText(/changed/i)
  await expect(result(page)).not.toContainText(publicHtml)
  await expect(result(page).locator('img, script, iframe')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __comparisonExecuted?: boolean }).__comparisonExecuted)).toBeUndefined()
  await expect.poll(() => responses.length).toBe(1)
  expect(responses[0]).not.toContain(publicHtml); expect(responses[0]).not.toContain('old public value')
  expect(lowerCalls).toBe(beforeCalls); expect(durable(automation.id)).toEqual(before)
  await page.reload()
  await expect(result(page)).toContainText('Revision 2')
  expect(lowerCalls).toBe(beforeCalls); expect(durable(automation.id)).toEqual(before)
})

test('keeps a pinned Draft comparison when another client saves and refreshes only after the explicit action', async ({ page }) => {
  const { automation, first, saved } = createFixture('Pinned Draft comparison')
  const initial = structuredClone(saved)
  if (initial.flow.type !== 'block') throw new Error('Fixture')
  initial.flow.steps.push({ type: 'wait', id: 'draft-v2-only', durationMs: { type: 'literal', value: 10 } })
  save(automation.id, initial)
  const requests: Array<Record<string, unknown>> = []
  let stateVersion = 0
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) requests.push(request.postDataJSON().input) })
  page.on('response', async response => {
    if (response.request().postDataJSON()?.procedure === stateQuery && response.ok()) stateVersion = (await response.json()).result.draftVersion
  })
  await openComparison(page, automation.id, first.id, 'draft', 2)
  await expect(result(page)).toContainText('Draft v2'); await expect(result(page)).toContainText('draft-v2-only')
  const newer = structuredClone(saved)
  if (newer.flow.type !== 'block') throw new Error('Fixture')
  newer.flow.steps.push({ type: 'wait', id: 'draft-v3-only', durationMs: { type: 'literal', value: 20 } })
  save(automation.id, newer)
  const before = durable(automation.id)
  await expect.poll(() => stateVersion).toBe(3)
  await expect(page.locator('.automation-comparison-page').getByRole('alert')).toContainText('The saved Draft has changed')
  await expect(result(page)).toContainText('Draft v2'); await expect(result(page)).not.toContainText('Draft v3')
  await expect(result(page)).toContainText('draft-v2-only'); await expect(result(page)).not.toContainText('draft-v3-only')
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: 'Refresh Draft comparison', exact: true }).click()
  await expect(result(page)).toContainText('Draft v3'); await expect(result(page)).toContainText('draft-v3-only')
  await expect(page).toHaveURL(comparisonPath(automation.id, first.id, 'draft', 3))
  await expect(result(page)).not.toContainText('draft-v2-only')
  expect(requests).toEqual([
    { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 2 } },
    { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 3 } },
  ])
  expect(durable(automation.id)).toEqual(before)
})

test('rejects an expired bookmarked Draft version without silently changing targets and recovers through explicit refresh', async ({ page }) => {
  const { automation, first, saved } = createFixture('Expired comparison bookmark')
  save(automation.id, complexChange(saved))
  const before = durable(automation.id), attempts: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) attempts.push(request.postDataJSON().input) })
  expectNetworkError(page, '409')
  await openComparison(page, automation.id, first.id, 'draft', 1)
  await expect(page.locator('.automation-comparison-page').getByRole('alert').first()).toBeVisible()
  await expect(result(page)).toHaveCount(0)
  expect(attempts).toEqual([{ automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 1 } }])
  expect(page.url()).toContain('draftVersion=1')
  await page.getByRole('button', { name: 'Refresh Draft comparison', exact: true }).click()
  await expect(result(page)).toContainText('Draft v2')
  await expect(page).toHaveURL(comparisonPath(automation.id, first.id, 'draft', 2))
  expect(attempts).toHaveLength(2)
  expect(durable(automation.id)).toEqual(before)
})

test('does not display a foreign or missing snapshot and does not mutate either Automation', async ({ page }) => {
  const first = createFixture('Comparison ownership first')
  const other = createFixture('Comparison ownership other')
  const before = durable(first.automation.id), otherBefore = durable(other.automation.id)
  expectNetworkError(page, '404')
  await openComparison(page, first.automation.id, first.first.id, other.first.id)
  await expect(page.locator('.automation-comparison-page').getByRole('alert')).toBeVisible()
  await expect(result(page)).toHaveCount(0)
  await expect(page.locator('.automation-comparison-page')).not.toContainText('Comparison ownership other')
  expectNetworkError(page, '404')
  await page.goto(comparisonPath(first.automation.id, first.first.id, `rev_${'0'.repeat(32)}`))
  await expect(page.locator('.automation-comparison-page').getByRole('alert')).toBeVisible()
  await expect(result(page)).toHaveCount(0)
  await expect(page.locator('.automation-comparison-page')).not.toContainText(secret)
  expect(durable(first.automation.id)).toEqual(before); expect(durable(other.automation.id)).toEqual(otherBefore)
})

test('fences an older real comparison response after identities change on the mounted route', async ({ page }, testInfo) => {
  const { context, automation, first, saved } = createFixture('Comparison response ordering')
  const olderSource = structuredClone(saved)
  if (olderSource.flow.type !== 'block') throw new Error('Fixture')
  olderSource.flow.steps.push({ type: 'wait', id: 'older-only-node', durationMs: { type: 'literal', value: 10 } })
  save(automation.id, olderSource)
  const older = context.automations.publishDraft(automation.id, 2)
  const newerSource = structuredClone(saved)
  if (newerSource.flow.type !== 'block') throw new Error('Fixture')
  newerSource.flow.steps.push({ type: 'wait', id: 'newer-only-node', durationMs: { type: 'literal', value: 20 } })
  save(automation.id, newerSource)
  const newer = context.automations.publishDraft(automation.id, 3)
  const before = durable(automation.id)
  await bootstrap(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false, fulfilled = false, aborted = false, received = false
  const identities: string[] = []
  page.on('requestfailed', request => {
    if (request.postDataJSON()?.procedure === query && request.postDataJSON().input.right.snapshotId === older.id) aborted = request.failure()?.errorText === 'net::ERR_ABORTED'
  })
  page.on('response', async response => {
    if (response.request().postDataJSON()?.procedure === query && response.request().postDataJSON().input.right.snapshotId === older.id) {
      try { received = await response.finished() === null } catch { /* The exact superseded request may be aborted. */ }
    }
  })
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure !== query) { await route.continue(); return }
    identities.push(body.input.right.snapshotId)
    if (body.input.right.snapshotId !== older.id) { await route.continue(); return }
    const response = await route.fetch()
    expect(response.ok()).toBe(true); expect((await response.json()).result.right.snapshotId).toBe(older.id)
    captured = true
    await gate
    try { await route.fulfill({ response }) }
    catch { await expect.poll(() => aborted).toBe(true) }
    fulfilled = true
  })
  try {
    await page.goto(comparisonPath(automation.id, first.id, older.id))
    await expect.poll(() => captured).toBe(true)
    await expect(result(page)).toHaveCount(0)
    await page.locator('.automation-comparison-page').evaluate(element => element.setAttribute('data-test-mounted', 'original-comparison-page'))
    await page.evaluate(path => { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }, comparisonPath(automation.id, first.id, newer.id))
    await expect(result(page)).toContainText('Revision 3'); await expect(result(page)).toContainText('newer-only-node')
    await expect(page.locator('.automation-comparison-page')).toHaveAttribute('data-test-mounted', 'original-comparison-page')
    release()
    await expect.poll(() => fulfilled).toBe(true); await expect.poll(() => aborted || received).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(result(page)).toContainText('Revision 3'); await expect(result(page)).not.toContainText('older-only-node')
    expect(identities).toEqual([older.id, newer.id]); expect(durable(automation.id)).toEqual(before)
    const outcomePath = testInfo.outputPath('comparison-request-order.json')
    await writeFile(outcomePath, JSON.stringify({ identities, mountedPagePreserved: true, obsoleteRequestAborted: aborted, obsoleteResponseReceived: received }))
    await testInfo.attach('comparison-request-order.json', { contentType: 'application/json', path: outcomePath })
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('opens Revision versus Draft from its dedicated action and protects invalid focused input when history navigation is cancelled', async ({ page }) => {
  const { automation, first } = createFixture('Comparison navigation protection', source(), { collapsedNodes: [], privateMetadata: secret })
  await openComparison(page, automation.id, first.id, 'draft', 1)
  await expect(result(page)).toContainText('Draft v1')
  await page.getByRole('button', { name: 'Open Automation', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Revisions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Compare Revision 1 with Draft', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Compare versions', exact: true })).toBeVisible()
  await expect(result(page)).toContainText('Revision 1'); await expect(result(page)).toContainText('Draft v1')
  await page.getByRole('button', { name: 'Open Automation', exact: true }).click()
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await page.locator('[data-node-id="parameter-step"]').click()
  const headers = page.getByLabel('Headers', { exact: true }), pending = '{"local-pending":'
  const before = durable(automation.id)
  await headers.fill(pending)
  const url = page.url()
  let dialogShown = false
  page.once('dialog', async dialog => { dialogShown = true; await dialog.dismiss() })
  await page.evaluate(() => history.back())
  await expect.poll(() => dialogShown).toBe(true)
  await expect(page).toHaveURL(url); await expect(headers).toHaveValue(pending); await expect(headers).toHaveAttribute('aria-invalid', 'true')
  expect(durable(automation.id)).toEqual(before)
  page.once('dialog', dialog => dialog.accept())
  await page.evaluate(() => history.back())
  await expect(page.getByRole('heading', { name: 'Compare versions', exact: true })).toBeVisible()
  await expect(result(page)).toContainText('Draft v1')
  expect(durable(automation.id)).toEqual(before)
})

test('keeps selector changes separate from the pinned result until Compare is explicitly requested', async ({ page }) => {
  const { context, automation, first, saved } = createFixture('Explicit comparison picker')
  const changed = structuredClone(saved)
  if (changed.flow.type !== 'block') throw new Error('Fixture')
  changed.flow.steps.push({ type: 'wait', id: 'picker-added-node', durationMs: { type: 'literal', value: 10 } })
  save(automation.id, changed)
  const second = context.automations.publishDraft(automation.id, 2)
  const before = durable(automation.id), attempts: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) attempts.push(request.postDataJSON().input) })
  await bootstrap(page)
  await page.goto(new URL(`/automations/${automation.id}/compare`, application.workbenchUrl!).href)
  await expect(page.getByRole('heading', { name: 'Compare versions', exact: true })).toBeVisible()
  await expect(result(page)).toHaveCount(0)
  await page.getByLabel('Left version', { exact: true }).selectOption(first.id)
  await page.getByLabel('Right version', { exact: true }).selectOption(second.id)
  expect(attempts).toHaveLength(0)
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(result(page)).toContainText('Revision 1'); await expect(result(page)).toContainText('Revision 2')
  await expect(page).toHaveURL(comparisonPath(automation.id, first.id, second.id))
  await expect(result(page)).toContainText('picker-added-node')
  await page.getByLabel('Right version', { exact: true }).selectOption('draft')
  await expect(result(page)).toContainText('Revision 2'); await expect(result(page)).not.toContainText('Draft v2')
  await expect(page).toHaveURL(comparisonPath(automation.id, first.id, second.id))
  expect(attempts).toHaveLength(1)
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(result(page)).toContainText('Draft v2')
  await expect(page).toHaveURL(comparisonPath(automation.id, first.id, 'draft', 2))
  expect(attempts).toEqual([
    { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'snapshot', snapshotId: second.id } },
    { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 2 } },
  ])
  expect(durable(automation.id)).toEqual(before)
})

test('retains an observed stale Draft warning through metadata failure and rereads the latest version on explicit refresh', async ({ page }) => {
  const { automation, first, saved } = createFixture('Comparison metadata outage')
  const versionSource = (version: number) => {
    const changed = structuredClone(saved)
    if (changed.flow.type !== 'block') throw new Error('Fixture')
    changed.flow.steps.push({ type: 'wait', id: `outage-draft-v${version}-only`, durationMs: { type: 'literal', value: version * 10 } })
    return changed
  }
  save(automation.id, versionSource(2))
  let stateVersion = 0
  const comparisonRequests: unknown[] = []
  page.on('request', request => { if (request.postDataJSON()?.procedure === query) comparisonRequests.push(request.postDataJSON().input) })
  page.on('response', async response => {
    if (response.request().postDataJSON()?.procedure === stateQuery && response.ok()) stateVersion = (await response.json()).result.draftVersion
  })
  await openComparison(page, automation.id, first.id, 'draft', 2)
  await expect(result(page)).toContainText('Draft v2')
  save(automation.id, versionSource(3))
  await expect.poll(() => stateVersion).toBe(3)
  await expect(page.locator('.comparison-stale')).toContainText('The saved Draft has changed')
  let rejectState = true, stateFailures = 0
  expectNetworkError(page, '503')
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== stateQuery || !rejectState) { await route.continue(); return }
    stateFailures += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Version status temporarily unavailable.' } }) })
  })
  try {
    save(automation.id, versionSource(4))
    const before = durable(automation.id)
    await expect.poll(() => stateFailures).toBe(1)
    await expect(page.locator('.automation-comparison-page').getByRole('alert').filter({ hasText: 'Version status could not be refreshed' })).toBeVisible()
    await expect(page.locator('.comparison-stale')).toContainText('The saved Draft has changed')
    await expect(result(page)).toContainText('Draft v2'); await expect(result(page)).toContainText('outage-draft-v2-only')
    await expect(result(page)).not.toContainText('Draft v4'); await expect(result(page)).not.toContainText('outage-draft-v4-only')
    expect(comparisonRequests).toHaveLength(1)
    rejectState = false
    await page.getByRole('button', { name: 'Refresh Draft comparison', exact: true }).click()
    await expect(result(page)).toContainText('Draft v4'); await expect(result(page)).toContainText('outage-draft-v4-only')
    await expect(page.locator('.comparison-stale')).toHaveCount(0)
    await expect(page.locator('.automation-comparison-page').getByRole('alert').filter({ hasText: 'Version status could not be refreshed' })).toHaveCount(0)
    expect(comparisonRequests).toEqual([
      { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 2 } },
      { automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'draft', version: 4 } },
    ])
    expect(page.url()).toContain('draftVersion=4')
    expect(durable(automation.id)).toEqual(before)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})
