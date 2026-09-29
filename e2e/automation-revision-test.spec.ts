import { expect, test } from '@playwright/test'
import type { AutomationSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let automationId: string

// A seeded valid source isolates the Revision-run workflow. Publish, edit, activate and launch use UI.
const initialSource: AutomationSource = {
  inputs: { message: { type: 'string', title: 'First message', default: 'r1-default' } },
  triggers: [{ id: 'annual', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
  flow: { type: 'block', id: 'root', steps: [{ type: 'capability', id: 'echo', capability: { id: 'demo:echo', version: 1 }, input: {
    message: { type: 'template', parts: [{ ref: 'input.message' }, ' / ', { ref: 'trigger.event' }] },
  } }] },
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-revision-run-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, {
    version: 2, dataDir: 'data', logger: { console: false },
    plugins: {
      database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
      credentials: {}, resources: { path: 'data/resources' }, connections: {}, demo: {}, schedule: {},
      automations: {}, scheduler: { autoDispatch: true }, triggers: {}, console: {},
      server: { host: '127.0.0.1', port: 0 }, workbench: {},
    },
  })
  application = await startRuntime({ configPath })
  automationId = application.context.automations.create({ name: 'Revision test E2E', source: initialSource }).automation.id
})

test.afterAll(async () => {
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('tests an inactive published Revision and recovers an accepted request with real subscription state unchanged', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  let abortedRequestUrl: string | undefined
  let expectedNetworkErrors = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    // Only the one deliberately aborted accepted request may emit this exact browser error.
    if (abortedRequestUrl && message.location().url === abortedRequestUrl
      && message.text() === 'Failed to load resource: net::ERR_FAILED' && expectedNetworkErrors === 0) {
      expectedNetworkErrors += 1
      return
    }
    consoleErrors.push(`${message.text()} (${message.location().url})`)
  })
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page).toHaveURL(new URL('/', application.workbenchUrl!).href)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(page).toHaveURL(new URL('/automations', application.workbenchUrl!).href)
  await page.locator('.automation-select').filter({ hasText: 'Revision test E2E' }).click()
  await expect(page.getByRole('heading', { name: 'Revision test E2E', exact: true })).toBeVisible()

  await test.step('publish and activate r1, then edit and publish r2 without switching the active Revision', async () => {
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
    await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
    await expect(page.getByText('Active r1', { exact: true })).toBeVisible()
    await page.getByRole('switch', { name: 'Enable Automation', exact: true }).click()
    await expect.poll(() => application.context.triggers.automationHealth(automationId)?.active).toBe(1)

    await page.getByRole('tab', { name: 'Settings', exact: true }).click()
    const declaration = page.locator('.automation-input-declaration').filter({ hasText: 'input.message' })
    await declaration.getByLabel('Label for message', { exact: true }).fill('Second message')
    await declaration.getByLabel('Label for message', { exact: true }).press('Tab')
    const defaultInput = declaration.locator('#default-input-message')
    await defaultInput.fill('r2-default')
    await defaultInput.press('Tab')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published r2', { exact: true })).toBeVisible()
    await expect(page.getByText('Active r1', { exact: true })).toBeVisible()
  })

  const revisions = application.context.automations.listRevisions(automationId)
  expect(revisions).toHaveLength(2)
  const second = revisions[0]!, first = revisions[1]!
  expect(second.source.inputs?.message?.default).toBe('r2-default')
  expect(first.source.inputs?.message?.default).toBe('r1-default')
  const activation = application.context.automations.get(automationId)!
  const subscriptions = application.context.triggers.automationHealth(automationId)!
  expect(activation).toMatchObject({ activeRevisionId: first.id, enabled: true })
  expect(subscriptions).toMatchObject({ status: 'READY', active: 1, revisionId: first.id })

  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  await page.locator('.automation-run-launcher > summary').getByText('Run a published version', { exact: true }).click()
  const launcher = page.locator('.automation-manual-run')
  await expect(launcher.getByRole('button', { name: 'Revision to test', exact: true })).toContainText('#2')
  await expect(launcher.getByLabel('Second message', { exact: true })).toHaveValue('r2-default')
  await expect(launcher.getByText(/may perform external side effects/)).toBeVisible()
  await expect(launcher.getByText(/does not cancel an accepted Run/)).toBeVisible()

  await test.step('reach the same test controls in English and Chinese on a narrow screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText('Published r2', { exact: true })).toBeVisible()
    await expect(page.getByText('Active r1', { exact: true })).toBeVisible()
    await launcher.getByRole('button', { name: 'Start Run', exact: true }).scrollIntoViewIfNeeded()
    await expect(launcher.getByRole('button', { name: 'Start Run', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await launcher.getByRole('button', { name: '选择试运行版本', exact: true }).click()
    await page.getByRole('option', { name: '#1 · 活动版本', exact: true }).click()
    await expect(launcher.getByLabel('First message', { exact: true })).toHaveValue('r1-default')
    await launcher.getByRole('button', { name: '选择试运行版本', exact: true }).click()
    await page.getByRole('option', { name: '#2', exact: true }).click()
    await expect(launcher.getByLabel('Second message', { exact: true })).toHaveValue('r2-default')
    await launcher.getByLabel('触发数据（JSON）', { exact: true }).fill('{"event":"explicit test event"}')
    await launcher.getByRole('button', { name: '启动运行', exact: true }).scrollIntoViewIfNeeded()
    await expect(launcher.getByRole('button', { name: '启动运行', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('revision-test-mobile-zh.png'), fullPage: true })
    await page.getByRole('button', { name: '语言', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 960 })
  })

  let loseNextResponse = true
  let acceptedRunId = ''
  const requests: Array<{ requestId: string; mode: string; revisionId: string; input: unknown; trigger: unknown }> = []
  await page.route('**/api/console/call', async route => {
    const body = route.request().postDataJSON() as { procedure?: string; input: typeof requests[number] }
    if (body.procedure === 'numen:manual-run-start@1') {
      requests.push(body.input)
      if (loseNextResponse) {
        loseNextResponse = false
        // Fetch reaches the real server and commits its Run before the browser sees a failed response.
        const accepted = await route.fetch()
        expect(accepted.ok()).toBe(true)
        abortedRequestUrl = route.request().url()
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  try {
    await test.step('recover uncertain acceptance with the frozen payload and the same durable Run', async () => {
      const message = launcher.getByLabel('Second message', { exact: true })
      await message.fill('custom-r2-input')
      await expect(message).toBeFocused()
      // Starting once must commit valid focused input without requiring a separate Tab or blur.
      await launcher.getByRole('button', { name: 'Start Run', exact: true }).click({ timeout: 5_000 })
      await expect(launcher.getByText('Run acceptance could not be confirmed. Retry safely with the same request.', { exact: true })).toBeVisible()
      await expect(launcher.getByRole('button', { name: 'Revision to test', exact: true })).toBeDisabled()
      await expect(launcher.getByRole('button', { name: 'Run source', exact: true })).toBeDisabled()
      await expect(launcher.getByRole('button', { name: 'Reload parameters', exact: true })).toBeDisabled()
      await expect(launcher.getByLabel('Second message', { exact: true })).toBeDisabled()
      await expect(launcher.getByLabel('Trigger data (JSON)', { exact: true })).toBeDisabled()
      const accepted = application.context.scheduler.listRuns().filter(run => run.automationId === automationId)
      expect(accepted).toHaveLength(1)
      acceptedRunId = accepted[0]!.id
      await launcher.getByRole('button', { name: 'Retry Start Run', exact: true }).click()
      await expect(launcher.getByRole('button', { name: 'View Run', exact: true })).toBeVisible()
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[0]).toMatchObject({ mode: 'revision-test', revisionId: second.id, input: { message: 'custom-r2-input' }, trigger: { event: 'explicit test event' } })
      expect(application.context.scheduler.listRuns().filter(run => run.automationId === automationId).map(run => run.id)).toEqual([accepted[0]!.id])
      await expect.poll(() => application.context.scheduler.getRun(accepted[0]!.id)?.status).toBe('COMPLETED')
      expect(application.context.scheduler.listExecutions(accepted[0]!.id).map(execution => execution.output)).toContainEqual({ message: 'custom-r2-input / explicit test event' })
      expect(application.context.automations.get(automationId)).toEqual(activation)
      expect(application.context.triggers.automationHealth(automationId)).toEqual(subscriptions)
    })
  } finally { await page.unroute('**/api/console/call') }

  await test.step('show the durable test origin and request in Run history after a browser refresh', async () => {
    await launcher.getByRole('button', { name: 'View Run', exact: true }).click()
    await expect(page).toHaveURL(new URL(`/runs/${acceptedRunId}/flow`, application.workbenchUrl!).href)
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    const timelineUrl = new URL(`/runs/${acceptedRunId}/timeline`, application.workbenchUrl!).href
    await expect(page).toHaveURL(timelineUrl)
    await expect(page.getByText(/Source: Revision-test/)).toContainText(second.id)
    await expect(page.getByText(/Source: Revision-test/)).toContainText(requests[0]!.requestId)
    await page.reload()
    await expect(page).toHaveTitle('Numen Workbench')
    await expect(page).toHaveURL(timelineUrl)
    await expect(page.getByText(/Source: Revision-test/)).toContainText(requests[0]!.requestId)
  })
  expect(expectedNetworkErrors).toBe(1)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
