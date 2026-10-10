import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AutomationSource, CapabilitySource, ValueExpr } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Browser plugin not available. Use the repository's real Playwright/runtime fixture.
// Flow: Automation editor -> nested member edits -> save/reload -> Draft test -> actual HTTP request.
let application: NumenApplication
let directory: string
let server: Server
let fixtureUrl: string
let requests: Array<{ method: string | undefined; contentType: string | undefined; body: unknown }>
let browserErrors: string[]

test.beforeEach(({ page }) => {
  requests = []
  browserErrors = []
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`) })
})
test.afterEach(async ({}, testInfo) => {
  await writeFile(join('/tmp', `numen-collection-${testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}-console.json`), JSON.stringify(browserErrors, null, 2))
  expect(browserErrors).toEqual([])
})
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-collection-e2e-'))
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: request.method, contentType: request.headers['content-type'], body: body ? JSON.parse(body) : null })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local HTTP fixture did not bind')
  fixtureUrl = `http://127.0.0.1:${address.port}/fixture`
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: true }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => {
  await application?.stop()
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  if (directory) await rm(directory, { recursive: true, force: true })
})

const draft = (id: string) => application.context.automations.getDraft(id)!
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const pending = (page: Page, value: boolean) => expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', String(value))
const mode = (page: Page, label: string) => page.getByRole('button', { name: `${label} value mode`, exact: true })
const field = (page: Page, label: string) => page.locator('.schema-field').filter({ has: mode(page, label) }).last()
const collection = (page: Page, label: string) => field(page, label).locator(':scope > .schema-field-row > .schema-value-editor > .schema-value-control > .collection-expression-editor')
const literal = (value: Extract<ValueExpr, { type: 'literal' }>['value']): ValueExpr => ({ type: 'literal', value })
const bodyWith = (value: ValueExpr): ValueExpr => ({ type: 'object', entries: { type: literal('json'), value } })

function requestNode(id: string): CapabilitySource {
  const flow = draft(id).source.flow
  if (flow.type !== 'block') throw new Error('Fixture flow is not a block')
  const node = flow.steps.find(item => item.id === 'request')
  if (node?.type !== 'capability') throw new Error('Fixture request is not a capability')
  return node
}
async function chooseMode(page: Page, label: string, value: string) {
  await mode(page, label).click()
  await page.getByRole('option', { name: value, exact: true }).click()
  await expect(mode(page, label)).toContainText(value)
}
async function fill(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Tab')
}
async function chooseDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  const dialog = page.waitForEvent('dialog')
  const clicked = action()
  await (await dialog)[accept ? 'accept' : 'dismiss']()
  await clicked
}
async function openFixture(page: Page, suffix: string, body: ValueExpr) {
  const source: AutomationSource = { inputs: {
    name: { type: 'string', title: 'Customer name', default: 'Mira' },
    amount: { type: 'number', title: 'Amount', default: 7 },
  }, triggers: [], flow: { type: 'block', id: 'flow', steps: [
    { type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      method: literal('POST'), url: literal(fixtureUrl), body,
    } },
  ] } }
  const { automation } = application.context.automations.create({ name: `Collection ${suffix}`, source })
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: `Collection ${suffix}` }).click()
  await expect(page.getByRole('heading', { name: `Collection ${suffix}`, exact: true })).toBeVisible()
  await page.locator('.automation-step[data-node-id="request"]').click()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await saved(page)
  return automation.id
}
async function expectWithinViewport(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded()
  await expect(control).toBeInViewport()
  const bounds = (await control.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('builds a mixed JSON request from object and array members, persists it and executes the saved Draft', async ({ page }) => {
  test.setTimeout(90_000)
  // HTTP's real contract is body: { type: 'json', value }, not a bodyJson field.
  const id = await openFixture(page, 'mixed request', literal({ type: 'json', value: {
    constant: 'kept', who: '', greeting: '', score: 0, items: [false, 'second'],
  } }))
  await mode(page, 'URL').click()
  await expect(page.getByRole('option', { name: 'Object', exact: true })).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'Array', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await chooseMode(page, 'Body', 'Object')
  await expect(page.getByLabel('type', { exact: true })).toHaveValue('"json"')
  await chooseMode(page, 'value', 'Object')
  await expect(page.getByLabel('constant', { exact: true })).toHaveValue('"kept"')
  await chooseMode(page, 'who', 'Reference')
  await fill(page, 'who', 'input.name')
  await chooseMode(page, 'greeting', 'Template')
  await fill(page, 'greeting', 'Hello {{ input.name }}')
  await chooseMode(page, 'score', 'Expression')
  await page.getByRole('button', { name: 'score expression function', exact: true }).click()
  await page.getByRole('option', { name: 'Add numbers', exact: true }).click()
  await chooseMode(page, 'Number 1', 'Reference')
  await fill(page, 'Number 1', 'input.amount')
  await fill(page, 'Number 2', '2')
  await chooseMode(page, 'items', 'Array')
  await expect(page.getByLabel('Item 1', { exact: true })).toHaveValue('false')
  await expect(page.getByLabel('Item 2', { exact: true })).toHaveValue('"second"')
  await chooseMode(page, 'Item 1', 'Reference')
  await fill(page, 'Item 1', 'input.amount')
  await collection(page, 'items').getByRole('button', { name: 'Add item', exact: true }).click()
  await chooseMode(page, 'Item 3', 'Template')
  await fill(page, 'Item 3', 'n={{ input.amount }}')
  await collection(page, 'value').getByRole('button', { name: 'Add field', exact: true }).click()
  await fill(page, 'value field name 6', '')
  await fill(page, 'Empty key', 'true')
  await saved(page)
  const expectedBody = bodyWith({ type: 'object', entries: {
    constant: literal('kept'), who: { type: 'ref', path: 'input.name' },
    greeting: { type: 'template', parts: ['Hello ', { ref: 'input.name' }] },
    score: { type: 'call', function: 'core:add', arguments: [{ type: 'ref', path: 'input.amount' }, literal(2)] },
    items: { type: 'array', items: [{ type: 'ref', path: 'input.amount' }, literal('second'), { type: 'template', parts: ['n=', { ref: 'input.amount' }] }] },
    '': literal(true),
  } })
  expect(requestNode(id).input.body).toEqual(expectedBody)
  await page.reload()
  await page.locator('.automation-step[data-node-id="request"]').click()
  await expect(page.getByLabel('who', { exact: true })).toHaveValue('input.name')
  await expect(page.getByLabel('Empty key', { exact: true })).toHaveValue('true')
  expect(requestNode(id).input.body).toEqual(expectedBody)
  await expectWithinViewport(page, mode(page, 'Body'))
  await expectWithinViewport(page, page.getByLabel('Number 1', { exact: true }))
  await page.screenshot({ path: '/tmp/numen-collection-desktop-1440.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectWithinViewport(page, page.getByLabel('Item 3', { exact: true }))
  await expectWithinViewport(page, collection(page, 'items').getByRole('button', { name: 'Add item', exact: true }))
  await page.screenshot({ path: '/tmp/numen-collection-mobile-390.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  await page.getByRole('button', { name: 'Save current Draft and test', exact: true }).click()
  const form = page.locator('.automation-draft-test .automation-manual-run')
  await expect(form.getByLabel('Customer name', { exact: true })).toHaveValue('Mira')
  await form.getByLabel('Customer name', { exact: true }).fill('Ada')
  await form.getByLabel('Amount', { exact: true }).fill('12')
  const acceptedVersion = draft(id).version
  await form.getByRole('button', { name: 'Test saved Draft', exact: true }).click()
  await expect(page.locator('.draft-test-result')).toContainText(`Accepted test · Draft v${acceptedVersion}`)
  await expect.poll(() => application.context.scheduler.listRuns().filter(run => run.automationId === id).length).toBe(1)
  const run = application.context.scheduler.listRuns().find(run => run.automationId === id)!
  await expect.poll(() => application.context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
  expect(requests).toEqual([{ method: 'POST', contentType: 'application/json; charset=utf-8', body: {
    constant: 'kept', who: 'Ada', greeting: 'Hello Ada', score: 14, items: [12, 'second', 'n=12'], '': true,
  } }])
  expect(application.context.automations.getExecutionSnapshot(run.revisionId)).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: acceptedVersion })
  expect(application.context.automations.listRevisions(id)).toEqual([])
})

test('rejects duplicate object keys without overwriting and protects pending names during removal and Undo', async ({ page }) => {
  const initial = bodyWith({ type: 'object', entries: { alpha: literal(1), beta: literal(2) } })
  const id = await openFixture(page, 'duplicate keys', initial)
  const name = page.getByLabel('value field name 2', { exact: true })
  await name.fill('alpha')
  await name.press('Tab')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('This field name already exists. Choose a different name.', { exact: true })).toBeVisible()
  await pending(page, true)
  expect(requestNode(id).input.body).toEqual(initial)
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Remove field alpha', exact: true }).click())
  await expect(name).toHaveValue('alpha')
  expect(requestNode(id).input.body).toEqual(initial)
  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Remove field alpha', exact: true }).click())
  await pending(page, false)
  await saved(page)
  const removed = bodyWith({ type: 'object', entries: { beta: literal(2) } })
  expect(requestNode(id).input.body).toEqual(removed)
  await expect(page.getByLabel('value field name 1', { exact: true })).toHaveValue('beta')
  await expect(page.getByLabel('beta', { exact: true })).toHaveValue('2')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(requestNode(id).input.body).toEqual(initial)
  await expect(page.getByLabel('value field name 2', { exact: true })).toHaveValue('beta')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await saved(page)
  expect(requestNode(id).input.body).toEqual(removed)
  await page.reload()
  await page.locator('.automation-step[data-node-id="request"]').click()
  await expect(page.getByLabel('value field name 1', { exact: true })).toHaveValue('beta')
})

test('protects invalid array member buffers when moving and removing and restores complete members with Undo and Redo', async ({ page }) => {
  const initial = bodyWith({ type: 'array', items: [literal(10), literal(20), literal(30)] })
  const id = await openFixture(page, 'array protection', initial)
  await expect(page.getByRole('button', { name: 'Move item 1 up', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Move item 3 down', exact: true })).toBeDisabled()
  const second = page.getByLabel('Item 2', { exact: true })
  await second.fill('{"unfinished":')
  await second.press('Tab')
  await expect(second).toHaveAttribute('aria-invalid', 'true')
  await pending(page, true)
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Move item 2 up', exact: true }).click())
  await expect(second).toHaveValue('{"unfinished":')
  expect(requestNode(id).input.body).toEqual(initial)
  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Move item 2 up', exact: true }).click())
  await pending(page, false)
  await saved(page)
  const moved = bodyWith({ type: 'array', items: [literal(20), literal(10), literal(30)] })
  expect(requestNode(id).input.body).toEqual(moved)
  await expect(page.getByLabel('Item 1', { exact: true })).toHaveValue('20')
  await expect(second).toHaveValue('10')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(requestNode(id).input.body).toEqual(initial)
  await expect(second).toHaveValue('20')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await saved(page)
  expect(requestNode(id).input.body).toEqual(moved)
  const first = page.getByLabel('Item 1', { exact: true })
  await first.fill('unquoted text')
  await first.press('Tab')
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Remove item 1', exact: true }).click())
  await expect(first).toHaveValue('unquoted text')
  expect(requestNode(id).input.body).toEqual(moved)
  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Remove item 1', exact: true }).click())
  await pending(page, false)
  await saved(page)
  expect(requestNode(id).input.body).toEqual(bodyWith({ type: 'array', items: [literal(10), literal(30)] }))
  await expect(first).toHaveValue('10')
  await expect(second).toHaveValue('30')
  await expect(page.getByLabel('Item 3', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(requestNode(id).input.body).toEqual(moved)
})
