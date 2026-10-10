import { compileAutomation } from '@numenjs/automation'
import type { AutomationSource, NumenValue, ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { evaluateExpression, ExpressionEvaluationError, type EvaluationBindings } from '../src/evaluator.js'

const literal = (value: NumenValue): ValueExpr => ({ type: 'literal', value })
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
const call = (name: string, ...args: ValueExpr[]): ValueExpr => ({ type: 'call', function: name, arguments: args })
const bindings = (input: Record<string, NumenValue>): EvaluationBindings => ({
  run: {}, trigger: null, input, steps: {}, vars: {}, loop: {}, error: null,
})

describe('shared condition expression evaluation', () => {
  it('evaluates the compiler-preserved combination of references, arrays, templates, and core conditions', () => {
    const condition = call('core:and',
      call('core:gt', call('core:length', ref('input.records')), literal(0)),
      call('core:gte', ref('input.score'), literal(0)),
      call('core:lt', ref('input.score'), literal(10)),
      call('core:lte', call('core:length', { type: 'array', items: [literal(null), ref('input.score')] }), literal(2)),
      call('core:contains', { type: 'template', parts: ['status: ', { ref: 'input.status' }] }, literal('ready')),
    )
    const source: AutomationSource = { triggers: [], flow: {
      type: 'if', id: 'condition', condition,
      then: { type: 'block', id: 'matched', steps: [] },
      else: { type: 'block', id: 'unmatched', steps: [] },
    } }
    const plan = compileAutomation(source, { get: () => undefined }).plan
    const instruction = plan.instructions.condition
    if (instruction?.op !== 'branch') throw Error('fixture')
    expect(instruction.condition).toEqual(condition)
    const ready = { records: [{ id: 1 }], score: 0, status: 'ready' }
    expect(evaluateExpression(instruction.condition, bindings(ready))).toBe(true)
    for (const changed of [{ records: [] }, { score: -0.5 }, { score: 10 }, { status: 'Ready' }]) {
      expect(evaluateExpression(instruction.condition, bindings({ ...ready, ...changed }))).toBe(false)
    }
    for (const changed of [{ records: null }, { score: '1' }, { score: null }]) {
      expect(() => evaluateExpression(instruction.condition, bindings({ ...ready, ...changed })))
        .toThrow(ExpressionEvaluationError)
    }
    expect(source.flow).toMatchObject({ condition })
  })

  it('preserves mixed member values and reports a nested failure instead of returning a partial object', () => {
    const expression: ValueExpr = { type: 'object', entries: {
      label: { type: 'template', parts: ['Batch ', { ref: 'input.name' }] },
      count: call('core:length', ref('input.items')),
      flags: { type: 'array', items: [
        call('core:eq', call('core:length', literal('😀')), literal(1)),
        call('core:contains', ref('input.name'), literal('urgent')),
      ] },
    } }
    const input = { name: 'urgent', items: [null, { id: 1 }] }
    const original = structuredClone(input)
    expect(evaluateExpression(expression, bindings(input))).toEqual({ label: 'Batch urgent', count: 2, flags: [true, true] })
    expect(input).toEqual(original)
    expect(() => evaluateExpression(expression, bindings({ ...input, name: false })))
      .toThrow('core:contains expects string arguments')
    expect(() => evaluateExpression(expression, bindings({ name: input.name })))
      .toThrow('reference not found: input.items')
  })
})
