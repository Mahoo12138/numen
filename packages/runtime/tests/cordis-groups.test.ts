import Loader, { Group, type EntryOptions } from '@cordisjs/plugin-loader'
import { Context, FiberState, type Plugin } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

async function createLoader(builtins: Record<string, Plugin> = {}) {
  const context = new Context()
  contexts.push(context)
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, { group: Group, ...builtins })
  return context
}

function group(id: string, config: EntryOptions[], disabled = false): EntryOptions {
  // Installed Loader keeps structural Group fibers alive when group is true.
  // Descendant Entries calculate effective state from each ancestor's intent.
  return { id, name: 'cordis:group', group: true, disabled, config }
}

function leaf(id: string, disabled = false): EntryOptions {
  return { id, name: 'cordis:probe', disabled, config: { id, businessId: `business-${id}` } }
}

function counts(context: Context) {
  return {
    fibers: [...context.registry.values()].reduce((total, runtime) => total + runtime.fibers.length, 0),
    listeners: Object.values(context.events._hooks).reduce((total, hooks) => total + hooks.length, 0),
  }
}

describe('installed Cordis Group and parent lifecycle contract', () => {
  it('restores nested groups without overwriting member intent, including edits under a disabled ancestor', async () => {
    const active = new Set<string>()
    const context = await createLoader({
      probe(ctx, config: { id: string }) {
        active.add(config.id)
        ctx.effect(() => () => { active.delete(config.id) })
      },
    })
    await context.loader.root.update([
      group('outer', [
        leaf('direct'),
        group('inner', [leaf('enabled'), leaf('disabled', true)]),
        group('initially-off', [leaf('deferred')], true),
      ]),
    ])
    await context.loader.await()
    expect([...active].sort()).toEqual(['direct', 'enabled'])
    expect(context.loader.resolve('deferred').disabled).toBe(true)

    await context.loader.update('outer', { disabled: true })
    await context.loader.await()
    expect([...active]).toEqual([])
    expect(context.loader.resolve('inner').fiber?.state).toBe(FiberState.ACTIVE)
    expect(context.loader.resolve('enabled').options.disabled).toBe(false)
    expect(context.loader.resolve('disabled').options.disabled).toBe(true)

    // User edits while the ancestor is off must become effective on restoration.
    await context.loader.update('direct', { disabled: true })
    await context.loader.update('initially-off', { disabled: false })
    await context.loader.await()
    expect([...active]).toEqual([])
    await context.loader.update('outer', { disabled: false })
    await context.loader.await()
    expect([...active].sort()).toEqual(['deferred', 'enabled'])
    expect(context.loader.resolve('direct').options.disabled).toBe(true)
    expect(context.loader.resolve('disabled').options.disabled).toBe(true)

    const restoredCounts = counts(context)
    for (let iteration = 0; iteration < 3; iteration++) {
      await context.loader.update('inner', { disabled: true })
      await context.loader.await()
      expect([...active]).toEqual(['deferred'])
      await context.loader.update('outer', { disabled: true })
      await context.loader.update('inner', { disabled: false })
      await context.loader.await()
      expect([...active]).toEqual([])
      await context.loader.update('outer', { disabled: false })
      await context.loader.await()
      expect([...active].sort()).toEqual(['deferred', 'enabled'])
      expect(counts(context)).toEqual(restoredCounts)
    }
  })

  it('moves a stable Entry ID and configuration between groups with different enabled states', async () => {
    const active = new Map<string, unknown>()
    const context = await createLoader({
      probe(ctx, config: { id: string; businessId: string }) {
        active.set(config.id, config)
        ctx.effect(() => () => { active.delete(config.id) })
      },
    })
    const instance = leaf('instance-42')
    const initiallyDisabled = leaf('instance-off', true)
    await context.loader.root.update([
      group('source', [instance, initiallyDisabled]),
      group('target', [group('nested-target', [])], true),
    ])
    await context.loader.await()
    const entry = context.loader.resolve('instance-42')
    const config = entry.options.config

    await context.loader.update('instance-42', {}, 'nested-target')
    await context.loader.update('instance-off', {}, 'nested-target')
    await context.loader.await()
    expect(active.size).toBe(0)
    expect(context.loader.resolve('instance-42')).toBe(entry)
    expect(entry.id).toBe('instance-42')
    expect(entry.options.config).toBe(config)
    expect(entry.options.disabled).toBe(false)
    expect(context.loader.resolveGroup('source').data).toEqual([])
    expect(context.loader.resolveGroup('nested-target').data.map(options => options.id)).toEqual(['instance-42', 'instance-off'])

    await context.loader.update('target', { disabled: false })
    await context.loader.await()
    expect([...active.keys()]).toEqual(['instance-42'])
    expect(active.get('instance-42')).toEqual({ id: 'instance-42', businessId: 'business-instance-42' })

    await context.loader.update('nested-target', {}, 'source')
    await context.loader.update('target', { disabled: true })
    await context.loader.await()
    expect(context.loader.resolve('instance-42')).toBe(entry)
    expect(entry.id).toBe('instance-42')
    expect([...active.keys()]).toEqual(['instance-42'])
    expect(context.loader.resolve('instance-off').options.disabled).toBe(true)
  })

  it('shares services across group boundaries and resumes consumers after the provider group returns', async () => {
    const active = new Map<string, unknown>()
    const service = { value: 'shared' }
    const context = await createLoader({
      provider(ctx) { ctx.provide('groupTestDependency', service) },
      consumer: {
        inject: ['groupTestDependency'],
        apply(ctx, config: { id: string }) {
          active.set(config.id, ctx.get('groupTestDependency'))
          ctx.effect(() => () => { active.delete(config.id) })
        },
      },
    })
    await context.loader.root.update([
      group('providers', [{ id: 'provider', name: 'cordis:provider' }]),
      { id: 'root-consumer', name: 'cordis:consumer', config: { id: 'root-consumer' } },
      group('consumers', [
        group('deep-consumers', [{ id: 'nested-consumer', name: 'cordis:consumer', config: { id: 'nested-consumer' } }]),
      ]),
    ])
    await context.loader.await()
    expect(context.get('groupTestDependency')).toBe(service)
    expect([...active.values()]).toEqual([service, service])
    const activeCounts = counts(context)

    for (let iteration = 0; iteration < 3; iteration++) {
      await context.loader.update('providers', { disabled: true })
      await context.loader.await()
      expect(active.size).toBe(0)
      expect(context.get('groupTestDependency')).toBeUndefined()
      for (const id of ['root-consumer', 'nested-consumer']) {
        expect(context.loader.resolve(id).fiber?.state).toBe(FiberState.PENDING)
        expect(context.loader.resolve(id).options.disabled).not.toBe(true)
      }
      await context.loader.update('providers', { disabled: false })
      await context.loader.await()
      expect([...active.values()]).toEqual([service, service])
      expect(counts(context)).toEqual(activeCounts)
    }
  })

  it('disposes composed children, keeps missing dependencies local, and returns registrations to baseline', async () => {
    const active = new Set<string>()
    const eventListener = vi.fn()
    const track = (ctx: Context, id: string) => {
      active.add(id)
      ctx.effect(() => () => { active.delete(id) })
      ctx.on('loader/config-update', eventListener)
    }
    const dependent: Plugin = {
      inject: ['compositionTestDependency'],
      apply(ctx) { track(ctx, 'dependent') },
    }
    const independent: Plugin = ctx => { track(ctx, 'independent') }
    const context = await createLoader({
      provider(ctx) { ctx.provide('compositionTestDependency', { available: true }) },
      parent(ctx) {
        ctx.plugin(dependent)
        ctx.plugin(independent)
      },
    })
    const baseline = counts(context)
    await context.loader.root.update([
      { id: 'parent', name: 'cordis:parent', disabled: false, config: { identity: 'persisted' } },
      { id: 'provider', name: 'cordis:provider', disabled: true },
    ])
    await context.loader.await()
    expect([...active]).toEqual(['independent'])
    expect(context.loader.resolve('parent').fiber?.state).toBe(FiberState.ACTIVE)
    expect([...context.registry.get(dependent)!.fibers][0]?.state).toBe(FiberState.PENDING)

    await context.loader.update('provider', { disabled: false })
    await context.loader.await()
    expect([...active].sort()).toEqual(['dependent', 'independent'])
    const activeCounts = counts(context)
    for (let iteration = 0; iteration < 3; iteration++) {
      eventListener.mockClear()
      context.emit('loader/config-update')
      expect(eventListener).toHaveBeenCalledTimes(2)
      await context.loader.update('provider', { disabled: true })
      await context.loader.await()
      expect([...active]).toEqual(['independent'])
      expect(context.loader.resolve('parent').options.disabled).toBe(false)
      await context.loader.update('parent', { disabled: true })
      await context.loader.await()
      expect([...active]).toEqual([])
      expect(counts(context)).toEqual(baseline)
      eventListener.mockClear()
      context.emit('loader/config-update')
      expect(eventListener).not.toHaveBeenCalled()
      await context.loader.update('parent', { disabled: false })
      await context.loader.await()
      expect([...active]).toEqual(['independent'])
      expect(context.loader.resolve('parent').options.config).toEqual({ identity: 'persisted' })
      await context.loader.update('provider', { disabled: false })
      await context.loader.await()
      expect([...active].sort()).toEqual(['dependent', 'independent'])
      expect(counts(context)).toEqual(activeCounts)
    }
  })
})
