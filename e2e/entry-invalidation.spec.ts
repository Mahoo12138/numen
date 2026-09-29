import { expect, test } from '@playwright/test'
import type { Context } from 'cordis'
import { writeConfig } from '../packages/config/dist/index.js'
import { startRuntime, type NumenApplication } from '../packages/runtime/dist/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: NumenApplication
let directory: string
let source: string

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'numen-entry-invalidation-'))
  source = join(directory, 'live-entry.js')
  await writeFile(source, `
    import { h } from '/workbench/vue.js'
    export default function liveEntry(ctx) {
      ctx.webuiExtensions.page(ctx, { id: 'fixture:live', version: 1, path: '/plugins/live', title: 'Live Entry', component: () => h('h1', 'Live Entry') })
      ctx.effect(() => {
        document.documentElement.dataset.liveEntry = 'loaded'
        return () => { delete document.documentElement.dataset.liveEntry }
      })
    }
  `)
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, http: {}, httpIntegration: {}, demo: {},
    automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: {},
    server: { host: '127.0.0.1', port: 0 }, workbench: {},
  } })
  application = await startRuntime({ configPath })
})
test.afterAll(async () => {
  await application?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})
function liveEntry(owner: Context) { owner.consoleEntries.addEntry(owner, { id: 'fixture:live', prod: source }) }
liveEntry.inject = ['consoleEntries']

test('loads and unloads another Entry online without remounting an invalid local Draft field', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const { automation } = application.context.automations.create({ name: 'Entry update keeps Draft', source: { triggers: [], flow: {
    type: 'block', id: 'flow', steps: [{ type: 'capability', id: 'request', capability: { id: 'http:request', version: 1 }, input: {
      url: { type: 'literal', value: 'http://127.0.0.1:1/fixture' }, headers: { type: 'literal', value: { Accept: 'application/json' } },
    } }],
  } } })
  await page.goto(application.workbenchUrl!)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await page.locator('.automation-row').filter({ hasText: 'Entry update keeps Draft' }).click()
  await page.locator('.automation-step[data-node-id="request"]').click()
  const headers = page.getByLabel('Headers', { exact: true })
  await headers.fill('{ "uncommitted": ')
  await headers.press('Tab')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  const original = structuredClone(application.context.automations.getDraft(automation.id)!.source)
  const documentIdentity = await page.evaluate(() => { const value = crypto.randomUUID(); document.documentElement.dataset.documentIdentity = value; return value })
  const entry = await application.context.plugin(liveEntry)
  await expect(page.locator('html')).toHaveAttribute('data-live-entry', 'loaded')
  await expect(headers).toHaveValue('{ "uncommitted": ')
  await expect(page.locator('.status-bar')).toHaveAttribute('data-input-pending', 'true')
  await entry.dispose()
  await expect(page.locator('html')).not.toHaveAttribute('data-live-entry', 'loaded')
  await expect(headers).toHaveValue('{ "uncommitted": ')
  await expect(headers).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-document-identity', documentIdentity)
  expect(application.context.automations.getDraft(automation.id)!.source).toEqual(original)
  expect(errors).toEqual([])
})

test('withdraws and restores Workbench online through Console while an independent Entry remains mounted', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const entry = await application.context.plugin(liveEntry)
  try {
    await page.goto(application.workbenchUrl!)
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-live-entry', 'loaded')
    await application.context.loader.update('workbench', { disabled: true })
    await application.context.loader.await()
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-live-entry', 'loaded')
    const manifest = await page.evaluate(async () => (await fetch('/api/console/entries', { credentials: 'include' })).json())
    expect(manifest.entries.map((item: { id: string }) => item.id)).toEqual(['fixture:live'])
    await application.context.loader.update('workbench', { disabled: false })
    await application.context.loader.await()
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-live-entry', 'loaded')
    expect(errors).toEqual([])
  } finally {
    await application.context.loader.update('workbench', { disabled: false })
    await application.context.loader.await()
    await entry.dispose()
  }
})
