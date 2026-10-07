import { expect, test, type Page } from '@playwright/test'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string

interface BrowserErrors {
  page: string[]
  console: string[]
  expected: Array<{ url: string; message: string; count: number }>
}
const browserErrors = new WeakMap<Page, BrowserErrors>()
const expectNetworkError = (page: Page, message: string) => {
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
  directory = await mkdtemp(join(tmpdir(), 'numen-draft-test-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {}, schedule: {},
    automations: {}, scheduler: { autoDispatch: true }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })

const echoSource = (): AutomationSource => ({
  inputs: { message: { type: 'string', title: 'Test message', default: 'initial-default' } },
  triggers: [{ id: 'annual', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
  flow: { type: 'block', id: 'root', steps: [{ type: 'capability', id: 'echo', capability: { id: 'demo:echo', version: 1 }, input: {
    message: { type: 'template', parts: [{ ref: 'input.message' }, ' / ', { ref: 'trigger.event' }] },
  } }] },
})
const form = (page: Page) => page.locator('.automation-draft-test .automation-manual-run')
const draft = (id: string) => application.context.automations.getDraft(id)!
const runs = (id: string) => application.context.scheduler.listRuns().filter(run => run.automationId === id)
const snapshotCount = (id: string) => (application.context.database.db.prepare("SELECT COUNT(*) AS count FROM automation_revisions WHERE automation_id = ? AND purpose = 'draft-test'").get(id) as { count: number }).count
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')

async function openFixture(page: Page, suffix: string, source = echoSource(), active = false) {
  const { automation } = application.context.automations.create({ name: `Draft test ${suffix}`, source })
  if (active) {
    const revision = application.context.automations.publishDraft(automation.id)
    application.context.automations.activateRevision(automation.id, revision.id)
    application.context.automations.setEnabled(automation.id, true)
    await expect.poll(() => application.context.triggers.automationHealth(automation.id)?.active).toBe(1)
  }
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: `Draft test ${suffix}` }).click()
  await expect(page.getByRole('heading', { name: `Draft test ${suffix}`, exact: true })).toBeVisible()
  await saved(page)
  return automation.id
}

test('waits for focused edits and queued saves, then keeps its accepted Source while editing and formal subscriptions continue', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const id = await openFixture(page, 'save and history', echoSource(), true)
  const published = application.context.automations.listRevisions(id)[0]!
  const activationBefore = application.context.automations.get(id)!
  const subscriptionBefore = structuredClone(application.context.triggers.automationHealth(id))
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  const defaultInput = page.locator('#default-input-message')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let firstSaveAccepted = false
  let delivered = false
  const queriedVersions: number[] = []
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure === 'numen:manual-run-form@1') queriedVersions.push(body.input.expectedDraftVersion)
    if (body.procedure === 'numen:automation-save-draft@1' && !firstSaveAccepted) {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      firstSaveAccepted = true
      await gate
      await route.fulfill({ response })
      delivered = true
    } else await route.continue()
  })
  try {
    await defaultInput.fill('focused-first-save')
    await expect(defaultInput).toBeFocused()
    await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
    await expect.poll(() => firstSaveAccepted).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    await expect(form(page).getByText('Loading parameters…', { exact: true })).toBeVisible()
    expect(queriedVersions).toEqual([])
    // Another edit arrives while the first save response is delayed. The launcher must wait for this save too.
    await defaultInput.fill('queued-latest-save')
    await defaultInput.press('Tab')
    release()
    await saved(page)
    await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('queued-latest-save')
  } finally { release(); await expect.poll(() => delivered).toBe(true); await page.unrouteAll({ behavior: 'wait' }) }
  const acceptedVersion = draft(id).version
  expect(queriedVersions).toEqual([acceptedVersion])
  expect(draft(id).source.inputs?.message?.default).toBe('queued-latest-save')
  await expect(form(page).getByText(`Draft test · Draft v${acceptedVersion}`, { exact: true })).toBeVisible()
  await form(page).getByLabel('Test message', { exact: true }).fill('focused-run-input')
  await form(page).getByLabel('Trigger data (JSON)', { exact: true }).fill('{"event":"snapshot event"}')
  await form(page).getByRole('button', { name: 'Test saved Draft', exact: true }).click()
  await expect(page.locator('.draft-test-result')).toContainText(`Accepted test · Draft v${acceptedVersion}`)
  expect(runs(id)).toHaveLength(1)
  const run = runs(id)[0]!
  const snapshot = structuredClone(application.context.automations.getExecutionSnapshot(run.revisionId)!)
  expect(snapshot).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: acceptedVersion, baseRevisionId: published.id })
  expect('number' in snapshot).toBe(false)
  await expect.poll(() => application.context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  expect(application.context.scheduler.listExecutions(run.id).map(execution => execution.output)).toContainEqual({ message: 'focused-run-input / snapshot event' })
  await defaultInput.fill('current-after-test')
  await defaultInput.press('Tab')
  await saved(page)
  await expect(page.locator('.draft-test-result')).toContainText('The current Draft has changed; this Run keeps its accepted snapshot.')
  expect(application.context.automations.getExecutionSnapshot(run.revisionId)).toEqual(snapshot)
  expect(application.context.automations.listRevisions(id)).toEqual([published])
  expect(application.context.automations.get(id)).toMatchObject({ activeRevisionId: activationBefore.activeRevisionId, enabled: true, activationGeneration: activationBefore.activationGeneration })
  expect(application.context.triggers.automationHealth(id)).toEqual(subscriptionBefore)
  expect(snapshotCount(id)).toBe(1)
  await page.locator('.automation-draft-test').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('draft-test-snapshot-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(form(page).getByRole('button', { name: '保存最新草稿并重新加载参数', exact: true })).toBeVisible()
  await form(page).getByRole('button', { name: '试运行已保存草稿', exact: true }).scrollIntoViewIfNeeded()
  await expect(form(page).getByRole('button', { name: '试运行已保存草稿', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('draft-test-actions-mobile-zh.png'), fullPage: true })
  await page.locator('.automation-draft-test').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('draft-test-snapshot-mobile-zh.png'), fullPage: true })
  await page.getByRole('button', { name: '语言', exact: true }).click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.locator('.draft-test-result').getByRole('button', { name: 'View Run', exact: true }).click()
  await expect(page).toHaveURL(new URL(`/runs/${run.id}/flow`, application.workbenchUrl!).href)
  await expect(page.locator('.run-detail-header')).toContainText(`Draft test · Draft v${acceptedVersion}`)
  await expect(page.getByRole('button', { name: 'Save current Draft and test', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.run-detail-header')).toContainText(`Draft test · Draft v${acceptedVersion}`)
  expect(draft(id).version).toBeGreaterThan(acceptedVersion)
  expect(application.context.automations.getExecutionSnapshot(run.revisionId)).toEqual(snapshot)
})

test('blocks invalid focused JSON and locates a real compile error without creating partial snapshots', async ({ page }) => {
  const source: AutomationSource = { inputs: {}, triggers: [], flow: { type: 'block', id: 'root', steps: [{ type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
    url: { type: 'literal', value: 'https://example.invalid/' }, headers: { type: 'literal', value: { Accept: 'application/json' } },
  } }] } }
  const id = await openFixture(page, 'invalid JSON', source)
  await page.locator('[data-node-id="request"]').click()
  const headers = page.getByLabel('Headers', { exact: true })
  const before = structuredClone(draft(id))
  await headers.fill('{"unfinished":')
  await expect(headers).toBeFocused()
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Apply or correct the pending field input before publishing, archiving, or testing. Your input has been kept.', { exact: true })).toBeVisible()
  await expect(form(page)).toHaveCount(0)
  await expect(headers).toHaveValue('{"unfinished":')
  expect(draft(id)).toEqual(before)
  expect(runs(id)).toHaveLength(0)
  expect(snapshotCount(id)).toBe(0)
  // Correct the pending buffer before moving to another fixture.
  await headers.fill('{"Accept":"application/json"}')
  await headers.press('Tab')
  await saved(page)

  const invalidSource: AutomationSource = { inputs: {}, triggers: [], flow: { type: 'block', id: 'root', steps: [
    { type: 'wait', id: 'selected-wait', durationMs: { type: 'literal', value: 1000 } },
    { type: 'capability', id: 'missing', capability: { id: 'missing:test-contract', version: 1 }, input: {} },
  ] } }
  const invalidId = await openFixture(page, 'compile diagnostics', invalidSource)
  await page.locator('[data-node-id="selected-wait"]').click()
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeEnabled()
  expectNetworkError(page, 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)')
  await form(page).getByRole('button', { name: 'Test saved Draft', exact: true }).click()
  await expect(form(page).getByText('The Draft could not be compiled. Fix the diagnostics, then save and reload parameters.', { exact: true })).toBeVisible()
  await expect(form(page).getByRole('alert').filter({ hasText: 'CAPABILITY_MISSING' })).toContainText('missing:test-contract@1')
  await form(page).getByRole('button', { name: 'Locate source node', exact: true }).click()
  await expect(page.locator('[data-node-id="missing"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeDisabled()
  expect(runs(invalidId)).toHaveLength(0)
  expect(snapshotCount(invalidId)).toBe(0)
})

test('rejects a changed saved version instead of silently selecting the latest Draft', async ({ page }) => {
  const id = await openFixture(page, 'remote version')
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('initial-default')
  const before = structuredClone(draft(id))
  const winner = structuredClone(before.source)
  winner.inputs!.message!.default = 'remote-winner-default'
  const response = await page.request.post(new URL('/api/console/call', application.workbenchUrl!).href, {
    headers: { origin: new URL(application.workbenchUrl!).origin },
    data: { kind: 'action', procedure: 'numen:automation-save-draft@1', input: { automationId: id, expectedVersion: before.version, source: winner, presentation: before.presentation } },
  })
  expect(response.ok()).toBe(true)
  const submittedVersions: number[] = []
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure === 'numen:manual-run-start@1') submittedVersions.push(body.input.expectedDraftVersion)
    await route.continue()
  })
  try {
    expectNetworkError(page, 'Failed to load resource: the server responded with a status of 409 (Conflict)')
    await form(page).getByRole('button', { name: 'Test saved Draft', exact: true }).click()
    await expect(form(page).getByText('The saved Draft version changed. No Run was accepted. Save and reload parameters explicitly before testing again.', { exact: true })).toBeVisible()
    await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeDisabled()
    await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('initial-default')
    expect(submittedVersions).toEqual([before.version])
    expect(runs(id)).toHaveLength(0)
    expect(snapshotCount(id)).toBe(0)
    await form(page).getByRole('button', { name: 'Save latest Draft and reload parameters', exact: true }).click()
    await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('remote-winner-default')
    await expect(form(page).getByText(`Draft test · Draft v${before.version + 1}`, { exact: true })).toBeVisible()
    await form(page).getByLabel('Trigger data (JSON)', { exact: true }).fill('{"event":"fresh"}')
    await form(page).getByRole('button', { name: 'Test saved Draft', exact: true }).click()
    await expect(page.locator('.draft-test-result')).toContainText(`Accepted test · Draft v${before.version + 1}`)
    expect(submittedVersions).toEqual([before.version, before.version + 1])
    expect(runs(id)).toHaveLength(1)
    expect(snapshotCount(id)).toBe(1)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('tests an unpublished disabled Draft and recovers a lost acceptance after close, archive and reopen', async ({ page }) => {
  const id = await openFixture(page, 'uncertain recovery')
  const before = structuredClone(draft(id))
  expect(application.context.automations.get(id)).toMatchObject({ enabled: false })
  expect(application.context.automations.listRevisions(id)).toHaveLength(0)
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('initial-default')
  const requests: unknown[] = []
  let loseNextResponse = true
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON()
    if (body.procedure === 'numen:manual-run-start@1') {
      requests.push(body.input)
      if (loseNextResponse) {
        loseNextResponse = false
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  try {
    await form(page).getByLabel('Test message', { exact: true }).fill('uncertain-frozen-input')
    await form(page).getByLabel('Trigger data (JSON)', { exact: true }).fill('{"event":"frozen"}')
    expectNetworkError(page, 'Failed to load resource: net::ERR_FAILED')
    await form(page).getByRole('button', { name: 'Test saved Draft', exact: true }).click()
    await expect(form(page).getByText('Run acceptance could not be confirmed. Retry safely with the same request.', { exact: true })).toBeVisible()
    expect(runs(id)).toHaveLength(1)
    const run = runs(id)[0]!
    expect(snapshotCount(id)).toBe(1)
    await form(page).getByRole('button', { name: 'Close test parameters', exact: true }).click()
    await expect(form(page)).toBeHidden()
    application.context.automations.archive(id)
    await expect(page.locator('.automation-badges').getByText('Archived', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Show test parameters', exact: true }).click({ timeout: 5_000 })
    await expect(form(page).getByLabel('Test message', { exact: true })).toHaveValue('uncertain-frozen-input')
    await expect(form(page).getByLabel('Test message', { exact: true })).toBeDisabled()
    await expect(form(page).getByRole('button', { name: 'Save latest Draft and reload parameters', exact: true })).toBeDisabled()
    await form(page).getByRole('button', { name: 'Retry Start Run', exact: true }).click()
    await expect(page.locator('.draft-test-result')).toContainText(`Accepted test · Draft v${before.version}`)
    await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeDisabled()
    await expect(form(page).getByRole('button', { name: 'Save latest Draft and reload parameters', exact: true })).toBeDisabled()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(requests[0]).toMatchObject({ mode: 'draft-test', expectedDraftVersion: before.version, input: { message: 'uncertain-frozen-input' }, trigger: { event: 'frozen' } })
    expect(runs(id).map(value => value.id)).toEqual([run.id])
    expect(snapshotCount(id)).toBe(1)
    expect(application.context.automations.listRevisions(id)).toHaveLength(0)
    expect(application.context.automations.get(id)).toMatchObject({ enabled: false })
    expect(draft(id)).toEqual(before)
    await expect.poll(() => application.context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(application.context.scheduler.listExecutions(run.id).map(value => value.output)).toContainEqual({ message: 'uncertain-frozen-input / frozen' })
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('protects valid focused test parameter buffers before they are committed', async ({ page }) => {
  const source = echoSource()
  source.inputs!.payload = { type: 'object', title: 'Test payload', default: { saved: true } }
  const id = await openFixture(page, 'focused parameter protection', source)
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  const message = form(page).getByLabel('Test message', { exact: true })
  const payload = form(page).getByLabel('Test payload', { exact: true })
  await expect(message).toHaveValue('initial-default')
  const savedDraft = structuredClone(draft(id))
  const protectsBeforeUnload = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  await message.fill('focused-valid-string')
  await expect(message).toBeFocused()
  const stringProtected = await protectsBeforeUnload()
  // Restore the committed state before independently checking the valid JSON buffer.
  await message.fill('initial-default')
  await message.press('Tab')
  await payload.fill('{"valid":"focused-json"}')
  await expect(payload).toBeFocused()
  const jsonProtected = await protectsBeforeUnload()
  await saved(page)
  expect(draft(id)).toEqual(savedDraft)
  expect({ stringProtected, jsonProtected }).toEqual({ stringProtected: true, jsonProtected: true })
})

test('explicitly reloading parameters resets an invalid buffer even at the same Draft version', async ({ page }) => {
  const source = echoSource()
  source.inputs!.payload = { type: 'object', title: 'Test payload', default: { saved: true } }
  const id = await openFixture(page, 'same version parameter reset', source)
  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  const payload = form(page).getByLabel('Test payload', { exact: true })
  await expect(payload).toBeVisible()
  const version = draft(id).version
  await payload.fill('{"unfinished":')
  await payload.press('Tab')
  await expect(payload).toHaveAttribute('aria-invalid', 'true')
  await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeDisabled()
  await form(page).getByRole('button', { name: 'Save latest Draft and reload parameters', exact: true }).click()
  await expect(form(page).getByText(`Draft test · Draft v${version}`, { exact: true })).toBeVisible()
  expect(draft(id).version).toBe(version)
  await expect(payload).toHaveAttribute('aria-invalid', 'false')
  expect(JSON.parse(await payload.inputValue())).toEqual({ saved: true })
  await expect(form(page).getByRole('button', { name: 'Test saved Draft', exact: true })).toBeEnabled()
  expect(runs(id)).toHaveLength(0)
  expect(snapshotCount(id)).toBe(0)
})
