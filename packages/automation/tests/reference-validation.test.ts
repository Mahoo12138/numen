import type { AutomationSource, BlockSource, CapabilityDefinition, ControlSource, ExtensionControlDefinition, ValueExpr } from '@numenjs/core'
import z from 'schemastery'
import { describe, expect, it, vi } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/index.js'

const definition: CapabilityDefinition = {
  id: 'test:value', version: 1, kind: 'action', title: 'Value',
  input: z.object({ value: z.any().required() }), output: z.object({ value: z.any() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}
const resolver = { get: () => ({ definition, providerAvailable: true }) }
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
const literal: ValueExpr = { type: 'literal', value: 1 }
const action = (id: string, value: ValueExpr = literal): ControlSource => ({
  type: 'capability', id, capability: { id: definition.id, version: 1 }, input: { value },
})
const block = (id: string, ...steps: ControlSource[]): BlockSource => ({ type: 'block', id, steps })
const source = (...steps: ControlSource[]): AutomationSource => ({ triggers: [], flow: block('flow', ...steps) })
function errors(candidate: AutomationSource, extension?: ExtensionControlDefinition) {
  try {
    compileAutomation(candidate, resolver, undefined, extension ? { get: () => extension } : undefined)
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationCompileError)
    return (error as AutomationCompileError).diagnostics
  }
  throw new Error('Expected compilation to fail')
}

describe('compile-time reference availability', () => {
  it('accepts prior outputs in the same block and ancestor outputs inside nested scopes', () => {
    const candidate = source(action('before'), block('nested', action('inside', ref('steps.before.value'))), {
      type: 'foreach', id: 'each', items: ref('input.items'),
      body: block('body', action('local', ref('loop.item')), {
        type: 'parallel', id: 'fork', branches: [
          block('left', action('use-local', ref('steps.local.value'))),
          block('right', action('use-outer', ref('steps.before.value'))),
        ],
      }),
    })
    expect(compileAutomation(candidate, resolver).plan.instructions['use-local']).toMatchObject({ op: 'invoke' })
  })

  it.each([
    ['missing', source(action('consumer', ref('steps.deleted.value'))), 'STEP_REFERENCE_MISSING'],
    ['forward', source(action('consumer', ref('steps.producer.value')), action('producer')), 'STEP_REFERENCE_NOT_READY'],
    ['self', source(action('consumer', ref('steps.consumer.value'))), 'STEP_REFERENCE_NOT_READY'],
    ['non-output', source({ type: 'wait', id: 'pause', durationMs: literal }, action('consumer', ref('steps.pause.value'))), 'STEP_REFERENCE_NO_OUTPUT'],
    ['dotted ID', source(action('producer.child'), action('consumer', ref('steps.producer.child.value'))), 'STEP_REFERENCE_UNADDRESSABLE'],
  ])('rejects %s references and identifies the input field', (_name, candidate, code) => {
    expect(errors(candidate as AutomationSource)).toContainEqual(expect.objectContaining({
      code, source: { nodeId: 'consumer', fieldPath: 'input.value' },
    }))
  })

  it('preserves evaluator first-segment semantics when a dotted ID is ambiguous', () => {
    expect(() => compileAutomation(source(action('producer'), action('producer.child'), action('consumer', ref('steps.producer.child.value'))), resolver)).not.toThrow()
  })

  it.each(['parallel', 'race'] as const)('isolates sibling %s branches', type => {
    expect(errors(source({ type, id: 'fork', branches: [
      block('left', action('producer')), block('right', action('consumer', ref('steps.producer.value'))),
    ] }))).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE' }))
  })

  it.each(['block', 'if', 'foreach', 'parallel', 'race'] as const)('does not leak outputs from a nested %s', type => {
    const body = block('body', action('producer'))
    const nested: ControlSource = type === 'block' ? body
      : type === 'if' ? { type, id: 'nested', condition: { type: 'literal', value: true }, then: body }
      : type === 'foreach' ? { type, id: 'nested', items: ref('input.items'), body }
      : { type, id: 'nested', branches: [body, block('other')] }
    expect(errors(source(nested, action('consumer', ref('steps.producer.value'))))).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE' }))
  })

  it('isolates then and else outputs', () => {
    expect(errors(source({ type: 'if', id: 'choice', condition: { type: 'literal', value: true },
      then: block('yes', action('producer')), else: block('no', action('consumer', ref('steps.producer.value'))),
    }))).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE' }))
  })

  it('traverses object, array, call, and template expressions with precise locations', () => {
    const candidate = source(action('consumer', { type: 'object', entries: {
      nested: { type: 'array', items: [{ type: 'call', function: 'core:to-string', arguments: [ref('steps.missing.value')] }] },
      text: { type: 'template', parts: ['Value: ', { ref: 'steps.missing.value' }] },
      opaque: { type: 'literal', value: { type: 'ref', path: 'steps.literal.value' } },
    } }))
    const problems = errors(candidate)
    expect(problems).toHaveLength(2)
    expect(problems.map(item => item.source?.fieldPath)).toEqual(['input.value.nested.0.arguments.0', 'input.value.text.parts.1'])
  })

  it('checks Wait, If, and ForEach expression fields', () => {
    const problems = errors(source(
      { type: 'wait', id: 'duration', durationMs: ref('steps.missing.value') },
      { type: 'wait', id: 'until', until: ref('steps.missing.value') },
      { type: 'if', id: 'choice', condition: ref('steps.missing.value'), then: block('then') },
      { type: 'foreach', id: 'each', items: ref('steps.missing.value'), body: block('body') },
    ))
    expect(problems.map(item => item.source?.fieldPath)).toEqual(['durationMs', 'until', 'condition', 'items'])
  })

  it('rejects flow outputs in admission policy without rejecting other binding roots', () => {
    const candidate = source(action('producer', ref('trigger.payload.value')))
    candidate.policy = { groupBy: ref('steps.producer.value') }
    expect(errors(candidate)).toContainEqual(expect.objectContaining({
      code: 'STEP_REFERENCE_NOT_READY', source: { nodeId: '__policy', fieldPath: 'policy.groupBy' },
    }))
    candidate.policy.groupBy = ref('input.group')
    expect(() => compileAutomation(candidate, resolver)).not.toThrow()
  })

  it('limits loop bindings to the body, including nested loops', () => {
    expect(errors(source({ type: 'foreach', id: 'each', items: ref('loop.item'), body: block('body') })))
      .toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_OUT_OF_SCOPE', source: { nodeId: 'each', fieldPath: 'items' } }))
    expect(errors(source(action('outside', ref('loop.index')))))
      .toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_OUT_OF_SCOPE' }))
    expect(errors(source({ type: 'foreach', id: 'each', items: ref('input.items'), body: block('body', action('bad', ref('loop.unknown'))) })))
      .toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_INVALID' }))
    expect(() => compileAutomation(source({ type: 'foreach', id: 'each', items: ref('input.items'), body: block('body', {
      type: 'foreach', id: 'nested', items: ref('loop.item.children'), body: block('nested-body', action('item', ref('loop.item')), action('index', ref('loop.index'))),
    }) }), resolver)).not.toThrow()
  })

  it('checks lowered expressions once and maps plugin-generated diagnostics to the authored node', () => {
    const lower = vi.fn(() => ({ type: 'wait' as const, id: 'extension', durationMs: ref('steps.missing.value') }))
    const extension: ExtensionControlDefinition = { kind: 'extension', id: 'test:pause', version: 1, title: 'Pause', input: z.object({}), lower }
    const candidate = source({ type: 'extension', id: 'extension', control: { id: extension.id, version: 1 }, input: {} })
    expect(errors(candidate, extension)).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_MISSING', source: { nodeId: 'extension' } }))
    expect(lower).toHaveBeenCalledTimes(1)
  })

  it('reports invalid extension inputs at authored fields without duplicate lowering errors', () => {
    const extension: ExtensionControlDefinition = { kind: 'extension', id: 'test:pause', version: 1, title: 'Pause', input: z.object({ duration: z.any() }),
      lower: ({ nodeId, input }) => ({ type: 'wait', id: nodeId, durationMs: input.duration! }),
    }
    const candidate = source({ type: 'extension', id: 'extension', control: { id: extension.id, version: 1 }, input: { duration: ref('steps.missing.value') } })
    expect(errors(candidate, extension)).toEqual([expect.objectContaining({ code: 'STEP_REFERENCE_MISSING', source: { nodeId: 'extension', fieldPath: 'input.duration' } })])
  })
})
