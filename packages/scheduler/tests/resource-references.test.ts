import { type AutomationSource, type CorePlan, type NumenValue, type ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { assertDraftTestRequestValues, collectRunResourceIds, collectSnapshotResourceIds } from '../src/resource-references.js'

const literal = (name: string): ValueExpr => ({ type: 'literal', value: { $resource: name } })

describe('Draft test static resource discovery', () => {
  it('covers supported nested Source and IR fields, lowered-only constants, Presentation and resolved Run values', () => {
    const source: AutomationSource = {
      inputs: { file: { type: 'object', default: { $resource: 'default' } } },
      triggers: [{ id: 'trigger', capability: { id: 'test:event', version: 1 }, config: { nested: [{ $resource: 'trigger-config' }] } }],
      policy: { groupBy: { type: 'call', function: 'core:string', arguments: [literal('policy')] } },
      flow: { type: 'block', id: 'flow', steps: [
        { type: 'if', id: 'if', condition: literal('condition'), then: { type: 'block', id: 'then', steps: [
          { type: 'wait', id: 'wait', until: literal('until'), durationMs: literal('duration') },
        ] }, else: { type: 'block', id: 'else', steps: [] } },
        { type: 'parallel', id: 'parallel', branches: [{ type: 'block', id: 'branch', steps: [{ type: 'foreach', id: 'each', items: { type: 'array', items: [literal('items')] }, body: { type: 'block', id: 'body', steps: [
          { type: 'extension', id: 'extension', control: { id: 'test:extension', version: 1 }, input: { file: { type: 'object', entries: { nested: literal('extension') } } } },
        ] } }] }] },
        { type: 'race', id: 'race', branches: [{ type: 'block', id: 'race-branch', steps: [{ type: 'capability', id: 'action', capability: { id: 'test:action', version: 1 }, input: { file: literal('action') } }] }] },
      ], output: { result: literal('source-output') } },
    }
    const compiledPlan: CorePlan = { irVersion: 1, entry: 'invoke', resources: [{ $resource: 'manifest' }], instructions: {
      invoke: { op: 'invoke', id: 'invoke', capability: { id: 'test:action', version: 1 }, input: literal('lowered-invoke') },
      eval: { op: 'eval', id: 'eval', expression: literal('eval'), assign: 'file' },
      branch: { op: 'branch', id: 'branch', condition: literal('branch'), then: 'yes', else: 'no' },
      suspend: { op: 'suspend', id: 'suspend', source: 'timer', config: { until: literal('ir-until'), durationMs: literal('ir-duration') } },
      iterate: { op: 'iterate', id: 'iterate', items: literal('iterate'), body: 'body', concurrency: 1, join: 'join' },
      complete: { op: 'complete', id: 'complete', output: literal('complete') },
      fail: { op: 'fail', id: 'fail', error: literal('fail') },
    } }
    expect(collectSnapshotResourceIds({ source, compiledPlan, presentation: { nested: { file: { $resource: 'presentation' } } } })).toEqual(new Set([
      'default', 'trigger-config', 'policy', 'condition', 'until', 'duration', 'items', 'extension', 'action', 'source-output',
      'manifest', 'lowered-invoke', 'eval', 'branch', 'ir-until', 'ir-duration', 'iterate', 'complete', 'fail', 'presentation',
    ]))
    expect(collectRunResourceIds({ file: { $resource: 'default' }, nested: [{ $resource: 'input' }] }, { file: { $resource: 'trigger' } })).toEqual(new Set(['default', 'input', 'trigger']))
  })

  it('recognizes only exact ResourceRef objects and rejects excessive depth, bytes and reference counts without truncation', () => {
    expect(collectRunResourceIds({ ordinary: '$resource:fake', extra: { $resource: 'fake', name: 'ordinary' } }, null)).toEqual(new Set())
    let nested: NumenValue = null
    for (let index = 0; index < 65; index++) nested = [nested]
    expect(() => assertDraftTestRequestValues({ nested }, null)).toThrow('depth')
    expect(() => assertDraftTestRequestValues({ large: 'x'.repeat(1024 * 1024) }, null)).toThrow('size')
    expect(() => collectRunResourceIds({ files: Array.from({ length: 1001 }, (_, index) => ({ $resource: `res_${index}` })) }, null)).toThrow('resource limit')
    expect(() => assertDraftTestRequestValues({ bad: Number.NaN }, null)).toThrow('Numen values')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => assertDraftTestRequestValues(cyclic, null)).toThrow('Numen values')
  })
})
