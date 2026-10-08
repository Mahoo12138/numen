import { expect, test, type Page } from '@playwright/test'
import { writeConfig } from '../../packages/config/dist/index.js'
import { startRuntime } from '../../packages/runtime/dist/index.js'
import type {} from '../../packages/automation/dist/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createAutomationCapacityFixture } from './fixtures.js'
import { createProbe, settings, summarize, writeResult, hostSnapshot } from './metrics.js'

// Browser plugin not available. This opt-in suite measures production Chromium
// against temporary real Runtime/SQLite state. No external Integration executes.
const selected = (id: string) => `.automation-step[data-node-id="${id}"][data-selected="true"]`
const node = (page: Page, id: string) => page.locator(`.automation-step[data-node-id="${id}"]`)
const saved = (page: Page) => expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')

for (const nodeCount of [100, 300, 1000] as const) test(`${nodeCount} node production workload`, async ({ browser }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-capacity-'))
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, demo: {}, schedule: {}, automations: {},
    scheduler: { autoDispatch: false }, triggers: {}, console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  const app = await startRuntime({ configPath })
  const fixture = createAutomationCapacityFixture(nodeCount)
  const { automation } = app.context.automations.create({ name: fixture.name, source: fixture.source })
  const published = app.context.automations.publishDraft(automation.id, 1)
  const targets = fixture.metadata.targets
  const url = new URL(app.workbenchUrl!)
  url.pathname = '/automations'; url.searchParams.set('automation', automation.id)
  const ready = { selector: `body:has(.status-bar[data-save-phase="CLEAN"]) .automation-step[data-node-id="${targets.editNodeId}"]` }
  const cold: number[] = [], coldSnapshots: object[] = []
  let stage = 'cold navigation'
  try {
    for (let trial = 0; trial < settings.coldTrials; trial++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
      try {
        const page = await context.newPage(), probe = await createProbe(page)
        cold.push(await probe.navigate(url.href, ready))
        await expect(page.getByRole('heading', { name: fixture.name, exact: true })).toBeVisible()
        // Readiness is backed by a real immediately usable selection operation.
        await node(page, targets.editNodeId).click()
        await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
        coldSnapshots.push({ trial, ...await probe.snapshot('initial expanded document'), observation: await probe.summary() })
        probe.assertHealthy()
      } finally { await context.close() }
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    const page = await context.newPage(), probe = await createProbe(page)
    try {
      await probe.navigate(url.href, ready)
      await node(page, targets.editNodeId).click()
      const initial = await probe.snapshot('expanded editor')
      const counts = async () => (await probe.summary()).requestCounts['numen:automation-save-draft@1'] ?? 0
      const initialSaves = await counts()
      const draftBeforeSelection = structuredClone(app.context.automations.getDraft(automation.id))
      stage = 'node selection'
      // Exclude locator scrolling and fixture preparation from event-to-paint.
      for (let index = 0; index <= settings.samples; index++) {
        const id = index % 2 === 0 ? targets.selectionNodeId : targets.editNodeId
        const button = node(page, id)
        await button.scrollIntoViewIfNeeded()
        await probe.measure(index ? 'nodeSelection' : 'nodeSelectionWarmup', {
          event: 'pointerdown', target: `.automation-step[data-node-id="${id}"]`, ready: { selector: selected(id) },
        }, () => button.click())
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.status-bar')).toHaveAttribute('data-save-phase', 'CLEAN')
      }
      const selectionSaves = await counts() - initialSaves
      expect(selectionSaves).toBe(0)
      expect(app.context.automations.getDraft(automation.id)).toEqual(draftBeforeSelection)
      await node(page, targets.editNodeId).click()
      const message = page.getByLabel('Message', { exact: true })
      const fieldSavesBefore = await counts()
      stage = 'field commit'
      for (let index = 0; index <= settings.samples; index++) {
        const value = `Capacity commit ${nodeCount} / ${index}`
        await message.fill(value)
        await probe.measure(index ? 'fieldCommitRender' : 'fieldCommitRenderWarmup', {
          event: 'blur', target: `#${targets.editNodeId}-input-message`,
          ready: { selector: '.status-bar[data-save-phase="DIRTY"][data-input-pending="false"]', latch: true },
        }, () => message.press('Tab'))
        await saved(page)
        const source = app.context.automations.getDraft(automation.id)!.source
        expect(source.flow.type === 'block' && source.flow.steps[0]?.type === 'capability' && source.flow.steps[0].input?.message).toEqual({ type: 'literal', value })
      }
      const fieldSaves = await counts() - fieldSavesBefore
      expect(fieldSaves).toBe(settings.samples + 1)

      const locationSavesBefore = await counts()
      stage = 'hidden node location'
      const sourceBeforeLocation = structuredClone(app.context.automations.getDraft(automation.id)!.source)
      for (let index = 0; index <= settings.samples; index++) {
        const savesBeforeRound = await counts()
        await node(page, targets.editNodeId).click()
        await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
        await saved(page)
        await expect(node(page, targets.searchNodeId)).toHaveCount(0)
        expect(await counts() - savesBeforeRound).toBe(1)
        const outline = page.locator('.structure-outline')
        if (await outline.getAttribute('open') === null) await outline.locator('summary').click()
        const search = outline.getByRole('searchbox', { name: 'Find a node', exact: true })
        await search.fill(targets.searchNodeId)
        const result = outline.getByRole('navigation').getByRole('button')
        await expect(result).toHaveCount(1)
        await result.scrollIntoViewIfNeeded()
        await probe.measure(index ? 'hiddenNodeLocate' : 'hiddenNodeLocateWarmup', {
          event: 'pointerdown', target: '.structure-outline nav button', ready: { selector: selected(targets.searchNodeId) },
        }, () => result.click())
        await expect(node(page, targets.searchNodeId)).toBeInViewport()
        await saved(page)
        expect(await counts() - savesBeforeRound).toBe(2)
      }
      const locationSaves = await counts() - locationSavesBefore
      expect(locationSaves).toBe(2 * (settings.samples + 1))
      expect(app.context.automations.getDraft(automation.id)!.source).toEqual(sourceBeforeLocation)

      // Behavioral guards run on the same large fixture after measured samples.
      stage = 'correctness guards and responsive evidence'
      await node(page, targets.editNodeId).click()
      const originalMessage = await message.inputValue()
      await message.fill('Capacity undo/redo guard')
      await message.press('Tab'); await saved(page)
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await saved(page)
      await expect(message).toHaveValue(originalMessage)
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); await saved(page)
      await expect(message).toHaveValue('Capacity undo/redo guard')
      await page.getByRole('button', { name: 'Expand all', exact: true }).click(); await saved(page)
      await node(page, targets.loopNodeId).click()
      await page.getByRole('button', { name: 'Items value mode', exact: true }).click()
      await page.getByRole('option', { name: 'Literal', exact: true }).click(); await saved(page)
      const items = page.getByLabel('Items', { exact: true })
      await items.fill('["unfinished",')
      await items.press('Tab')
      await expect(items).toHaveAttribute('aria-invalid', 'true')
      const beforeRejectedNavigation = structuredClone(app.context.automations.getDraft(automation.id))
      await page.getByRole('button', { name: 'Focus selected container', exact: true }).click()
      await expect(items).toHaveValue('["unfinished",')
      await page.getByRole('button', { name: 'Show entire flow', exact: true }).click()
      page.once('dialog', dialog => dialog.dismiss())
      await node(page, targets.editNodeId).click()
      await expect(node(page, targets.loopNodeId)).toHaveAttribute('data-selected', 'true')
      await expect(items).toHaveValue('["unfinished",')
      expect(app.context.automations.getDraft(automation.id)).toEqual(beforeRejectedNavigation)
      await items.fill('["east","west"]'); await items.press('Tab'); await saved(page)
      const outline = page.locator('.structure-outline')
      if (await outline.getAttribute('open') === null) await outline.locator('summary').click()
      const search = outline.getByRole('searchbox', { name: 'Find a node', exact: true })
      await search.fill(targets.searchNodeId)
      await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
      await expect(search).toBeFocused()
      await expect(node(page, targets.loopNodeId)).toHaveAttribute('data-selected', 'true')
      await search.press('Enter')
      await expect(node(page, targets.searchNodeId)).toHaveAttribute('data-selected', 'true')
      await expect(node(page, targets.searchNodeId)).toBeFocused()
      await saved(page)
      await page.screenshot({ path: testInfo.outputPath('capacity-desktop.png') })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.inspector-close').click()
      // Resizing changes line wrapping; explicitly locate again at this width.
      if (await outline.getAttribute('open') === null) await outline.locator('summary').click()
      await search.fill(targets.searchNodeId); await search.press('Enter')
      await page.locator('.inspector-close').click()
      await expect(page.locator('.inspector')).not.toBeInViewport()
      await expect(node(page, targets.searchNodeId)).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('capacity-mobile.png') })
      await page.setViewportSize({ width: 1440, height: 960 })

      const home = async () => {
        await page.getByRole('button', { name: 'Home', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
        await expect(page.locator('.home-overview')).toBeVisible()
        await page.waitForTimeout(100) // Defined cleanup quiescence, outside latency samples.
      }
      const open = async () => {
        await page.getByRole('button', { name: 'Automations', exact: true }).click()
        await expect(page.getByRole('heading', { name: fixture.name, exact: true })).toBeVisible()
        await node(page, targets.editNodeId).click()
        await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Capacity undo/redo guard')
      }
      await home(); await open(); await home()
      stage = 'lifecycle cleanup'
      const lifecycle = [{ ...await probe.snapshot('warm neutral baseline'), host: hostSnapshot(app.context) }]
      expect(lifecycle[0]!.host.consoleSubscriptions.supported).toBe(true)
      expect(lifecycle[0]!.host.consoleSockets.supported).toBe(true)
      const draftBeforeLifecycle = structuredClone(app.context.automations.getDraft(automation.id))
      for (let round = 1; round <= settings.lifecycleRounds; round++) {
        await open(); await home()
        lifecycle.push({ ...await probe.snapshot(`neutral after round ${round}`), host: hostSnapshot(app.context) })
      }
      for (const sample of lifecycle.slice(1)) {
        expect(sample.activeSubscriptions).toBe(lifecycle[0]!.activeSubscriptions)
        expect(sample.subscriptions).toEqual(lifecycle[0]!.subscriptions)
        expect(sample.pendingSubscriptions).toBe(0)
        expect(sample.closingSubscriptions).toBe(0)
        expect(sample.openSockets).toBe(lifecycle[0]!.openSockets)
        expect(sample.host).toEqual(lifecycle[0]!.host)
      }
      expect(app.context.automations.getDraft(automation.id)).toEqual(draftBeforeLifecycle)
      expect(app.context.automations.getRevision(published.id)?.source).toEqual(fixture.source)
      probe.assertHealthy()
      await writeResult(testInfo, `automation-${nodeCount}`, { fixture: fixture.metadata,
        fixtureSha256: createHash('sha256').update(JSON.stringify(fixture.source)).digest('hex'), chromiumVersion: browser.version(),
        pressureProbe: nodeCount === 1000, firstInteractive: summarize(cold), coldSnapshots, initial, lifecycle,
        saves: { selectionSaves, fieldSaves, expectedFieldSaves: settings.samples + 1, locationSaves, expectedLocationSaves: 2 * (settings.samples + 1) },
        ...await probe.summary() })
    } catch (error) {
      await writeResult(testInfo, `automation-${nodeCount}`, {
        outcome: 'failed', failedStage: stage, failureKind: error instanceof Error ? error.name : 'unknown',
        fixture: fixture.metadata, chromiumVersion: browser.version(), pressureProbe: nodeCount === 1000,
        firstInteractive: summarize(cold), coldSnapshots, partial: await probe.summary(),
      })
      throw error
    } finally { await context.close() }
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }) }
})
