import { expect, test, type Page, type Route } from '@playwright/test'
import type { AutomationSource, BlockSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Browser plugin not available: production Chromium and an isolated real Runtime.
// Flow: context navigation and batch folding -> scoped canvas with unchanged
// Source; errors and pending Inspector JSON survive view-only interactions.
let application: NumenApplication, directory: string
let errors: string[], conflicts: number, expectedConflicts: number, invalidPublishes: number, expectedInvalidPublishes: number
const z = createRequire(new URL('../packages/workbench/package.json', import.meta.url))('schemastery')
const outer = 'orders'
const condition = 'paid-order'
const longNodeTitle = '华东订单处理与库存核对后通知财务客服及仓储部门并保留完整处理记录的自动化步骤：付款完成与配送信息确认后的多部门协同处理及异常恢复'
const automationName = '华东订单跨部门协同处理：库存核对、账务通知及异常恢复的完整业务流程'
const echo = (id: string) => ({ type: 'capability' as const, id, capability: { id: 'context:echo', version: 1 }, input: { message: { type: 'literal' as const, value: '订单库存核对结果及后续处理说明' } } })
const fixtureSource = (): AutomationSource => ({
  triggers: [{ id: 'annual', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
  flow: { type: 'block', id: 'root', steps: [
    { type: 'block', id: outer, steps: [
      echo('summary'),
      { type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
        url: { type: 'literal', value: 'https://example.invalid/orders' },
        headers: { type: 'literal', value: { Accept: 'application/json', 'X-部门处理说明': '财务与仓储确认订单库存后发送结果并保留完整核对记录' } },
      } },
      { type: 'if', id: condition, condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [
        { type: 'foreach', id: 'order-items', items: { type: 'literal', value: [{ 订单: '华东一区', 商品: ['库存核对', '发货确认'] }] }, body: { type: 'block', id: 'body', steps: [
          { type: 'parallel', id: 'parallel', branches: [
            { type: 'block', id: 'branch-a', steps: [echo('nested-echo')] },
            { type: 'block', id: 'branch-b', steps: [] },
          ] },
        ] } },
      ] }, else: { type: 'block', id: 'else', steps: [echo('else-echo')] } },
    ] },
    { type: 'block', id: 'outside', steps: [echo('outside-echo'), {
      type: 'capability', id: 'invalid-outside', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'ref', path: 'loop.item' } },
    }] },
  ] },
})
const draft = (id: string) => application.context.automations.getDraft(id)!
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
const node = (page: Page, id: string) => page.locator(`[data-structure-node-id="${id}"]`).first()
const step = (page: Page, id: string) => page.locator(`.automation-step[data-node-id="${id}"]`).first()

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-context-e2e-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {}, schedule: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
  const capability = { id: 'context:echo', version: 1, kind: 'action' as const, title: longNodeTitle,
    input: z.object({ message: z.string().description('订单处理说明') }), output: z.object({}),
    semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  application.context.capabilities.define(application.context, capability)
  application.context.capabilities.provide(application.context, capability, { async invoke() { return {} } })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })
test.beforeEach(({ page }) => {
  errors = []; conflicts = 0; expectedConflicts = 0; invalidPublishes = 0; expectedInvalidPublishes = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', event => {
    if (event.type() !== 'error') return
    if (event.text() === 'Failed to load resource: the server responded with a status of 409 (Conflict)' && event.location().url === new URL('/api/console/call', application.workbenchUrl!).href && conflicts < expectedConflicts) conflicts++
    else if (event.text() === 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)' && event.location().url === new URL('/api/console/call', application.workbenchUrl!).href && invalidPublishes < expectedInvalidPublishes) invalidPublishes++
    else errors.push(`${event.text()} (${event.location().url})`)
  })
})
test.afterEach(() => { expect(errors).toEqual([]); expect(conflicts).toBe(expectedConflicts); expect(invalidPublishes).toBe(expectedInvalidPublishes) })

async function openFixture(page: Page, suffix: string, collapsedNodes: string[] = []) {
  const name = `${automationName} · ${suffix}`
  const { automation } = application.context.automations.create({ name, source: fixtureSource(), presentation: { collapsedNodes, opaque: { preserve: true } } })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: name }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page).toHaveURL(/\/automations(?:\?|$)/)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await expect(page.locator('.structured-flow')).toBeVisible()
  await saved(page)
  return automation.id
}
async function closeInspector(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) >= 900) return
  if (await page.locator('.inspector').getAttribute('data-open') === 'true') {
    await page.locator('.inspector-close').click()
  }
  await expect(page.locator('.inspector')).not.toBeInViewport()
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.locator('.automation-canvas').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
}
const contextBar = (page: Page) => page.locator('.structure-context-bar')
const focused = (page: Page, id?: string) => id
  ? expect(page.locator('.structured-flow')).toHaveAttribute('data-focus-container-id', id)
  : expect(page.locator('.structured-flow')).not.toHaveAttribute('data-focus-container-id')
async function focusContainer(page: Page, id: string) {
  await closeInspector(page)
  await step(page, id).click()
  await contextBar(page).getByRole('button', { name: 'Focus selected container', exact: true }).click()
}
async function outline(page: Page, query: string) {
  const panel = page.locator('.structure-outline')
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click()
  const search = panel.getByRole('searchbox', { name: 'Find a node', exact: true })
  await search.fill(query)
  return { panel, search, result: panel.getByRole('navigation', { name: 'Flow outline', exact: true }).getByRole('button') }
}
function saveRequests(page: Page) {
  const requests: unknown[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/console/call') && request.method() === 'POST' && request.postDataJSON()?.procedure === 'numen:automation-save-draft@1') requests.push(request.postDataJSON().input)
  })
  return requests
}
async function publishProblems(page: Page) {
  expectedInvalidPublishes++
  const response = page.waitForResponse(response => response.request().postDataJSON()?.procedure === 'numen:automation-publish-draft@1')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await response
  await expect(page.locator('.automation-problem').filter({ hasText: 'LOOP_REFERENCE_OUT_OF_SCOPE' })).toBeVisible()
}

test('keeps a complete Chinese workspace readable with long titles, diagnostics and pending JSON', async ({ page }, testInfo) => {
  const id = await openFixture(page, '上下文验收'), before = structuredClone(draft(id).source)
  await publishProblems(page)
  await step(page, 'request').click()
  await contextBar(page).getByRole('button', { name: 'Focus selected container', exact: true }).click()
  await focused(page, outer)
  await page.getByRole('button', { name: 'Language', exact: true }).click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  const headers = page.locator('[id="request-input-headers"]')
  await expect(headers).toHaveValue(/X-部门处理说明/)
  await headers.fill('{\n  "部门": "财务与仓储需要保留未提交配置",\n  "待确认": ')
  await headers.press('Tab')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  for (const [width, height, label] of [[1440, 960, 'desktop'], [780, 860, 'narrow'], [390, 844, 'mobile']] as const) {
    await page.setViewportSize({ width, height })
    await expect.poll(async () => {
      const box = await page.locator('.inspector').boundingBox()
      return box ? Math.round(box.x + box.width) : null
    }).toBe(width)
    await noOverflow(page)
    await page.screenshot({ path: testInfo.outputPath(`context-${label}-inspector.png`), fullPage: false })
    await closeInspector(page)
    await step(page, 'summary').scrollIntoViewIfNeeded()
    await noOverflow(page)
    await page.screenshot({ path: testInfo.outputPath(`context-${label}-canvas.png`), fullPage: false })
    await expect(headers).toHaveValue('{\n  "部门": "财务与仓储需要保留未提交配置",\n  "待确认": ')
    expect(draft(id).source).toEqual(before)
    if (width !== 390 && width < 900) await page.locator('.mobile-inspector-button').click()
  }
})

test('focuses selected containers, follows parent breadcrumbs and restores persistent folding without saving', async ({ page }, testInfo) => {
  const id = await openFixture(page, 'Focus navigation', [outer, 'outside']), before = structuredClone(draft(id)), requests = saveRequests(page)
  await focusContainer(page, outer)
  await focused(page, outer)
  await expect(step(page, 'request')).toBeVisible()
  await expect(step(page, 'outside-echo')).toHaveCount(0)
  await expect(step(page, 'annual')).toHaveCount(0)
  await focusContainer(page, 'order-items')
  await focused(page, 'order-items')
  await expect(step(page, 'parallel')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('context-nested-container.png'), fullPage: false })
  await contextBar(page).getByRole('button', { name: 'Back to parent', exact: true }).click()
  await focused(page, 'then')
  await contextBar(page).getByRole('button', { name: `Show container ${outer}`, exact: true }).click()
  await focused(page, outer)
  await contextBar(page).getByRole('button', { name: 'Show entire flow', exact: true }).click()
  await focused(page)
  await expect(step(page, 'request')).toHaveCount(0)
  await expect(node(page, outer).getByRole('button', { name: 'Expand Orders', exact: true })).toBeVisible()
  expect(draft(id)).toEqual(before)
  expect(requests).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
})

test('collapses and expands only the current scope through one persisted Presentation edit and one Undo', async ({ page }) => {
  const id = await openFixture(page, 'Scoped folding', ['outside']), original = structuredClone(draft(id)), requests = saveRequests(page)
  const nested = [condition, 'then', 'order-items', 'body', 'parallel', 'branch-a', 'branch-b', 'else']
  await focusContainer(page, outer)
  await contextBar(page).getByRole('button', { name: 'Collapse all', exact: true }).click()
  await saved(page)
  expect([...draft(id).presentation.collapsedNodes as string[]].sort()).toEqual(['outside', ...nested].sort())
  expect(draft(id).source).toEqual(original.source)
  expect(draft(id).presentation.opaque).toEqual({ preserve: true })
  expect(draft(id).version).toBe(original.version + 1)
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(draft(id).presentation).toEqual(original.presentation)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  await contextBar(page).getByRole('button', { name: 'Collapse all', exact: true }).click()
  await saved(page)
  const collapsed = structuredClone(draft(id).presentation)
  await contextBar(page).getByRole('button', { name: 'Expand all', exact: true }).click()
  await saved(page)
  expect(draft(id).presentation).toEqual(original.presentation)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(draft(id).presentation).toEqual(collapsed)
  await contextBar(page).getByRole('button', { name: 'Show entire flow', exact: true }).click()
  await contextBar(page).getByRole('button', { name: 'Collapse all', exact: true }).click()
  await saved(page)
  expect([...draft(id).presentation.collapsedNodes as string[]].sort()).toEqual([outer, 'outside', ...nested].sort())
  await contextBar(page).getByRole('button', { name: 'Expand all', exact: true }).click()
  await saved(page)
  expect(draft(id).presentation.collapsedNodes).toEqual([])
  expect(draft(id).source).toEqual(original.source)
})

test('returns to the entire flow for search and Problems targets outside the focused container', async ({ page }) => {
  const id = await openFixture(page, 'Global locate'), before = structuredClone(draft(id).source)
  await focusContainer(page, outer)
  const search = await outline(page, 'outside-echo')
  await expect(search.result).toHaveCount(1)
  await search.result.click()
  await focused(page)
  await expect(step(page, 'outside-echo')).toHaveAttribute('aria-pressed', 'true')
  await expect(step(page, 'outside-echo')).toBeFocused()
  await focusContainer(page, outer)
  await publishProblems(page)
  await focused(page, outer)
  await page.locator('.automation-problem').filter({ hasText: 'LOOP_REFERENCE_OUT_OF_SCOPE' }).click()
  await focused(page)
  await expect(step(page, 'invalid-outside')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[id="invalid-outside-input-message"]')).toBeFocused()
  expect(draft(id).source).toEqual(before)
})

test('returns safely to the root when the focused container disappears remotely and preserves search focus', async ({ page }) => {
  const id = await openFixture(page, 'Remote scope removal'), requests = saveRequests(page)
  await focusContainer(page, outer)
  const search = await outline(page, 'nested-echo')
  await expect(search.result).toHaveCount(1)
  const before = structuredClone(draft(id)), winner = structuredClone(before.source)
  ;(winner.flow as BlockSource).steps = (winner.flow as BlockSource).steps.filter(node => node.id !== outer)
  application.context.automations.saveDraft({ automationId: id, expectedVersion: before.version, source: winner, presentation: before.presentation })
  await focused(page)
  await expect(search.search).toBeFocused()
  await expect(search.search).toHaveValue('nested-echo')
  await expect(search.result).toHaveCount(0)
  await expect(step(page, 'outside-echo')).toBeVisible()
  expect(draft(id).source).toEqual(winner)
  expect(draft(id).version).toBe(before.version + 1)
  expect(requests).toHaveLength(0)
})

test('keeps batch folding local during a real two-client Draft conflict', async ({ page }) => {
  const id = await openFixture(page, 'Read-only context'), before = structuredClone(draft(id)), requests = saveRequests(page)
  let release!: () => void, captured = false
  const hold = new Promise<void>(resolve => { release = resolve })
  const routeSave = async (route: Route) => {
    if (route.request().postDataJSON()?.procedure !== 'numen:automation-save-draft@1') return route.continue()
    captured = true; await hold; await route.continue()
  }
  await page.route('**/api/console/call', routeSave)
  try {
    await step(page, 'summary').click()
    await page.locator('[id="summary-input-message"]').fill('Local edit awaiting the server')
    await page.locator('[id="summary-input-message"]').press('Tab')
    await expect.poll(() => captured).toBe(true)
    const winner = structuredClone(before.source)
    ;(winner.flow as BlockSource).steps.push({ type: 'wait', id: 'remote-winner', durationMs: { type: 'literal', value: 1000 } })
    application.context.automations.saveDraft({ automationId: id, expectedVersion: before.version, source: winner, presentation: before.presentation })
    expectedConflicts++; release()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    await focusContainer(page, outer)
    await focused(page, outer)
    await contextBar(page).getByRole('button', { name: 'Collapse all', exact: true }).click()
    await expect(step(page, 'order-items')).toHaveCount(0)
    await contextBar(page).getByRole('button', { name: 'Expand all', exact: true }).click()
    await expect(step(page, 'order-items')).toBeVisible()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    expect(draft(id).source).toEqual(winner)
    expect(draft(id).presentation).toEqual(before.presentation)
    expect(draft(id).version).toBe(before.version + 1)
    expect(requests).toHaveLength(1)
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  } finally { release(); await page.unroute('**/api/console/call', routeSave) }
})

test('preserves pending JSON through context navigation, persistent folding and Presentation Undo', async ({ page }) => {
  const id = await openFixture(page, 'Unapplied JSON'), before = structuredClone(draft(id)), requests = saveRequests(page)
  await step(page, 'request').click()
  const headers = page.locator('[id="request-input-headers"]'), invalid = '{"pending": '
  await headers.fill(invalid); await headers.press('Tab')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await contextBar(page).getByRole('button', { name: 'Focus selected container', exact: true }).click()
  await focused(page, outer)
  await expect(headers).toHaveValue(invalid)
  await expect(step(page, 'request')).toHaveAttribute('aria-pressed', 'true')
  await contextBar(page).getByRole('button', { name: 'Back to parent', exact: true }).click()
  await focused(page)
  await expect(headers).toHaveValue(invalid)
  const dialogs: string[] = []
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await contextBar(page).getByRole('button', { name: 'Collapse all', exact: true }).click()
  await saved(page)
  expect(dialogs).toEqual([])
  await expect(headers).toHaveValue(invalid)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  expect(draft(id).source).toEqual(before.source)
  expect(draft(id).presentation.collapsedNodes).toContain(outer)
  expect(draft(id).version).toBe(before.version + 1)
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(dialogs).toEqual([])
  expect(draft(id).presentation).toEqual(before.presentation)
  expect(draft(id).source).toEqual(before.source)
  await expect(headers).toHaveValue(invalid)
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
})
