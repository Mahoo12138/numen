import { Context, type Plugin } from 'cordis'
import Loader, { Group } from '@cordisjs/plugin-loader'
import { CapabilityRegistry, type RuntimeRegistration } from '@numenjs/core'
import { readManagedConfig, writeConfig, type HostConfigOperation, type HostRegistrationRef } from '@numenjs/config'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, expect, it } from 'vitest'
import { HostConfigurationService, toCordisEntry } from '../src/config-management.js'
import { RegistrationOwnership } from '../src/registration-ownership.js'

const contexts: Context[] = [], directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const ref: HostRegistrationRef = { kind: 'capability', id: 'fixture:query', version: 1 }
const definition = { id: ref.id, version: 1, kind: 'query' as const, title: 'Query', input: z.object({}), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
const builtins = new Set(['declaration', 'implementation', 'unused'])
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'numen-ownership-')); directories.push(directory)
  const filename = join(directory, 'config.yml')
  await writeConfig(filename, { version: 2, dataDir: '.data', plugins: {
    'group:original': { $label: 'Original', plugins: { declaration: {}, implementation: {}, '~unused': {} } },
    'group:destination': { plugins: {} },
  } })
  const create = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(CapabilityRegistry)
    const child = (owner: Context) => { owner.capabilities.provide(owner, definition, { async invoke() { return {} } }) }
    const declaration = (owner: Context) => { owner.capabilities.define(owner, definition) }
    const implementation = (owner: Context) => { owner.plugin(child) }
    child.inject = declaration.inject = implementation.inject = ['capabilities']
    Object.assign(ctx.loader.builtins, { group: Group, declaration, implementation, unused() { throw new Error('Disabled fixture started') } } satisfies Record<string, Plugin>)
    const document = await readManagedConfig(filename, builtins)
    await ctx.plugin(HostConfigurationService, { filename, builtins, safeMode: false, fingerprint: document.fingerprint })
    await ctx.loader.root.update(document.entries.map(toCordisEntry)); await ctx.loader.await()
    return ctx
  }
  return { ctx: await create(), create, filename }
}
const change = async (ctx: Context, operation: HostConfigOperation) => ctx.hostConfig.apply({ fingerprint: (await ctx.hostConfig.read()).fingerprint, operation })

it('finds separate definition and nested provider owners, preserves evidence while disabled, and recomputes moved ancestry', async () => {
  const { ctx, create } = await fixture()
  const read = async () => (await ctx.hostConfig.diagnose([ref]))[0]!
  const initial = await read()
  expect(ctx.capabilities.get(ref)?.providerAvailable).toBe(true)
  expect(initial.owners).toMatchObject([
    { role: 'definition', evidence: 'current', entry: { id: 'declaration' }, ancestors: [{ id: 'group-original' }] },
    { role: 'provider', evidence: 'current', entry: { id: 'implementation' }, ancestors: [{ id: 'group-original' }] },
  ])
  await change(ctx, { kind: 'setEnabled', id: 'group-original', enabled: false })
  expect((await read()).owners).toMatchObject([
    { evidence: 'previous', entry: { actualState: 'DISABLED' }, ancestors: [{ selfEnabled: false }] },
    { evidence: 'previous', entry: { actualState: 'DISABLED' }, ancestors: [{ selfEnabled: false }] },
  ])
  await change(ctx, { kind: 'move', id: 'implementation', parentId: 'group-destination' })
  // Definition remains missing: a failed reactivation must not pretend the old Provider is live.
  expect((await read()).owners[1]).toMatchObject({ evidence: 'previous', ancestors: [{ id: 'group-destination' }] })
  await change(ctx, { kind: 'setEnabled', id: 'group-original', enabled: true })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: false })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: true })
  expect((await read()).owners[1]).toMatchObject({ evidence: 'current', entry: { id: 'implementation' }, ancestors: [{ id: 'group-destination' }] })
  expect((await ctx.hostConfig.read()).entries.find(entry => entry.id === 'unused')?.selfEnabled).toBe(false)
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: false })
  await ctx.fiber.dispose()
  const restarted = await create()
  expect((await restarted.hostConfig.diagnose([ref]))[0]?.owners).toMatchObject([
    { evidence: 'current', entry: { id: 'declaration' } },
    { evidence: 'unknown', reason: 'not-observed' },
  ])
})

it('fences late disposals and reports unmanaged and externally drifted owners without guessing', async () => {
  const { ctx, filename } = await fixture()
  let stale: RuntimeRegistration | undefined
  ctx.on('numen/registration-change', registration => { if (registration.id === ref.id && registration.role === 'provider' && !stale) stale = registration })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: false })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: true })
  ctx.emit('numen/registration-change', stale!, false)
  expect((await ctx.hostConfig.diagnose([ref]))[0]?.owners[1]?.evidence).toBe('current')
  const unmanaged = { ...definition, id: 'fixture:unmanaged' }
  ctx.capabilities.define(ctx, unmanaged)
  expect((await ctx.hostConfig.diagnose([{ ...ref, id: unmanaged.id }, { ...ref, id: 'fixture:never' }])).map(item => item.owners[0])).toMatchObject([
    { evidence: 'unknown', reason: 'unmanaged' }, { evidence: 'unknown', reason: 'not-observed' },
  ])
  const before = await readFile(filename, 'utf8')
  await writeFile(filename, before + '\n# external edit\n')
  expect((await ctx.hostConfig.diagnose([ref]))[0]?.owners.every(owner => owner.reason === 'configuration-changed' && !owner.entry)).toBe(true)
  await expect(ctx.hostConfig.diagnose(Array.from({ length: 65 }, () => ref))).rejects.toMatchObject({ code: 'DIAGNOSTIC_LIMIT' })
})

it('revokes provider evidence when its definition disappears before the provider plugin', async () => {
  const { ctx } = await fixture()
  await change(ctx, { kind: 'setEnabled', id: 'declaration', enabled: false })
  expect(ctx.capabilities.get(ref)).toBeUndefined()
  expect((await ctx.hostConfig.diagnose([ref]))[0]?.owners).toMatchObject([
    { evidence: 'previous', entry: { id: 'declaration', actualState: 'DISABLED' } },
    { evidence: 'previous', entry: { id: 'implementation', actualState: 'ACTIVE' } },
  ])
  await change(ctx, { kind: 'setEnabled', id: 'declaration', enabled: true })
  expect(ctx.capabilities.get(ref)?.providerAvailable).toBe(false)
  expect((await ctx.hostConfig.diagnose([ref]))[0]?.owners[1]?.evidence).toBe('previous')
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: false })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: true })
  expect((await ctx.hostConfig.diagnose([ref]))[0]?.owners[1]?.evidence).toBe('current')
})

it('does not navigate to deleted or replaced instances and never exposes configuration in evidence', async () => {
  const { ctx } = await fixture()
  const index = new RegistrationOwnership()
  ctx.on('numen/registration-change', (registration, active) => index.observe(registration, active, id => ctx.loader.store[id]?.options.name))
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: false })
  await change(ctx, { kind: 'setEnabled', id: 'implementation', enabled: true })
  const snapshot = await ctx.hostConfig.read()
  const entry = snapshot.entries.find(entry => entry.id === 'implementation')!
  entry.config = { password: 'private-configuration' }
  expect(JSON.stringify(index.diagnose([ref], snapshot))).not.toContain('private-configuration')
  entry.name = 'unrelated-package'
  expect(index.diagnose([ref], snapshot)[0]?.owners[1]).toMatchObject({ evidence: 'unknown', reason: 'entry-replaced' })
  snapshot.entries = snapshot.entries.filter(entry => entry.id !== 'implementation')
  expect(index.diagnose([ref], snapshot)[0]?.owners[1]).toMatchObject({ evidence: 'unknown', reason: 'entry-removed' })
})
