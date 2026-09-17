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
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()

  await page.getByRole('button', { name: 'Create automation' }).click()
  await page.getByLabel('Automation name', { exact: true }).fill('Focused Publish E2E')
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Focused Publish E2E', exact: true })).toBeVisible()

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
})
