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
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en-US')
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
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
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en-US')
    await expect(page.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('User content stays unchanged <b>plain text</b>')
    await expect(page.getByRole('heading', { name: 'User title stays unchanged', exact: true })).toBeVisible()
    expect(page.url()).toBe(route)
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await expect(page.getByText('已发布 r1', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('i18n-desktop.png') })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('zh-CN')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('combobox', { name: '语言', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en-US')
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
