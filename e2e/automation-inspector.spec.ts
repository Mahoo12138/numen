import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import type { CapabilitySource } from '../packages/core/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let server: Server
let fixtureUrl: string
let browserErrors: string[]

test.beforeEach(async ({ page }) => {
  browserErrors = []
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`) })
})

test.afterEach(() => { expect(browserErrors).toEqual([]) })

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-inspector-e2e-'))
  server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}') })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local HTTP fixture did not bind')
  fixtureUrl = `http://127.0.0.1:${address.port}/fixture`
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})

test.afterAll(async () => {
  await application?.stop()
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function openFixture(page: Page, suffix: string) {
  const { automation } = application.context.automations.create({ name: `Inspector ${suffix}`, source: { triggers: [], flow: { type: 'block', id: 'flow', steps: [
    { type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: fixtureUrl }, headers: { type: 'literal', value: { Accept: 'application/json' } },
    } },
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 1000 } },
    { type: 'capability', id: 'echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'Saved message' } } },
  ] } } })
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(page).toHaveURL(new URL('/automations', application.workbenchUrl!).href)
  await page.locator('.automation-row').filter({ hasText: `Inspector ${suffix}` }).click()
  await expect(page.getByRole('heading', { name: `Inspector ${suffix}`, exact: true })).toBeVisible()
  return automation.id
}
const draft = (id: string) => application.context.automations.getDraft(id)!
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const pending = (page: Page, value: boolean) => expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', String(value))
const node = (page: Page, id: string) => page.locator(`.automation-step[data-node-id="${id}"]`)
function capability(id: string, nodeId: string): CapabilitySource {
  const flow = draft(id).source.flow
  if (flow.type !== 'block') throw new Error('Fixture flow is not a block')
  const result = flow.steps.find(item => item.id === nodeId)
  if (result?.type !== 'capability') throw new Error('Fixture node is not a capability')
  return result
}
async function chooseDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  const dialog = page.waitForEvent('dialog')
  const clicked = action()
  await (await dialog)[accept ? 'accept' : 'dismiss']()
  await clicked
}

test('keeps invalid JSON and numbers on cancellation and resets mounted fields on confirmed discard', async ({ page }, testInfo) => {
  const id = await openFixture(page, 'draft reset')
  const initial = structuredClone(draft(id).source)
  await node(page, 'request').click()
  const headers = page.getByLabel('Headers', { exact: true })
  const invalidJson = '{ "pending": '
  await headers.fill(invalidJson)
  await headers.press('Tab')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await pending(page, true)
  await chooseDiscard(page, false, () => node(page, 'echo').click())
  await expect(headers).toHaveValue(invalidJson)
  expect(draft(id).source).toEqual(initial)
  await chooseDiscard(page, true, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await pending(page, false)
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await node(page, 'request').click()
  await expect(headers).toHaveValue(JSON.stringify({ Accept: 'application/json' }, null, 2))
  await expect(headers).toHaveAttribute('aria-invalid', 'false')

  await node(page, 'wait').click()
  const duration = page.getByRole('textbox', { name: 'Wait duration in seconds', exact: true })
  await duration.fill('-')
  await duration.press('Tab')
  await expect(duration).toHaveValue('-')
  await expect(duration).toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: 'Wait wake source', exact: true }).click()
  await chooseDiscard(page, false, () => page.getByRole('option', { name: 'Until a date and time', exact: true }).click())
  await expect(duration).toHaveValue('-')
  expect(draft(id).source).toEqual(initial)
  await chooseDiscard(page, false, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await expect(duration).toHaveValue('-')
  await pending(page, true)
  await chooseDiscard(page, true, () => page.getByRole('tab', { name: 'Revisions', exact: true }).click())
  await pending(page, false)
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await node(page, 'wait').click()
  await expect(duration).toHaveValue('1')
  await expect(duration).toHaveAttribute('aria-invalid', 'false')
  expect(draft(id).source).toEqual(initial)
  await page.screenshot({ path: testInfo.outputPath('inspector-restored-draft.png'), fullPage: true })
})

test('publishes a just-entered timeout with one click and restricts retry controls to safe capabilities', async ({ page }) => {
  const id = await openFixture(page, 'runtime policy')
  await node(page, 'request').click()
  await expect(page.getByText('This capability is not declared safe for automatic retry. Retry editing is unavailable.', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Maximum attempts', { exact: true })).toHaveCount(0)
  await page.locator('.execution-policy-fields').getByLabel('Timeout (ms)', { exact: true }).fill('1200')
  await pending(page, true)
  // No preliminary Tab or save: Publish must first commit the focused valid field.
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect.poll(() => application.context.automations.listRevisions(id).length).toBe(1)
  await pending(page, false)
  expect(capability(id, 'request').policy).toEqual({ timeoutMs: 1200 })
  const revision = application.context.automations.listRevisions(id)[0]!
  expect(revision.source).toEqual(draft(id).source)

  await node(page, 'echo').click()
  await page.getByLabel('Maximum attempts', { exact: true }).fill('3')
  await page.getByLabel('Maximum attempts', { exact: true }).press('Tab')
  await expect(page.getByLabel('Retry base delay (ms)', { exact: true })).toBeVisible()
  await page.getByLabel('Retry base delay (ms)', { exact: true }).fill('250')
  await page.getByLabel('Retry base delay (ms)', { exact: true }).press('Tab')
  await saved(page)
  expect(capability(id, 'echo').policy).toEqual({ retry: { maxAttempts: 3, backoffMs: 250 } })
  expect(capability(id, 'request').policy).toEqual({ timeoutMs: 1200 })
  await page.getByLabel('Retry base delay (ms)', { exact: true }).fill('-')
  await page.getByLabel('Retry base delay (ms)', { exact: true }).press('Tab')
  await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Remove retry policy', exact: true }).click())
  await expect(page.getByLabel('Retry base delay (ms)', { exact: true })).toHaveValue('-')
  expect(capability(id, 'echo').policy).toEqual({ retry: { maxAttempts: 3, backoffMs: 250 } })
  await chooseDiscard(page, true, () => page.getByRole('button', { name: 'Remove retry policy', exact: true }).click())
  await pending(page, false)
  await saved(page)
  await expect(page.getByLabel('Retry base delay (ms)', { exact: true })).toHaveCount(0)
  expect(capability(id, 'echo').policy).toBeUndefined()
})
