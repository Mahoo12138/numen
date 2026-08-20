import type { AutomationSource, CapabilityDefinition, CapabilityStatus } from '@numen/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/index.js'

const triggerDefinition: CapabilityDefinition = {
  id: 'test:manual',
  version: 1,
  kind: 'trigger',
  title: 'Manual trigger',
  input: z.object({ source: z.string().required() }),
  output: z.object({}),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}

const actionDefinition: CapabilityDefinition = {
  id: 'test:send',
  version: 1,
  kind: 'action',
  title: 'Send message',
  input: z.object({ message: z.string().required() }),
  output: z.object({ delivered: z.boolean().required() }),
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
}

const definitions = new Map<string, CapabilityDefinition>([
  ['test:manual@1', triggerDefinition],
  ['test:send@1', actionDefinition],
])

const resolver = {
  get(ref: { id: string; version: number }): CapabilityStatus | undefined {
    const definition = definitions.get(`${ref.id}@${ref.version}`)
    return definition ? { definition, providerAvailable: false } : undefined
  },
}

const source: AutomationSource = {
  triggers: [{
    id: 'manual-trigger',
    capability: { id: 'test:manual', version: 1 },
    config: { source: 'test' },
  }],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [
      {
        type: 'capability',
        id: 'send-message',
        capability: { id: 'test:send', version: 1 },
        input: { message: { type: 'literal', value: 'Hello' } },
      },
      {
        type: 'wait',
        id: 'short-wait',
        durationMs: { type: 'literal', value: 1000 },
      },
    ],
  },
}

describe('automation compiler', () => {
  it('lowers structured source into deterministic Core IR and snapshots contracts', () => {
    const result = compileAutomation(source, resolver)
    expect(result.plan.entry).toBe('send-message')
    expect(result.plan.instructions['send-message']).toMatchObject({ op: 'invoke', next: 'short-wait' })
    expect(result.plan.instructions['short-wait']).toMatchObject({ op: 'suspend', next: '__complete' })
    expect(result.dependencyManifest.capabilities.map(item => item.id)).toEqual(['test:manual', 'test:send'])
    expect(result.contractSnapshot.capabilities).toHaveLength(2)
  })

  it('blocks publishing when a contract or required field is missing', () => {
    const invalid: AutomationSource = {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'broken',
        capability: { id: 'missing:action', version: 1 },
        input: {},
      },
    }
    expect(() => compileAutomation(invalid, resolver)).toThrow(AutomationCompileError)

    const missingInput = structuredClone(source)
    const flow = missingInput.flow
    if (flow.type !== 'block' || flow.steps[0]?.type !== 'capability') throw new Error('invalid fixture')
    flow.steps[0].input = {}
    try {
      compileAutomation(missingInput, resolver)
      throw new Error('expected compilation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationCompileError)
      expect((error as AutomationCompileError).diagnostics).toContainEqual(expect.objectContaining({ code: 'INPUT_REQUIRED' }))
    }
  })

  it('returns structural diagnostics for untrusted draft JSON', () => {
    expect(() => compileAutomation({ triggers: [] } as unknown as AutomationSource, resolver))
      .toThrow(AutomationCompileError)
    expect(() => compileAutomation({
      triggers: [],
      flow: { type: 'block', id: 'flow' },
    } as unknown as AutomationSource, resolver)).toThrow(AutomationCompileError)
  })

  it('rejects retry policies for capabilities whose contract is not retry-safe', () => {
    const retrying = structuredClone(source)
    const flow = retrying.flow
    if (flow.type !== 'block' || flow.steps[0]?.type !== 'capability') throw new Error('invalid fixture')
    flow.steps[0].policy = { retry: { maxAttempts: 2 } }

    try {
      compileAutomation(retrying, resolver)
      throw new Error('expected compilation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationCompileError)
      expect((error as AutomationCompileError).diagnostics)
        .toContainEqual(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    }
  })

  it('lowers Parallel branches into deterministic Fork, scope terminals, and Join', () => {
    const parallel: AutomationSource = {
      triggers: [],
      flow: {
        type: 'parallel',
        id: 'parallel-work',
        branches: [
          {
            type: 'block',
            id: 'left-branch',
            steps: [{
              type: 'capability',
              id: 'left-send',
              capability: { id: 'test:send', version: 1 },
              input: { message: { type: 'literal', value: 'left' } },
            }],
          },
          {
            type: 'block',
            id: 'right-branch',
            steps: [{
              type: 'capability',
              id: 'right-send',
              capability: { id: 'test:send', version: 1 },
              input: { message: { type: 'literal', value: 'right' } },
            }],
          },
        ],
      },
    }

    const result = compileAutomation(parallel, resolver)
    expect(result.plan.entry).toBe('parallel-work')
    expect(result.plan.instructions['parallel-work']).toEqual({
      op: 'fork',
      id: 'parallel-work',
      mode: 'all',
      branches: ['left-send', 'right-send'],
      join: '__parallel-work.join',
    })
    expect(result.plan.instructions['left-send']).toMatchObject({
      next: '__parallel-work.branch.0.complete',
    })
    expect(result.plan.instructions['right-send']).toMatchObject({
      next: '__parallel-work.branch.1.complete',
    })
    expect(result.plan.instructions['__parallel-work.join']).toEqual({
      op: 'join',
      id: '__parallel-work.join',
      mode: 'all',
      next: '__complete',
    })
  })

  it('lowers Race into a first-success Fork and Join', () => {
    const race: AutomationSource = {
      triggers: [],
      flow: {
        type: 'race',
        id: 'fastest',
        branches: [
          { type: 'block', id: 'first-branch', steps: [] },
          { type: 'block', id: 'second-branch', steps: [] },
        ],
      },
    }
    const result = compileAutomation(race, resolver)
    expect(result.plan.instructions.fastest).toEqual({
      op: 'fork',
      id: 'fastest',
      mode: 'first_success',
      branches: ['__fastest.branch.0.complete', '__fastest.branch.1.complete'],
      join: '__fastest.join',
    })
    expect(result.plan.instructions['__fastest.join']).toEqual({
      op: 'join',
      id: '__fastest.join',
      mode: 'first_success',
      next: '__complete',
    })
  })

  it('lowers ForEach into a windowed Iterate body and Join', () => {
    const forEach: AutomationSource = {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each-message',
        items: { type: 'ref', path: 'input.messages' },
        concurrency: 3,
        body: {
          type: 'block',
          id: 'each-body',
          steps: [{
            type: 'capability',
            id: 'send-each',
            capability: { id: 'test:send', version: 1 },
            input: { message: { type: 'ref', path: 'loop.item' } },
          }],
        },
      },
    }
    const result = compileAutomation(forEach, resolver)
    expect(result.plan.entry).toBe('each-message')
    expect(result.plan.instructions['each-message']).toEqual({
      op: 'iterate',
      id: 'each-message',
      items: { type: 'ref', path: 'input.messages' },
      body: 'send-each',
      concurrency: 3,
      join: '__each-message.join',
    })
    expect(result.plan.instructions['send-each']).toMatchObject({
      next: '__each-message.iteration.complete',
    })
    expect(result.plan.instructions['__each-message.join']).toEqual({
      op: 'join',
      id: '__each-message.join',
      mode: 'iterate',
      next: '__complete',
    })
  })
})
