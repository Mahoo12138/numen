import { applyFreshHostConfig } from './helpers/host-config.js'
import { expect, test, type Page } from '@playwright/test'
import { loadConfig, writeConfig, type HostConfigMutationRequest } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import demoIntegrationPlugin from '../packages/integration-demo/dist/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication, directory: string, configPath: string
const schema = createRequire(new URL('../packages/runtime/package.json', import.meta.url))('schemastery')
const editableDemo = demoIntegrationPlugin as typeof demoIntegrationPlugin & { Config?: unknown }
let originalSchema: unknown
const originalConfig = { retained: 'original value', nested: { unchanged: true } }
interface BrowserErrors {
  page: string[]
  console: string[]
  expected: Array<{ url: string; message: string; count: number }>
}
const browserErrors = new WeakMap<Page, BrowserErrors>()
let observedPages: Page[]
function observePage(page: Page) {
  const errors: BrowserErrors = { page: [], console: [], expected: [] }
  browserErrors.set(page, errors)
  observedPages.push(page)
  page.on('pageerror', error => errors.page.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const expected = errors.expected.find(item => item.count === 0 && item.url === message.location().url && item.message === message.text())
    if (expected) expected.count += 1
    else errors.console.push(`${message.text()} (${message.location().url})`)
  })
}
function expectNetworkError(page: Page, message: string) {
  browserErrors.get(page)!.expected.push({ url: new URL('/api/console/call', application.workbenchUrl!).href, message, count: 0 })
}

test.beforeEach(async ({ page }) => {
  // The N0 JSON editing regressions require an explicitly public, nonsecret Schema.
  // Keep this test-only declaration scoped to the fixture rather than widening production policy.
  originalSchema = editableDemo.Config
  editableDemo.Config = schema.object({})
  observedPages = []
  observePage(page)
  directory = await mkdtemp(join(tmpdir(), 'numen-plugin-editing-e2e-'))
  configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: originalConfig,
    'group:first': { $label: 'First group', plugins: {} }, 'group:second': { $label: 'Second group', plugins: {} },
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterEach(async () => {
  try {
    for (const page of observedPages) {
      const errors = browserErrors.get(page)!
      expect(errors.page).toEqual([])
      expect(errors.console).toEqual([])
      for (const expected of errors.expected) expect(expected.count, expected.message).toBe(1)
    }
  } finally {
    await application?.stop()
    if (originalSchema === undefined) delete editableDemo.Config
    else editableDemo.Config = originalSchema
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

async function plugins(page: Page) {
  await page.goto(application.workbenchUrl!)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-entry-id="demo"]')).toBeVisible()
}
async function editConfig(page: Page) {
  await page.locator('[data-entry-id="demo"]').getByRole('button', { name: 'Edit instance', exact: true }).click()
  await page.locator('.plugin-editor').getByLabel('Operation', { exact: true }).selectOption('setConfig')
  await page.locator('.plugin-editor').getByRole('button', { name: 'Advanced JSON', exact: true }).click()
  return page.locator('.plugin-editor').getByLabel('Plugin configuration (JSON)', { exact: true })
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
}
function recordMutations(page: Page) {
  const calls: Array<{ procedure: string; input: HostConfigMutationRequest }> = []
  page.on('request', request => {
    if (!request.url().endsWith('/api/console/call') || request.method() !== 'POST') return
    const call = request.postDataJSON()
    if (call.procedure === 'numen:plugin-preview@1' || call.procedure === 'numen:plugin-apply@1') calls.push(call)
  })
  return calls
}

async function chooseDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  let shown = false
  page.once('dialog', async dialog => {
    shown = true
    expect(dialog.type()).toBe('confirm')
    if (accept) await dialog.accept()
    else await dialog.dismiss()
  })
  await action()
  await expect.poll(() => shown).toBe(true)
}

for (const timing of ['before Preview', 'after Preview'] as const) {
  test(`keeps the form baseline when another browser writes ${timing}`, async ({ page, browser }, testInfo) => {
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    observePage(other)
    try {
      await plugins(page)
      const base = await application.context.hostConfig.read()
      const calls = recordMutations(page)
      const local = { ...originalConfig, localAddition: 'kept in the first browser' }
      const remote = { ...originalConfig, retained: 'updated by another browser', remoteAddition: 'must survive' }
      const config = await editConfig(page)
      await config.fill(JSON.stringify(local, null, 2))
      if (timing === 'after Preview') {
        await page.locator('.plugin-editor').getByRole('button', { name: 'Preview change', exact: true }).click()
        await expect(page.locator('.plugin-preview')).toBeVisible()
      }

      const refreshed = page.waitForResponse(async response => {
        if (!response.url().endsWith('/api/console/call') || response.request().postDataJSON()?.procedure !== 'numen:plugins@1') return false
        const body = await response.json()
        return body.result?.entries?.some((entry: { id: string; config: Record<string, unknown> }) => entry.id === 'demo' && entry.config.remoteAddition === 'must survive')
      })
      await plugins(other)
      await (await editConfig(other)).fill(JSON.stringify(remote, null, 2))
      await other.locator('.plugin-editor').getByRole('button', { name: 'Preview change', exact: true }).click()
      await save(other)
      const latest = await application.context.hostConfig.read()
      expect(latest.fingerprint).not.toBe(base.fingerprint)
      await refreshed
      await expect(config).toHaveValue(JSON.stringify(local, null, 2))

      if (timing === 'before Preview') {
        await page.locator('.plugin-editor').getByRole('button', { name: 'Preview change', exact: true }).click()
        await expect(page.locator('.plugin-preview')).toBeVisible()
      }
      const previewCall = calls.find(call => call.procedure === 'numen:plugin-preview@1')!
      expect.soft(previewCall.input.fingerprint, 'Preview must keep the fingerprint paired with the text opened by this browser').toBe(base.fingerprint)
      expect(previewCall.input.operation).toEqual({ kind: 'setConfig', id: 'demo', config: local })
      const applyButton = page.getByRole('button', { name: 'Save and apply this change', exact: true })
      if (timing === 'after Preview') {
        await expect(applyButton).toBeEnabled()
        expectNetworkError(page, 'Failed to load resource: the server responded with a status of 409 (Conflict)')
        await applyButton.click()
        await expect(page.locator('.plugin-preview')).not.toBeVisible()
        await expect(page.getByText(/Configuration changed\. Refresh/)).toBeVisible()
      } else {
        await expect(page.locator('.plugin-preview').getByRole('alert')).toContainText('Configuration changed.')
        await expect(applyButton).toBeDisabled()
      }
      const applyCall = calls.find(call => call.procedure === 'numen:plugin-apply@1')
      if (timing === 'after Preview') {
        expect(applyCall, 'The post-Preview conflict must be checked by an actual Apply request').toBeDefined()
        expect.soft(applyCall!.input.fingerprint, 'Apply must use the same frozen baseline as Preview').toBe(base.fingerprint)
        expect(applyCall!.input).toMatchObject({ previewToken: expect.any(String) })
      } else expect(applyCall, 'The blocked pre-Preview conflict must not issue an Apply request').toBeUndefined()
      const disk = await loadConfig(configPath)
      const yaml = await readFile(configPath, 'utf8')
      await testInfo.attach('concurrent-edit-evidence', { body: JSON.stringify({ timing, baseFingerprint: base.fingerprint, latestFingerprint: latest.fingerprint, calls, finalConfig: disk.config.plugins.demo }, null, 2), contentType: 'application/json' })
      await testInfo.attach('final-temporary-config.yml', { body: yaml, contentType: 'text/yaml' })
      expect.soft(disk.config.plugins.demo, 'The other browser\'s complete configuration must remain on disk').toEqual(remote)
      await expect(config).toHaveValue(JSON.stringify(local, null, 2))

      await expect(page.getByText(/^Configuration changed elsewhere\. Your local input has been kept\./)).toBeVisible()
      const editor = page.locator('.plugin-editor')
      await editor.getByText('Compare with latest configuration', { exact: true }).click()
      await expect(editor.locator('details')).toContainText('original value')
      await expect(editor.locator('details')).toContainText('updated by another browser')
      if (timing === 'before Preview') {
        await page.screenshot({ path: testInfo.outputPath('plugin-stale-comparison-desktop.png'), fullPage: true })
        await page.setViewportSize({ width: 900, height: 800 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await editor.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await page.screenshot({ path: testInfo.outputPath('plugin-stale-comparison-narrow.png'), fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.getByRole('button', { name: 'Language', exact: true }).click()
        await page.getByRole('option', { name: '简体中文', exact: true }).click()
        await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await editor.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await page.screenshot({ path: testInfo.outputPath('plugin-stale-comparison-mobile-zh.png'), fullPage: true })
        await page.getByRole('button', { name: '语言', exact: true }).click()
        await page.getByRole('option', { name: 'English', exact: true }).click()
        await page.setViewportSize({ width: 1440, height: 960 })
      }
      await chooseDiscard(page, false, () => editor.getByRole('button', { name: 'Reload latest configuration', exact: true }).click())
      await expect(config).toHaveValue(JSON.stringify(local, null, 2))
      await chooseDiscard(page, true, () => editor.getByRole('button', { name: 'Reload latest configuration', exact: true }).click())
      await expect(config).toHaveValue(JSON.stringify(remote, null, 2))
      const merged = { ...remote, localAddition: 'reviewed after reloading' }
      await config.fill(JSON.stringify(merged, null, 2))
      await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
      await save(page)
      expect(calls.at(-2)?.input.fingerprint).toBe(latest.fingerprint)
      expect(calls.at(-1)?.input.fingerprint).toBe(latest.fingerprint)
      expect((await loadConfig(configPath)).config.plugins.demo).toEqual(merged)
    } finally { await otherContext.close() }
  })
}

test('preserves invalid JSON and hidden fields, then changes instance or closes only after explicit discard', async ({ page }) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8')
  const calls = recordMutations(page)
  const config = await editConfig(page)
  const editor = page.locator('.plugin-editor')
  const invalid = '{ "unfinished": '
  await config.fill(invalid)
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.getByText('Enter a valid JSON object.', { exact: true })).toBeVisible()
  await expect(config).toHaveValue(invalid)
  expect(calls).toEqual([])

  await editor.getByLabel('Operation', { exact: true }).selectOption('setLabel')
  await editor.getByLabel('Display label', { exact: true }).fill('Unsubmitted local label')
  await editor.getByLabel('Operation', { exact: true }).selectOption('move')
  await editor.getByLabel('Parent group', { exact: true }).selectOption('group-first')
  await editor.getByLabel('Parent group', { exact: true }).selectOption('group-second')
  await editor.getByLabel('Operation', { exact: true }).selectOption('setConfig')
  await expect(config).toHaveValue(invalid)
  await editor.getByLabel('Operation', { exact: true }).selectOption('setLabel')
  await expect(editor.getByLabel('Display label', { exact: true })).toHaveValue('Unsubmitted local label')
  await editor.getByLabel('Operation', { exact: true }).selectOption('move')
  await expect(editor.getByLabel('Parent group', { exact: true })).toHaveValue('group-second')
  await editor.getByLabel('Operation', { exact: true }).selectOption('setConfig')

  await chooseDiscard(page, false, () => page.locator('[data-entry-id="group-first"]').getByRole('button', { name: 'Edit instance', exact: true }).click())
  await expect(editor.getByRole('heading', { name: 'demo', exact: true })).toBeVisible()
  await expect(config).toHaveValue(invalid)
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Create group', exact: true }).click())
  await expect(config).toHaveValue(invalid)
  await chooseDiscard(page, false, () => editor.getByRole('button', { name: 'Cancel', exact: true }).click())
  await expect(config).toHaveValue(invalid)
  await chooseDiscard(page, false, () => page.locator('[data-entry-id="demo"]').getByRole('button', { name: 'Disable', exact: true }).click())
  await expect(config).toHaveValue(invalid)
  await chooseDiscard(page, true, () => page.locator('[data-entry-id="group-first"]').getByRole('button', { name: 'Edit instance', exact: true }).click())
  await expect(editor.getByLabel('Display label', { exact: true })).toHaveValue('First group')
  await editor.getByLabel('Display label', { exact: true }).fill('Unsubmitted group label')
  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Create group', exact: true }).click())
  await expect(editor.getByLabel('Stable group identifier', { exact: true })).toBeVisible()
  await editor.getByLabel('Stable group identifier', { exact: true }).fill('unsaved-group')
  await chooseDiscard(page, false, () => editor.getByRole('button', { name: 'Cancel', exact: true }).click())
  await expect(editor.getByLabel('Stable group identifier', { exact: true })).toHaveValue('unsaved-group')
  await chooseDiscard(page, true, () => editor.getByRole('button', { name: 'Cancel', exact: true }).click())
  await expect(editor).not.toBeVisible()
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(calls).toEqual([])
})

test('protects invalid input on application navigation, browser history and refresh', async ({ page }, testInfo) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8')
  const config = await editConfig(page)
  const invalid = '{ "unfinished": '
  await config.fill(invalid)
  const pluginsUrl = page.url()
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
  await expect(page).toHaveURL(pluginsUrl)
  await expect(config).toHaveValue(invalid)
  await chooseDiscard(page, false, () => page.evaluate(() => history.back()))
  await expect.poll(() => page.url()).toBe(pluginsUrl)
  await expect(config).toHaveValue(invalid)

  const refreshing = page.waitForEvent('dialog')
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0) })
  const dialog = await refreshing
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await expect(config).toHaveValue(invalid)
  await expect(page).toHaveURL(pluginsUrl)
  await page.screenshot({ path: testInfo.outputPath('plugin-unsubmitted-input.png'), fullPage: true })

  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Home', exact: true }).click())
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const clean = await editConfig(page)
  await expect(clean).toHaveValue(JSON.stringify(originalConfig, null, 2))
  await clean.fill('{"validButUnsubmitted":true}')
  const leaving = page.waitForEvent('dialog')
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0) })
  const leaveDialog = await leaving
  expect(leaveDialog.type()).toBe('beforeunload')
  await leaveDialog.accept()
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.locator('.plugin-editor')).not.toBeVisible()
  const afterReload = await editConfig(page)
  await expect(afterReload).toHaveValue(JSON.stringify(originalConfig, null, 2))
  await afterReload.fill('{"validButUnsubmitted":true}')
  await chooseDiscard(page, true, () => page.evaluate(() => history.back()))
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  expect(await readFile(configPath, 'utf8')).toBe(before)
})

test('keeps local values when Preview is cancelled and protects a clean form with an unapplied Preview', async ({ page }) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8')
  const calls = recordMutations(page)
  const config = await editConfig(page)
  const local = JSON.stringify({ ...originalConfig, localAddition: 'not yet applied' }, null, 2)
  await config.fill(local)
  const editor = page.locator('.plugin-editor')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview')).toBeVisible()
  await page.locator('.plugin-preview').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.plugin-preview')).not.toBeVisible()
  await expect(config).toHaveValue(local)
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
  await expect(config).toHaveValue(local)
  await chooseDiscard(page, true, () => editor.getByRole('button', { name: 'Cancel', exact: true }).click())

  await page.locator('[data-entry-id="demo"]').getByRole('button', { name: 'Edit instance', exact: true }).click()
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview')).toBeVisible()
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
  await expect(page.locator('.plugin-preview')).toBeVisible()
  await page.locator('.plugin-preview').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toEqual([])
  expect(await readFile(configPath, 'utf8')).toBe(before)
})

test('keeps the input element and invalid text through a failed refresh and recovery', async ({ page }) => {
  await plugins(page)
  const config = await editConfig(page)
  const invalid = '{"unfinished":'
  await config.fill(invalid)
  const input = await config.elementHandle()
  expectNetworkError(page, 'Failed to load resource: net::ERR_FAILED')
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure === 'numen:plugins@1') await route.abort('failed')
    else await route.continue()
  })
  await page.getByRole('button', { name: 'Refresh current state', exact: true }).click()
  await expect(page.getByText('Host configuration unavailable', { exact: true })).toBeVisible()
  await expect(config).toHaveValue(invalid)
  expect(await input!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.locator('.plugin-editor').getByRole('button', { name: 'Preview change', exact: true })).toBeDisabled()
  // A Host write while the query remains unavailable must be observed on retry without replacing local input.
  expectNetworkError(page, 'Failed to load resource: net::ERR_FAILED')
  const base = await application.context.hostConfig.read()
  await applyFreshHostConfig(application.context.hostConfig, { fingerprint: base.fingerprint, operation: { kind: 'setLabel', id: 'demo', label: 'Updated while Query was unavailable' } })
  await expect.poll(() => browserErrors.get(page)!.expected.reduce((count, expected) => count + expected.count, 0)).toBe(2)
  await page.unroute('**/api/console/call')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('Host configuration unavailable', { exact: true })).not.toBeVisible()
  await expect(config).toHaveValue(invalid)
  expect(await input!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.locator('.plugin-editor').getByRole('button', { name: 'Preview change', exact: true })).toBeEnabled()
  await expect(page.locator('[data-entry-id="demo"]')).toContainText('Updated while Query was unavailable')
  await expect(page.getByText(/^Configuration changed elsewhere\. Your local input has been kept\./)).toBeVisible()
  expect((await loadConfig(configPath)).config.plugins.demo).toEqual({ ...originalConfig, $label: 'Updated while Query was unavailable' })
})

test('applies one operation only after explicitly discarding buffered input for other operations', async ({ page }) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8')
  const base = await application.context.hostConfig.read()
  const calls = recordMutations(page)
  const config = await editConfig(page)
  const invalid = '{"unfinished":'
  const editor = page.locator('.plugin-editor')
  await config.fill(invalid)
  await editor.getByLabel('Operation', { exact: true }).selectOption('setLabel')
  await editor.getByLabel('Display label', { exact: true }).fill('Reviewed local label')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  const applyButton = page.getByRole('button', { name: 'Save and apply this change', exact: true })
  await chooseDiscard(page, false, () => applyButton.click())
  await expect(page.locator('.plugin-preview')).toBeVisible()
  await expect(editor.getByLabel('Display label', { exact: true })).toHaveValue('Reviewed local label')
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toEqual([])
  expect(await readFile(configPath, 'utf8')).toBe(before)
  await editor.getByLabel('Operation', { exact: true }).selectOption('setConfig')
  await expect(config).toHaveValue(invalid)
  await editor.getByLabel('Operation', { exact: true }).selectOption('setLabel')
  await expect(editor.getByLabel('Display label', { exact: true })).toHaveValue('Reviewed local label')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await chooseDiscard(page, false, () => applyButton.click())
  await expect(page.locator('.plugin-preview')).toBeVisible()
  await chooseDiscard(page, true, () => applyButton.click())
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
  await expect(editor).not.toBeVisible()
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toEqual([
    expect.objectContaining({ input: { fingerprint: base.fingerprint, operation: { kind: 'setLabel', id: 'demo', label: 'Reviewed local label' }, previewToken: expect.any(String) } }),
  ])
  expect((await loadConfig(configPath)).config.plugins.demo).toEqual({ ...originalConfig, $label: 'Reviewed local label' })
})
