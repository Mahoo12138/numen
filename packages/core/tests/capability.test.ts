import { Context } from 'cordis'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, type CapabilityDefinition } from '../src/index.js'

const definition: CapabilityDefinition<string, string> = {
  id: 'test:echo',
  version: 1,
  kind: 'query',
  title: 'Echo',
  input: z.string(),
  output: z.string(),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}

describe('CapabilityRegistry', () => {
  it('tracks definition and provider lifecycles with Cordis effects', async () => {
    const root = new Context()
    await root.plugin(CapabilityRegistry)
    const consumer = (ctx: Context) => {
      ctx.capabilities.define(ctx, definition)
      ctx.capabilities.provide(ctx, definition, {
        async invoke({ input }) {
          return input
        },
      })
    }
    consumer.inject = ['capabilities']
    const plugin = await root.plugin(consumer)

    expect(root.capabilities.get(definition)).toMatchObject({ providerAvailable: true })
    await plugin.dispose()
    expect(root.capabilities.get(definition)).toBeUndefined()
    await root.fiber.dispose()
  })

  it('rejects duplicate contracts in the same context', async () => {
    const root = new Context()
    await root.plugin(CapabilityRegistry)
    root.capabilities.define(root, definition)
    expect(() => root.capabilities.define(root, definition)).toThrow('already defined')
    await root.fiber.dispose()
  })

  it('tracks trigger providers separately from invocation providers', async () => {
    const root = new Context()
    await root.plugin(CapabilityRegistry)
    const trigger: CapabilityDefinition = {
      id: 'test:event',
      version: 1,
      kind: 'trigger',
      title: 'Test event',
      input: z.object({ channel: z.string().required() }),
      output: z.object({ value: z.string().required() }),
      semantics: { sideEffect: false, idempotent: true, retrySafe: true },
    }
    root.capabilities.define(root, trigger)
    expect(() => root.capabilities.provide(root, trigger, {
      async invoke({ input }) {
        return input
      },
    })).toThrow('requires provideTrigger')

    const dispose = root.capabilities.provideTrigger(root, trigger, {
      activate() {},
    })
    expect(root.capabilities.get(trigger)).toMatchObject({ providerAvailable: true })
    expect(root.capabilities.resolveTriggerProvider(trigger)).toBeDefined()
    dispose()
    expect(root.capabilities.get(trigger)).toMatchObject({ providerAvailable: false })
    await root.fiber.dispose()
  })
})
