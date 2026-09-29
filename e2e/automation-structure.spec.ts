import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AutomationSource, BlockSource, ControlSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let fixtureServer: Server
let fixtureUrl: string
let fixtureRequests = 0

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-structure-e2e-'))
  fixtureServer = createServer((_request, response) => {
    fixtureRequests += 1
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ items: ['alpha', 'beta'] }))
  })
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once('error', reject)
    fixtureServer.listen(0, '127.0.0.1', resolve)
  })
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a port')
  fixtureUrl = `http://127.0.0.1:${address.port}/items`
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, {
    version: 2,
    dataDir: 'data',
    logger: { console: false },
    plugins: {
      database: { path: 'data/numen.db' },
      capabilities: {}, controls: {}, coreControls: {}, credentials: {},
      resources: { path: 'data/resources' }, connections: {},
      http: { timeout: 2_000 }, httpIntegration: {}, demo: {}, schedule: {},
      automations: {}, scheduler: { autoDispatch: true }, triggers: {},
      console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
    },
  })
  application = await startRuntime({ configPath })
})

test.afterAll(async () => {
  await application?.stop()
  if (fixtureServer) {
    fixtureServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve()))
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

// The backend is observed only for assertions. All Draft/Revision/Run writes go through the UI.
const draft = (automationId: string) => application.context.automations.getDraft(automationId)!
const source = (automationId: string) => draft(automationId).source

function controls(root: ControlSource): ControlSource[] {
  const children = root.type === 'block' ? root.steps
    : root.type === 'if' ? [root.then, ...(root.else ? [root.else] : [])]
      : root.type === 'foreach' ? [root.body]
        : root.type === 'parallel' || root.type === 'race' ? root.branches : []
  return [root, ...children.flatMap(controls)]
}

function control<T extends ControlSource['type']>(automationId: string, id: string, type: T): Extract<ControlSource, { type: T }> {
  const found = controls(source(automationId).flow).find(item => item.id === id)
  expect(found?.type).toBe(type)
  return found as Extract<ControlSource, { type: T }>
}

const node = (page: Page, id: string) => page.locator(`[data-structure-node-id="${id}"]`).first()
const block = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`).first()
const saved = (page: Page) => expect(page.locator('.status-bar[data-save-phase]')).toHaveAttribute('data-save-phase', 'CLEAN')

async function closeMobileInspector(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) >= 900) return
  const close = page.getByRole('button', { name: 'Close inspector', exact: true })
  // The mobile drawer stays mounted offscreen while closed.
  if (await page.locator('.inspector').getAttribute('data-open') === 'true') await close.click()
  await expect(page.locator('.inspector')).not.toBeInViewport()
}

async function selectNode(page: Page, id: string) {
  await closeMobileInspector(page)
  await node(page, id).locator('.automation-step').first().click()
}

async function createAutomation(page: Page, name: string): Promise<string> {
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByLabel('Automation name', { exact: true }).fill(name)
  await page.locator('form.automation-create-form').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await saved(page)
  return application.context.automations.listSummaries().find(item => item.name === name)!.id
}

async function insert(page: Page, automationId: string, trigger: Locator, title: string): Promise<string> {
  await closeMobileInspector(page)
  const before = new Set([...source(automationId).triggers, ...controls(source(automationId).flow)].map(item => item.id))
  await trigger.click()
  const picker = page.getByRole('dialog', { name: 'Add automation step', exact: true })
  await expect(picker).toBeVisible()
  await picker.getByRole('option').filter({ has: page.getByText(title, { exact: true }) }).click()
  await expect(picker).toHaveCount(0)
  await expect.poll(() => [...source(automationId).triggers, ...controls(source(automationId).flow)]
    .some(item => !before.has(item.id))).toBe(true)
  await saved(page)
  const inserted = [...source(automationId).triggers, ...controls(source(automationId).flow)]
    .find(item => !before.has(item.id) && (!('type' in item) || item.type !== 'block'))!
  await expect(node(page, inserted.id)).toBeVisible()
  return inserted.id
}

async function fillField(page: Page, id: string, field: string, value: string) {
  await selectNode(page, id)
  const input = page.getByLabel(field, { exact: true })
  await input.fill(value)
  await input.press('Tab')
  await saved(page)
}

async function expression(page: Page, id: string, field: string, mode: 'Reference' | 'Template', value: string) {
  await selectNode(page, id)
  await page.getByRole('button', { name: `${field} value mode`, exact: true }).click()
  await page.getByRole('option', { name: mode, exact: true }).click()
  const input = page.locator(`[id="${id}-input-${field.toLowerCase()}"]`)
  await input.fill(value)
  await input.press('Tab')
  await saved(page)
}

async function openActions(page: Page, id: string) {
  await closeMobileInspector(page)
  const trigger = node(page, id).getByRole('button', { name: /^Actions for / }).first()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  return node(page, id).locator('.structure-actions').first()
}

async function action(page: Page, id: string, label: string) {
  const actions = await openActions(page, id)
  await actions.getByRole('button', { name: label === 'Delete' ? /^Delete / : label, exact: label !== 'Delete' }).click()
}

async function assertNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const canvas = page.locator('.automation-canvas')
  expect(await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
}

test('builds, restructures and executes a nested flow entirely through the editor', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 960 })
  const automationId = await createAutomation(page, 'Nested structure acceptance')
  const addRoot = () => page.getByRole('button', { name: 'Add step', exact: true })
  let httpId = ''
  let ifId = ''
  let foreachId = ''
  let firstEchoId = ''
  let secondEchoId = ''
  let elseEchoId = ''
  let elseBlockId = ''

  await test.step('create Cron → HTTP → If → Then / ForEach / Echo and Else / Echo', async () => {
    const cronId = await insert(page, automationId, addRoot(), 'Cron Schedule')
    await fillField(page, cronId, 'Cron', '0 0 1 1 *')
    httpId = await insert(page, automationId, addRoot(), 'HTTP Request')
    await fillField(page, httpId, 'URL', fixtureUrl)
    ifId = await insert(page, automationId, addRoot(), 'If')
    await expression(page, ifId, 'Condition', 'Reference', `steps.${httpId}.ok`)
    const then = control(automationId, ifId, 'if').then
    foreachId = await insert(page, automationId, block(page, then.id).getByRole('button', { name: 'Add step to Then', exact: true }), 'For each')
    await expression(page, foreachId, 'Items', 'Reference', `steps.${httpId}.body.items`)
    const body = control(automationId, foreachId, 'foreach').body
    firstEchoId = await insert(page, automationId, block(page, body.id).getByRole('button', { name: 'Add step to Body', exact: true }), 'Echo')
    await expression(page, firstEchoId, 'Message', 'Template', '{{ loop.item }}')
    await openActions(page, firstEchoId)
    secondEchoId = await insert(page, automationId, node(page, firstEchoId).getByRole('button', { name: 'Insert after Echo', exact: true }), 'Echo')
    await expression(page, secondEchoId, 'Message', 'Reference', `steps.${firstEchoId}.message`)
    await node(page, ifId).getByRole('button', { name: 'Add else', exact: true }).click()
    await expect.poll(() => control(automationId, ifId, 'if').else?.id).toBeTruthy()
    elseBlockId = control(automationId, ifId, 'if').else!.id
    elseEchoId = await insert(page, automationId, block(page, elseBlockId).getByRole('button', { name: 'Add step to Else', exact: true }), 'Echo')
    await fillField(page, elseEchoId, 'Message', 'HTTP request did not succeed')
    expect(source(automationId)).toMatchObject({
      triggers: [{ capability: { id: 'schedule:cron' } }],
      flow: { type: 'block', steps: [
        { id: httpId, capability: { id: 'http:request' }, input: { url: { type: 'literal', value: fixtureUrl } } },
        { id: ifId, type: 'if', then: { steps: [{ id: foreachId, type: 'foreach', body: { steps: [{ id: firstEchoId }, { id: secondEchoId }] } }] }, else: { steps: [{ id: elseEchoId }] } },
      ] },
    })
  })

  await test.step('copy a nested subtree with fresh IDs and remap only its internal references', async () => {
    const before = structuredClone(source(automationId))
    const original = control(automationId, foreachId, 'foreach')
    await action(page, foreachId, 'Copy')
    await block(page, elseBlockId).getByRole('button', { name: 'Paste into Else', exact: true }).click()
    await expect.poll(() => control(automationId, ifId, 'if').else!.steps.length).toBe(2)
    const copied = control(automationId, ifId, 'if').else!.steps[1]!
    expect(copied.type).toBe('foreach')
    if (copied.type !== 'foreach') throw new Error('Copy did not produce a ForEach subtree')
    expect(controls(copied).map(item => item.id).some(id => controls(original).some(item => item.id === id))).toBe(false)
    expect(copied.items).toEqual({ type: 'ref', path: `steps.${httpId}.body.items` })
    expect(copied.body.steps[0]).toMatchObject({ input: { message: { type: 'template', parts: [{ ref: 'loop.item' }] } } })
    expect(copied.body.steps[1]).toMatchObject({ input: { message: { type: 'ref', path: `steps.${copied.body.steps[0]!.id}.message` } } })
    const ids = [...source(automationId).triggers, ...controls(source(automationId).flow)].map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    await action(page, copied.id, 'Delete')
    await expect.poll(() => source(automationId)).toEqual(before)
  })

  await test.step('confirm nonempty branch removal and restore its entire subtree with one Undo', async () => {
    await selectNode(page, elseEchoId)
    const before = structuredClone(source(automationId))
    await node(page, ifId).getByRole('button', { name: 'Remove else', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm removal', exact: true })).toBeVisible()
    expect(source(automationId)).toEqual(before)
    await page.getByRole('button', { name: 'Confirm removal', exact: true }).click()
    await expect.poll(() => control(automationId, ifId, 'if').else).toBeUndefined()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => source(automationId)).toEqual(before)
    await expect(node(page, elseEchoId).locator('.automation-step').first()).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('move across scope, locate the diagnostic, and undo / redo without changing identity', async () => {
    const before = structuredClone(source(automationId))
    await action(page, firstEchoId, 'Cut')
    await block(page, elseBlockId).getByRole('button', { name: 'Paste into Else', exact: true }).click()
    await expect.poll(() => control(automationId, ifId, 'if').else!.steps.map(item => item.id)).toEqual([elseEchoId, firstEchoId])
    expect(control(automationId, firstEchoId, 'capability').input.message).toEqual({ type: 'template', parts: [{ ref: 'loop.item' }] })
    // Invalid Drafts remain saveable; Publish requests the authoritative compiler diagnostics.
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    const problem = page.locator('.automation-problem').filter({ hasText: 'LOOP_REFERENCE_OUT_OF_SCOPE' })
    await expect(problem).toBeVisible()
    await selectNode(page, httpId)
    await problem.click()
    await expect(page.locator(`[id="${firstEchoId}-input-message"]`)).toBeFocused()
    await node(page, firstEchoId).locator('.automation-step').first().click()
    await problem.click()
    await expect(page.locator(`[id="${firstEchoId}-input-message"]`)).toBeFocused()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => source(automationId)).toEqual(before)
    await expect(problem).toHaveCount(0)
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(problem).toBeVisible()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => source(automationId)).toEqual(before)
    await expect(page.locator('.automation-problem')).toHaveCount(0)
  })

  await test.step('keep a newer field edit when an older save response arrives', async () => {
    await saved(page)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let captured = false
    let delayNext = true
    await page.route('**/api/console/call', async route => {
      const request = route.request().postDataJSON() as { procedure?: string }
      if (delayNext && request.procedure === 'numen:automation-save-draft@1') {
        delayNext = false
        const response = await route.fetch()
        captured = true
        await gate
        await route.fulfill({ response })
      } else await route.continue()
    })
    try {
      await selectNode(page, elseEchoId)
      const message = page.getByLabel('Message', { exact: true })
      await message.fill('First save is in flight')
      await message.press('Tab')
      await expect.poll(() => captured).toBe(true)
      await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
      await message.fill('Newer edit survives the old response')
      await message.press('Tab')
      release()
      await expect(message).toHaveValue('Newer edit survives the old response')
      await expect.poll(() => control(automationId, elseEchoId, 'capability').input.message).toEqual({ type: 'literal', value: 'Newer edit survives the old response' })
      await saved(page)
    } finally {
      release()
      await page.unroute('**/api/console/call')
    }
  })

  await test.step('persist Source and collapse Presentation, then inspect reachable mobile controls', async () => {
    await node(page, ifId).getByRole('button', { name: /^Collapse / }).first().click()
    await expect(node(page, firstEchoId)).not.toBeVisible()
    await saved(page)
    const persisted = structuredClone(draft(automationId))
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Nested structure acceptance', exact: true })).toBeVisible()
    await expect(node(page, firstEchoId)).not.toBeVisible()
    expect(draft(automationId).source).toEqual(persisted.source)
    expect(draft(automationId).presentation).toEqual(persisted.presentation)
    await page.locator('.structure-outline > summary').click()
    const outline = page.getByRole('navigation', { name: 'Flow outline', exact: true })
    await outline.getByRole('button', { name: `Locate Echo (${firstEchoId})`, exact: true }).click()
    await expect(outline).not.toBeVisible()
    await expect(node(page, firstEchoId)).toBeVisible()
    await expect(node(page, firstEchoId).locator('.automation-step').first()).toHaveAttribute('aria-pressed', 'true')
    await expect(node(page, firstEchoId).locator('.automation-step').first()).toBeFocused()
    await expect(node(page, ifId).getByRole('button', { name: /^Collapse / }).first()).toHaveAttribute('aria-expanded', 'true')
    await saved(page)
    await assertNoHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('structure-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await closeMobileInspector(page)
    await assertNoHorizontalOverflow(page)
    const menu = node(page, firstEchoId).getByRole('button', { name: /^Actions for / }).first()
    await menu.click()
    await expect(node(page, firstEchoId).locator('.structure-actions').getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    await menu.press('Tab')
    await expect(node(page, firstEchoId).getByRole('button', { name: 'Insert before Echo', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(node(page, firstEchoId).locator('.structure-actions')).toHaveCount(0)
    await expect(menu).toBeFocused()
    await openActions(page, firstEchoId)
    const insertBefore = node(page, firstEchoId).getByRole('button', { name: 'Insert before Echo', exact: true })
    const beforeMobileInsert = structuredClone(source(automationId))
    const waitId = await insert(page, automationId, insertBefore, 'Wait')
    expect(control(automationId, foreachId, 'foreach').body.steps.map(item => item.id)).toEqual([waitId, firstEchoId, secondEchoId])
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => source(automationId)).toEqual(beforeMobileInsert)
    await selectNode(page, elseEchoId)
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Newer edit survives the old response')
    await closeMobileInspector(page)
    await page.screenshot({ path: testInfo.outputPath('structure-mobile.png'), fullPage: true })
    await assertNoHorizontalOverflow(page)
    await page.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await node(page, firstEchoId).getByRole('button', { name: '回显 的操作', exact: true }).click()
    const chineseActions = node(page, firstEchoId).locator('.structure-actions').first()
    await expect(chineseActions.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await expect(chineseActions.getByRole('button', { name: '在回显之前插入', exact: true })).toBeVisible()
    await chineseActions.getByRole('button', { name: '复制', exact: true }).click()
    const bodyId = control(automationId, foreachId, 'foreach').body.id
    await expect(block(page, bodyId).getByRole('button', { name: '粘贴到循环体', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('structure-mobile-zh.png'), fullPage: true })
    await assertNoHorizontalOverflow(page)
    await block(page, bodyId).getByRole('button', { name: '向循环体添加步骤', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '添加自动化步骤', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭步骤选择器', exact: true }).click()
    await expect(block(page, bodyId).getByRole('button', { name: '向循环体添加步骤', exact: true })).toBeFocused()
    expect(source(automationId)).toEqual(beforeMobileInsert)
    await page.getByRole('button', { name: '语言', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    await page.setViewportSize({ width: 1440, height: 960 })
  })

  await test.step('publish and run the authored Source against the local HTTP fixture', async () => {
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published r1', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
    await page.getByRole('button', { name: 'Activate Revision 1', exact: true }).click()
    await expect(page.getByText('Active r1', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Runs', exact: true }).click()
    await page.getByText('Run a published version', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Start Run', exact: true }).click()
    await expect(page.getByRole('button', { name: 'View Run', exact: true })).toBeVisible()
    await expect.poll(() => application.context.scheduler.listRuns().find(run => run.automationId === automationId)?.status).toBe('COMPLETED')
    const run = application.context.scheduler.listRuns().find(item => item.automationId === automationId)!
    const outputs = application.context.scheduler.listExecutions(run.id).map(item => item.output)
    expect(outputs).toContainEqual({ message: 'alpha' })
    expect(outputs).toContainEqual({ message: 'beta' })
    expect(fixtureRequests).toBe(1)
    expect(application.context.automations.get(automationId)?.enabled).toBe(false)
  })

  await test.step('inspect archived collapsed structure without changing its Draft', async () => {
    await page.getByRole('tab', { name: 'Editor', exact: true }).click()
    await node(page, ifId).getByRole('button', { name: /^Collapse / }).first().click()
    await expect(node(page, firstEchoId)).not.toBeVisible()
    await saved(page)
    const persisted = structuredClone(draft(automationId))
    await page.getByRole('button', { name: 'More actions for Nested structure acceptance', exact: true }).click()
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('menuitem', { name: 'Archive automation', exact: true }).click()
    await expect.poll(() => application.context.automations.get(automationId)?.archivedAt).toBeTruthy()
    await page.getByRole('tab', { name: 'Editor', exact: true }).click()
    await expect(page.getByText('This Automation is archived and read-only. Restore it to edit, publish, activate, or start a manual Run.', { exact: true })).toBeVisible()
    await expect(node(page, firstEchoId)).not.toBeVisible()
    await node(page, ifId).getByRole('button', { name: /^Expand / }).first().click()
    await expect(node(page, firstEchoId)).toBeVisible()
    await node(page, ifId).getByRole('button', { name: /^Collapse / }).first().click()
    await page.locator('.structure-outline > summary').click()
    await page.getByRole('navigation', { name: 'Flow outline', exact: true })
      .getByRole('button', { name: `Locate Echo (${firstEchoId})`, exact: true }).click()
    await expect(node(page, firstEchoId).locator('.automation-step').first()).toBeFocused()
    expect(draft(automationId)).toEqual(persisted)
    await page.reload()
    await page.getByRole('button', { name: 'Filter automations', exact: true }).click()
    await page.getByRole('button', { name: 'Automation status', exact: true }).click()
    await page.getByRole('option', { name: 'Archived', exact: true }).click()
    await page.locator('.automation-select').filter({ hasText: 'Nested structure acceptance' }).click()
    await page.getByRole('tab', { name: 'Editor', exact: true }).click()
    await expect(node(page, firstEchoId)).not.toBeVisible()
    await expect(node(page, ifId).getByRole('button', { name: /^Expand / }).first()).toBeVisible()
    expect(draft(automationId)).toEqual(persisted)
  })
  expect(errors).toEqual([])
})

test('adds and removes populated Parallel and Race branches with one-step recovery', async ({ page }) => {
  test.setTimeout(90_000)
  const automationId = await createAutomation(page, 'Branch structure acceptance')
  for (const [title, type] of [['Parallel', 'parallel'], ['Race', 'race']] as const) {
    const id = await insert(page, automationId, page.getByRole('button', { name: 'Add step', exact: true }), title)
    expect(control(automationId, id, type).branches).toHaveLength(2)
    await expect(node(page, id).getByRole('button', { name: 'Remove branch 1', exact: true })).toBeDisabled()
    await node(page, id).getByRole('button', { name: 'Add branch', exact: true }).click()
    await expect.poll(() => control(automationId, id, type).branches.length).toBe(3)
    const branch: BlockSource = control(automationId, id, type).branches[2]!
    const echoId = await insert(page, automationId, block(page, branch.id).getByRole('button', { name: 'Add step to Branch 3', exact: true }), 'Echo')
    await fillField(page, echoId, 'Message', `${title} branch content`)
    const before: AutomationSource = structuredClone(source(automationId))
    await node(page, id).getByRole('button', { name: 'Remove branch 3', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm removal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(source(automationId)).toEqual(before)
    await node(page, id).getByRole('button', { name: 'Remove branch 3', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm removal', exact: true }).click()
    await expect.poll(() => control(automationId, id, type).branches.length).toBe(2)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => source(automationId)).toEqual(before)
    await expect(node(page, echoId).locator('.automation-step').first()).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(() => control(automationId, id, type).branches.length).toBe(2)
    await expect(node(page, echoId)).toHaveCount(0)
  }
})
