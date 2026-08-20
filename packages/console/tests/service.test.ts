import { Context, type Logger } from 'cordis'
import z from 'schemastery'
import { describe, expect, it, vi } from 'vitest'
import {
  ConsoleProcedureKindError,
  ConsoleProcedureUnavailableError,
  ConsoleService,
  type ConsoleRequestContext,
} from '../src/index.js'

function request(signal = new AbortController().signal): ConsoleRequestContext {
  return {
    requestId: 'request-1',
    principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
    session: { id: 'session-1' },
    signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
  }
}

describe('ConsoleService', () => {
  it('validates and invokes versioned Query and Action providers', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    const query = {
      id: 'test:echo',
      version: 1,
      kind: 'query' as const,
      title: 'Echo',
      input: z.object({ value: z.string().required() }),
      output: z.object({ value: z.string().required(), principal: z.string().required() }),
    }
    const action = {
      id: 'test:uppercase',
      version: 1,
      kind: 'action' as const,
      title: 'Uppercase',
      input: z.object({ value: z.string().required() }),
      output: z.string(),
    }
    root.console.define(root, query)
    root.console.define(root, action)
    root.console.provideQuery(root, query, {
      query({ input, request: context }) {
        return { value: input.value, principal: context.principal.subject.id }
      },
    })
    root.console.provideAction(root, action, {
      action({ input }) {
        return input.value.toUpperCase()
      },
    })

    await expect(root.console.query(query, { value: 'hello' }, request())).resolves.toEqual({
      value: 'hello',
      principal: 'owner',
    })
    await expect(root.console.action(action, { value: 'hello' }, request())).resolves.toBe('HELLO')
    await expect(root.console.query(query, {}, request())).rejects.toThrow()
    await expect(root.console.action(query, { value: 'hello' }, request()))
      .rejects.toThrow(ConsoleProcedureKindError)
    await root.fiber.dispose()
  })

  it('tracks definitions and providers with Cordis effect lifecycles', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    const definition = {
      id: 'test:current',
      version: 1,
      kind: 'query' as const,
      title: 'Current',
      input: z.object({}),
      output: z.string(),
    }
    const extension = (ctx: Context) => {
      ctx.console.define(ctx, definition)
      ctx.console.provideQuery(ctx, definition, { query: () => 'ready' })
    }
    extension.inject = ['console']
    const plugin = await root.plugin(extension)

    expect(root.console.get(definition)).toMatchObject({ providerAvailable: true })
    await plugin.dispose()
    expect(root.console.get(definition)).toBeUndefined()
    await root.fiber.dispose()
  })

  it('validates Subscription events and cleans up on abort or provider disposal', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    const definition = {
      id: 'test:updates',
      version: 1,
      kind: 'subscription' as const,
      title: 'Updates',
      input: z.object({ topic: z.string().required() }),
      event: z.object({ value: z.number().required() }),
    }
    root.console.define(root, definition)
    const cleanup = vi.fn()
    let publish: ((event: unknown) => void | Promise<void>) | undefined
    const disposeProvider = root.console.provideSubscription(root, definition, {
      subscribe({ emit }) {
        publish = emit
        return cleanup
      },
    })
    const controller = new AbortController()
    const events: unknown[] = []
    await root.console.subscribe(definition, { topic: 'runs' }, request(controller.signal), event => {
      events.push(event)
    })

    await publish?.({ value: 1 })
    expect(() => publish?.({ value: 'invalid' })).toThrow()
    expect(events).toEqual([{ value: 1 }])
    controller.abort()
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    await disposeProvider()

    const secondCleanup = vi.fn()
    const disposeSecondProvider = root.console.provideSubscription(root, definition, {
      subscribe() {
        return secondCleanup
      },
    })
    await root.console.subscribe(definition, { topic: 'runs' }, request(), () => {})
    await disposeSecondProvider()
    expect(secondCleanup).toHaveBeenCalledTimes(1)
    await expect(root.console.subscribe(definition, { topic: 'runs' }, request(), () => {}))
      .rejects.toThrow(ConsoleProcedureUnavailableError)
    await root.fiber.dispose()
  })

  it('rejects invalid and duplicate procedure identities', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    const definition = {
      id: 'test:query',
      version: 1,
      kind: 'query' as const,
      title: 'Query',
      input: z.object({}),
      output: z.object({}),
    }
    root.console.define(root, definition)
    expect(() => root.console.define(root, definition)).toThrow('already defined')
    expect(() => root.console.define(root, { ...definition, id: 'invalid' }))
      .toThrow('invalid console procedure id')
    await root.fiber.dispose()
  })
})
