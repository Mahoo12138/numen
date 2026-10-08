import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Plugin } from 'cordis'
import Loader, { Group } from '@cordisjs/plugin-loader'
import { CapabilityRegistry } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { HostConfigError, readManagedConfig, type HostConfigApplyRequest, type HostConfigOperation } from '@numenjs/config'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostConfigurationService, toCordisEntry } from '../src/config-management.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const directories: string[] = [], contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(chmod).mockImplementation(actualFs.chmod)
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const builtins = new Set(['probe'])
async function fixture(plugins: Record<string, unknown> = { 'probe:a': {}, 'probe:b': {} }, plugin?: Plugin) {
  const directory = await mkdtemp(join(tmpdir(), 'numen-preview-guard-')); directories.push(directory)
  const filename = join(directory, 'config.yml')
  await writeFile(filename, JSON.stringify({ version: 2, dataDir: '.data', plugins }))
  const owners = new Map<string, Context>()
  const defaultPlugin: Plugin = { Config: z.object({ title: z.string() }), apply(owner) { owners.set(owner.fiber.entry!.id, owner) } }
  const start = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { group: Group, probe: plugin ?? defaultPlugin })
    const doc = await readManagedConfig(filename, builtins)
    await ctx.plugin(HostConfigurationService, { filename, builtins, safeMode: false, fingerprint: doc.fingerprint })
    await ctx.loader.root.update(doc.entries.map(toCordisEntry)); await ctx.loader.await()
    return ctx
  }
  return { ctx: await start(), filename, owners, start }
}
async function preview(ctx: Context, operation: HostConfigOperation): Promise<HostConfigApplyRequest> {
  const input = { fingerprint: (await ctx.hostConfig.read()).fingerprint, operation }
  const result = await ctx.hostConfig.preview(input)
  expect(result.blockedReason).toBeUndefined()
  expect(result.previewToken).toMatch(/^[a-f0-9]{64}$/)
  return { ...input, previewToken: result.previewToken! }
}
async function database(ctx: Context, path = ':memory:') {
  await ctx.plugin(DatabaseService, { path })
  for (const name of ['connections', 'automations', 'scheduler']) ctx.provide(name, {})
  return ctx.database.db
}
const definition = { id: 'guard:call', version: 1, kind: 'action' as const, title: 'Guard call', input: z.object({}), output: z.object({}), semantics: { sideEffect: true, idempotent: false, retrySafe: false } }
async function registered(ctx: Context, declaration: Context, implementation = declaration) {
  await ctx.plugin(CapabilityRegistry)
  const define = () => ctx.capabilities.define(declaration, definition)
  const provide = () => ctx.capabilities.provide(implementation, definition, { async invoke() { return {} } })
  return { releaseDefinition: define(), releaseProvider: provide(), define, provide }
}
type DB = Context['database']['db']
function connection(db: DB, id: string, adapter = 'guard:adapter') {
  db.prepare(`INSERT INTO connections(id,name,adapter_id,adapter_version,type_id,type_version,config_json,enabled,created_at,updated_at)
    VALUES (?, 'secret-name', ?, 1, 'guard:type', 1, '{"private":"same-value"}', 1, 'now', 'now')`).run(id, adapter)
}
function revision(db: DB, id: string, capability = definition.id) {
  db.prepare(`INSERT INTO automations(id,name,enabled,active_revision_id,created_at,updated_at) VALUES (?, 'secret-name', 1, ?, 'now', 'now')`).run(`auto_${id}`, id)
  db.prepare(`INSERT INTO automation_revisions(id,automation_id,number,purpose,protocol_version,source_json,presentation_json,ir_version,compiled_plan_json,dependency_manifest_json,contract_snapshot_json,content_hash,created_at)
    VALUES (?, ?, 1, 'published', 1, '{}', '{}', 1, ?, ?, ?, 'hash', 'now')`).run(id, `auto_${id}`,
      JSON.stringify({ irVersion: 1, instructions: { call: { id: 'call', op: 'invoke', capability: { id: capability, version: 1 } } } }),
      JSON.stringify({ capabilities: [{ id: capability, version: 1, kind: 'action' }] }),
      JSON.stringify({ capabilities: [{ id: capability, version: 1, kind: 'action', semantics: { sideEffect: true } }] }))
}
function run(db: DB, id: string, revisionId: string) {
  db.prepare(`INSERT INTO runs(id,automation_id,revision_id,status,trigger_json,input_json,created_at) VALUES (?, ?, ?, 'QUEUED', '{}', '{}', 'now')`).run(id, `auto_${revisionId}`, revisionId)
}
const disable = { kind: 'setEnabled', id: 'probe-a', enabled: false } as const

describe('Host preview freshness and write guard', () => {
  it('rejects missing, forged, operation-mismatched and restarted proofs without changing disk', async () => {
    const { ctx, filename, start } = await fixture()
    const input = await preview(ctx, disable), original = await readFile(filename, 'utf8')
    await expect(ctx.hostConfig.apply({ ...input, previewToken: '' })).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    await expect(ctx.hostConfig.apply({ ...input, previewToken: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    await expect(ctx.hostConfig.apply({ ...input, operation: { ...disable, id: 'probe-b' } })).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    const noOp = { ...input, operation: { ...disable, enabled: true }, previewToken: '' }
    await expect(ctx.hostConfig.apply(noOp)).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' })
    await ctx.fiber.dispose()
    const restarted = await start()
    await expect(restarted.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(await readFile(filename, 'utf8')).toBe(original)
    expect((await restarted.hostConfig.apply(await preview(restarted, disable))).saved).toBe(true)
  })

  it('binds the full config and destination while canonicalizing object property order', async () => {
    const { ctx } = await fixture({ 'probe:a': { title: 'old' }, 'group:x': { plugins: {} }, 'group:y': { plugins: {} } })
    const move = await preview(ctx, { kind: 'move', id: 'probe-a', parentId: 'group-x' })
    await expect(ctx.hostConfig.apply({ ...move, operation: { ...move.operation, parentId: 'group-y' } as HostConfigOperation })).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    const operation: HostConfigOperation = { kind: 'setConfig', id: 'probe-a', config: { title: 'new', future: { beta: 2, alpha: 1 } } }
    const config = await preview(ctx, operation)
    await expect(ctx.hostConfig.apply({ ...config, operation: { ...operation, config: { title: 'changed', future: { beta: 2, alpha: 1 } } } })).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect((await ctx.hostConfig.apply({ ...config, operation: { config: { future: { alpha: 1, beta: 2 }, title: 'new' }, id: 'probe-a', kind: 'setConfig' } })).saved).toBe(true)
  })

  it('detects same-millisecond Provider replacement for the paired Definition and affected group', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'))
    const { ctx, owners, filename } = await fixture({ 'group:source': { plugins: { 'probe:a': {}, 'probe:b': {} } } })
    const registration = await registered(ctx, owners.get('probe-a')!, owners.get('probe-b')!)
    const inputs = [await preview(ctx, disable), await preview(ctx, { kind: 'setEnabled', id: 'group-source', enabled: false })]
    const original = await readFile(filename, 'utf8')
    registration.releaseProvider(); registration.provide()
    for (const input of inputs) await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(await readFile(filename, 'utf8')).toBe(original)
    expect((await ctx.hostConfig.apply(await preview(ctx, disable))).saved).toBe(true)
  })

  it('ignores unrelated registrations and complete-source objects, but rejects related Connection edits', async () => {
    const { ctx, owners, filename } = await fixture()
    const owner = owners.get('probe-a')!
    owner.emit('numen/registration-change', { kind: 'connection-adapter', id: 'guard:adapter', version: 1, role: 'provider', owner, token: Symbol() }, true)
    const db = await database(ctx)
    connection(db, 'related'); connection(db, 'other', 'other:adapter')
    const input = await preview(ctx, disable), original = await readFile(filename, 'utf8')
    const otherOwner = owners.get('probe-b')!
    otherOwner.emit('numen/registration-change', { kind: 'capability', id: 'other:capability', version: 1, role: 'provider', owner: otherOwner, token: Symbol() }, true)
    connection(db, 'another', 'other:adapter')
    db.prepare('UPDATE connections SET generation = generation + 1 WHERE id = ?').run('other')
    const stillCurrent = await ctx.hostConfig.preview(input)
    expect(stillCurrent.previewToken).toBe(input.previewToken)
    db.prepare('UPDATE connections SET generation = generation + 1 WHERE id = ?').run('related')
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    const refreshed = await preview(ctx, disable)
    db.prepare(`UPDATE connections SET config_json = '{"private":"new-secret-value"}' WHERE id = 'related'`).run()
    await expect(ctx.hostConfig.apply(refreshed)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(JSON.stringify(await ctx.hostConfig.preview(input))).not.toContain('new-secret-value')
    expect(await readFile(filename, 'utf8')).toBe(original)
    expect((await ctx.hostConfig.apply(await preview(ctx, disable))).saved).toBe(true)
  })

  it('detects related active revision, new Run, execution and attempt transitions but ignores unrelated Runs', async () => {
    const { ctx, owners } = await fixture()
    await registered(ctx, owners.get('probe-a')!)
    const db = await database(ctx)
    revision(db, 'related'); revision(db, 'other', 'other:call')
    const beforeRun = await preview(ctx, disable)
    run(db, 'unrelated_run', 'other')
    expect((await ctx.hostConfig.preview(beforeRun)).previewToken).toBe(beforeRun.previewToken)
    run(db, 'related_run', 'related')
    await expect(ctx.hostConfig.apply(beforeRun)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    let current = await preview(ctx, disable)
    db.prepare(`INSERT INTO executions(id,run_id,instruction_id,status,created_at,updated_at) VALUES ('exec', 'related_run', 'call', 'RUNNABLE', 'now', 'now')`).run()
    await expect(ctx.hostConfig.apply(current)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    current = await preview(ctx, disable)
    db.prepare(`INSERT INTO attempts(id,execution_id,number,status,provider_ref,started_at) VALUES ('attempt', 'exec', 1, 'OUTCOME_UNKNOWN', 'private-provider', 'now')`).run()
    await expect(ctx.hostConfig.apply(current)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    current = await preview(ctx, disable)
    db.prepare(`UPDATE automations SET active_revision_id = NULL, activation_generation = activation_generation + 1 WHERE id = 'auto_related'`).run()
    await expect(ctx.hostConfig.apply(current)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect((await ctx.hostConfig.apply(await preview(ctx, disable))).saved).toBe(true)
    expect(db.prepare('SELECT status FROM attempts WHERE id = ?').get('attempt')).toEqual({ status: 'OUTCOME_UNKNOWN' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 1 })
  })

  it('conservatively invalidates omitted-source changes, without reading business data for metadata edits', async () => {
    const { ctx } = await fixture()
    const db = await database(ctx)
    for (let index = 0; index < 129; index++) connection(db, `conn_${index}`, 'other:adapter')
    const input = await preview(ctx, disable)
    db.prepare('UPDATE connections SET generation = generation + 1 WHERE id = ?').run('conn_128')
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    const prepare = vi.spyOn(db, 'prepare')
    const metadata = await preview(ctx, { kind: 'setLabel', id: 'probe-a', label: 'Renamed' })
    expect(prepare).not.toHaveBeenCalled()
    db.prepare(`UPDATE connections SET generation = generation + 1`).run()
    prepare.mockClear()
    expect((await ctx.hostConfig.apply(metadata)).saved).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('invalidates omitted-source writes from another database connection', async () => {
    const { ctx, filename } = await fixture()
    const path = `${filename}.sqlite`
    const db = await database(ctx, path)
    for (let index = 0; index < 129; index++) connection(db, `conn_${index}`, 'other:adapter')
    const input = await preview(ctx, disable)
    const external = new Context(); contexts.push(external)
    await external.plugin(DatabaseService, { path })
    external.database.db.prepare('UPDATE connections SET generation = generation + 1 WHERE id = ?').run('conn_128')
    await external.fiber.dispose()
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect((await ctx.hostConfig.apply(await preview(ctx, disable))).saved).toBe(true)
  })

  it('treats an initializing database getter as unavailable evidence and detects its later availability', async () => {
    const { ctx } = await fixture()
    const unavailable = ctx.provide('database', { get db() { throw new Error('private-initialization-error') } })
    const input = await preview(ctx, disable)
    const result = await ctx.hostConfig.preview(input)
    expect(result.impact.coverage.find(item => item.source === 'connections')?.status).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('private-initialization-error')
    unavailable()
    await database(ctx)
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
  })

  it('clones queued input and rejects stale replay after the first commit', async () => {
    const { ctx } = await fixture()
    const input = await preview(ctx, { kind: 'setLabel', id: 'probe-a', label: 'Reviewed' })
    const replay = structuredClone(input)
    const result = ctx.hostConfig.apply(input)
    ;(input.operation as { label: string }).label = 'Unreviewed mutation'
    expect((await result).saved).toBe(true)
    expect((await ctx.hostConfig.read()).entries.find(entry => entry.id === 'probe-a')?.label).toBe('Reviewed')
    await expect(ctx.hostConfig.apply(replay)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  })

  it('does not expose a post-commit observer error as a pre-save Host rejection', async () => {
    const { ctx, filename } = await fixture()
    const input = await preview(ctx, { kind: 'setLabel', id: 'probe-a', label: 'Already saved' })
    const removeObserver = ctx.on('numen/host-config-change', () => { throw new HostConfigError('PRIVATE_PLUGIN_ERROR', 'private-observer-message') })
    let rejected: unknown
    try { await ctx.hostConfig.apply(input) } catch (error) { rejected = error }
    removeObserver()
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).not.toBeInstanceOf(HostConfigError)
    expect((rejected as Error).message).toContain('Configuration was saved')
    expect((rejected as Error).message).not.toContain('private-observer-message')
    expect((await readManagedConfig(filename, builtins)).config.plugins['probe:a'].$label).toBe('Already saved')
    expect((await ctx.hostConfig.read()).fingerprint).not.toBe(input.fingerprint)
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  })

  it('rechecks Provider observations after asynchronous temporary-file preparation', async () => {
    const { ctx, owners, filename } = await fixture()
    const registration = await registered(ctx, owners.get('probe-a')!)
    const input = await preview(ctx, disable), original = await readFile(filename, 'utf8')
    vi.mocked(chmod).mockImplementationOnce(async (path, mode) => {
      await actualFs.chmod(path, mode)
      registration.releaseProvider(); registration.provide()
    })
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(await readFile(filename, 'utf8')).toBe(original)
    expect((await ctx.hostConfig.read()).entries.find(entry => entry.id === 'probe-a')?.selfEnabled).toBe(true)
  })

  it.each(['plain', 'service'] as const)('protects the actual alternative %s service provider and ancestors while allowing metadata', async form => {
    class AlternativeConsole extends Service { constructor(ctx: Context) { super(ctx, 'consoleSession'); } }
    const { ctx } = await fixture({ 'group:management': { plugins: { 'probe:a': {} } }, 'group:off': { $if: false, plugins: {} } }, {
      Config: z.object({}), async apply(owner) { if (form === 'plain') owner.provide('consoleSession', {}); else await owner.plugin(AlternativeConsole) },
    })
    const current = await ctx.hostConfig.read()
    expect(current.entries.find(entry => entry.id === 'probe-a')?.protected).toBe(true)
    expect(current.entries.find(entry => entry.id === 'group-management')?.protected).toBe(true)
    for (const operation of [disable, { kind: 'move', id: 'probe-a', parentId: 'group-off' }, { kind: 'setConfig', id: 'probe-a', config: {} }, { kind: 'setEnabled', id: 'group-management', enabled: false }] as HostConfigOperation[]) {
      const input = { fingerprint: current.fingerprint, operation }
      expect(await ctx.hostConfig.preview(input)).toMatchObject({ blockedReason: expect.stringContaining('management channel') })
      expect((await ctx.hostConfig.preview(input)).previewToken).toBeUndefined()
      await expect(ctx.hostConfig.apply({ ...input, previewToken: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'MANAGEMENT_CHANNEL_PROTECTED' })
    }
    expect((await ctx.hostConfig.apply(await preview(ctx, { kind: 'setLabel', id: 'probe-a', label: 'Session provider' }))).saved).toBe(true)
    expect((await ctx.hostConfig.apply(await preview(ctx, { kind: 'setCollapsed', id: 'group-management', collapsed: true }))).saved).toBe(true)
  })

  it('rechecks newly assumed management ownership immediately before file replacement', async () => {
    const { ctx, owners, filename } = await fixture()
    const input = await preview(ctx, disable), original = await readFile(filename, 'utf8')
    vi.mocked(chmod).mockImplementationOnce(async (path, mode) => {
      await actualFs.chmod(path, mode)
      owners.get('probe-a')!.provide('consoleAuth', {})
    })
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'MANAGEMENT_CHANNEL_PROTECTED' })
    expect(await readFile(filename, 'utf8')).toBe(original)
  })
})
