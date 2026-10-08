import type { AutomationSource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { projectAutomationSteps } from '../src/automation-projection.js'
import { searchAutomationNodes } from '../src/automation-node-search.js'

const action = (id: string): ControlSource => ({ type: 'capability', id, capability: { id: 'mail:send', version: 3 }, input: { message: { type: 'literal', value: 'PRIVATE_ACTION_VALUE' } } })
function fixture(): AutomationSource {
  return {
    inputs: { password: { type: 'string', default: 'PRIVATE_AUTOMATION_DEFAULT' } },
    triggers: [{ id: 'daily-trigger', capability: { id: 'timer:daily', version: 2 }, config: { password: 'PRIVATE_TRIGGER_CONFIG' }, connection: 'PRIVATE_CONNECTION_ID' }],
    flow: { type: 'block', id: 'root', steps: [
      { type: 'if', id: 'check', condition: { type: 'literal', value: 'PRIVATE_CONDITION' }, then: { type: 'block', id: 'yes', steps: [action('send-first')] }, else: { type: 'block', id: 'no', steps: [
        { type: 'parallel', id: 'fan-out', branches: [{ type: 'block', id: 'parallel-branch', steps: [
          { type: 'race', id: 'first-response', branches: [{ type: 'block', id: 'race-branch', steps: [
            { type: 'foreach', id: 'each', items: { type: 'literal', value: ['PRIVATE_ITEMS'] }, body: { type: 'block', id: 'each-body', steps: [action('send-second')] } },
          ] }] },
        ] }] },
      ] } },
      { type: 'wait', id: 'pause', durationMs: { type: 'literal', value: 8675309000 } },
      { type: 'extension', id: 'unknown-extension', control: { id: 'PRIVATE_CONTROL_IDENTIFIER', version: 9 }, input: { hidden: { type: 'literal', value: { type: 'capability', id: 'PRIVATE_NESTED_FAKE_NODE', capability: { id: 'private:fake', version: 7 } } } } },
    ] },
  }
}

describe('Automation node search', () => {
  it('locates nested nodes in projection order with stable IDs despite identical display names', () => {
    const source = fixture(), steps = projectAutomationSteps(source, [], new Map([['mail:send@3', 'Send message']]))
    const results = searchAutomationNodes(source, steps, '  SEND   mail:send@3  ')
    expect(results.map(({ id, label, capability, step }) => ({ id, label, capability, projectionId: step.id }))).toEqual([
      { id: 'send-first', label: 'Send message', capability: 'mail:send@3', projectionId: 'source:send-first' },
      { id: 'send-second', label: 'Send message', capability: 'mail:send@3', projectionId: 'source:send-second' },
    ])
    expect(results[1]?.step).toBe(steps.find(step => step.sourceId === 'send-second'))
    expect(searchAutomationNodes(source, steps, 'message second').map(item => item.id)).toEqual(['send-second'])
    expect(searchAutomationNodes(source, steps, 'DAILY @2').map(item => item.id)).toEqual(['daily-trigger'])
    expect(searchAutomationNodes(source, steps, '  \n\t ').map(item => item.id)).toEqual(steps.map(step => step.sourceId))
    expect(searchAutomationNodes(source, steps, '').some(item => item.id === 'root')).toBe(false)
  })

  it('does not index summaries, inputs, config, expressions, connections, arbitrary metadata or extension payloads', () => {
    const source = fixture(), before = structuredClone(source)
    Object.assign(source, { futureMetadata: 'PRIVATE_UNKNOWN_METADATA' })
    const steps = projectAutomationSteps(source).map(step => ({ ...step, summary: `${step.summary} PRIVATE_SUMMARY_ONLY` }))
    for (const query of ['PRIVATE_ACTION_VALUE', 'PRIVATE_AUTOMATION_DEFAULT', 'PRIVATE_TRIGGER_CONFIG', 'PRIVATE_CONNECTION_ID', 'PRIVATE_CONDITION', 'PRIVATE_ITEMS', '8675309000', 'PRIVATE_CONTROL_IDENTIFIER', 'PRIVATE_NESTED_FAKE_NODE', 'private:fake', 'PRIVATE_UNKNOWN_METADATA', 'PRIVATE_SUMMARY_ONLY']) {
      expect(searchAutomationNodes(source, steps, query), query).toEqual([])
    }
    expect(searchAutomationNodes(source, steps, 'unknown extension').map(item => item.id)).toEqual(['unknown-extension'])
    expect(searchAutomationNodes(source, steps, 'unknown-extension')[0]?.capability).toBeUndefined()
    expect(source.triggers).toEqual(before.triggers)
    expect(source.flow).toEqual(before.flow)
  })

  it('never reads secret-bearing fields or summary while building its index', () => {
    const source = fixture(), steps = projectAutomationSteps(source)
    const inaccessible = () => { throw new Error('Private field was inspected') }
    Object.defineProperty(source, 'inputs', { get: inaccessible })
    Object.defineProperty(source.triggers[0]!, 'config', { get: inaccessible })
    Object.defineProperty(steps[0]!, 'summary', { get: inaccessible })
    if (source.flow.type !== 'block') throw new Error('Invalid fixture')
    const extension = source.flow.steps.find(node => node.type === 'extension')!
    Object.defineProperty(extension, 'input', { get: inaccessible })
    Object.defineProperty(extension, 'futureMetadata', { get: inaccessible })
    expect(searchAutomationNodes(source, steps, 'daily')[0]?.id).toBe('daily-trigger')
    expect(searchAutomationNodes(source, steps, 'unknown')[0]?.id).toBe('unknown-extension')
  })

  it('matches Unicode case and canonical composition while retaining original labels and identities', () => {
    const source: AutomationSource = { triggers: [], flow: { type: 'capability', id: '发送通知', capability: { id: '通知:résumé', version: 1 }, input: {} } }
    const steps = projectAutomationSteps(source, [], new Map([['通知:résumé@1', 'CAFÉ 通知']]))
    const result = searchAutomationNodes(source, steps, ' cafe\u0301 发送 RÉSUMÉ@1 ')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: '发送通知', label: 'CAFÉ 通知', capability: '通知:résumé@1' })
  })

  it('excludes stale projected IDs and refuses ambiguous Source identities without searching unknown child fields', () => {
    const source = fixture(), steps = projectAutomationSteps(source)
    if (source.flow.type !== 'block') throw new Error('Invalid fixture')
    source.flow.steps = source.flow.steps.filter(node => node.id !== 'pause')
    expect(searchAutomationNodes(source, steps, 'pause')).toEqual([])
    source.flow.steps.push(action('send-first'))
    expect(searchAutomationNodes(source, steps, 'send-first')).toEqual([])
    const future = { type: 'future-node', id: 'future', child: action('hidden-child') } as unknown as ControlSource
    source.flow.steps.push(future)
    const template = steps[0]!
    const extended = [...steps, { ...template, id: 'source:future', sourceId: 'future', label: 'Future node' }, { ...template, id: 'source:hidden-child', sourceId: 'hidden-child', label: 'Hidden child' }]
    expect(searchAutomationNodes(source, extended, 'future').map(item => item.id)).toEqual(['future'])
    expect(searchAutomationNodes(source, extended, 'hidden-child')).toEqual([])
  })
})
