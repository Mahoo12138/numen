import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader, { Group } from '@cordisjs/plugin-loader'
import { Context, type Plugin } from 'cordis'
import z from 'schemastery'
const stringify = (value: unknown) => JSON.stringify(value, null, 2)
import { afterEach, describe, expect, it } from 'vitest'
import { HostConfigError, readManagedConfig, writeConfig, type HostConfigOperation } from '@numenjs/config'
import { startRuntime } from '../src/app.js'
import { HostConfigurationService, toCordisEntry } from '../src/config-management.js'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const builtinNames = new Set(['probe', 'console', 'workbench', 'server'])
async function start(filename: string, plugins: Record<string, Plugin>) {
  const ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(`${filename.slice(0, filename.lastIndexOf('/'))}/`).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { group: Group, ...plugins })
  const doc = await readManagedConfig(filename, builtinNames)
  await ctx.plugin(HostConfigurationService, { filename, builtins: builtinNames, safeMode: false, fingerprint: doc.fingerprint })
  await ctx.loader.root.update(doc.entries.map(toCordisEntry)); await ctx.loader.await()
  return ctx
}
async function fixture(plugins: Record<string, unknown>, builtins: Record<string, Plugin> = { probe() {} }, version: 1 | 2 = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'numen-config-manager-')); directories.push(directory)
  const filename = join(directory, 'config.yml')
  await writeFile(filename, `# keep document comment\n${stringify({ version, dataDir: '.numen', plugins })}`, { mode: 0o600 })
  return { filename, ctx: await start(filename, builtins) }
}
const change = async (ctx: Context, operation: HostConfigOperation) => ctx.hostConfig.apply({ fingerprint: (await ctx.hostConfig.read()).fingerprint, operation })

describe('host configuration management', () => {
  it('serializes two clients with CAS, preserves comments, and reconciles a lost response', async () => {
    const { filename, ctx } = await fixture({ 'probe:a': { custom: 'retained' }, 'probe:b': {} })
    const snapshot = await ctx.hostConfig.read()
    const results = await Promise.allSettled([
      ctx.hostConfig.apply({ fingerprint: snapshot.fingerprint, operation: { kind: 'setEnabled', id: 'probe-a', enabled: false } }),
      ctx.hostConfig.apply({ fingerprint: snapshot.fingerprint, operation: { kind: 'setLabel', id: 'probe-b', label: 'Stale edit' } }),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFIG_CONFLICT' } })
    const refreshed = await ctx.hostConfig.read()
    expect(refreshed.entries.find(entry => entry.id === 'probe-a')).toMatchObject({ selfEnabled: false, actualState: 'DISABLED' })
    expect(refreshed.entries.find(entry => entry.id === 'probe-b')?.label).toBeUndefined()
    // Caller did not receive the first result: observe desired state, then explicit set is safe.
    const replay = await change(ctx, { kind: 'setEnabled', id: 'probe-a', enabled: false })
    expect(replay.fingerprint).toBe(refreshed.fingerprint)
    const source = await readFile(filename, 'utf8')
    expect(source).toContain('# keep document comment')
    expect((await readManagedConfig(filename, builtinNames)).config.plugins['probe:a']).toEqual({ custom: 'retained', $if: false })
  })

  it('creates, moves, disables, restores, renames and removes groups without rewriting member intent', async () => {
    const active = new Set<string>()
    const builtins = { probe(ctx: Context, config: { identity: string }) { active.add(config.identity); ctx.effect(() => () => { active.delete(config.identity) }) } }
    const { filename, ctx } = await fixture({ 'group:original': { plugins: { 'probe:a': { identity: 'business-a' }, '~probe:b': { identity: 'business-b' } } } }, builtins)
    await change(ctx, { kind: 'createGroup', id: 'target', label: 'Target' })
    await change(ctx, { kind: 'createGroup', id: 'nested', parentId: 'group-target' })
    await change(ctx, { kind: 'move', id: 'probe-a', parentId: 'group-nested' })
    await change(ctx, { kind: 'move', id: 'probe-b', parentId: 'group-nested' })
    await expect(change(ctx, { kind: 'move', id: 'group-target', parentId: 'group-nested' })).rejects.toMatchObject({ code: 'GROUP_CYCLE' })
    await expect(change(ctx, { kind: 'removeGroup', id: 'group-target' })).rejects.toMatchObject({ code: 'GROUP_NOT_EMPTY' })
    await change(ctx, { kind: 'setEnabled', id: 'group-target', enabled: false })
    expect([...active]).toEqual([])
    let snapshot = await ctx.hostConfig.read()
    expect(snapshot.entries.find(entry => entry.id === 'probe-a')).toMatchObject({ selfEnabled: true, effectiveEnabled: false, actualState: 'DISABLED' })
    expect(snapshot.entries.find(entry => entry.id === 'probe-b')).toMatchObject({ selfEnabled: false, effectiveEnabled: false })
    await change(ctx, { kind: 'setLabel', id: 'group-target', label: 'Renamed' })
    await change(ctx, { kind: 'setCollapsed', id: 'group-target', collapsed: true })
    await change(ctx, { kind: 'setEnabled', id: 'group-target', enabled: true })
    expect([...active]).toEqual(['business-a'])
    await change(ctx, { kind: 'removeGroup', id: 'group-original' })
    await ctx.fiber.dispose()
    const restarted = await start(filename, builtins)
    snapshot = await restarted.hostConfig.read()
    expect(snapshot.restartRequired).toBe(false)
    expect(snapshot.entries.find(entry => entry.id === 'group-target')).toMatchObject({ label: 'Renamed', collapsed: true })
    expect(snapshot.entries.find(entry => entry.id === 'probe-b')).toMatchObject({ selfEnabled: false, actualState: 'DISABLED', parentId: 'group-nested' })
    expect([...active]).toEqual(['business-a'])
  })

  it('protects both management products, necessary services and ancestors against indirect shutdown', async () => {
    const empty = () => {}
    const { ctx } = await fixture({ 'group:management': { plugins: { console: {}, workbench: {}, server: {} } }, 'group:off': { $if: false, plugins: {} } }, { console: empty, workbench: empty, server: empty })
    for (const id of ['console', 'workbench', 'server', 'group-management']) {
      for (const operation of [{ kind: 'setEnabled', id, enabled: false }, { kind: 'move', id, parentId: 'group-off' }, { kind: 'setConfig', id, config: {} }] as HostConfigOperation[]) {
        const request = { fingerprint: (await ctx.hostConfig.read()).fingerprint, operation }
        expect((await ctx.hostConfig.preview(request)).blockedReason).toContain('management channel')
        await expect(ctx.hostConfig.apply(request)).rejects.toMatchObject({ code: 'MANAGEMENT_CHANNEL_PROTECTED' })
      }
    }
    expect((await change(ctx, { kind: 'setLabel', id: 'group-management', label: 'Management' })).runtimeApplied).toBe(true)
  })

  it('records saved versus failed runtime application and repairs without automatic retries', async () => {
    let starts = 0
    const { filename, ctx } = await fixture({ probe: { fail: false } }, { probe: { Config: z.object({ fail: z.boolean() }), apply(_ctx, config: { fail: boolean }) { starts++; if (config.fail) throw new Error('fixture initialization failed') } } })
    const result = await change(ctx, { kind: 'setConfig', id: 'probe', config: { fail: true } })
    expect(result).toMatchObject({ saved: true, runtimeApplied: false, restartRequired: false, error: { code: 'RUNTIME_APPLY_FAILED' } })
    expect((await readManagedConfig(filename, builtinNames)).config.plugins.probe.fail).toBe(true)
    expect(result.snapshot.entries[0]?.actualState).toBe('FAILED')
    const afterFailure = starts
    await ctx.hostConfig.read(); await ctx.hostConfig.read()
    expect(starts).toBe(afterFailure)
    const recovered = await change(ctx, { kind: 'setConfig', id: 'probe', config: { fail: false } })
    expect(recovered).toMatchObject({ saved: true, runtimeApplied: true })
    expect(recovered.snapshot.entries[0]?.actualState).toBe('ACTIVE')
  })

  it('reports a first activation failure without an unhandled Loader completion rejection', async () => {
    const { filename, ctx } = await fixture({ probe: { $if: false, fail: true } }, { probe() { throw new Error('first activation failed') } })
    const result = await change(ctx, { kind: 'setEnabled', id: 'probe', enabled: true })
    expect(result).toMatchObject({ saved: true, runtimeApplied: false, error: { code: 'RUNTIME_APPLY_FAILED' } })
    expect(result.snapshot.entries[0]).toMatchObject({ selfEnabled: true, actualState: 'FAILED' })
    expect((await readManagedConfig(filename, builtinNames)).config.plugins.probe?.$if).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('redacts nested credentials, refuses secret writes, exposes owned internal states, and marks impact unknown', async () => {
    const child: Plugin = { inject: ['missingFixtureDependency'], apply() {} }
    const { ctx } = await fixture({ probe: { nested: { password: 'should-never-leak' }, unchanged: 42 } }, { probe(ctx) { ctx.plugin(child) } })
    const snapshot = await ctx.hostConfig.read()
    expect(JSON.stringify(snapshot)).not.toContain('should-never-leak')
    expect(snapshot.entries[0]).toMatchObject({ configEditable: false, internal: [{ state: 'PENDING', dependencies: ['missingFixtureDependency'], ownerEntryId: 'probe' }] })
    const request = { fingerprint: snapshot.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { token: 'new-private-value' } } }
    const preview = await ctx.hostConfig.preview(request)
    expect(JSON.stringify(preview)).not.toContain('new-private-value')
    expect(preview.impact).toMatchObject({ status: 'unknown' })
    await expect(ctx.hostConfig.apply(request)).rejects.toMatchObject({ code: 'SECRET_CONFIG_READ_ONLY' })
  })

  it('redacts schema-declared secrets and credentials embedded in URLs', async () => {
    const probe: Plugin = { Config: z.object({ accessCode: z.string().role('secret'), nested: z.object({ passphrase: z.string().role('secret') }), proxy: z.string() }), apply() {} }
    const { ctx } = await fixture({ probe: { accessCode: 'private-code', nested: { passphrase: 'private-phrase' }, proxy: 'https://alice:private-password@example.com' } }, { probe })
    const snapshot = await ctx.hostConfig.read()
    for (const secret of ['private-code', 'private-phrase', 'private-password']) expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(snapshot.entries[0]?.configEditable).toBe(false)
    const preview = await ctx.hostConfig.preview({ fingerprint: snapshot.fingerprint, operation: { kind: 'setConfig', id: 'probe', config: { accessCode: 'replacement-secret' } } })
    expect(JSON.stringify(preview)).not.toContain('replacement-secret')
    expect(preview.blockedReason).toContain('Secret-bearing')
  })

  it('omits configuration payloads for readonly and unloaded external entries without a schema', async () => {
    const { ctx } = await fixture({
      '~external:unloaded': { $package: './not-installed-fixture.js', unlockPhrase: 'unclassified-private-value' },
      probe: { token: 'classified-private-value', ordinarySetting: 'also-withheld' },
    })
    const snapshot = await ctx.hostConfig.read()
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'external-unloaded', configEditable: false, installed: null, config: {} }),
      expect.objectContaining({ id: 'probe', configEditable: false, config: {} }),
    ]))
    for (const value of ['unclassified-private-value', 'classified-private-value', 'also-withheld']) expect(JSON.stringify(snapshot)).not.toContain(value)
  })

  it('projects real public Schemastery fields and keeps explicit values, unknown fields and omitted defaults through validation and restart', async () => {
    const schema = z.intersect([
      z.object({ title: z.string().required(), count: z.number().min(0).default(3), mode: z.union(['fast', 'careful']) }),
      z.object({ section: z.object({ tags: z.array(z.string()) }), mapping: z.dict(z.number()) }),
    ])
    const probe: Plugin = { Config: schema, apply() {} }
    const initial = { title: 'First', mode: 'fast', section: { tags: ['one'], extension: 'retained' }, unknown: { value: [1, false] } }
    const { ctx, filename } = await fixture({ probe: initial }, { probe })
    const before = await ctx.hostConfig.read()
    expect(before.entries[0]).toMatchObject({ configEditable: true, config: initial, configSchema: { type: 'object', fields: [
      { name: 'title', type: 'string', required: true }, { name: 'count', type: 'number', min: 0, hasDefault: true },
      { name: 'mode', type: 'enum', options: [{ value: 'fast' }, { value: 'careful' }] },
      { name: 'section', type: 'object', fields: [{ name: 'tags', type: 'array', item: { type: 'string' } }] },
      { name: 'mapping', type: 'json', fallbackReason: 'unsupported' },
    ] } })
    expect(before.entries[0]?.config).not.toHaveProperty('count')
    const config = { ...initial, title: 'Second', section: { ...initial.section, tags: ['two', 'three'] } }
    const request = { fingerprint: before.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config } }
    expect((await ctx.hostConfig.preview(request)).blockedReason).toBeUndefined()
    expect((await ctx.hostConfig.apply(request)).runtimeApplied).toBe(true)
    expect(config).not.toHaveProperty('count')
    expect((await readManagedConfig(filename, builtinNames)).config.plugins.probe).toEqual(config)
    await ctx.fiber.dispose()
    const restarted = await start(filename, { probe })
    expect((await restarted.hostConfig.read()).entries[0]).toMatchObject({ config, configEditable: true })
    await expect(restarted.hostConfig.apply(request)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  })

  it('keeps absent schema, absent secret values, uninspectable schema, unloaded plugins and management entries read-only', async () => {
    const plain: Plugin = { apply() {} }
    const secret: Plugin = { Config: z.object({ phrase: z.string().role('secret').default('private-default') }), apply() {} }
    const regular: Plugin = { Config: z.object({ title: z.string().default('untitled') }), apply() {} }
    const { ctx } = await fixture({ 'probe:plain': { anything: 'withheld-private-setting' }, 'probe:secret': {}, '~probe:off': {}, workbench: {} }, { probe: plain, workbench: regular })
    const missing = await ctx.hostConfig.read()
    expect(missing.entries.find(entry => entry.id === 'probe-plain')).toMatchObject({ configEditable: false, config: {}, configReadOnlyReason: expect.stringContaining('inspectable configuration schema') })
    // Separate instances may share a package; replace the live schema only for
    // this inspection to exercise a late-loaded schema without a file write.
    const runtime = ctx.loader.store['probe-secret']!.fiber!.runtime!
    const original = runtime.Config
    runtime.Config = secret.Config
    const snapshot = await ctx.hostConfig.read()
    runtime.Config = original
    expect(snapshot.entries.find(entry => entry.id === 'probe-secret')).toMatchObject({ configEditable: false, config: {}, configReadOnlyReason: expect.stringContaining('Secret-bearing') })
    for (const entry of snapshot.entries) { expect(entry.configSchema).toBeUndefined(); expect(entry.config).toEqual({}) }
    expect(JSON.stringify(snapshot)).not.toContain('private')
    const request = { fingerprint: snapshot.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe-plain', config: { anything: 'unclassified-secret-input' } } }
    expect((await ctx.hostConfig.preview(request)).operation).toMatchObject({ config: {} })
    await expect(ctx.hostConfig.apply(request)).rejects.toMatchObject({ code: 'PLUGIN_SCHEMA_UNAVAILABLE' })
    await expect(change(ctx, { kind: 'setConfig', id: 'probe-off', config: {} })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
    await expect(change(ctx, { kind: 'setConfig', id: 'workbench', config: {} })).rejects.toMatchObject({ code: 'MANAGEMENT_CHANNEL_PROTECTED' })
    runtime.Config = secret.Config
    await expect(change(ctx, { kind: 'setConfig', id: 'probe-secret', config: {} })).rejects.toMatchObject({ code: 'SECRET_CONFIG_READ_ONLY' })
    runtime.Config = original
  })

  it('retains a complete config across coupled validation errors, validator mutation, stale writes and later valid repair', async () => {
    const schema = z.object({ mode: z.union(['fast', 'careful']).required(), attempts: z.number().min(1).required() })
    const standard = schema['~standard']
    Object.defineProperty(schema, '~standard', { value: { ...standard, validate(input: unknown) {
      const result = standard.validate(input)
      if ('then' in result || result.issues) return result
      const config = result.value as { mode: string; attempts: number }
      if (config.mode === 'careful' && config.attempts < 2) return { issues: [{ message: 'private-validation-fragment' }] }
      // Real plugins may normalize the caller's input. Such normalization is
      // runtime-only and must not become an accidental config file edit.
      ;(input as Record<string, unknown>).injectedDefault = 'runtime-only-value'
      return result
    } } })
    const probe: Plugin = { Config: schema, apply() {} }
    const { ctx, filename } = await fixture({ probe: { mode: 'fast', attempts: 1 } }, { probe })
    const before = await ctx.hostConfig.read()
    const invalid = { fingerprint: before.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { mode: 'careful', attempts: 1, custom: { preserved: true } } } }
    const originalDisk = await readFile(filename, 'utf8')
    expect(await ctx.hostConfig.preview(invalid)).toMatchObject({ blockedReason: 'Plugin configuration does not match its schema. Values are omitted.', operation: invalid.operation })
    await expect(ctx.hostConfig.apply(invalid)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_INVALID', message: expect.not.stringContaining('private-validation-fragment') })
    expect(await readFile(filename, 'utf8')).toBe(originalDisk)
    const valid = { ...invalid, operation: { ...invalid.operation, config: { ...invalid.operation.config, attempts: 2 } } }
    expect((await ctx.hostConfig.preview(valid)).blockedReason).toBeUndefined()
    const saved = await ctx.hostConfig.apply(valid)
    expect(saved.runtimeApplied).toBe(true)
    expect(saved.snapshot.entries[0]?.config).toEqual(valid.operation.config)
    expect(valid.operation.config).not.toHaveProperty('injectedDefault')
    expect((await readManagedConfig(filename, builtinNames)).config.plugins.probe).toEqual(valid.operation.config)
    await expect(ctx.hostConfig.apply(invalid)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  })

  it('does not execute Schema accessors or overridden list helpers during Host reads and previews', async () => {
    let calls = 0
    const schema = z.union([z.object({ value: z.string() }), z.object({ value: z.number() })])
    Object.defineProperty(schema.list!, 'flatMap', { value() { calls++; throw new Error('private-method-fragment') } })
    const { ctx } = await fixture({ probe: { value: 'original' } }, { probe: { Config: schema, apply() {} } })
    const current = await ctx.hostConfig.read()
    expect(current.entries[0]).toMatchObject({ configEditable: true, configSchema: { type: 'json', fallbackReason: 'unsupported' } })
    const input = { fingerprint: current.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { value: 'updated' } } }
    expect((await ctx.hostConfig.preview(input)).blockedReason).toBeUndefined()
    expect((await ctx.hostConfig.apply(input)).runtimeApplied).toBe(true)
    expect(calls).toBe(0)

    const unsafeSchema = z.object({})
    Object.defineProperty(unsafeSchema.dict!, 'value', { get() { calls++; throw new Error('private-getter-fragment') }, enumerable: false })
    const instance = await fixture({ probe: { value: 'must-be-withheld' } }, { probe: { Config: unsafeSchema, apply() {} } })
    const readonly = await instance.ctx.hostConfig.read()
    expect(readonly.entries[0]).toMatchObject({ configEditable: false, config: {} })
    expect(JSON.stringify(readonly)).not.toContain('must-be-withheld')
    const preview = await instance.ctx.hostConfig.preview({ fingerprint: readonly.fingerprint, operation: { kind: 'setConfig', id: 'probe', config: { value: 'new-value' } } })
    expect(preview).toMatchObject({ operation: { config: {} }, blockedReason: expect.stringContaining('inspectable configuration schema') })
    expect(calls).toBe(0)
  })

  it('classifies non-enumerable Schema secret declarations without exposing their values or metadata', async () => {
    const schema = z.object({})
    Object.defineProperty(schema.dict!, 'phrase', { value: z.string().role('secret'), enumerable: false })
    const { ctx } = await fixture({ probe: { phrase: 'private-nonenumerable-value' } }, { probe: { Config: schema, apply() {} } })
    const snapshot = await ctx.hostConfig.read()
    expect(snapshot.entries[0]).toMatchObject({ configEditable: false, config: {}, configReadOnlyReason: expect.stringContaining('Secret-bearing') })
    expect(snapshot.entries[0]?.configSchema).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('private-nonenumerable-value')
    const input = { fingerprint: snapshot.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { phrase: 'new-private-value' } } }
    expect((await ctx.hostConfig.preview(input)).operation).toMatchObject({ config: {} })
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'SECRET_CONFIG_READ_ONLY' })
  })

  it('keeps non-finite YAML values read-only instead of serializing unknown fields as null', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-non-json-config-')); directories.push(directory)
    const filename = join(directory, 'config.yml')
    await writeFile(filename, 'version: 2\ndataDir: .numen\nplugins:\n  probe:\n    title: visible\n    future: .inf\n')
    const ctx = await start(filename, { probe: { Config: z.object({ title: z.string() }), apply() {} } })
    const current = await ctx.hostConfig.read()
    expect(current.entries[0]).toMatchObject({ configEditable: false, config: {}, configReadOnlyReason: expect.stringContaining('represented losslessly as JSON') })
    expect(current.entries[0]?.configSchema).toBeUndefined()
    const before = await readFile(filename, 'utf8')
    const input = { fingerprint: current.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { title: 'changed', future: null } } }
    expect(await ctx.hostConfig.preview(input)).toMatchObject({ operation: { config: {} }, blockedReason: expect.stringContaining('represented losslessly as JSON') })
    await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_NOT_JSON' })
    expect(await readFile(filename, 'utf8')).toBe(before)
    expect((await readManagedConfig(filename, builtinNames)).config.plugins.probe?.future).toBe(Infinity)
  })

  it('rejects non-JSON request values, cycles and accessors without evaluating or partially persisting them', async () => {
    const { ctx, filename } = await fixture({ probe: { title: 'original' } }, { probe: { Config: z.object({ title: z.string() }), apply() {} } })
    const snapshot = await ctx.hostConfig.read(), before = await readFile(filename, 'utf8')
    let calls = 0
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'hidden', { enumerable: true, get() { calls++; return 'private-getter-value' } })
    const hidden = Object.defineProperty({}, 'hidden', { value: 'private-nonenumerable-value', enumerable: false })
    const toJSON = { toJSON() { calls++; return 'private-serializer-value' } }
    for (const future of [Infinity, -Infinity, NaN, new Date(), Buffer.from('private-buffer-value'), cyclic, accessor, hidden, toJSON, [undefined], new Array(1)]) {
      const input = { fingerprint: snapshot.fingerprint, operation: { kind: 'setConfig' as const, id: 'probe', config: { title: 'changed', future } } }
      expect(await ctx.hostConfig.preview(input)).toMatchObject({ operation: { config: {} }, blockedReason: expect.stringContaining('represented losslessly as JSON') })
      await expect(ctx.hostConfig.apply(input)).rejects.toMatchObject({ code: 'PLUGIN_CONFIG_NOT_JSON' })
    }
    expect(calls).toBe(0)
    expect(await readFile(filename, 'utf8')).toBe(before)
    expect((await ctx.hostConfig.read()).fingerprint).toBe(snapshot.fingerprint)
  })

  it('keeps v1 read-only and flags external writes without hiding actual runtime state', async () => {
    const legacy = await fixture({ probe: {} }, { probe() {} }, 1)
    expect(await legacy.ctx.hostConfig.read()).toMatchObject({ writable: false, readOnlyReason: expect.stringContaining('Version 1') })
    await expect(change(legacy.ctx, { kind: 'setEnabled', id: 'probe', enabled: false })).rejects.toMatchObject({ code: 'MIGRATION_REQUIRED' })
    const { ctx, filename } = await fixture({ probe: {} })
    await writeFile(filename, stringify({ version: 2, dataDir: '.numen', plugins: { probe: { $if: false } } }))
    const snapshot = await ctx.hostConfig.read()
    expect(snapshot).toMatchObject({ writable: false, restartRequired: true })
    expect(snapshot.entries[0]).toMatchObject({ selfEnabled: false, actualState: 'ACTIVE' })
    await expect(change(ctx, { kind: 'setLabel', id: 'probe', label: 'Changed' })).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
  })
})


it('previews against real optional domain services and remains usable when they disappear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-management-domains-')); directories.push(directory)
  const filename = join(directory, 'config.yml')
  await writeConfig(filename, { version: 2, dataDir: 'data', plugins: {
    database: { path: ':memory:' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: join(directory, 'resources') }, connections: {}, automations: {}, demo: {},
    server: { host: '127.0.0.1', port: 0 }, console: { auth: { token: 'fixture-secret-token' } }, workbench: {},
  } })
  const app = await startRuntime({ configPath: filename }); contexts.push(app.context)
  const input = { fingerprint: (await app.context.hostConfig.read()).fingerprint, operation: { kind: 'setEnabled' as const, id: 'demo', enabled: false } }
  const preview = await app.context.hostConfig.preview(input)
  expect(preview.impact.status).toBe('unknown')
  expect(preview.impact.capabilities).toContain('demo:echo@1')
  expect(JSON.stringify(preview)).not.toContain('fixture-secret-token')
  expect((await app.context.hostConfig.read()).entries.find(entry => entry.id === 'workbench')?.internal.some(child => child.name.includes('workbench'))).toBe(true)
  expect((await app.context.hostConfig.apply(input)).runtimeApplied).toBe(true)
  await change(app.context, { kind: 'setEnabled', id: 'database', enabled: false })
  const withoutDatabase = await app.context.hostConfig.preview({ fingerprint: (await app.context.hostConfig.read()).fingerprint, operation: { kind: 'setEnabled', id: 'demo', enabled: true } })
  expect(withoutDatabase.impact).toMatchObject({ status: 'unknown', connections: [], automations: [] })
  expect(app.context.get('hostConfig')).toBeDefined()
})
