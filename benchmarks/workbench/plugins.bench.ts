import { expect, test, type Locator, type Page } from '@playwright/test'
import { createProbe, hostSnapshot, settings, summarize, writeResult } from './metrics.js'
import { createPluginBenchmarkRuntime, type PluginBenchmarkRuntime } from './plugins-runtime.js'

// Browser plugin not available. Opt-in production Chromium benchmark; no build
// or performance threshold is hidden in this suite. Run it serially via the
// benchmark config after the shared production build has been completed.
const previewProcedure = 'numen:plugin-preview@1'
const applyProcedure = 'numen:plugin-apply@1'
const savedMessage = 'Configuration saved; runtime application completed.'
const rowSelector = (id: string) => `.plugin-row[data-entry-id="${id}"]`
const row = (page: Page, id: string) => page.locator(rowSelector(id))
const editor = (page: Page) => page.locator('.plugin-editor')
const configJson = (page: Page) => editor(page).getByLabel('Plugin configuration (JSON)', { exact: true })

function launchUrl(runtime: PluginBenchmarkRuntime, targetId?: string) {
  const url = new URL(runtime.application.workbenchUrl!)
  url.pathname = '/plugins/installed'
  if (targetId) url.searchParams.set('entryId', targetId)
  return url.href // The bootstrap fragment is used only for navigation, never reported.
}
async function ready(page: Page, runtime: PluginBenchmarkRuntime) {
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/plugins\/installed(?:\?|#|$)/)
  await expect(page.locator('.plugin-row')).toHaveCount(runtime.fixture.metadata.entryCount)
  await expect(row(page, runtime.fixture.metadata.targets.entryId).getByRole('button', { name: 'Edit instance', exact: true })).toBeEnabled()
}
async function openEditor(page: Page, targetId: string) {
  await row(page, targetId).getByRole('button', { name: 'Edit instance', exact: true }).click()
  await expect(editor(page).getByLabel('Operation', { exact: true })).toHaveValue('setConfig')
  const field = editor(page).getByRole('textbox', { name: 'label', exact: true })
  await expect(field).toBeVisible()
  return field
}
async function fieldSelector(field: Locator) {
  const id = await field.getAttribute('id')
  expect(id).toBeTruthy()
  // Generated Schema field IDs are safely addressable without assuming a session counter.
  return `[id=${JSON.stringify(id)}]`
}
async function chooseDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  let shown = false
  page.once('dialog', async dialog => {
    shown = true; expect(dialog.type()).toBe('confirm')
    if (accept) await dialog.accept(); else await dialog.dismiss()
  })
  await action()
  expect(shown, 'Navigation must explicitly protect the existing input.').toBe(true)
}
function recordPersistence(page: Page) {
  const requests = { previews: 0, applies: 0 }
  page.on('request', request => {
    if (!request.url().endsWith('/api/console/call') || request.method() !== 'POST') return
    const procedure = request.postDataJSON()?.procedure
    if (procedure === previewProcedure) requests.previews++
    if (procedure === applyProcedure) requests.applies++
  })
  return requests
}

for (const entryCount of [100, 300] as const) test(`plugins ${entryCount} entries production capacity baseline`, async ({ browser, page }, testInfo) => {
  let runtime: PluginBenchmarkRuntime | undefined
  let activeProbe: Awaited<ReturnType<typeof createProbe>> | undefined
  let failedStage = 'runtime-setup'
  const completed: Record<string, unknown> = { entryCount }
  try {
    runtime = await createPluginBenchmarkRuntime(entryCount)
    // The alias stays nonoptional inside callbacks while cleanup owns runtime.
    const activeRuntime = runtime
    completed.fixture = runtime.fixture.metadata
    const { targets } = runtime.fixture.metadata
    const coldTrials: Array<{ elapsedMs: number; summary: Awaited<ReturnType<Awaited<ReturnType<typeof createProbe>>['summary']>>; snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof createProbe>>['snapshot']>> }> = []
    completed.coldTrials = coldTrials
    for (let trial = 0; trial < settings.coldTrials; trial++) {
      failedStage = `cold-navigation-${trial}`
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
      try {
        const coldPage = await context.newPage(), coldProbe = await createProbe(coldPage)
        const elapsedMs = await coldProbe.navigate(launchUrl(runtime), { selector: `${rowSelector(targets.entryId)} .plugin-entry-name:not(:disabled)` })
        await ready(coldPage, runtime)
        await row(coldPage, runtime.fixture.metadata.targets.entryId).locator('.plugin-entry-name').click()
        await expect(coldPage.locator('.plugin-instance-facts dd code')).toHaveText(runtime.fixture.metadata.targets.entryId)
        coldProbe.assertHealthy()
        coldTrials.push({ elapsedMs, summary: await coldProbe.summary(), snapshot: await coldProbe.snapshot(`cold-expanded-tree-${trial}`) })
      } finally { await context.close() }
    }

    failedStage = 'main-navigation'
    const probe = activeProbe = await createProbe(page), requests = recordPersistence(page)
    completed.requests = requests
    await probe.navigate(launchUrl(runtime), { selector: `${rowSelector(targets.entryId)} .plugin-entry-name:not(:disabled)` })
    await ready(page, runtime)
    const initialYaml = await runtime.readYaml(), originalConfig = await runtime.readTargetConfig()
    const initialRuntime = runtime.observations()
    const initial = await probe.snapshot('expanded plugin tree')
    completed.initial = initial

    for (const [name, ids] of [['instanceSelection', runtime.targets.instanceIds], ['groupSelection', runtime.targets.groupIds]] as const) {
      for (let sample = -1; sample < settings.samples; sample++) {
        failedStage = `${name}-${sample < 0 ? 'warmup' : sample}`
        const targetId = ids[(sample + 1) % ids.length]!
        const button = row(page, targetId).locator('.plugin-entry-name')
        await button.scrollIntoViewIfNeeded()
        await probe.measure(sample < 0 ? `${name}-warmup` : name, {
          event: 'pointerdown', target: `${rowSelector(targetId)} .plugin-entry-name`,
          ready: { selector: '.plugin-instance-facts dd code', text: targetId },
        }, () => button.click())
        await expect(row(page, targetId)).toHaveAttribute('data-selected', 'true')
        await expect(page.locator('.plugin-instance-facts dd code')).toHaveText(targetId)
      }
    }

    const field = await openEditor(page, targets.entryId), inputSelector = await fieldSelector(field)
    const canonicalJsonSelector = '.plugin-configuration > label textarea'
    await expect(page.locator(canonicalJsonSelector)).toHaveCount(1)
    await expect(page.locator(canonicalJsonSelector)).toHaveValue(await configJson(page).inputValue())
    for (let sample = -1; sample < settings.samples; sample++) {
      failedStage = `local-field-commit-${sample < 0 ? 'warmup' : sample}`
      const label = sample < 0 ? 'local-field-warmup' : `local-field-${sample}`
      const localConfig = JSON.parse(await configJson(page).inputValue()) as Record<string, unknown>
      await field.fill(label)
      await expect(field).toBeFocused()
      await probe.measure(sample < 0 ? 'localFieldCommit-warmup' : 'localFieldCommit', {
        event: 'blur', target: inputSelector,
        ready: { selector: canonicalJsonSelector, property: 'value', value: JSON.stringify({ ...localConfig, label }, null, 2) },
      }, () => field.press('Tab'))
      expect(JSON.parse(await configJson(page).inputValue())).toEqual({ ...localConfig, label })
    }
    expect(await runtime.readYaml()).toBe(initialYaml)
    expect(requests).toEqual({ previews: 0, applies: 0 })
    failedStage = 'input-protection'
    const finalLocalLabel = `local-field-${settings.samples - 1}`
    await chooseDiscard(page, false, () => row(page, activeRuntime.targets.instanceIds[1]!).locator('.plugin-entry-name').click())
    await expect(field).toHaveValue(finalLocalLabel)
    await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
    await expect(field).toHaveValue(finalLocalLabel)
    await editor(page).getByRole('button', { name: 'Advanced JSON', exact: true }).click()
    const invalidJson = '{"unfinished":'
    await configJson(page).fill(invalidJson)
    await editor(page).getByRole('button', { name: 'Form', exact: true }).click()
    await expect(configJson(page)).toBeVisible()
    await expect(configJson(page)).toHaveValue(invalidJson)
    await editor(page).getByRole('button', { name: 'Preview change', exact: true }).click()
    await expect(page.getByText('Enter a valid JSON object.', { exact: true })).toBeVisible()
    await chooseDiscard(page, false, () => page.getByRole('button', { name: 'Home', exact: true }).click())
    await expect(configJson(page)).toHaveValue(invalidJson)
    expect(await runtime.readYaml()).toBe(initialYaml)
    expect(requests).toEqual({ previews: 0, applies: 0 })
    await chooseDiscard(page, true, () => editor(page).getByRole('button', { name: 'Cancel', exact: true }).click())
    await expect(editor(page)).toHaveCount(0)

    let yamlVerifiedWrites = 0, successfulApplyResponses = 0
    const applyEvidence: Array<{ sample: number; label: string; runtimeApplied: boolean; yamlChanged: boolean }> = []
    completed.applyEvidence = applyEvidence
    for (let sample = -1; sample < settings.samples; sample++) {
      failedStage = `preview-${sample < 0 ? 'warmup' : sample}`
      const field = await openEditor(page, targets.entryId)
      const label = sample < 0 ? 'persisted-warmup' : `persisted-${sample}`
      const expectedConfig = { ...originalConfig, label }, beforeYaml = await runtime.readYaml()
      await field.fill(label); await field.press('Tab')
      const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === previewProcedure)
      await editor(page).getByRole('button', { name: 'Preview change', exact: true }).click()
      const preview = await (await previewResponse).json()
      expect(preview.result.operation).toEqual({ kind: 'setConfig', id: targets.entryId, config: expectedConfig })
      expect(preview.result.blockedReason).toBeUndefined()
      expect(preview.result.previewToken).toEqual(expect.any(String))
      expect(await runtime.readYaml()).toBe(beforeYaml)
      const apply = page.locator('.plugin-preview').getByRole('button', { name: 'Save and apply this change', exact: true })
      await expect(apply).toBeEnabled()
      await apply.scrollIntoViewIfNeeded()
      // A previous successful Apply must never satisfy this sample's readiness.
      await expect(page.getByText(savedMessage, { exact: true })).toHaveCount(0)
      const applyResponse = page.waitForResponse(response => response.url().endsWith('/api/console/call') && response.request().postDataJSON()?.procedure === applyProcedure)
      failedStage = `apply-${sample < 0 ? 'warmup' : sample}`
      await probe.measure(sample < 0 ? 'applyToRendered-warmup' : 'applyToRendered', {
        event: 'pointerdown', target: '.plugin-preview > .plugin-actions > button:first-child',
        ready: { selector: '.plugins-page > [role="status"]', text: savedMessage },
      }, () => apply.click())
      const response = await (await applyResponse).json()
      expect(response.result.saved).toBe(true)
      expect(response.result.runtimeApplied).toBe(true)
      successfulApplyResponses++
      failedStage = `yaml-verification-${sample < 0 ? 'warmup' : sample}`
      expect(await runtime.readTargetConfig()).toEqual(expectedConfig)
      expect(await runtime.readYaml()).not.toBe(beforeYaml)
      yamlVerifiedWrites++
      applyEvidence.push({ sample, label, runtimeApplied: response.result.runtimeApplied, yamlChanged: true })
      await ready(page, runtime)
    }
    expect(requests).toEqual({ previews: settings.samples + 1, applies: settings.samples + 1 })
    expect(yamlVerifiedWrites).toBe(settings.samples + 1)

    // Compare a neutral route, so detached plugin trees cannot hide behind the
    // intentional live DOM of the current Plugins page.
    const home = async () => {
      await page.getByRole('button', { name: 'Home', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
      await expect(page.locator('.home-overview')).toBeVisible()
    }
    const open = async () => {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await ready(page, activeRuntime)
    }
    await page.screenshot({ path: testInfo.outputPath('plugins-capacity.png'), fullPage: false })
    failedStage = 'lifecycle-warmup'
    await home(); await open(); await home()
    const lifecycle = [{ ...await probe.snapshot('warm neutral baseline'), host: hostSnapshot(runtime.application.context) }]
    completed.lifecycle = lifecycle
    for (let round = 1; round <= settings.lifecycleRounds; round++) {
      failedStage = `lifecycle-round-${round}`
      await open(); await home()
      lifecycle.push({ ...await probe.snapshot(`neutral after round ${round}`), host: hostSnapshot(runtime.application.context) })
    }
    for (const sample of lifecycle) {
      expect(sample.host.consoleSubscriptions.supported).toBe(true)
      expect(sample.host.consoleSockets.supported).toBe(true)
      expect(sample.pendingSubscriptions).toBe(0)
      expect(sample.closingSubscriptions).toBe(0)
      if (sample.host.consoleSockets.supported) expect(sample.host.consoleSockets.liveSocketTransports).toBe(sample.host.consoleSockets.openSockets)
    }
    for (const sample of lifecycle.slice(1)) {
      expect(sample.activeSubscriptions).toBe(lifecycle[0]!.activeSubscriptions)
      expect(sample.openSockets).toBe(lifecycle[0]!.openSockets)
      expect(sample.subscriptions).toEqual(lifecycle[0]!.subscriptions)
      expect(sample.host).toEqual(lifecycle[0]!.host)
    }
    expect(requests.applies).toBe(settings.samples + 1)
    const mainSummary = await probe.summary()
    completed.mainSummary = mainSummary
    probe.assertHealthy()

    // Plugins has no in-page search/Locate control. This measures its supported
    // entryId deep-link, including full document navigation with cache disabled.
    // It must not be compared with an in-place automation node lookup.
    const locateTrials: Array<{ sample: number; elapsedMs: number; summary: Awaited<ReturnType<typeof probe.summary>> }> = []
    completed.locateTrials = locateTrials
    for (let sample = -1; sample < settings.samples; sample++) {
      failedStage = `deep-link-navigation-${sample < 0 ? 'warmup' : sample}`
      const targetPage = await page.context().newPage()
      try {
        const targetProbe = await createProbe(targetPage)
        let elapsedMs: number
        try {
          elapsedMs = await targetProbe.navigate(launchUrl(runtime, targets.deepEntryId), {
            selector: `${rowSelector(targets.deepEntryId)}:focus[data-selected="true"]`,
          })
        } catch (error) {
          completed.deepLinkFailure = {
            sample,
            dom: await targetPage.evaluate(id => {
              const target = document.querySelector(`[data-entry-id="${id}"]`)
              const rect = target?.getBoundingClientRect()
              return { documentHasFocus: document.hasFocus(), targetExists: !!target,
                targetIsActiveElement: target === document.activeElement, targetMatchesFocus: target?.matches(':focus'),
                selected: target?.getAttribute('data-selected'), activeTag: document.activeElement?.tagName,
                activeEntryId: (document.activeElement as HTMLElement | null)?.dataset.entryId,
                targetTop: rect?.top, targetBottom: rect?.bottom, viewportHeight: innerHeight }
            }, targets.deepEntryId),
            observation: await targetProbe.summary(),
          }
          throw error
        }
        await ready(targetPage, runtime)
        await expect(targetPage.locator('.plugin-instance-facts dd code')).toHaveText(targets.deepEntryId)
        await expect(row(targetPage, targets.deepEntryId)).toBeInViewport()
        targetProbe.assertHealthy()
        locateTrials.push({ sample, elapsedMs, summary: await targetProbe.summary() })
      } finally { await targetPage.close() }
    }
    await expect.poll(() => hostSnapshot(activeRuntime.application.context)).toEqual(lifecycle[0]!.host)
    // Supplemental correctness/visual check after every timing and memory sample.
    // Its resize/layout work is intentionally excluded from mainSummary.
    failedStage = 'mobile-readonly-details'
    await open()
    await row(page, targets.deepEntryId).locator('.plugin-entry-name').click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.plugin-instance-facts').scrollIntoViewIfNeeded()
    await expect(page.locator('.plugin-instance-facts dd code')).toHaveText(targets.deepEntryId)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(editor(page)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('plugins-capacity-mobile.png'), fullPage: false })
    await page.setViewportSize({ width: 1440, height: 960 })
    await home()
    await expect.poll(() => hostSnapshot(activeRuntime.application.context)).toEqual(lifecycle[0]!.host)
    expect(requests.applies).toBe(settings.samples + 1)
    expect(runtime.observations().active).toBe(initialRuntime.active)
    probe.assertHealthy()

    failedStage = 'write-report'
    await writeResult(testInfo, `plugins-${entryCount}`, {
      status: 'passed', kind: 'plugins', fixture: runtime.fixture.metadata, chromiumVersion: browser.version(),
      method: {
        firstInteractive: 'Fresh browser context; cache disabled; document start through editable tree target rendered and two animation frames.',
        fieldCommit: 'Valid form field blur through the local canonical JSON value update and two frames; no Preview, Apply or YAML writes.',
        applyToRendered: 'Actual Preview then Apply; pointerdown through successful saved status and two frames; YAML read/verification happens after timing.',
        locate: 'entryId deep-link full document navigation; new page sharing the main context session; cache disabled; target row focused/in viewport. All groups initially expanded.',
        lifecycle: `${settings.lifecycleRounds} Plugins/Home round trips (${settings.lifecycleRounds * 2} route transitions), after one unmeasured warm-up round trip; compare the same neutral Home view with per-round forced GC snapshots.`,
        subscriptions: 'Console WebSocket frame acknowledgements plus read-only server registry/socket snapshots. Counts must return to the same warm neutral baseline; this is not a complete heap reachability proof.',
        writes: 'Network Apply request count, saved responses and separately verified changed YAML snapshots; filesystem syscall count is not measured.',
      },
      firstInteractive: summarize(coldTrials.map(trial => trial.elapsedMs)), coldTrials,
      ...mainSummary,
      deepLinkLocate: summarize(locateTrials.filter(trial => trial.sample >= 0).map(trial => trial.elapsedMs)), locateTrials,
      initial, lifecycle,
      persistence: { ...requests, successfulApplyResponses, yamlVerifiedWrites, warmupWrites: 1, measuredWrites: settings.samples, applyEvidence },
      fixtureRuntime: { initial: initialRuntime, final: runtime.observations() },
      correctness: { localFormCommitDidNotWrite: true, invalidJsonPreserved: true, cancelledNavigationPreservedInput: true, explicitDiscardRequired: true, allAppliedYamlVerified: true,
        mobileReadOnlyDetails: { width: 390, height: 844, horizontalOverflow: false, additionalApplyRequests: 0 } },
    })
  } catch (error) {
    // Preserve completed measurements for diagnosis; this artifact can never be
    // mistaken for a valid baseline and the original failure still fails the test.
    if (activeProbe && !page.isClosed()) {
      try { completed.lastObservation = await activeProbe.summary() }
      catch (observationError) { completed.observationUnavailable = observationError instanceof Error ? observationError.name : 'UnknownError' }
    }
    const message = error instanceof Error ? error.message : String(error)
    try {
      await writeResult(testInfo, `plugins-${entryCount}-failed-diagnostic`, {
        outcome: 'failed', status: 'failed', diagnosticOnly: true, kind: 'plugins', failedStage, chromiumVersion: browser.version(), completed,
        error: { name: error instanceof Error ? error.name : 'UnknownError', message: message.replace(/numen-bootstrap=[^&\s"'<>]+/g, 'numen-bootstrap=[redacted]').slice(0, 2000) },
      })
    } catch (reportError) { throw new AggregateError([error, reportError], 'Plugin benchmark and diagnostic output both failed.') }
    throw error
  } finally { await runtime?.stop() }
})
