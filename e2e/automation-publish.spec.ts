import { expect, test } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate an E2E port.')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-browser-e2e-'))
  const port = await availablePort()
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, {
    version: 1,
    dataDir: 'data',
    logger: { console: false, capacity: 250, levels: { base: 2, e2e: 3 } },
    plugins: {
      database: { path: 'data/numen.db' },
      capabilities: {},
      controls: {},
      coreControls: {},
      credentials: {},
      resources: { path: 'data/resources' },
      connections: {},
      demo: {},
      schedule: {},
      automations: {},
      scheduler: { autoDispatch: false },
      triggers: {},
      console: {},
      consoleEntries: {},
      consoleAuth: {},
      server: { host: '127.0.0.1', port },
      workbench: {},
      workbenchAutomationAuthoring: {},
      workbenchAutomationActivation: {},
      workbenchAutomationCatalog: {},
      workbenchAutomations: {},
      workbenchConnections: {},
      workbenchCredentials: {},
      workbenchHome: {},
      workbenchLogs: {},
      workbenchInvalidation: {},
      workbenchRuns: {},
      consoleSession: {},
      consoleAssets: { mode: 'prod' },
      consoleHttp: {},
      consoleWs: {},
      health: {},
      readiness: {},
    },
  })
  application = await startRuntime({ configPath })
})

test.afterAll(async () => {
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('publishes the latest focused field edit with one click', async ({ page }) => {
  await page.setViewportSize({ width: 1103, height: 740 })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()

  await page.getByRole('button', { name: 'Create automation' }).click()
  await page.getByLabel('Automation name', { exact: true }).fill('Focused Publish E2E')
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Focused Publish E2E', exact: true })).toBeVisible()

  const filter = page.getByRole('button', { name: 'Filter automations' })
  await filter.click()
  await expect(page.getByRole('region', { name: 'Automation filters' })).toBeVisible()
  await page.getByLabel('Search automations').fill('does not exist')
  await expect(page.getByText('No automations match these filters.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('.automation-select').filter({ hasText: 'Focused Publish E2E' })).toBeVisible()
  await filter.click()

  const rowMenu = page.getByRole('button', { name: 'More actions for Focused Publish E2E' })
  await rowMenu.click()
  await expect(page.getByRole('menuitem', { name: 'Open editor' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'View runs' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Open editor' }).click()

  const inspectorToggle = page.getByRole('button', { name: 'Open Inspector' })
  await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'false')
  await inspectorToggle.click()
  await expect(page.getByRole('button', { name: 'Close Inspector', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Inspector' })).toHaveAttribute('aria-expanded', 'false')

  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText('Cron Schedule', { exact: true }).click()
  await page.getByLabel('Cron', { exact: true }).fill('* * * * *')

  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText('Echo', { exact: true }).click()
  const message = page.getByLabel('Message', { exact: true })
  await message.fill('Published from the focused field.')
  await expect(message).toBeFocused()

  const publish = page.getByRole('button', { name: 'Publish', exact: true })
  await expect(publish).toBeEnabled()
  await publish.click()

  await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
  await expect(message).toHaveValue('Published from the focused field.')

  const automation = application.context.automations.listSummaries()
    .find(item => item.name === 'Focused Publish E2E')!
  expect(automation.revisionCount).toBe(1)
  const revision = application.context.automations.listRevisions(automation.id)[0]!
  expect(revision.source).toMatchObject({
    triggers: [{ capability: { id: 'schedule:cron', version: 1 }, config: { cron: '* * * * *', timezone: 'UTC' } }],
    flow: {
      type: 'block',
      steps: [{
        type: 'capability',
        capability: { id: 'demo:echo', version: 1 },
        input: { message: { type: 'literal', value: 'Published from the focused field.' } },
      }],
    },
  })

  await page.getByRole('tab', { name: 'Revisions' }).click()
  await page.getByRole('button', { name: 'Activate Revision 1' }).click()
  await expect(page.getByText('Active r1', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Runs' }).click()
  await page.getByText('Run manually', { exact: true }).first().click()
  const startRun = page.getByRole('button', { name: 'Start Run', exact: true })
  const reloadParameters = page.getByRole('button', { name: 'Reload parameters', exact: true })
  await expect(startRun).toBeVisible()
  await expect(reloadParameters).toBeVisible()
  const [startBox, reloadBox] = await Promise.all([startRun.boundingBox(), reloadParameters.boundingBox()])
  expect(startBox).not.toBeNull()
  expect(reloadBox).not.toBeNull()
  expect(Math.abs(startBox!.y - reloadBox!.y)).toBeLessThan(2)

  const runStatus = page.getByRole('button', { name: 'Run status' })
  await runStatus.click()
  await expect(page.getByRole('listbox', { name: 'Run status' })).toBeVisible()
  await page.getByRole('option', { name: 'Failed' }).click()
  await expect(runStatus).toContainText('Failed')
  await expect(runStatus).toBeFocused()
  await runStatus.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Failed' })).toBeFocused()
  await page.getByRole('option', { name: 'Failed' }).press('Escape')
  await expect(runStatus).toBeFocused()
  await expect(page.getByRole('listbox', { name: 'Run status' })).toHaveCount(0)
  await runStatus.click()
  await runStatus.press('Shift+Tab')
  await expect(page.getByRole('listbox', { name: 'Run status' })).toHaveCount(0)
  await expect(page.locator('.automation-run-filter select')).toHaveCount(0)
})

test.describe('Workbench localization', () => {
  test.use({ locale: 'zh-CN' })

  test('switches languages without replacing the Draft, then restores the preference', async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(application.workbenchUrl!)
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByRole('button', { name: '语言', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await page.getByRole('button', { name: '自动化', exact: true }).click()
    await page.getByRole('button', { name: '创建自动化', exact: true }).click()
    await page.getByLabel('自动化名称', { exact: true }).fill('User title stays unchanged')
    await page.locator('form.automation-create-form').getByRole('button', { name: '创建', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'User title stays unchanged', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加步骤', exact: true }).click()
    await page.getByPlaceholder('搜索控制节点和能力…').fill('回显')
    await page.getByText('回显', { exact: true }).click()
    const message = page.getByLabel('消息', { exact: true })
    await message.fill('User content stays unchanged <b>plain text</b>')
    await expect(message).toBeFocused()
    const route = page.url()
    await page.getByRole('button', { name: '语言', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('User content stays unchanged <b>plain text</b>')
    await expect(page.getByRole('heading', { name: 'User title stays unchanged', exact: true })).toBeVisible()
    expect(page.url()).toBe(route)
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await expect(page.getByText('已发布 r1', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('i18n-desktop.png') })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByRole('button', { name: '语言', exact: true })).toContainText('简体中文')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: '语言', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '语言', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    await page.screenshot({ path: testInfo.outputPath('i18n-mobile.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const automation = application.context.automations.listSummaries().find(item => item.name === 'User title stays unchanged')!
    const revision = application.context.automations.listRevisions(automation.id)[0]!
    expect(revision.source.flow).toMatchObject({ type: 'block', steps: [{ input: {
      message: { type: 'literal', value: 'User content stays unchanged <b>plain text</b>' },
    } }] })
    expect(errors).toEqual([])
  })
})

test('shows authenticated live logs, recovers from a lost query and WebSocket, and bounds history', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let socket: { close(): void } | undefined
  await page.routeWebSocket('**/api/console/subscribe', route => { socket = route.connectToServer() })
  const unauthorized = await fetch(new URL('/api/console/call', application.serverUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'query', procedure: 'numen:logs@1', input: {} }),
  })
  expect(unauthorized.status).toBe(401)
  await page.goto(application.workbenchUrl!)
  await page.getByRole('button', { name: 'System', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Runtime logs', exact: true })).toBeVisible()
  const view = page.getByRole('region', { name: 'Runtime logs', exact: true })
  await view.getByLabel('Namespace', { exact: true }).fill('e2e')
  await view.getByLabel('Namespace', { exact: true }).press('Tab')
  const logger = application.context.logger('e2e:logger')
  logger.info('literal <script>window.logExecuted=true</script> token=%s', 'e2e-secret-token')
  await expect(view.locator('.log-record pre')).toContainText(['literal <script>window.logExecuted=true</script> token=[REDACTED]'])
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).logExecuted)).toBeUndefined()
  await expect(view).not.toContainText('e2e-secret-token')
  logger.debug('debug-visible-only-when-requested')
  await expect(view).not.toContainText('debug-visible-only-when-requested')
  await view.getByRole('button', { name: 'Level', exact: true }).click()
  await page.getByRole('option', { name: 'Including debug', exact: true }).click()
  await expect(view).toContainText('debug-visible-only-when-requested')
  // Live redraws must not overwrite a partially typed, uncommitted filter.
  await view.getByLabel('Search messages', { exact: true }).fill('pending filter')
  logger.info('while-filter-is-focused')
  await expect(view).toContainText('while-filter-is-focused')
  await expect(view.getByLabel('Search messages', { exact: true })).toHaveValue('pending filter')
  await view.getByLabel('Search messages', { exact: true }).fill('')
  await view.getByLabel('Search messages', { exact: true }).press('Tab')
  await view.getByRole('button', { name: 'Pause updates' }).click()
  await expect(view.getByText('Loading…', { exact: true })).toHaveCount(0)
  logger.warn('arrived-while-paused')
  await page.waitForTimeout(600)
  await expect(view).not.toContainText('arrived-while-paused')
  await view.getByRole('button', { name: 'Follow updates' }).click()
  await expect(view).toContainText('arrived-while-paused')
  socket!.close()
  logger.warn('arrived-during-reconnect')
  await expect(view).toContainText('arrived-during-reconnect')
  await expect(view.locator('.log-record pre').filter({ hasText: 'arrived-during-reconnect' })).toHaveCount(1)
  let failNext = true
  await page.route('**/api/console/call', async route => {
    if (route.request().postDataJSON()?.procedure === 'numen:logs@1' && failNext) { failNext = false; await route.abort(); return }
    await route.continue()
  })
  logger.info('refresh-after-network-failure')
  await expect(view.getByRole('alert')).toContainText('Logs could not be refreshed')
  await view.getByRole('button', { name: 'Try again' }).click()
  await expect(view).toContainText('refresh-after-network-failure')
  for (let index = 0; index < 280; index++) logger.info('flood-%d', index)
  await expect(view.locator('.log-record')).toHaveCount(100)
  await expect(view).toContainText('flood-279')
  await view.getByRole('button', { name: 'Older logs' }).click()
  await expect(view).toContainText('flood-179')
  await expect(view).not.toContainText('flood-279')
  await view.getByRole('button', { name: 'Latest logs' }).click()
  await expect(view).toContainText('flood-279')
  await page.screenshot({ path: testInfo.outputPath('logs-desktop.png') })
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(page.getByRole('heading', { name: '系统日志', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '暂停更新', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('logs-mobile.png') })
  await page.getByRole('tab', { name: '日志', exact: true }).click()
  const panel = page.locator('.logs-panel-content')
  await expect(panel.locator('.log-record')).toHaveCount(100)
  expect(await panel.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('logs-panel-mobile.png') })
  expect(errors).toEqual([])
})

test('uses shared controls in system logs at desktop and mobile widths', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(application.workbenchUrl!)
  await page.getByRole('button', { name: 'System', exact: true }).click()
  await expect(page).toHaveURL(/\/system\/overview$/)
  await expect(page).toHaveTitle(/Numen/)
  await expect(page.getByRole('heading', { name: 'Runtime logs', exact: true })).toBeVisible()
  await expect(page.locator('select')).toHaveCount(0)
  await expect(page.getByLabel('Namespace', { exact: true })).toHaveClass(/n-input/)
  await expect(page.getByRole('button', { name: 'Pause updates', exact: true })).toHaveClass(/n-button/)
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  const level = page.getByRole('button', { name: '级别', exact: true })
  for (const [width, height] of [[1103, 740], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await level.click()
    const list = page.getByRole('listbox', { name: '级别', exact: true })
    await expect(list).toBeVisible()
    const box = await list.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(height)
    await page.screenshot({ path: `/tmp/numen-shared-controls-${width}.png` })
    await page.keyboard.press('Escape')
    await expect(level).toBeFocused()
    await expect(list).toHaveCount(0)
    await level.click()
    await page.getByRole('heading', { name: '系统日志', exact: true }).click()
    await expect(list).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('resizes and restores Workbench regions without losing editor state', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(application.workbenchUrl!)
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill('Resizable workspace')
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Resizable workspace', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.getByText('Echo', { exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft while resizing')
  const sidebar = page.getByRole('separator', { name: 'Resize sidebar', exact: true })
  const inspector = page.getByRole('separator', { name: 'Resize inspector', exact: true })
  const panel = page.getByRole('separator', { name: 'Resize bottom panel', exact: true })
  const bounds = (selector: string) => page.locator(selector).boundingBox()
  const size = async (selector: string, axis: 'width' | 'height') => (await bounds(selector))![axis]
  const drag = async (handle: typeof sidebar, dx: number, dy: number, cancel = false) => {
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 })
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('.n-resize-shield')).toHaveCount(0)
  }
  await expect(sidebar).toBeVisible()
  await drag(sidebar, 90, 0)
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(350)
  await drag(sidebar, 60, 0, true)
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(350)
  await drag(inspector, -70, 0)
  await expect.poll(() => size('.inspector', 'width')).toBe(430)
  await page.locator('.inspector-close').click()
  await expect(inspector).toHaveCount(0)
  await page.getByRole('button', { name: 'Open Inspector', exact: true }).click()
  await expect.poll(() => size('.inspector', 'width')).toBe(430)
  await drag(panel, 0, -254)
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await page.getByRole('button', { name: 'Collapse bottom panel', exact: true }).click()
  await page.getByRole('button', { name: 'Expand bottom panel', exact: true }).click()
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await sidebar.press('Home')
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(180)
  await sidebar.press('End')
  await expect.poll(() => size('.primary-sidebar', 'width')).toBeLessThanOrEqual(480)
  await sidebar.press('Enter')
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(260)
  await sidebar.press('Shift+ArrowRight')
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(300)
  await drag(sidebar, 50, 0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Resizable workspace', exact: true })).toBeVisible()
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(350)
  await expect.poll(() => size('.inspector', 'width')).toBe(430)
  await page.getByRole('tab', { name: 'Logs', exact: true }).click()
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft while resizing')
  await expect(page.locator('.bottom-panel').getByText('Loading…', { exact: true })).toHaveCount(0)
  await sidebar.focus()
  await page.screenshot({ path: '/tmp/numen-resizable-workbench-desktop.png' })
  await page.setViewportSize({ width: 1103, height: 740 })
  await expect(sidebar).toBeVisible()
  await expect(inspector).toBeVisible()
  const separatorBox = (await inspector.boundingBox())!
  const inspectorBox = (await bounds('.inspector'))!
  expect(Math.abs(separatorBox.x + separatorBox.width / 2 - inspectorBox.x)).toBeLessThan(2)
  await drag(inspector, -30, 0)
  await expect.poll(() => size('.inspector', 'width')).toBe(460)
  await page.setViewportSize({ width: 390, height: 600 })
  await expect(sidebar).toHaveCount(0)
  await expect(inspector).toHaveCount(0)
  await page.getByRole('button', { name: 'Close inspector overlay', exact: true }).click({ position: { x: 5, y: 50 } })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect.poll(() => size('.bottom-panel', 'height')).toBeLessThanOrEqual(278)
  await expect(page.locator('.workbench-shell')).toHaveAttribute('data-inspector-open', 'false')
  await expect.poll(async () => (await bounds('.inspector'))!.x).toBeGreaterThanOrEqual(390)
  await page.screenshot({ path: '/tmp/numen-resizable-workbench-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(350)
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await page.getByRole('button', { name: 'System', exact: true }).click()
  await expect.poll(() => size('.primary-sidebar', 'width')).toBe(350)
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(300)
  await drag(panel, 0, -50)
  await expect.poll(() => size('.bottom-panel', 'height')).toBe(350)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('resizing survives blocked storage and cancelled pointer input', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (key === 'numen.workbench.layout.v1') throw new DOMException('Storage unavailable', 'SecurityError')
      return get.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'numen.workbench.layout.v1') throw new DOMException('Storage unavailable', 'QuotaExceededError')
      return set.call(this, key, value)
    }
  })
  await page.goto(application.workbenchUrl!)
  await page.getByRole('button', { name: 'System', exact: true }).click()
  const sidebar = page.getByRole('separator', { name: 'Resize sidebar', exact: true })
  await sidebar.press('ArrowRight')
  await expect(sidebar).toHaveAttribute('aria-valuenow', '268')
  const box = (await sidebar.boundingBox())!
  await sidebar.evaluate(element => element.addEventListener('pointerdown', event => {
    element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId))
  }, { once: true }))
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + box.height / 2)
  await expect(sidebar).not.toHaveAttribute('aria-valuenow', '268')
  await sidebar.dispatchEvent('pointercancel', { pointerId: Number(await sidebar.getAttribute('data-test-pointer')) })
  await page.mouse.up()
  await expect(sidebar).toHaveAttribute('aria-valuenow', '268')
  await expect(page.locator('.n-resize-shield')).toHaveCount(0)
  await sidebar.dblclick()
  await expect(sidebar).toHaveAttribute('aria-valuenow', '260')
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 600 })
  const panel = page.getByRole('separator', { name: 'Resize bottom panel', exact: true })
  await expect(panel).toHaveAttribute('aria-valuenow', '42')
  await panel.press('ArrowUp')
  await expect.poll(async () => (await page.locator('.bottom-panel').boundingBox())!.height).toBe(120)
  await page.getByRole('button', { name: 'Collapse bottom panel', exact: true }).click()
  await expect(panel).toHaveAttribute('aria-valuenow', '42')
  expect(errors).toEqual([])
})
