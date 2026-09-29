import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationSource } from '../packages/core/dist/index.js'

let application: NumenApplication
let directory: string
let automationId: string

interface BrowserErrors {
  page: string[]
  console: string[]
  expected: Array<{ url: string; message: string; count: number }>
}
const browserErrors = new WeakMap<Page, BrowserErrors>()
const expectNetworkError = (page: Page, url: string, message: string) => {
  browserErrors.get(page)!.expected.push({ url, message, count: 0 })
}
test.beforeEach(({ page }) => {
  const errors: BrowserErrors = { page: [], console: [], expected: [] }
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.page.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const expected = errors.expected.find(item => item.count === 0 && item.url === message.location().url && item.message === message.text())
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
  directory = await mkdtemp(join(tmpdir(), 'numen-document-e2e-'))
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

async function openFixture(page: Page, suffix: string, inputs?: AutomationSource['inputs']) {
  const created = application.context.automations.create({ name: `A Protected ${suffix}`, source: { ...(inputs ? { inputs } : {}), triggers: [], flow: { type: 'block', id: 'flow', steps: [
    { type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: 'https://example.invalid/' }, headers: { type: 'literal', value: { Accept: 'application/json' } },
    } },
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 1000 } },
  ] } } })
  automationId = created.automation.id
  application.context.automations.create({ name: `B Other ${suffix}` })
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: `A Protected ${suffix}` }).click()
  await expect(page.getByRole('heading', { name: `A Protected ${suffix}`, exact: true })).toBeVisible()
  await page.locator('[data-node-id="request"]').click()
  await expect(page.getByLabel('Headers', { exact: true })).toBeVisible()
}

const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const draft = () => application.context.automations.getDraft(automationId)!
async function dismissNext(page: Page, action: () => Promise<unknown>) {
  let shown = false
  page.once('dialog', async dialog => { shown = true; await dialog.dismiss() })
  await action()
  await expect.poll(() => shown).toBe(true)
}

test('preserves unapplied input across cancelled node, tab, automation and history navigation', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await openFixture(page, 'input')
  const before = structuredClone(draft())
  const headers = page.getByLabel('Headers', { exact: true })
  const invalid = '{ "Authorization": '
  await headers.fill(invalid)
  await headers.press('Tab')
  await expect(headers).toHaveValue(invalid)
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  expect(draft()).toEqual(before)
  const closing = page.waitForEvent('dialog')
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0) })
  const closeDialog = await closing
  expect(closeDialog.type()).toBe('beforeunload')
  await closeDialog.dismiss()
  await expect(headers).toHaveValue(invalid)

  await dismissNext(page, () => page.locator('[data-node-id="wait"]').click())
  await expect(page.locator('[data-node-id="request"]')).toHaveAttribute('aria-pressed', 'true')
  await dismissNext(page, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute('aria-selected', 'true')
  await dismissNext(page, () => page.locator('.automation-row').filter({ hasText: 'B Other input' }).click())
  await expect(page.getByRole('heading', { name: 'A Protected input', exact: true })).toBeVisible()
  await dismissNext(page, () => page.getByRole('button', { name: 'Runs', exact: true }).click())
  const editorUrl = page.url()
  await dismissNext(page, () => page.evaluate(() => history.back()))
  await expect.poll(() => page.url()).toBe(editorUrl)
  await expect(headers).toHaveValue(invalid)

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Apply or correct the pending field input before publishing or archiving. Your input has been kept.', { exact: true })).toBeVisible()
  expect(application.context.automations.listRevisions(automationId)).toHaveLength(0)
  expect(draft()).toEqual(before)
  await page.screenshot({ path: testInfo.outputPath('document-invalid-desktop.png'), fullPage: true })
  await headers.fill('{"Accept":"text/plain"}')
  await headers.press('Tab')
  await saved(page)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'false')

  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByLabel('New input name', { exact: true }).fill('pending')
  await dismissNext(page, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await expect(page.getByLabel('New input name', { exact: true })).toHaveValue('pending')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Revisions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'false')
  expect(draft().source.inputs).toBeUndefined()
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
})

test('protects saving and failed Drafts, then discards only after an explicit choice', async ({ page }) => {
  test.setTimeout(90_000)
  await openFixture(page, 'save')
  await saved(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let accepted = false
  let delivered = false
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON().procedure === 'numen:automation-save-draft@1') {
      const response = await route.fetch()
      accepted = true
      await gate
      await route.fulfill({ response })
      delivered = true
    } else await route.continue()
  })
  try {
    await page.getByLabel('URL', { exact: true }).fill('https://example.invalid/accepted')
    await page.getByLabel('URL', { exact: true }).press('Tab')
    await expect.poll(() => accepted).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    await dismissNext(page, () => page.getByRole('button', { name: 'Runs', exact: true }).click())
    await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://example.invalid/accepted')
  } finally { release(); await expect.poll(() => delivered).toBe(true); await page.unroute('**/api/console/call') }
  await saved(page)
  const durable = structuredClone(draft().source)
  expectNetworkError(page, new URL('/api/console/call', application.workbenchUrl!).href, 'Failed to load resource: net::ERR_FAILED')
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON().procedure === 'numen:automation-save-draft@1') {
      await route.abort('failed')
    }
    else await route.continue()
  })
  await page.getByLabel('URL', { exact: true }).fill('https://example.invalid/not-saved')
  await page.getByLabel('URL', { exact: true }).press('Tab')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'ERROR')
  await dismissNext(page, () => page.locator('.automation-row').filter({ hasText: 'B Other save' }).click())
  await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://example.invalid/not-saved')
  expect(draft().source).toEqual(durable)
  page.once('dialog', dialog => dialog.accept())
  await page.locator('.automation-row').filter({ hasText: 'B Other save' }).click()
  await expect(page.getByRole('heading', { name: 'B Other save', exact: true })).toBeVisible()
  await page.unroute('**/api/console/call')
  await page.locator('.automation-row').filter({ hasText: 'A Protected save' }).click()
  await page.locator('[data-node-id="request"]').click()
  await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://example.invalid/accepted')
})

test('keeps an invalid default and checkbox consistent when discard is cancelled', async ({ page }) => {
  await openFixture(page, 'defaults', { payload: { type: 'object', default: { accepted: true } } })
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  const value = page.getByRole('textbox', { name: /^Default value/ })
  const enabled = page.getByRole('checkbox', { name: 'Use default for payload', exact: true })
  await value.fill('{"unfinished":')
  await value.press('Tab')
  await dismissNext(page, () => enabled.click())
  await expect(enabled).toBeChecked()
  await expect(value).toHaveValue('{"unfinished":')
  expect(draft().source.inputs?.payload?.default).toEqual({ accepted: true })
  await dismissNext(page, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await expect(value).toHaveValue('{"unfinished":')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'false')
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await expect(enabled).toBeChecked()
  expect(JSON.parse(await value.inputValue())).toEqual({ accepted: true })
})

test('discards pending JSON only when explicitly reloading after a real Draft conflict', async ({ page }) => {
  test.setTimeout(90_000)
  await openFixture(page, 'conflict')
  await saved(page)
  const before = structuredClone(draft())
  const serverSource = structuredClone(before.source)
  if (serverSource.flow.type !== 'block' || serverSource.flow.steps[0]?.type !== 'capability') throw new Error('Expected the request fixture')
  serverSource.flow.steps[0].input = {
    url: { type: 'literal', value: 'https://example.invalid/server-winner' },
    headers: { type: 'literal', value: { Accept: 'server/version', 'X-Version': 'winner' } },
  }
  const headers = page.getByLabel('Headers', { exact: true })
  const invalid = '{"unfinished-local":'
  let captured = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON().procedure !== 'numen:automation-save-draft@1') { await route.continue(); return }
    captured = true
    // Delay delivery to the server, allowing another client to win the same version.
    await gate
    const response = await route.fetch()
    expect(response.status()).toBe(409)
    expect(await response.json()).toMatchObject({ error: {
      code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: before.version, actualVersion: before.version + 1 },
    } })
    await route.fulfill({ response })
  })
  try {
    await page.getByLabel('URL', { exact: true }).fill('https://example.invalid/local-loser')
    await page.getByLabel('URL', { exact: true }).press('Tab')
    await expect.poll(() => captured).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    await headers.fill(invalid)
    await headers.press('Tab')
    await expect(headers).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')

    // APIRequestContext bypasses this page's route: this is a real independent Console client.
    const winner = await page.request.post(new URL('/api/console/call', application.workbenchUrl!).href, {
      headers: { origin: new URL(application.workbenchUrl!).origin },
      data: {
        kind: 'action', procedure: 'numen:automation-save-draft@1',
        input: { automationId, expectedVersion: before.version, source: serverSource, presentation: before.presentation },
      },
    })
    expect(winner.ok()).toBe(true)
    expect(await winner.json()).toMatchObject({ result: { draft: { version: before.version + 1, source: serverSource } } })
    expectNetworkError(page, new URL('/api/console/call', application.workbenchUrl!).href, 'Failed to load resource: the server responded with a status of 409 (Conflict)')
    release()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }

  const serverDraft = structuredClone(draft())
  expect(serverDraft.version).toBe(before.version + 1)
  await expect(headers).toHaveValue(invalid)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  await page.getByRole('button', { name: 'Compare and recover', exact: true }).click()
  const discard = page.getByRole('button', { name: 'Discard local and reload latest', exact: true })
  await expect(discard).toBeEnabled()
  await expect(page.getByRole('region', { name: 'Draft conflict recovery', exact: true })).toContainText('server-winner')
  await expect(headers).toHaveValue(invalid)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  await discard.click()
  await saved(page)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'false')
  await expect(page.getByRole('button', { name: 'Compare and recover', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://example.invalid/server-winner')
  expect(JSON.parse(await headers.inputValue())).toEqual({ Accept: 'server/version', 'X-Version': 'winner' })
  await expect(headers).toHaveAttribute('aria-invalid', 'false')
  await expect(headers).toBeEnabled()
  expect(draft()).toEqual(serverDraft)
  // A refresh must retain the winning version, not autosave the discarded local buffer.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'A Protected conflict', exact: true })).toBeVisible()
  await page.locator('[data-node-id="request"]').click()
  await saved(page)
  expect(JSON.parse(await headers.inputValue())).toEqual({ Accept: 'server/version', 'X-Version': 'winner' })
  expect(draft()).toEqual(serverDraft)
})
