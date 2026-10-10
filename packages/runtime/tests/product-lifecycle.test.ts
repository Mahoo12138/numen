import type { Context, EffectMeta } from 'cordis'
import { ConsoleService } from '@numenjs/console'
import { workbenchRuntimePlugin } from '@numenjs/workbench/runtime'
import { writeConfig, type PluginConfig } from '@numenjs/config'
import z from 'schemastery'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRuntime, type NumenApplication } from '../src/index.js'

const apps: NumenApplication[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.stop()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function start(plugins: Record<string, PluginConfig | null>, safeMode = false) {
  const directory = await mkdtemp(join(tmpdir(), 'numen-products-'))
  directories.push(directory)
  await writeFile(join(directory, 'index.html'), '<main>Workbench fixture</main>')
  await writeFile(join(directory, 'core-entry.js'), 'export default function() {}')
  const configPath = join(directory, 'numen.config.yml')
  await writeConfig(configPath, {
    version: 2, dataDir: 'data', logger: { console: false },
    plugins: {
      server: { host: '127.0.0.1', port: 0 },
      ...plugins,
      ...(plugins.workbench ? { workbench: { root: directory, entrySource: join(directory, 'core-entry.js'), ...plugins.workbench } } : {}),
    },
  })
  const app = await startRuntime({ configPath, safeMode })
  apps.push(app)
  return app
}

async function enabled(ctx: Context, id: string, value: boolean) {
  await ctx.loader.update(id, { disabled: !value })
  await ctx.loader.await()
}

function resources(ctx: Context) {
  const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
  const effects = (items: EffectMeta[]): number => items.reduce((n, item) => n + 1 + effects(item.children), 0)
  return {
    http: [...ctx.server.httpRoutes].length,
    websocket: [...ctx.server.wsRoutes].length,
    fibers: fibers.length,
    effects: fibers.reduce((n, fiber) => n + effects(fiber.getEffects()), 0),
    entries: ctx.consoleEntries?.list().map(entry => entry.id).sort() ?? [],
    procedures: ctx.console?.list().map(item => `${item.definition.id}:${item.providerAvailable}`).sort() ?? [],
  }
}

async function session(app: NumenApplication) {
  return fetch(`${app.serverUrl}/api/console/session`, {
    method: 'POST', headers: { authorization: 'Bearer product-fixture-token' },
  })
}

describe('independent Console and Workbench product entries', () => {
  it('starts Console alone without creating Workbench and fails closed without credentials', async () => {
    const app = await start({ console: { auth: { token: 'product-fixture-token' } } })
    expect(app.context.workbench).toBeUndefined()
    expect(app.workbenchUrl).toBeUndefined()
    expect(app.context.console.list()).toEqual([expect.objectContaining({
      definition: expect.objectContaining({ id: 'console:entries-changed', version: 1, kind: 'subscription' }),
      providerAvailable: true,
    })])
    expect(app.context.consoleEntries.list()).toEqual([])
    expect((await session(app)).status).toBe(200)
    expect((await fetch(`${app.serverUrl}/api/console/entries`)).status).toBe(401)
    expect((await fetch(`${app.serverUrl}/`)).status).toBe(404)
  })

  it('keeps Workbench intent while Console is missing, without installing a replacement', async () => {
    const app = await start({ workbench: {} })
    expect(app.context.console).toBeUndefined()
    expect(app.context.workbench).toBeUndefined()
    expect(app.context.loader.resolve('workbench').options.disabled).toBe(false)
    expect((await fetch(`${app.serverUrl}/`)).status).toBe(404)
    expect(app.context.loader.resolve('workbench').fiber?.getEffects().length).toBeGreaterThan(0)
  })

  it('returns to cleanup baselines over ten independent stop/start cycles and keeps background work alive', async () => {
    const app = await start({
      database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {},
      credentials: {}, resources: { path: 'data/resources' }, connections: {}, demo: {}, schedule: {},
      automations: {}, scheduler: { autoDispatch: false }, triggers: {},
      console: { auth: { token: 'product-fixture-token' } }, workbench: { $if: false },
    })
    const ctx = app.context
    const externalQuery = { id: 'fixture:independent', version: 1, kind: 'query' as const, title: 'Other plugin', input: z.object({}), output: z.string() }
    function independentEntry(owner: Context) {
      owner.console.define(owner, externalQuery)
      owner.console.provideQuery(owner, externalQuery, { query: () => 'available' })
      owner.consoleEntries.addEntry(owner, { id: 'fixture:other-entry', prod: join(directories.at(-1)!, 'core-entry.js') })
    }
    independentEntry.inject = ['console', 'consoleEntries']
    await ctx.plugin(independentEntry)
    const { automation } = ctx.automations.create({
      name: 'Background survives UI shutdown',
      source: {
        triggers: [{ id: 'cron', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '* * * * *', timezone: 'UTC' } }],
        flow: { type: 'capability', id: 'echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'background' } } },
      },
    })
    const revision = ctx.automations.publishDraft(automation.id, 1)
    ctx.automations.activateRevision(automation.id, revision.id)
    ctx.automations.setEnabled(automation.id, true)
    const backend = Object.fromEntries(['database', 'scheduler', 'triggers'].map(id => [id, ctx.loader.resolve(id).fiber!.uid]))
    const consoleOnly = resources(ctx)
    let allEnabled: ReturnType<typeof resources> | undefined
    const sampleMetadata = () => ctx.console.query({ id: 'numen:output-samples', version: 1 }, { automationId: automation.id }, {
      requestId: 'product-local-test-recovery', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
      signal: new AbortController().signal, logger: ctx.logger('product:local-test-recovery'),
    })

    for (let cycle = 0; cycle < 10; cycle++) {
      await enabled(ctx, 'workbench', true)
      await vi.waitFor(() => expect(ctx.workbench).toBeDefined())
      expect(ctx.console.list().every(item => item.providerAvailable)).toBe(true)
      expect(await sampleMetadata()).toEqual({ items: [] })
      expect(ctx.consoleEntries.list()).toHaveLength(2)
      expect((await fetch(`${app.serverUrl}/`)).status).toBe(200)
      allEnabled ??= resources(ctx)
      expect(resources(ctx)).toEqual(allEnabled)
      const workbenchParent = ctx.loader.resolve('workbench').fiber!
      expect([...ctx.registry.get(workbenchRuntimePlugin)!.fibers][0]!.parent.fiber.uid).toBe(workbenchParent.uid)
      expect([...ctx.registry.get(ConsoleService)!.fibers][0]!.parent.fiber.uid).toBe(ctx.loader.resolve('console').fiber!.uid)
      await enabled(ctx, 'workbench', false)
      await vi.waitFor(() => expect(resources(ctx)).toEqual(consoleOnly))
      expect(ctx.workbench).toBeUndefined()
      expect((await session(app)).status).toBe(200)
      expect((await fetch(`${app.serverUrl}/`)).status).toBe(404)
      expect(ctx.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    }

    await enabled(ctx, 'workbench', true)
    let withoutConsole: ReturnType<typeof resources> | undefined
    for (let cycle = 0; cycle < 10; cycle++) {
      const run = ctx.scheduler.startManual(automation.id)
      await enabled(ctx, 'console', false)
      await vi.waitFor(() => expect(ctx.workbench).toBeUndefined())
      expect(ctx.console).toBeUndefined()
      expect(ctx.loader.resolve('workbench').options.disabled).toBe(false)
      withoutConsole ??= resources(ctx)
      expect(resources(ctx)).toEqual(withoutConsole)
      expect([...ctx.server.httpRoutes]).toHaveLength(0)
      expect([...ctx.server.wsRoutes]).toHaveLength(0)
      expect(ctx.loader.resolve('database').fiber!.uid).toBe(backend.database)
      expect(ctx.loader.resolve('scheduler').fiber!.uid).toBe(backend.scheduler)
      expect(ctx.loader.resolve('triggers').fiber!.uid).toBe(backend.triggers)
      expect(ctx.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
      await ctx.scheduler.dispatchUntilIdle()
      expect(ctx.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
      await enabled(ctx, 'console', true)
      await vi.waitFor(() => expect(resources(ctx)).toEqual(allEnabled))
      expect(await sampleMetadata()).toEqual({ items: [] })
      expect((await session(app)).status).toBe(200)
    }
    await enabled(ctx, 'workbench', false)
    await enabled(ctx, 'console', false)
    await enabled(ctx, 'console', true)
    await vi.waitFor(() => expect(resources(ctx)).toEqual(consoleOnly))
    expect(ctx.workbench).toBeUndefined()
    expect(ctx.loader.resolve('workbench').options.disabled).toBe(true)
  })
})


describe('v2 group configuration through the real Host', () => {
  it.each([false, true])('preserves nested member intent and enforces safe mode (%s)', async safeMode => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-group-fixtures-'))
    directories.push(directory)
    const modulePath = join(directory, 'plugin.mjs')
    await writeFile(modulePath, `
      export default function fixture(ctx, config) {
        ctx.server.get(config.path, async (_request, response) => response.text(config.value));
      }
      fixture.inject = ['server'];
    `)
    const source = pathToFileURL(modulePath).href
    const app = await start({
      'group:telegram': {
        $label: 'Local Telegram fixtures', plugins: {
          'integration:personal': { $package: source, path: '/fixture/integration', value: 'integration' },
          'group:messages': { plugins: {
            'notifications:personal': { $package: source, path: '/fixture/notification', value: 'notification' },
            '~rules:personal': { $package: source, path: '/fixture/rules', value: 'rules' },
          } },
        },
      },
      'group:other': { plugins: {} },
    }, safeMode)
    const request = (path: string) => fetch(`${app.serverUrl}/fixture/${path}`)
    expect((await request('integration')).status).toBe(safeMode ? 404 : 200)
    expect((await request('notification')).status).toBe(safeMode ? 404 : 200)
    expect((await request('rules')).status).toBe(404)
    await enabled(app.context, 'group-telegram', false)
    expect((await request('integration')).status).toBe(404)
    await enabled(app.context, 'group-telegram', true)
    expect((await request('notification')).status).toBe(safeMode ? 404 : 200)
    expect((await request('rules')).status).toBe(404)
    expect(app.context.loader.resolve('rules-personal').options.disabled).toBe(true)
    await app.context.loader.update('notifications-personal', {}, 'group-other')
    await app.context.loader.await()
    expect(app.context.loader.resolve('notifications-personal').id).toBe('notifications-personal')
    expect(app.context.loader.resolve('notifications-personal').options.config).toEqual({ path: '/fixture/notification', value: 'notification' })
    await enabled(app.context, 'group-telegram', false)
    expect((await request('notification')).status).toBe(safeMode ? 404 : 200)
    expect((await request('integration')).status).toBe(404)
    expect([...app.context.server.httpRoutes]).toHaveLength(safeMode ? 0 : 1)
  })
})
