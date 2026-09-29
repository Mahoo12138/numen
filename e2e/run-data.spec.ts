import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const secret = 'RUN_DATA_PRIVATE_CANARY_7619'
const html = '<img id="run-data-html" src=x onerror="window.__inspectionExecuted=true">'
let application: NumenApplication
let directory: string
let http: Server
const runs: string[] = []

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-run-data-e2e-'))
  http = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `fixture=${secret}` })
    response.end(JSON.stringify({ token: secret, nested: { html }, publicLooking: secret }))
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address')
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {},
    console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  const context = application.context
  const visible = () => z.string().extra('extra', { numen: { execution: 'public' } })
  const capability = { id: 'fixture:inspection', version: 1, kind: 'query' as const, title: 'Classified text',
    input: z.object({}), output: z.object({ text: visible(), password: visible(), payload: z.any() }),
    semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  context.capabilities.define(context, capability)
  context.capabilities.provide(context, capability, { async invoke() { return { text: html, password: secret, payload: { innocent: secret } } } })
  const created = context.automations.create({ name: 'Controlled data acceptance', source: { triggers: [], flow: { type: 'block', id: 'root', steps: [
    { type: 'capability', id: 'http-fetch', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: `http://127.0.0.1:${address.port}/items?token=${secret}` },
      headers: { type: 'literal', value: { authorization: `Bearer ${secret}`, cookie: `fixture=${secret}` } },
    } },
    { type: 'capability', id: 'classified-text', capability: { id: capability.id, version: 1 }, input: {} },
  ] } } })
  const revision = context.automations.publishDraft(created.automation.id, 1)
  context.automations.activateRevision(created.automation.id, revision.id)
  for (let i = 0; i < 2; i++) {
    runs.push(context.scheduler.startManual(created.automation.id).id)
    await context.scheduler.dispatchUntilIdle()
  }
})

test.afterAll(async () => {
  await application?.stop()
  if (http) { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function openRun(page: Page, id: string) {
  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await page.getByRole('button', { name: `Open Run ${id}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Controlled data acceptance', exact: true })).toBeVisible()
}

test('inspects classified data on demand, links source nodes, and clears pending data on navigation', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const inspected: Array<{ body: string; cache: string | undefined }> = []
  const requests: unknown[] = []
  const errors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('request', request => {
    if (request.url().endsWith('/api/console/call') && request.postDataJSON()?.procedure === 'numen:execution-data@1') requests.push(request.postDataJSON())
  })
  page.on('response', async response => {
    if (response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === 'numen:execution-data@1') {
      inspected.push({ body: await response.text(), cache: response.headers()['cache-control'] })
    }
  })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await openRun(page, runs[0]!)
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Executions for http-fetch', exact: true }).click()
  await expect(page.locator('.execution-record')).toHaveCount(1)
  const inspect = page.getByRole('button', { name: 'Inspect input / output', exact: true })
  await inspect.click()
  const panel = page.getByRole('region', { name: 'Execution data', exact: true })
  await expect(panel).toBeFocused()
  await expect(panel.locator('pre').last()).toContainText('"status": 200')
  await expect.poll(() => inspected.length).toBe(1)
  expect(inspected[0]!.cache).toBe('no-store')
  expect(inspected[0]!.body).not.toContain(secret)
  expect(inspected[0]!.body).not.toContain(html)
  await panel.getByRole('button', { name: 'Close data', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(inspect).toBeFocused()
  await page.getByRole('button', { name: 'Locate source node', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Executions for http-fetch', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Executions for classified-text', exact: true }).click()
  await expect(page.locator('.execution-record')).toHaveCount(1)
  await page.getByRole('button', { name: 'Inspect input / output', exact: true }).click()
  await expect(panel.locator('pre').last()).toContainText(JSON.stringify(html))
  await expect(panel.locator('img, script, iframe')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __inspectionExecuted?: boolean }).__inspectionExecuted)).toBeUndefined()
  await expect.poll(() => inspected.length).toBe(2)
  expect(inspected.every(item => !item.body.includes(secret))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('run-data-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('run-data-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  const chinesePanel = page.getByRole('region', { name: '执行数据', exact: true })
  await expect(chinesePanel.getByRole('button', { name: '关闭数据', exact: true })).toBeVisible()
  await expect(chinesePanel.getByRole('button', { name: '定位源节点', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('run-data-mobile-zh.png'), fullPage: true })
  await page.getByRole('button', { name: '语言', exact: true }).click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await panel.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 960 })

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured = false
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure !== 'numen:execution-data@1') { await route.continue(); return }
    const response = await route.fetch()
    captured = true
    await gate
    await route.fulfill({ response }).catch(() => {}) // Closing the panel intentionally aborts this browser request.
  })
  try {
    await page.getByRole('button', { name: 'Inspect input / output', exact: true }).click()
    await expect.poll(() => captured).toBe(true)
    await page.getByRole('button', { name: 'Back to Runs', exact: true }).click()
    await page.getByRole('button', { name: `Open Run ${runs[1]!}`, exact: true }).click()
    release()
    await expect(page.getByRole('button', { name: 'Executions for http-fetch', exact: true })).toBeVisible()
    await expect(panel).toHaveCount(0)
  } finally { release(); await page.unroute('**/api/console/call') }
  expect(page.url()).not.toContain(secret)
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret)
  expect(await page.locator('body').innerText()).not.toContain(secret)
  expect(errors).toEqual([])
  expect(consoleErrors).toEqual([])
})
