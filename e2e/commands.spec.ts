import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let automationId: string
let otherId: string
let errors: string[]

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-commands-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  automationId = application.context.automations.create({ name: 'Commands Alpha', source: { triggers: [], flow: { type: 'block', id: 'flow', steps: [
    { type: 'capability', id: 'one', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'First' } } },
    { type: 'capability', id: 'two', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'Second' } } },
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 1000 } },
  ] } } }).automation.id
  application.context.automations.publishDraft(automationId)
  otherId = application.context.automations.create({ name: 'Commands Beta' }).automation.id
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
})
test.afterEach(() => expect(errors).toEqual([]))

const source = () => application.context.automations.getDraft(automationId)!.source
const ids = () => { const flow = source().flow; return flow.type === 'block' ? flow.steps.map(step => step.id) : [] }
const node = (page: Page, id: string) => page.locator(`.automation-step[data-node-id="${id}"]`)
const saved = (page: Page) => expect(page.locator('.status-bar[data-save-phase]')).toHaveAttribute('data-save-phase', 'CLEAN')
const center = (page: Page) => page.getByRole('dialog', { name: 'Command center', exact: true })
async function mod(page: Page) { return page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'Meta' : 'Control') }
async function command(page: Page, id: string) {
  await page.getByRole('button', { name: 'Command center', exact: true }).click()
  await center(page).locator(`[data-command-id="${id}"]`).click()
  await expect(center(page)).toHaveCount(0)
}

test('uses real global commands, traps and restores palette focus, and removes page commands on navigation', async ({ page }) => {
  await page.goto(application.workbenchUrl!)
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.locator('.status-bar')).not.toContainText('Saved')
  await expect(page.getByRole('tab', { name: 'Logs', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Problems/ })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Preview', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Help', exact: true })).toHaveCount(0)
  const modifier = await mod(page)
  const trigger = page.getByRole('button', { name: 'Command center', exact: true })
  await expect(trigger.locator('kbd')).toHaveText(modifier === 'Meta' ? '⌘K' : 'Ctrl+K')
  await trigger.focus()
  await page.keyboard.press(`${modifier}+k`)
  const search = center(page).getByRole('textbox', { name: 'Search commands and Automations', exact: true })
  await expect(search).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(await center(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Tab')
  await expect(search).toBeFocused()
  await search.fill('no-such-command')
  await expect(center(page).getByText('No commands match your search.', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await search.fill('Open Automations')
  await expect(center(page).locator('[data-command-id]')).toHaveCount(1)
  await search.dispatchEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })
  await expect(center(page)).toBeVisible()
  await search.press('Enter')
  await expect(center(page)).toHaveCount(0)
  await expect(page).toHaveURL(new URL('/automations', application.workbenchUrl!).href)
  await command(page, `automation.open.${otherId}`)
  await expect(page.getByRole('heading', { name: 'Commands Beta', exact: true })).toBeVisible()
  await trigger.click()
  await expect(center(page).locator('[data-command-id="automation.undo"]')).toHaveAttribute('aria-disabled', 'true')
  await expect(center(page).locator('[data-command-id="automation.undo"]')).toContainText('No change to undo')
  await page.keyboard.press('Escape')
  await command(page, `automation.open.${automationId}`)
  await expect(page.getByRole('heading', { name: 'Commands Alpha', exact: true })).toBeVisible()
  await command(page, 'automation.testRun')
  await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.automation-run-launcher')).toHaveAttribute('open', '')
  await command(page, 'workbench.open.home')
  await trigger.click()
  await expect(center(page).locator('[data-command-id="automation.undo"]')).toHaveCount(0)
  await expect(center(page).locator('[data-command-id="automation.testRun"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${modifier}+Alt+n`)
  await expect(page.getByLabel('Automation name', { exact: true })).toBeFocused()
  await page.getByLabel('Automation name', { exact: true }).fill('Created from command')
  await page.locator('.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Created from command', exact: true })).toBeVisible()
  await saved(page)
})

test('shares edit commands across keys, palette and toolbar while protecting inputs, IME and dialogs', async ({ page }, testInfo) => {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  const url = new URL('/automations', application.workbenchUrl!); url.searchParams.set('automation', automationId)
  await page.goto(url.href)
  await expect(page.getByRole('heading', { name: 'Commands Alpha', exact: true })).toBeVisible()
  const modifier = await mod(page)
  await node(page, 'one').click()
  await page.keyboard.press(`${modifier}+c`)
  await node(page, 'two').click()
  await page.keyboard.press(`${modifier}+v`)
  await expect.poll(() => ids().length).toBe(4)
  expect(ids().slice(0, 2)).toEqual(['one', 'two'])
  expect(ids()[3]).toBe('wait')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(ids).toEqual(['one', 'two', 'wait'])
  await node(page, 'one').click()
  await page.keyboard.press(`${modifier}+x`)
  await node(page, 'wait').click()
  await page.keyboard.press(`${modifier}+v`)
  await expect.poll(ids).toEqual(['two', 'wait', 'one'])
  await page.keyboard.press(`${modifier}+z`)
  await expect.poll(ids).toEqual(['one', 'two', 'wait'])
  await node(page, 'one').click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(ids).toEqual(['two', 'one', 'wait'])
  await command(page, 'automation.undo')
  await expect.poll(ids).toEqual(['one', 'two', 'wait'])
  for (const flags of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await node(page, 'one').dispatchEvent('keydown', { key: 'Delete', bubbles: true, ...flags })
  }
  expect(ids()).toEqual(['one', 'two', 'wait'])
  await page.locator('[data-block-id="flow"]').getByRole('button', { name: 'Add step', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Add automation step', exact: true })).toBeVisible()
  await page.keyboard.press('Delete')
  expect(ids()).toEqual(['one', 'two', 'wait'])
  await page.keyboard.press('Escape')

  await node(page, 'wait').click()
  const duration = page.getByRole('textbox', { name: 'Wait duration in seconds', exact: true })
  await duration.fill('2'); await duration.press('Tab'); await saved(page)
  await duration.fill('-')
  await duration.dispatchEvent('keydown', { key: 'z', ctrlKey: modifier === 'Control', metaKey: modifier === 'Meta', bubbles: true })
  await expect(duration).toHaveValue('-')
  const before = structuredClone(source())
  await duration.focus(); await page.keyboard.press(`${modifier}+k`)
  await expect(center(page)).toBeVisible()
  const cancelled = page.waitForEvent('dialog')
  const clickUndo = center(page).locator('[data-command-id="automation.undo"]').click()
  await (await cancelled).dismiss(); await clickUndo
  await expect(duration).toHaveValue('-')
  expect(source()).toEqual(before)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  await duration.focus(); await page.keyboard.press(`${modifier}+k`)
  const accepted = page.waitForEvent('dialog')
  const acceptedUndo = center(page).locator('[data-command-id="automation.undo"]').click()
  await (await accepted).accept(); await acceptedUndo
  await expect(duration).toHaveValue('1')
  await saved(page)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'false')
  await node(page, 'one').click()
  await page.keyboard.press('Delete')
  await expect.poll(ids).toEqual(['two', 'wait'])
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(ids).toEqual(['one', 'two', 'wait'])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click()
  await page.getByRole('button', { name: 'Command center', exact: true }).click()
  await expect(center(page)).toBeInViewport()
  await center(page).getByRole('textbox').fill('Move')
  await expect(center(page).locator('[data-command-id]')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('commands-mobile.png'), fullPage: true })
})
