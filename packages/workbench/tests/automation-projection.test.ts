import type { AutomationSource, NumenValue, ValueExpr } from '@numenjs/core'
import { describe, expect, it, vi } from 'vitest'
import { projectAutomationSteps } from '../src/automation-projection.js'

describe('Automation Source projection', () => {
  it('keeps unavailable extension nodes and their inputs intact with a recoverable Unknown Control label', () => {
    const source: AutomationSource = { triggers: [], flow: { type: 'extension', id: 'custom', control: { id: 'test:pause', version: 2 }, input: { value: { type: 'literal', value: 5 } } } }
    const before = structuredClone(source)
    expect(projectAutomationSteps(source)[0]).toMatchObject({ sourceId: 'custom', label: 'Unknown Control', summary: 'Control · test:pause@2' })
    expect(projectAutomationSteps(source, [], new Map([['control:test:pause@2', 'Pause']]))[0]?.label).toBe('Pause')
    expect(source).toEqual(before)
  })

  it('derives a stable read-only step list from structured Source', () => {
    const source: AutomationSource = {
      triggers: [{
        id: 'daily-trigger',
        capability: { id: 'numen.trigger.schedule', version: 1 },
        config: { cron: '0 7 * * *' },
      }],
      flow: {
        type: 'block',
        id: 'root',
        steps: [{
          type: 'if',
          id: 'check-weather',
          condition: { type: 'ref', path: 'trigger.rain' },
          then: {
            type: 'block',
            id: 'rainy-path',
            steps: [{
              type: 'capability',
              id: 'send-alert',
              capability: { id: 'slack.message.send', version: 2 },
              connection: 'conn_slack',
              input: {},
            }],
          },
          else: {
            type: 'block',
            id: 'dry-path',
            steps: [{
              type: 'wait',
              id: 'wait-one-minute',
              durationMs: { type: 'literal', value: 60_000 },
            }],
          },
        }],
      },
    }

    expect(projectAutomationSteps(source).map(item => ({
      id: item.id,
      kind: item.kind,
      depth: item.depth,
      summary: item.summary,
    }))).toEqual([
      { id: 'trigger:daily-trigger', kind: 'trigger', depth: 0, summary: 'Trigger · numen.trigger.schedule@1' },
      { id: 'source:check-weather', kind: 'if', depth: 0, summary: 'If · trigger.rain' },
      { id: 'source:rainy-path', kind: 'block', depth: 1, summary: '1 step' },
      { id: 'source:send-alert', kind: 'capability', depth: 2, summary: 'Capability · slack.message.send@2 · conn_slack' },
      { id: 'source:dry-path', kind: 'block', depth: 1, summary: '1 step' },
      { id: 'source:wait-one-minute', kind: 'wait', depth: 2, summary: 'Wait · 60000' },
    ])
  })

  it('projects an empty root block as an empty Canvas rather than a shadow node', () => {
    expect(projectAutomationSteps({
      triggers: [],
      flow: { type: 'block', id: 'root', steps: [] },
    })).toEqual([])
  })

  it('uses registry presentation metadata without changing Source identity', () => {
    const steps = projectAutomationSteps({
      triggers: [],
      flow: {
        type: 'capability',
        id: 'capability-1',
        capability: { id: 'demo:weather', version: 1 },
        input: {},
      },
    }, [], new Map([['demo:weather@1', 'Weather lookup']]))

    expect(steps[0]).toMatchObject({
      sourceId: 'capability-1',
      label: 'Weather lookup',
      summary: 'Capability · demo:weather@1',
    })
  })
})


describe('compact literal expression summaries', () => {
  const conditional = (condition: ValueExpr): AutomationSource => ({ triggers: [], flow: {
    type: 'if', id: 'condition', condition, then: { type: 'block', id: 'then', steps: [] },
  } })

  it('describes large arrays and nested objects only by shape while retaining the full Source values', () => {
    const samples: Array<{ value: NumenValue; summary: string }> = [
      { value: Array.from({ length: 1000 }, (_, index) => ({ private: `ARRAY_CANARY_${index}`, nested: [index, 'HIDDEN_ARRAY_TEXT'] })), summary: 'If · 1000 item array' },
      { value: { PRIVATE_FIELD_CANARY: { deep: ['OBJECT_CANARY', { secret: 'HIDDEN_OBJECT_TEXT' }] }, other: Array.from({ length: 100 }, () => 'NESTED_CANARY') }, summary: 'If · 2 field object' },
      { value: [], summary: 'If · 0 item array' },
      { value: {}, summary: 'If · 0 field object' },
    ]
    for (const { value, summary } of samples) {
      const source = conditional({ type: 'literal', value }), before = structuredClone(source)
      const steps = projectAutomationSteps(source)
      expect(steps[0]?.summary).toBe(summary)
      expect(JSON.stringify(steps)).not.toMatch(/CANARY|HIDDEN_/)
      expect(source).toEqual(before)
      expect((source.flow as Extract<typeof source.flow, { type: 'if' }>).condition).toEqual({ type: 'literal', value })
    }
  })

  it('never evaluates object fields, array members or a serialization accessor to build a compact summary', () => {
    const member = vi.fn(() => { throw new Error('PRIVATE_GETTER_MUST_NOT_RUN') })
    const object = Object.defineProperties({}, {
      private: { get: member, enumerable: true },
      second: { value: { nested: 'OBJECT_CANARY' }, enumerable: true },
      toJSON: { get: member, enumerable: false },
    }) as NumenValue
    const array = new Array<NumenValue>(3)
    Object.defineProperty(array, '0', { get: member, enumerable: true })
    Object.defineProperty(array, 'toJSON', { get: member, enumerable: false })
    const objectDescriptor = Object.getOwnPropertyDescriptor(object, 'private')
    const arrayDescriptor = Object.getOwnPropertyDescriptor(array, '0')
    expect(projectAutomationSteps(conditional({ type: 'literal', value: object }))[0]?.summary).toBe('If · 2 field object')
    expect(projectAutomationSteps(conditional({ type: 'literal', value: array }))[0]?.summary).toBe('If · 3 item array')
    expect(member).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(object, 'private')).toEqual(objectDescriptor)
    expect(Object.getOwnPropertyDescriptor(array, '0')).toEqual(arrayDescriptor)
    expect(array.length).toBe(3)
  })

  it('uses the same translation callback for literal containers and structured array/object expressions', () => {
    const translate = vi.fn((key: string, params?: Record<string, string | number>) => {
      if (key === 'workbench.projection.array') return `数组(${params?.count})`
      if (key === 'workbench.projection.object') return `对象(${params?.count})`
      if (key === 'workbench.projection.if') return '条件'
      return key
    })
    for (const condition of [
      { type: 'literal', value: [1, 2] },
      { type: 'array', items: [{ type: 'literal', value: 1 }, { type: 'literal', value: 2 }] },
    ] as ValueExpr[]) expect(projectAutomationSteps(conditional(condition), [], new Map(), translate)[0]?.summary).toBe('条件 · 数组(2)')
    for (const condition of [
      { type: 'literal', value: { private: 1 } },
      { type: 'object', entries: { private: { type: 'literal', value: 1 } } },
    ] as ValueExpr[]) expect(projectAutomationSteps(conditional(condition), [], new Map(), translate)[0]?.summary).toBe('条件 · 对象(1)')
    expect(translate).toHaveBeenCalledWith('workbench.projection.array', { count: 2 })
    expect(translate).toHaveBeenCalledWith('workbench.projection.object', { count: 1 })
  })

  it.each([
    [{ type: 'literal', value: 'visible text' }, 'If · "visible text"'],
    [{ type: 'literal', value: 42 }, 'If · 42'],
    [{ type: 'literal', value: true }, 'If · true'],
    [{ type: 'literal', value: false }, 'If · false'],
    [{ type: 'literal', value: null }, 'If · null'],
    [{ type: 'ref', path: 'input.value' }, 'If · input.value'],
    [{ type: 'literal', value: 'x'.repeat(60) }, `If · "${'x'.repeat(40)}…`],
  ] as Array<[ValueExpr, string]>)('retains existing primitive/reference summary for %j', (condition, summary) => {
    expect(projectAutomationSteps(conditional(condition))[0]?.summary).toBe(summary)
  })
})
