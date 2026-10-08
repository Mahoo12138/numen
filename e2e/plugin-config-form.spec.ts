import { applyFreshHostConfig } from './helpers/host-config.js'
import { expect, test, type Page } from '@playwright/test'
import { loadConfig, writeConfig, type HostConfigMutationRequest, type HostConfigSnapshot } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Browser plugin not available: exercise the production bundle with repository Playwright
// and a real, isolated Runtime. The external plugin uses the installed Schema implementation.
const require = createRequire(new URL('../packages/runtime/package.json', import.meta.url))
const schemaUrl = pathToFileURL(require.resolve('schemastery')).href
const original = {
  title: 'Alpha title', attempts: 2, active: true, mode: 'steady',
  connection: { endpoint: 'https://example.test', retry: 1, futureOption: { retain: true } },
  tags: ['first', 'second'], lower: 1, upper: 4,
  advanced: { keep: ['nested', 2] }, futureRoot: { untouched: ['alpha', { beta: false }] },
}
let application: NumenApplication, directory: string, configPath: string, modulePath: string
interface ObservedErrors { page: string[]; console: string[]; expected: Array<{ message: string; count: number }> }
let errors: ObservedErrors

function expectNetworkError(message: string) { errors.expected.push({ message, count: 0 }) }
test.beforeEach(async ({ page }) => {
  errors = { page: [], console: [], expected: [] }
  page.on('pageerror', error => errors.page.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const item = errors.expected.find(item => item.count === 0 && item.message === message.text() && message.location().url === new URL('/api/console/call', application.workbenchUrl!).href)
    if (item) item.count++
    else errors.console.push(`${message.text()} (${message.location().url})`)
  })
  directory = await mkdtemp(join(tmpdir(), 'numen-plugin-config-form-e2e-'))
  configPath = join(directory, 'numen.config.yml')
  modulePath = join(directory, 'form-fixture.mjs')
  await writeFile(modulePath, `import z from ${JSON.stringify(schemaUrl)};
const base = z.object({
  title: z.string().required(), attempts: z.number().min(0), active: z.boolean(),
  mode: z.union([z.const('steady'), z.const('burst')]),
  connection: z.object({ endpoint: z.string(), retry: z.number() }),
  tags: z.array(z.string()), lower: z.number(), upper: z.number(),
  optionalDefault: z.string().default('RUNTIME_DEFAULT_MUST_NOT_BE_SENT'),
  advanced: z.dict(z.any()),
});
const Config = { type: 'object', dict: base.dict, meta: base.meta, '~standard': {
  version: 1, vendor: 'numen-browser-fixture', validate(input) {
    const result = base['~standard'].validate(input);
    if (result.issues) return result;
    if (result.value.lower > result.value.upper) return { issues: [{ message: 'Internal cross-field validator details must stay on the host' }] };
    return result;
  },
} };
export default { name: 'safe-form-product', Config, apply(ctx) {
  ctx.plugin({ name: 'readonly-form-internal', apply() {} });
} };
`)
  const secretPath = join(directory, 'secret-fixture.mjs')
  await writeFile(secretPath, `import z from ${JSON.stringify(schemaUrl)};
export default { name: 'secret-product', Config: z.object({ accessPhrase: z.string().role('secret'), ordinary: z.string() }), apply() {} };
`)
  const noSchemaPath = join(directory, 'no-schema-fixture.mjs')
  await writeFile(noSchemaPath, 'export default { name: "no-schema-product", apply() {} };\n')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    'form:a': { $package: modulePath, $label: 'Form Alpha', ...structuredClone(original) },
    'form:b': { $package: modulePath, $label: 'Form Beta', ...structuredClone(original), title: 'Beta title' },
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {},
    secret: { $package: secretPath, accessPhrase: 'DO_NOT_EXPOSE_SCHEMA_SECRET', ordinary: 'WITHHOLD_ENTIRE_SECRET_CONFIG' },
    noSchema: { $package: noSchemaPath, ordinary: 'WITHHOLD_UNKNOWN_SCHEMA_CONFIG' },
    '~unloaded': { $package: join(directory, 'not-installed.mjs'), ordinary: 'WITHHOLD_UNLOADED_CONFIG' },
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterEach(async () => {
  try {
    expect(errors.page).toEqual([])
    expect(errors.console).toEqual([])
    for (const item of errors.expected) expect(item.count, item.message).toBe(1)
  } finally { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) }
})

async function plugins(page: Page) {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/plugins\/installed(?:\?|$)/)
  await expect(page).toHaveTitle(/Numen/)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await expect(page.locator('[data-entry-id="form-a"]')).toBeVisible()
}
async function form(page: Page, id = 'form-a') {
  await page.locator(`[data-entry-id="${id}"]`).getByRole('button', { name: 'Edit instance', exact: true }).click()
  const editor = page.locator('.plugin-editor')
  await editor.getByLabel('Operation', { exact: true }).selectOption('setConfig')
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toBeVisible()
  return editor
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
  page.once('dialog', async dialog => { shown = true; expect(dialog.type()).toBe('confirm'); await (accept ? dialog.accept() : dialog.dismiss()) })
  await action()
  await expect.poll(() => shown).toBe(true)
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText('Configuration saved; runtime application completed.', { exact: true })).toBeVisible()
}
async function diskConfig(id = 'form:a') {
  const raw = (await loadConfig(configPath)).config.plugins[id]!
  const { $package, $label, ...config } = raw
  return config
}

test('keeps one exact configuration across schema and JSON edits, Preview and Apply without inserting defaults', async ({ page }, testInfo) => {
  await plugins(page)
  const base = await application.context.hostConfig.read(), before = await readFile(configPath, 'utf8')
  const calls = recordMutations(page)
  const editor = await form(page)
  await expect(editor.getByRole('textbox', { name: 'optionalDefault', exact: true })).toHaveValue('')
  await editor.getByRole('textbox', { name: 'title', exact: true }).fill('Alpha changed')
  await editor.getByRole('textbox', { name: 'attempts', exact: true }).fill('3')
  await editor.getByRole('button', { name: 'Advanced JSON', exact: true }).click()
  const json = editor.getByLabel('Plugin configuration (JSON)', { exact: true })
  const expected = { ...original, title: 'Alpha changed', attempts: 3 }
  expect(JSON.parse(await json.inputValue())).toEqual(expected)
  await json.fill(JSON.stringify({ ...expected, connection: { ...original.connection, retry: 2 }, futureFromJson: ['preserve me'] }, null, 2))
  await editor.getByRole('button', { name: 'Form', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Alpha changed')
  await expect(editor.getByRole('textbox', { name: 'connection.retry', exact: true })).toHaveValue('2')
  await expect(editor.getByRole('textbox', { name: 'optionalDefault', exact: true })).toHaveValue('')
  const finalConfig = { ...expected, connection: { ...original.connection, retry: 2 }, futureFromJson: ['preserve me'] }
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview')).toBeVisible()
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(calls[0]?.input).toEqual({ fingerprint: base.fingerprint, operation: { kind: 'setConfig', id: 'form-a', config: finalConfig } })
  await save(page)
  expect(calls[1]?.input).toEqual({ ...calls[0]?.input, previewToken: expect.any(String) })
  expect(await diskConfig()).toEqual(finalConfig)
  expect(await diskConfig('form:b')).toEqual({ ...original, title: 'Beta title' })
  await testInfo.attach('exact-preview-apply-payloads', { body: JSON.stringify(calls, null, 2), contentType: 'application/json' })
  await form(page)
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Alpha changed')
  await expect(editor.getByRole('textbox', { name: 'optionalDefault', exact: true })).toHaveValue('')
  await page.screenshot({ path: testInfo.outputPath('plugin-schema-desktop.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Alpha changed')
  await editor.evaluate(element => element.scrollIntoView({ block: 'start' }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-schema-mobile-zh.png'), fullPage: false })
})

test('preserves cross-field server failures and allows correction without resetting other local input', async ({ page }) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8'), calls = recordMutations(page)
  const editor = await form(page)
  await editor.getByRole('textbox', { name: 'title', exact: true }).fill('Keep this unsaved title')
  await editor.getByRole('textbox', { name: 'lower', exact: true }).fill('9')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview').getByRole('alert')).toContainText('Plugin configuration does not match its schema.')
  await expect(page.getByRole('button', { name: 'Save and apply this change', exact: true })).toBeDisabled()
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Keep this unsaved title')
  await expect(editor.getByRole('textbox', { name: 'lower', exact: true })).toHaveValue('9')
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toHaveLength(0)
  await editor.getByRole('textbox', { name: 'upper', exact: true }).fill('10')
  await expect(page.locator('.plugin-preview')).not.toBeVisible()
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview').getByRole('alert')).toHaveCount(0)
  await save(page)
  expect(await diskConfig()).toEqual({ ...original, title: 'Keep this unsaved title', lower: 9, upper: 10 })
})

test('edits scalar, enum, nested and array fields while preserving unsupported and unknown sections', async ({ page }) => {
  await plugins(page)
  const editor = await form(page)
  await editor.getByRole('button', { name: 'active', exact: true }).click()
  await page.getByRole('option', { name: 'False', exact: true }).click()
  await editor.getByRole('button', { name: 'mode', exact: true }).click()
  await page.getByRole('option', { name: 'burst', exact: true }).click()
  await editor.getByRole('textbox', { name: 'connection.endpoint', exact: true }).fill('https://changed.example.test')
  await editor.getByRole('textbox', { name: 'tags.0', exact: true }).fill('first edited')
  await editor.getByRole('button', { name: 'Remove tags.1', exact: true }).click()
  await editor.getByRole('button', { name: 'Add item to tags', exact: true }).click()
  await editor.getByRole('textbox', { name: 'tags.1', exact: true }).fill('new second')
  await editor.getByRole('textbox', { name: 'advanced', exact: true }).fill('{"keep":["edited",2],"extra":{"nested":true}}')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await save(page)
  expect(await diskConfig()).toEqual({
    ...original, active: false, mode: 'burst',
    connection: { ...original.connection, endpoint: 'https://changed.example.test' },
    tags: ['first edited', 'new second'], advanced: { keep: ['edited', 2], extra: { nested: true } },
  })
})

test('protects invalid field and JSON buffers across mode changes, refresh, instance changes and navigation', async ({ page }) => {
  await plugins(page)
  const before = await readFile(configPath, 'utf8'), calls = recordMutations(page)
  const editor = await form(page), attempts = editor.getByRole('textbox', { name: 'attempts', exact: true })
  await attempts.fill('-')
  await editor.getByRole('button', { name: 'Advanced JSON', exact: true }).click()
  await expect(attempts).toBeVisible()
  await expect(attempts).toHaveValue('-')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  expect(calls).toHaveLength(0)
  const element = await attempts.elementHandle()
  await page.getByRole('button', { name: 'Refresh current state', exact: true }).click()
  await expect(attempts).toHaveValue('-')
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  await chooseDiscard(page, false, () => page.locator('[data-entry-id="form-b"]').getByRole('button', { name: 'Edit instance', exact: true }).click())
  await expect(attempts).toHaveValue('-')
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(attempts).toHaveValue('-')
  const reloading = page.waitForEvent('dialog')
  await page.evaluate(() => { setTimeout(() => location.reload(), 0) })
  const dialog = await reloading
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await expect(attempts).toHaveValue('-')
  await attempts.fill('3')
  await editor.getByRole('button', { name: 'Advanced JSON', exact: true }).click()
  const json = editor.getByLabel('Plugin configuration (JSON)', { exact: true })
  const invalid = '{"unfinished":'
  await json.fill(invalid)
  await editor.getByRole('button', { name: 'Form', exact: true }).click()
  await expect(json).toBeVisible()
  await expect(json).toHaveValue(invalid)
  await chooseDiscard(page, false, () => page.locator('[data-entry-id="form-b"]').getByRole('button', { name: 'Edit instance', exact: true }).click())
  await expect(json).toHaveValue(invalid)
  await chooseDiscard(page, true, () => editor.getByRole('button', { name: 'Cancel', exact: true }).click())
  await expect(editor).not.toBeVisible()
  expect(calls).toHaveLength(0)
  expect(await readFile(configPath, 'utf8')).toBe(before)
})

test('keeps the form fingerprint and local fields when another client changes configuration after Preview', async ({ page }) => {
  await plugins(page)
  const base = await application.context.hostConfig.read(), calls = recordMutations(page)
  const editor = await form(page)
  await editor.getByRole('textbox', { name: 'title', exact: true }).fill('First client local title')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview')).toBeVisible()
  const remote = { ...original, title: 'Second client title', remoteFuture: ['retain the other client'] }
  await applyFreshHostConfig(application.context.hostConfig, { fingerprint: base.fingerprint, operation: { kind: 'setConfig', id: 'form-a', config: remote } })
  await expect(page.getByText(/^Configuration changed elsewhere\. Your local input has been kept\./)).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('First client local title')
  expectNetworkError('Failed to load resource: the server responded with a status of 409 (Conflict)')
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText(/Configuration changed\. Refresh/)).toBeVisible()
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.input.fingerprint === base.fingerprint)).toBe(true)
  expect(await diskConfig()).toEqual(remote)
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('First client local title')
  await editor.getByText('Compare with latest configuration', { exact: true }).click()
  await chooseDiscard(page, false, () => editor.getByRole('button', { name: 'Reload latest configuration', exact: true }).click())
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('First client local title')
  await chooseDiscard(page, true, () => editor.getByRole('button', { name: 'Reload latest configuration', exact: true }).click())
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Second client title')
  await editor.getByRole('textbox', { name: 'title', exact: true }).fill('Reviewed merged title')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await save(page)
  expect(await diskConfig()).toEqual({ ...remote, title: 'Reviewed merged title' })
})

test('retains form buffers through a failed query refresh and reconciles a lost Apply response without replay', async ({ page }) => {
  await plugins(page)
  const editor = await form(page), title = editor.getByRole('textbox', { name: 'title', exact: true }), calls = recordMutations(page)
  await title.fill('Local value survives refresh')
  const element = await title.elementHandle()
  expectNetworkError('Failed to load resource: net::ERR_FAILED')
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure === 'numen:plugins@1') await route.abort('failed')
    else await route.continue()
  })
  await page.getByRole('button', { name: 'Refresh current state', exact: true }).click()
  await expect(page.getByText('Host configuration unavailable', { exact: true })).toBeVisible()
  await expect(title).toHaveValue('Local value survives refresh')
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  await page.unroute('**/api/console/call')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('Host configuration unavailable', { exact: true })).not.toBeVisible()
  await expect(title).toHaveValue('Local value survives refresh')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview')).toBeVisible()
  expectNetworkError('Failed to load resource: net::ERR_FAILED')
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== 'numen:plugin-apply@1') return route.continue()
    await route.fetch()
    await route.abort('failed')
  })
  await page.getByRole('button', { name: 'Save and apply this change', exact: true }).click()
  await expect(page.getByText(/The response did not confirm the outcome/)).toBeVisible()
  await expect(title).toHaveValue('Local value survives refresh')
  expect(calls.filter(call => call.procedure === 'numen:plugin-apply@1')).toHaveLength(1)
  expect(await diskConfig()).toEqual({ ...original, title: 'Local value survives refresh' })
  await page.unroute('**/api/console/call')
})

test('shows independent product instances and read-only internal details without exposing withheld configuration or executable metadata', async ({ page }, testInfo) => {
  const dtoResponse = page.waitForResponse(response => response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === 'numen:plugins@1')
  await plugins(page)
  const dto = (await (await dtoResponse).json()).result as HostConfigSnapshot
  const serialized = JSON.stringify(dto)
  for (const secret of ['DO_NOT_EXPOSE_SCHEMA_SECRET', 'WITHHOLD_ENTIRE_SECRET_CONFIG', 'WITHHOLD_UNKNOWN_SCHEMA_CONFIG', 'WITHHOLD_UNLOADED_CONFIG', 'RUNTIME_DEFAULT_MUST_NOT_BE_SENT', 'Internal cross-field validator details']) expect(serialized).not.toContain(secret)
  const alpha = dto.entries.find(entry => entry.id === 'form-a')!, beta = dto.entries.find(entry => entry.id === 'form-b')!
  expect(alpha.configEditable).toBe(true)
  expect(beta.configEditable).toBe(true)
  expect(alpha.internal).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'readonly-form-internal', ownerEntryId: 'form-a' })]))
  expect(beta.internal).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'readonly-form-internal', ownerEntryId: 'form-b' })]))
  expect(alpha.configSchema?.fields?.find(field => field.name === 'optionalDefault')).toMatchObject({ type: 'string', hasDefault: true })
  expect(alpha.configSchema?.fields?.find(field => field.name === 'advanced')).toMatchObject({ type: 'json' })
  const schema = JSON.stringify(alpha.configSchema)
  for (const executableKey of ['~standard', 'validate', 'dict', 'transform', 'RUNTIME_DEFAULT_MUST_NOT_BE_SENT']) expect(schema).not.toContain(executableKey)
  await expect(page.locator('[data-entry-id="form-a"]')).toContainText('Form Alpha')
  await expect(page.locator('[data-entry-id="form-b"]')).toContainText('Form Beta')
  await page.getByRole('button', { name: 'View details for Form Alpha', exact: true }).click()
  const detail = page.locator('.plugin-detail')
  await expect(detail).toContainText('form-a')
  await detail.locator('.plugin-internal summary').click()
  await expect(detail.getByText('readonly-form-internal', { exact: true })).toBeVisible()
  await expect(detail.locator('li').filter({ hasText: 'readonly-form-internal' }).getByRole('button')).toHaveCount(0)
  for (const id of ['secret', 'noSchema', 'unloaded', 'workbench']) {
    expect(dto.entries.find(entry => entry.id === id)).toMatchObject({ config: {}, configEditable: false })
    await page.locator(`[data-entry-id="${id}"]`).getByRole('button', { name: 'Edit instance', exact: true }).click()
    const editor = page.locator('.plugin-editor')
    await expect(editor.getByLabel('Operation', { exact: true }).locator('option[value="setConfig"]')).toHaveJSProperty('disabled', true)
    await expect(editor.getByLabel('Plugin configuration (JSON)', { exact: true })).toHaveCount(0)
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await expect(page.locator('[data-entry-id="workbench"]').getByRole('button', { name: 'Disable', exact: true })).toBeDisabled()
  await testInfo.attach('safe-field-metadata', { body: JSON.stringify({ alpha: alpha.configSchema, restricted: dto.entries.filter(entry => ['secret', 'noSchema', 'unloaded', 'workbench'].includes(entry.id)) }, null, 2), contentType: 'application/json' })
  await page.getByRole('button', { name: 'View details for Form Alpha', exact: true }).click()
  await detail.locator('.plugin-internal summary').click()
  await page.locator('.plugins-page').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('plugin-compact-list-desktop.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.plugins-page').evaluate(element => { element.scrollTop = 0 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-compact-list-mobile.png'), fullPage: false })
})

test('keeps a local field buffer across external disable and enable operations while retaining its original baseline', async ({ page }) => {
  await plugins(page)
  const editor = await form(page), title = editor.getByRole('textbox', { name: 'title', exact: true }), calls = recordMutations(page)
  await title.fill('Keep this during state changes')
  const base = await application.context.hostConfig.read()
  await applyFreshHostConfig(application.context.hostConfig, { fingerprint: base.fingerprint, operation: { kind: 'setEnabled', id: 'form-a', enabled: false } })
  await expect(page.locator('[data-entry-id="form-a"] .plugin-state')).toHaveAttribute('data-state', 'DISABLED')
  await expect(title).toHaveValue('Keep this during state changes')
  const disabled = await application.context.hostConfig.read()
  // DISABLED retains the already loaded public Schema; the never-loaded case above is readonly.
  expect(disabled.entries.find(entry => entry.id === 'form-a')).toMatchObject({ configEditable: true, actualState: 'DISABLED' })
  await applyFreshHostConfig(application.context.hostConfig, { fingerprint: disabled.fingerprint, operation: { kind: 'setEnabled', id: 'form-a', enabled: true } })
  await expect(title).toBeEnabled()
  await expect(title).toHaveValue('Keep this during state changes')
  await editor.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(page.locator('.plugin-preview').getByRole('alert')).toContainText('Configuration changed.')
  await expect(page.getByRole('button', { name: 'Save and apply this change', exact: true })).toBeDisabled()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.input.fingerprint).toBe(base.fingerprint)
  const latest = await diskConfig()
  expect(latest.title).toBe(original.title)
  await expect(editor.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Keep this during state changes')
})
