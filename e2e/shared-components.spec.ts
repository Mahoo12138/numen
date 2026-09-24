import componentsExample from '../examples/components-plugin/dist/index.js'
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


test('independently bundled plugin shares host components, locale, and lifecycle', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()) })
  const fiber = await application.context.plugin(componentsExample)
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.goto(new URL('/plugins/components', application.serverUrl!).href)
  await expect(page).toHaveTitle(/Numen/)
  await expect(page.getByRole('heading', { name: 'Shared components' })).toBeVisible()
  const select = page.getByRole('button', { name: 'Execution mode' })
  await select.focus()
  await select.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Fast', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: 'Careful', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(select).toBeFocused()
  await expect(select).toContainText('Careful')
  const enabled = page.getByRole('button', { name: 'Enabled', exact: true })
  await enabled.click()
  await expect(page.getByRole('option', { name: 'Select…', exact: true })).toBeDisabled()
  await expect(page.getByRole('option', { name: 'True', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(enabled).toContainText('False')
  await page.getByRole('button', { name: 'Attempts', exact: true }).click()
  await page.getByRole('option', { name: 'Three times', exact: true }).click()
  await expect(page.getByLabel('Current settings')).toContainText('"enabled":false,"attempts":3')
  await select.click()
  await page.keyboard.press('Escape')
  await expect(select).toHaveAttribute('aria-expanded', 'false')
  await page.getByLabel('Message', { exact: true }).fill('uncommitted edit')
  // Changing locale through the shared popup must preserve the edited value.
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('uncommitted edit')
  await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute('placeholder', '必填')
  const json = page.getByLabel('JSON data', { exact: true })
  await json.fill('{ invalid')
  await json.blur()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply settings' })).toBeDisabled()
  await expect(page.getByLabel('Current settings')).toContainText('"data":{"enabled":true}')
  await json.fill('{"enabled":false,"nested":[1,null,"ok"]}')
  await json.blur()
  await page.getByRole('button', { name: 'Apply settings' }).click()
  await expect(page.getByLabel('Current settings')).toContainText('"commits":1')
  await expect(page.getByLabel('Current settings')).toContainText('"message":"uncommitted edit"')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/numen-components-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await select.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.screenshot({ path: '/tmp/numen-components-mobile.png' })
  await page.keyboard.press('Escape')
  await fiber.dispose()
  // The current host reconciles Entries at startup and subscription reconnect.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Shared components' })).toHaveCount(0)
  const next = await application.context.plugin(componentsExample)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Shared components' })).toBeVisible()
  await expect(page.getByLabel('Current settings')).toContainText('"commits":0')
  await next.dispose()
  expect(errors).toEqual([])
})
