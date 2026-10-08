import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let automationId: string
let newestRunId: string
const automationName = '华东订单跨部门协同处理：库存核对、账务通知及异常恢复的完整业务流程'

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-page-layout-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: {}, automations: {},
    scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  const created = application.context.automations.create({ name: automationName,
    source: { triggers: [], flow: { type: 'block', id: 'root', steps: [] } } })
  automationId = created.automation.id
  const revision = application.context.automations.publishDraft(automationId, 1)
  application.context.automations.activateRevision(automationId, revision.id)
  for (let index = 0; index < 25; index++) {
    application.context.scheduler.startManual(automationId)
    await application.context.scheduler.dispatchUntilIdle()
  }
  newestRunId = application.context.scheduler.listRuns(1)[0]!.id
})

test.afterAll(async () => {
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(page: Page, path: string) {
  if (page.url() === 'about:blank') {
    await page.goto(application.workbenchUrl!)
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  }
  await page.goto(new URL(path, application.workbenchUrl!).href)
}

async function assertFullWidth(page: Page, width: number) {
  await expect(page.locator('.workbench-shell')).toHaveAttribute('data-has-sidebar', 'false')
  await expect(page.locator('.primary-sidebar, .sidebar-resize-handle')).toHaveCount(0)
  await expect(page.locator('.bottom-panel, .status-bar')).toHaveCount(0)
  const main = await page.locator('main.main-workbench').boundingBox()
  expect(main).not.toBeNull()
  const rail = width < 900 ? 0 : width < 1280 ? 68 : 76
  expect(main!.x).toBeCloseTo(rail, 0)
  expect(main!.width).toBeCloseTo(width - rail, 0)
  expect(main!.x + main!.width).toBeLessThanOrEqual(width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('reclaims unused sidebar space across routes and breakpoint boundaries', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const routes = [
    ['/', 'Home'], ['/plugins/installed', 'Plugins'], ['/connections', 'Connections'],
    ['/connections/credentials', 'Credentials'], ['/runs', 'Runs'], ['/system/overview', 'System'],
  ] as const
  for (const width of [390, 900, 1280, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    for (const [path, heading] of routes) {
      await open(page, path)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await assertFullWidth(page, width)
    }
    await open(page, `/runs/${newestRunId}/flow`)
    await expect(page.getByRole('heading', { name: automationName, exact: true })).toBeVisible()
    await assertFullWidth(page, width)
    const heading = await page.getByRole('heading', { name: automationName, exact: true }).boundingBox()
    expect(heading!.x + heading!.width).toBeLessThanOrEqual(width + 1)
  }
  // Existing useful automation chrome must survive navigation through sidebar-free pages.
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(page.locator('.workbench-shell')).toHaveAttribute('data-has-sidebar', 'true')
  await expect(page.locator('.primary-sidebar')).toBeVisible()
  await expect(page.locator('.sidebar-resize-handle')).toBeVisible()
  await expect(page.locator('.bottom-panel')).toBeVisible()
  await expect(page.locator('.status-bar')).toBeVisible()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-entry-id="demo"]').getByRole('button', { name: 'View details for demo', exact: true }).click()
  await expect(page.locator('.plugin-detail')).toBeVisible()
  await assertFullWidth(page, 1440)
  const list = await page.locator('.plugin-list').boundingBox()
  const detail = await page.locator('.plugin-detail').boundingBox()
  expect(list!.x + list!.width).toBeLessThan(detail!.x)
  expect(list!.width).toBeLessThan(detail!.width)
  expect(errors).toEqual([])
})

test('keeps real run filters operable through pagination, logs, reload and mobile reflow', async ({ page }) => {
  test.setTimeout(90_000)
  await open(page, `/runs?automationId=${automationId}`)
  const status = page.getByLabel('Status', { exact: true })
  await assertFullWidth(page, 1440)
  await expect(status).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible()
  await expect(page.locator('.runs-filters')).toBeVisible()
  await status.selectOption('COMPLETED')
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(20)
  const toolbar = await page.locator('.runs-filters').boundingBox()
  const table = await page.locator('.runs-table-wrap').boundingBox()
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(table!.y)
  await expect(page.locator('.runs-automation-filter')).toContainText(automationId)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(5)
  const pageTwoUrl = page.url()
  expect(new URL(pageTwoUrl).searchParams.get('status')).toBe('COMPLETED')
  expect(new URL(pageTwoUrl).searchParams.get('automationId')).toBe(automationId)
  expect(new URL(pageTwoUrl).searchParams.get('cursor')).toBeTruthy()
  await page.getByRole('button', { name: /^Open Run / }).first().click()
  const detailUrl = page.url()
  await assertFullWidth(page, 1440)
  await page.getByRole('button', { name: 'View runtime logs', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Runtime logs', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.logs-view')).toHaveCount(1)
  await expect(page.locator('.system-check')).toHaveCount(0)
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
  const logQuery = new URL(page.url()).searchParams
  await page.getByRole('tab', { name: 'System health', exact: true }).click()
  await expect(page.locator('.system-check')).toHaveCount(5)
  expect(new URL(page.url()).searchParams.get('view')).toBe('health')
  expect(new URL(page.url()).searchParams.get('runId')).toBe(logQuery.get('runId'))
  expect(new URL(page.url()).searchParams.get('from')).toBe(logQuery.get('from'))
  await page.getByRole('tab', { name: 'Runtime logs', exact: true }).click()
  expect(new URL(page.url()).searchParams.get('view')).toBe('logs')
  expect(new URL(page.url()).searchParams.get('runId')).toBe(logQuery.get('runId'))
  expect(new URL(page.url()).searchParams.get('from')).toBe(logQuery.get('from'))
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Runtime logs', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Back to Run', exact: true }).click()
  await expect(page).toHaveURL(detailUrl)
  await page.getByRole('button', { name: 'Back to Runs', exact: true }).click()
  await expect(page).toHaveURL(pageTwoUrl)
  await page.reload()
  await expect(status).toHaveValue('COMPLETED')
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(5)
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(20)
  await page.goBack()
  await expect(page).toHaveURL(pageTwoUrl)
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(5)
  await status.selectOption('FAILED')
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false)
  expect(new URL(page.url()).searchParams.has('history')).toBe(false)
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(status).toHaveValue('')
  await expect(page.locator('.runs-automation-filter')).toHaveCount(0)
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(20)
  for (const width of [900, 1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(status).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible()
    await assertFullWidth(page, width)
    await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible()
    const controls = await status.boundingBox()
    expect(controls!.x).toBeGreaterThanOrEqual(0)
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(width + 1)
  }
  await status.selectOption('COMPLETED')
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(20)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.locator('.runs-table tbody tr')).toHaveCount(5)
  await page.reload()
  await expect(status).toBeVisible()
  await expect(status).toHaveValue('COMPLETED')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('switches system views with URL state and accessible keyboard tabs on desktop and mobile', async ({ page }) => {
  test.setTimeout(90_000)
  await open(page, '/system/overview')
  await expect(page.locator('.system-check')).toHaveCount(5)
  await expect(page.locator('.logs-view')).toHaveCount(0)
  const health = page.getByRole('tab', { name: 'System health', exact: true })
  const logs = page.getByRole('tab', { name: 'Runtime logs', exact: true })
  await expect(health).toHaveAttribute('aria-selected', 'true')
  for (const width of [1440, 1280, 900, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await assertFullWidth(page, width)
    await expect(health).toBeVisible()
    await expect(logs).toBeVisible()
    await health.focus()
    await page.keyboard.press('ArrowRight')
    await expect(logs).toBeFocused()
    await expect(logs).toHaveAttribute('aria-selected', 'true')
    await expect(logs).toHaveAttribute('tabindex', '0')
    await expect(health).toHaveAttribute('tabindex', '-1')
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expect(page.locator('#system-logs')).toHaveAttribute('aria-labelledby', 'system-logs-tab')
    await expect(page.locator('.logs-view')).toHaveCount(1)
    await expect(page.locator('.system-check')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('view')).toBe('logs')
    await page.reload()
    await expect(logs).toHaveAttribute('aria-selected', 'true')
    await logs.focus()
    await page.keyboard.press('Home')
    await expect(health).toBeFocused()
    await expect(health).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#system-health')).toHaveAttribute('aria-labelledby', 'system-health-tab')
    await expect(page.locator('.system-check')).toHaveCount(5)
    await expect(page.locator('.logs-view')).toBeHidden()
    await page.keyboard.press('End')
    await expect(logs).toBeFocused()
    await expect(logs).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(health).toBeFocused()
    await expect(health).toHaveAttribute('aria-selected', 'true')
    expect(new URL(page.url()).searchParams.get('view')).toBe('health')
  }
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
  await page.locator('#system-check-scheduler').getByRole('button', { name: 'Inspect failed Runs', exact: true }).click()
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('FAILED')
  await expect(page.getByLabel('Status', { exact: true })).toBeVisible()
})

test('keeps system tabs usable when health observations fail and recovers on refresh', async ({ page }) => {
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure === 'numen:system@1') return route.abort('failed')
    await route.continue()
  })
  await open(page, '/system/overview')
  await expect(page.locator('#system-health [role="alert"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Runtime logs', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Runtime logs', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#system-health')).toHaveCount(0)
  await expect(page.locator('.logs-view')).toHaveCount(1)
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
  await page.unroute('**/api/console/call')
  await page.getByRole('tab', { name: 'System health', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh current state', exact: true }).click()
  await expect(page.locator('.system-check')).toHaveCount(5)
  await expect(page.locator('#system-health [role="alert"]')).toHaveCount(0)
})

test('retains log filters, pause state and older-page position while suspending a hidden feed', async ({ page }) => {
  test.setTimeout(90_000)
  const namespace = 'layout:tab-retention'
  const logger = application.context.logger(namespace)
  for (let index = 0; index < 140; index++) logger.info('retention-record-%s', String(index).padStart(3, '0'))
  const logQueries: Array<{ namespace?: string; search?: string; maxLevel?: number; before?: unknown }> = []
  const subscriptions = new Set<string>()
  const unsubscribed = new Set<string>()
  let latestSubscription: string | undefined
  page.on('request', request => {
    if (!request.url().endsWith('/api/console/call')) return
    const body = request.postDataJSON()
    if (body?.procedure === 'numen:logs@1') logQueries.push(body.input)
  })
  await page.routeWebSocket('**/api/console/subscribe', route => {
    const server = route.connectToServer()
    route.onMessage(message => {
      const body = JSON.parse(String(message)) as { type: string; id: string; procedure?: string }
      if (body.type === 'subscribe' && body.procedure === 'numen:logs-changed@1') {
        subscriptions.add(body.id)
        latestSubscription = body.id
      }
      if (body.type === 'unsubscribe' && subscriptions.has(body.id)) unsubscribed.add(body.id)
      server.send(message)
    })
  })
  await open(page, '/system/overview?view=logs')
  const view = page.locator('.logs-view')
  await view.getByLabel('Namespace', { exact: true }).fill(namespace)
  await view.getByLabel('Namespace', { exact: true }).press('Tab')
  await view.getByLabel('Search messages', { exact: true }).fill('retention-record-')
  await view.getByLabel('Search messages', { exact: true }).press('Tab')
  await view.getByRole('button', { name: 'Level', exact: true }).click()
  await page.getByRole('option', { name: 'Including debug', exact: true }).click()
  await expect(view.locator('.log-record')).toHaveCount(100)
  await expect(view).toContainText('retention-record-139')
  await expect(view.getByText('Loading…', { exact: true })).toHaveCount(0)
  await expect.poll(() => latestSubscription).toBeTruthy()
  const activeSubscription = latestSubscription!
  await page.getByRole('tab', { name: 'System health', exact: true }).click()
  await expect(view).toBeHidden()
  await expect.poll(() => unsubscribed.has(activeSubscription)).toBe(true)
  const hiddenQueries = logQueries.length
  const hiddenSubscriptions = subscriptions.size
  logger.info('hidden-only-signal')
  const refresh = page.waitForResponse(response => response.url().endsWith('/api/console/call')
    && response.request().postDataJSON()?.procedure === 'numen:system@1')
  await page.getByRole('button', { name: 'Refresh current state', exact: true }).click()
  await refresh
  await expect(page.locator('.system-check')).toHaveCount(5)
  expect(logQueries).toHaveLength(hiddenQueries)
  expect(subscriptions.size).toBe(hiddenSubscriptions)
  await page.getByRole('tab', { name: 'Runtime logs', exact: true }).click()
  await expect(view.getByLabel('Namespace', { exact: true })).toHaveValue(namespace)
  await expect(view.getByLabel('Search messages', { exact: true })).toHaveValue('retention-record-')
  await expect(view.getByRole('button', { name: 'Level', exact: true })).toContainText('Including debug')
  await view.getByRole('button', { name: 'Pause updates', exact: true }).click()
  await expect(view.getByText('Loading…', { exact: true })).toHaveCount(0)
  await view.getByRole('button', { name: 'Older logs', exact: true }).click()
  await expect(view.locator('.log-record')).toHaveCount(40)
  await expect(view).toContainText('retention-record-039')
  await expect(view).not.toContainText('retention-record-139')
  const olderQuery = logQueries.at(-1)!
  expect(olderQuery.before).toBeTruthy()
  await page.getByRole('tab', { name: 'System health', exact: true }).click()
  await expect(view).toBeHidden()
  await page.getByRole('tab', { name: 'Runtime logs', exact: true }).click()
  await expect(view.getByLabel('Namespace', { exact: true })).toHaveValue(namespace)
  await expect(view.getByLabel('Search messages', { exact: true })).toHaveValue('retention-record-')
  await expect(view.getByRole('button', { name: 'Level', exact: true })).toContainText('Including debug')
  await expect(view.getByRole('button', { name: 'Follow updates', exact: true })).toBeVisible()
  await expect(view.locator('.log-record')).toHaveCount(40)
  await expect(view).toContainText('retention-record-039')
  expect(logQueries.at(-1)).toEqual(olderQuery)
  await view.getByRole('button', { name: 'Level', exact: true }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'System health', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(view).toBeHidden()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.goForward()
  await expect(view.getByRole('button', { name: 'Level', exact: true })).toContainText('Including debug')
  await expect(view.getByRole('button', { name: 'Follow updates', exact: true })).toBeVisible()
  await expect(view.locator('.log-record')).toHaveCount(40)
})
