import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import type { AutomationSource, BlockSource, ControlSource } from '../packages/core/dist/index.js'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Browser plugin not available: production Chromium + real temporary Runtime.
// Flow: native mouse drag -> an explicit structural drop -> durable Draft + one
// Undo; outline search -> reveal collapsed ancestors without searching inputs.
let application: NumenApplication, directory: string
let errors: string[], conflicts: number, expectedConflicts: number
const secret = 'SEARCH_PRIVATE_CANARY_73184'
const echo = (id: string, value = 'public message'): ControlSource => ({ type: 'capability', id, capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value } } })
const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 1000 } })
const fixtureSource = (): AutomationSource => ({
  inputs: { payload: { type: 'object', default: { authorization: secret } } }, triggers: [],
  flow: { type: 'block', id: 'root', steps: [
    { type: 'block', id: 'subtree', steps: [echo('echo-first'), {
      type: 'foreach', id: 'loop', items: { type: 'literal', value: ['one', 'two'] }, body: { type: 'block', id: 'loop-body', steps: [
        { type: 'if', id: 'deep-if', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'deep-then', steps: [
          { type: 'capability', id: 'nested-echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'ref', path: 'loop.item' } } },
        ] } },
      ] },
    }] },
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'empty-then', steps: [] }, else: { type: 'block', id: 'else-block', steps: [echo('else-echo')] } },
    wait('tail'),
    { type: 'capability', id: 'hidden-request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: `https://example.invalid/${secret}` }, headers: { type: 'literal', value: { authorization: secret } },
    } },
  ] },
})
const draft = (id: string) => application.context.automations.getDraft(id)!
const source = (id: string) => draft(id).source
const step = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`).first()
const structure = (page: Page, id: string) => page.locator(`[data-structure-node-id="${id}"]`).first()
const zone = (page: Page, id: string, placement: 'before' | 'after' | 'inside') => page.locator(`[data-drop-node-id="${id}"][data-drop-placement="${placement}"]`).first()
const clean = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
function descendants(node: ControlSource): ControlSource[] {
  const children = node.type === 'block' ? node.steps : node.type === 'if' ? [node.then, ...(node.else ? [node.else] : [])]
    : node.type === 'foreach' ? [node.body] : node.type === 'parallel' || node.type === 'race' ? node.branches : []
  return [node, ...children.flatMap(descendants)]
}
function block(id: string, nodeId: string): BlockSource {
  const found = descendants(source(id).flow).find(node => node.id === nodeId)
  expect(found?.type).toBe('block')
  return found as BlockSource
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-drag-search-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => { await application?.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })
test.beforeEach(({ page }) => {
  errors = []; conflicts = 0; expectedConflicts = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', event => {
    if (event.type() !== 'error') return
    if (event.text() === 'Failed to load resource: the server responded with a status of 409 (Conflict)' && event.location().url === new URL('/api/console/call', application.workbenchUrl!).href && conflicts < expectedConflicts) conflicts++
    else errors.push(`${event.text()} (${event.location().url})`)
  })
})
test.afterEach(async ({ page }) => { await page.mouse.up(); expect(errors).toEqual([]); expect(conflicts).toBe(expectedConflicts) })

async function openFixture(page: Page, name: string, initial = fixtureSource(), collapsedNodes: string[] = ['subtree']) {
  const { automation } = application.context.automations.create({ name, source: initial, presentation: { collapsedNodes } })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: name }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page).toHaveTitle('Numen Workbench')
  await expect(page).toHaveURL(/\/automations(?:\?|$)/)
  await expect(page.locator('.structured-flow')).toBeVisible()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await clean(page)
  return automation.id
}
function saves(page: Page) {
  const requests: unknown[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/console/call') && request.method() === 'POST') {
      const call = request.postDataJSON()
      if (call.procedure === 'numen:automation-save-draft@1') requests.push(call.input)
    }
  })
  return requests
}
async function beginDrag(page: Page, id: string) {
  const handle = page.locator(`[data-drag-node-id="${id}"]`).first()
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox()
  if (!box) throw new Error(`Drag handle ${id} has no bounds`)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 12, point.y + 12, { steps: 4 })
  await expect(page.locator('.structured-flow')).toHaveAttribute('data-dragging-node-id', id)
}
async function hoverDrop(page: Page, target: Locator, allowed = true) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('Drop target has no bounds')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y, { steps: 8 })
  // Chromium dispatches dragover on the second movement at the stable drop target.
  await page.mouse.move(point.x + 1, point.y + 1)
  await expect(target).toHaveAttribute('data-drop-state', allowed ? 'allowed' : 'rejected')
  return point
}
async function drag(page: Page, id: string, target: string, placement: 'before' | 'after' | 'inside') {
  await beginDrag(page, id)
  await hoverDrop(page, zone(page, target, placement))
  await page.mouse.up()
  await expect(page.locator('.structured-flow')).not.toHaveAttribute('data-dragging-node-id')
  await clean(page)
}
async function oneUndo(page: Page, id: string, before: AutomationSource) {
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => source(id)).toEqual(before)
  await clean(page)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
}
async function outline(page: Page) {
  const panel = page.locator('.structure-outline')
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click()
  const search = panel.getByRole('searchbox', { name: 'Find a node', exact: true })
  await expect(search).toBeVisible()
  return { panel, search, results: panel.getByRole('navigation', { name: 'Flow outline', exact: true }) }
}

test('moves nested subtrees through explicit before, after and empty-container drops with one Undo each', async ({ page }, testInfo) => {
  const id = await openFixture(page, 'Drag nested structure'), before = structuredClone(source(id)), requests = saves(page)
  await drag(page, 'tail', 'subtree', 'before')
  await expect.poll(() => block(id, 'root').steps.map(node => node.id)).toEqual(['tail', 'subtree', 'condition', 'hidden-request'])
  expect(requests).toHaveLength(1)
  await oneUndo(page, id, before)
  await drag(page, 'subtree', 'tail', 'after')
  await expect.poll(() => block(id, 'root').steps.map(node => node.id)).toEqual(['condition', 'tail', 'subtree', 'hidden-request'])
  await oneUndo(page, id, before)
  await drag(page, 'subtree', 'empty-then', 'inside')
  await expect.poll(() => block(id, 'empty-then').steps.map(node => node.id)).toEqual(['subtree'])
  expect(block(id, 'subtree')).toEqual((before.flow as BlockSource).steps[0])
  const ids = descendants(source(id).flow).map(node => node.id)
  expect(new Set(ids).size).toBe(ids.length)
  await page.screenshot({ path: testInfo.outputPath('nested-drag-desktop.png'), fullPage: false })
  await oneUndo(page, id, before)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Drag nested structure', exact: true })).toBeVisible()
  expect(source(id)).toEqual(before)
})

test('rejects an ancestor-to-descendant drop and cancels a valid drag without writing or creating Undo history', async ({ page }, testInfo) => {
  const id = await openFixture(page, 'Rejected and cancelled drag', fixtureSource(), []), before = structuredClone(draft(id)), requests = saves(page)
  await beginDrag(page, 'subtree')
  await hoverDrop(page, zone(page, 'deep-then', 'inside'), false)
  await page.screenshot({ path: testInfo.outputPath('rejected-descendant-drop.png'), fullPage: false })
  await page.mouse.up()
  await expect(page.locator('.structured-flow')).not.toHaveAttribute('data-dragging-node-id')
  expect(draft(id)).toEqual(before)
  await beginDrag(page, 'tail')
  await hoverDrop(page, zone(page, 'empty-then', 'inside'))
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.structured-flow')).not.toHaveAttribute('data-dragging-node-id')
  expect(draft(id)).toEqual(before); expect(requests).toEqual([])
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
})

test('auto-scrolls a long canvas during a real mouse drag and preserves a single structural edit', async ({ page }, testInfo) => {
  const initial: AutomationSource = { triggers: [], flow: { type: 'block', id: 'long-root', steps: Array.from({ length: 36 }, (_, index) => wait(`long-${index}`)) } }
  const id = await openFixture(page, 'Long drag auto-scroll', initial, []), before = structuredClone(source(id))
  const canvas = page.locator('.automation-canvas')
  await beginDrag(page, 'long-0')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Canvas has no bounds')
  const initialScroll = await canvas.evaluate(element => element.scrollTop)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 8, { steps: 8 })
  await page.mouse.move(bounds.x + bounds.width / 2 + 1, bounds.y + bounds.height - 7)
  await expect.poll(() => canvas.evaluate(element => element.scrollTop), { timeout: 10_000 }).toBeGreaterThan(initialScroll + 80)
  await expect(zone(page, 'long-35', 'after')).toBeInViewport({ timeout: 15_000 })
  await hoverDrop(page, zone(page, 'long-35', 'after'))
  await page.mouse.up()
  await expect.poll(() => block(id, 'long-root').steps.map(node => node.id)).toEqual([...Array.from({ length: 35 }, (_, index) => `long-${index + 1}`), 'long-0'])
  await clean(page)
  await page.screenshot({ path: testInfo.outputPath('auto-scroll-drop.png'), fullPage: false })
  await oneUndo(page, id, before)
})

test('cancels a drag when its target disappears remotely and never falls back to the root', async ({ page }) => {
  const initial: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [wait('moving'), { type: 'block', id: 'destination', steps: [] }, wait('kept')] } }
  const id = await openFixture(page, 'Disappearing drag target', initial, []), requests = saves(page)
  await beginDrag(page, 'moving')
  const point = await hoverDrop(page, zone(page, 'destination', 'inside'))
  const before = structuredClone(draft(id)), winner = structuredClone(before.source)
  ;(winner.flow as BlockSource).steps = (winner.flow as BlockSource).steps.filter(node => node.id !== 'destination')
  application.context.automations.saveDraft({ automationId: id, expectedVersion: before.version, source: winner, presentation: before.presentation })
  await expect(structure(page, 'destination')).toHaveCount(0)
  await expect(page.locator('.structured-flow')).not.toHaveAttribute('data-dragging-node-id')
  await page.mouse.move(point.x, point.y)
  await page.mouse.up()
  expect(source(id)).toEqual(winner)
  expect(draft(id).version).toBe(before.version + 1)
  expect(requests).toEqual([])
  await clean(page)
})

test('cancels an in-flight drag when an independent client causes a real Draft conflict', async ({ page }) => {
  const initial: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [echo('editable'), wait('moving'), { type: 'block', id: 'destination', steps: [] }] } }
  const id = await openFixture(page, 'Drag conflict', initial, []), before = structuredClone(draft(id))
  let release!: () => void, captured = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const routeSave = async (route: Route) => {
    if (route.request().postDataJSON()?.procedure !== 'numen:automation-save-draft@1') return route.continue()
    captured = true; await gate
    const response = await route.fetch()
    expect(response.status()).toBe(409)
    await route.fulfill({ response })
  }
  await page.route('**/api/console/call', routeSave)
  try {
    await step(page, 'editable').click()
    await page.getByLabel('Message', { exact: true }).fill('Local pending edit')
    await page.getByLabel('Message', { exact: true }).press('Tab')
    await expect.poll(() => captured).toBe(true)
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'SAVING')
    await beginDrag(page, 'moving')
    const point = await hoverDrop(page, zone(page, 'destination', 'inside'))
    const winner = structuredClone(before.source)
    ;(winner.flow as BlockSource).steps.push(wait('remote-winner'))
    application.context.automations.saveDraft({ automationId: id, expectedVersion: before.version, source: winner, presentation: before.presentation })
    expectedConflicts++
    release()
    await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CONFLICT')
    await expect(page.locator('.structured-flow')).not.toHaveAttribute('data-dragging-node-id')
    await page.mouse.move(point.x, point.y); await page.mouse.up()
    expect(source(id)).toEqual(winner)
    expect(draft(id).version).toBe(before.version + 1)
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Local pending edit')
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  } finally { release(); await page.unroute('**/api/console/call', routeSave) }
})

test('searches only names, capabilities and stable IDs, reveals hidden ancestors and does not steal focus on refresh', async ({ page }, testInfo) => {
  const id = await openFixture(page, 'Find nested nodes', fixtureSource(), ['subtree', 'loop', 'deep-if']), beforeSource = structuredClone(source(id))
  await expect(step(page, 'nested-echo')).toHaveCount(0)
  let searchPanel = await outline(page)
  await searchPanel.search.fill('eChO')
  await expect(searchPanel.results.getByRole('button', { name: 'Locate Echo (nested-echo)', exact: true })).toBeVisible()
  await searchPanel.search.fill('http:request')
  await expect(searchPanel.results.getByRole('button', { name: 'Locate HTTP Request (hidden-request)', exact: true })).toBeVisible()
  await expect(searchPanel.results.getByRole('button')).toHaveCount(1)
  for (const query of [secret, 'authorization', 'loop.item', 'example.invalid']) {
    await searchPanel.search.fill(query)
    await expect(searchPanel.panel.getByText('No matching nodes', { exact: true })).toBeVisible()
    await expect(searchPanel.results.getByRole('button')).toHaveCount(0)
  }
  await searchPanel.search.fill('nested-echo')
  await searchPanel.results.getByRole('button', { name: 'Locate Echo (nested-echo)', exact: true }).click()
  await expect(step(page, 'nested-echo')).toBeVisible()
  await expect(step(page, 'nested-echo')).toHaveAttribute('aria-pressed', 'true')
  await expect(step(page, 'nested-echo')).toBeFocused()
  for (const nodeId of ['subtree', 'loop', 'deep-if']) await expect(structure(page, nodeId).getByRole('button', { name: /^Collapse / }).first()).toHaveAttribute('aria-expanded', 'true')
  await clean(page)
  expect(source(id)).toEqual(beforeSource)
  await page.screenshot({ path: testInfo.outputPath('search-located-desktop.png'), fullPage: false })
  const command = page.getByRole('button', { name: 'Command center', exact: true })
  await command.focus()
  const response = page.waitForResponse(response => response.request().postDataJSON()?.procedure === 'numen:automation-detail@1')
  application.context.emit('numen/automation-change', id)
  await response
  await expect(command).toBeFocused()
  searchPanel = await outline(page)
  await searchPanel.search.fill('demo:echo')
  await expect(searchPanel.results.getByRole('button')).toHaveCount(3)
  const refreshed = page.waitForResponse(response => response.request().postDataJSON()?.procedure === 'numen:automation-detail@1')
  application.context.emit('numen/automation-change', id)
  await refreshed
  await expect(searchPanel.search).toBeFocused()
  await expect(searchPanel.search).toHaveValue('demo:echo')
  // Deleting the selected node changes activeStepId implicitly. Search keeps its
  // focus even while the canvas chooses a fallback selection after the refresh.
  const current = structuredClone(draft(id)), winner = structuredClone(current.source)
  const deletedParent = descendants(winner.flow).find(node => node.id === 'deep-then') as BlockSource
  deletedParent.steps = []
  application.context.automations.saveDraft({ automationId: id, expectedVersion: current.version, source: winner, presentation: current.presentation })
  await expect(searchPanel.results.getByRole('button')).toHaveCount(2)
  await expect(searchPanel.search).toBeFocused()
  await expect(searchPanel.search).toHaveValue('demo:echo')
  await page.setViewportSize({ width: 780, height: 860 })
  const closeInspector = page.getByRole('button', { name: 'Close inspector', exact: true })
  if (await page.locator('.inspector').getAttribute('data-open') === 'true') await closeInspector.click()
  await expect(page.locator('.inspector')).not.toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await searchPanel.search.fill('else-echo')
  await page.screenshot({ path: testInfo.outputPath('search-narrow.png'), fullPage: false })
  await searchPanel.results.getByRole('button', { name: 'Locate Echo (else-echo)', exact: true }).click()
  await expect(step(page, 'else-echo')).toHaveAttribute('aria-pressed', 'true')
  expect(source(id)).toEqual(winner)
  await page.setViewportSize({ width: 390, height: 844 })
  if (await page.locator('.inspector').getAttribute('data-open') === 'true') await closeInspector.click()
  await expect(page.locator('.inspector')).not.toBeInViewport()
  await expect(page.locator('[data-drag-node-id]:visible')).toHaveCount(0)
  searchPanel = await outline(page)
  await searchPanel.search.fill('else-echo')
  await expect(searchPanel.results.getByRole('button')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.locator('.automation-canvas').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('search-mobile.png'), fullPage: false })
  await searchPanel.results.getByRole('button', { name: 'Locate Echo (else-echo)', exact: true }).click()
  await expect(step(page, 'else-echo')).toHaveAttribute('aria-pressed', 'true')
  await expect(step(page, 'else-echo')).toBeFocused()
  await expect(searchPanel.panel.locator('nav')).not.toBeVisible()
  expect(source(id)).toEqual(winner)
})

test('keeps pending Inspector input and the outline when node search navigation is declined', async ({ page }) => {
  const id = await openFixture(page, 'Protected search navigation'), before = structuredClone(source(id))
  await step(page, 'hidden-request').click()
  const headers = page.getByLabel('Headers', { exact: true }), invalid = '{"Authorization":'
  await headers.fill(invalid); await headers.press('Tab')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  const { panel, search, results } = await outline(page)
  await search.fill('nested-echo')
  const result = results.getByRole('button', { name: 'Locate Echo (nested-echo)', exact: true })
  let declined = false
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); declined = true; await dialog.dismiss() })
  await result.click()
  expect(declined).toBe(true)
  await expect(step(page, 'hidden-request')).toHaveAttribute('aria-pressed', 'true')
  await expect(headers).toHaveValue(invalid)
  await expect(panel.locator('nav')).toBeVisible()
  await expect(search).toHaveValue('nested-echo')
  expect(source(id)).toEqual(before)
  let accepted = false
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); accepted = true; await dialog.accept() })
  await result.click()
  expect(accepted).toBe(true)
  await expect(step(page, 'nested-echo')).toHaveAttribute('aria-pressed', 'true')
  await expect(step(page, 'nested-echo')).toBeFocused()
  await expect(panel.locator('nav')).not.toBeVisible()
  await clean(page)
  expect(source(id)).toEqual(before)
})
