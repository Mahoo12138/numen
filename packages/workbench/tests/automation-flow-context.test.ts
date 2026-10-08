import type { AutomationSource, BlockSource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { automationCollapsibleIds, automationContainerPath, automationFlowContainers } from '../src/automation-flow-context.js'

const block = (id: string, steps: ControlSource[] = []): BlockSource => ({ type: 'block', id, steps })
const leaf = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 10 } })
function fixture(): AutomationSource {
  return { triggers: [{ id: 'timer', capability: { id: 'clock:tick', version: 1 }, config: {} }], flow: block('root', [
    leaf('first'),
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: block('yes', [
      { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [block('nested', [leaf('deep')])]) },
    ]), else: block('no') },
    { type: 'parallel', id: 'parallel', branches: [block('left', [leaf('parallel-leaf')]), block('right', [
      { type: 'race', id: 'race', branches: [block('winner', [leaf('race-leaf')]), block('runner-up')] },
    ])] },
    { type: 'extension', id: 'unknown', control: { id: 'uninstalled:control', version: 1 }, input: { hidden: { type: 'literal', value: { type: 'block', id: 'opaque-container', steps: [] } } } },
  ]) }
}
const ids = (source: AutomationSource, id: string) => automationContainerPath(source, id).map(item => item.node.id)

describe('Automation flow container context', () => {
  it('records Source-order structure, nearest parents, fixed slots and branch positions', () => {
    const source = fixture(), entries = automationFlowContainers(source)
    expect(entries.map(({ node, ...context }) => ({ id: node.id, type: node.type, ...context }))).toEqual([
      { id: 'root', type: 'block', role: 'root' },
      { id: 'condition', type: 'if', role: 'block', parentId: 'root' },
      { id: 'yes', type: 'block', role: 'then', parentId: 'condition' },
      { id: 'loop', type: 'foreach', role: 'block', parentId: 'yes' },
      { id: 'body', type: 'block', role: 'body', parentId: 'loop' },
      { id: 'nested', type: 'block', role: 'block', parentId: 'body' },
      { id: 'no', type: 'block', role: 'else', parentId: 'condition' },
      { id: 'parallel', type: 'parallel', role: 'block', parentId: 'root' },
      { id: 'left', type: 'block', role: 'branch', parentId: 'parallel', branchIndex: 0 },
      { id: 'right', type: 'block', role: 'branch', parentId: 'parallel', branchIndex: 1 },
      { id: 'race', type: 'race', role: 'block', parentId: 'right' },
      { id: 'winner', type: 'block', role: 'branch', parentId: 'race', branchIndex: 0 },
      { id: 'runner-up', type: 'block', role: 'branch', parentId: 'race', branchIndex: 1 },
    ])
    expect(entries[0]?.node).toBe(source.flow)
    if (source.flow.type !== 'block') throw new Error('Invalid fixture')
    expect(entries[1]?.node).toBe(source.flow.steps[1])
  })

  it('locates structural nodes themselves and leaf ancestors without treating triggers as flow children', () => {
    const source = fixture()
    expect(ids(source, 'root')).toEqual(['root'])
    expect(ids(source, 'first')).toEqual(['root'])
    expect(ids(source, 'condition')).toEqual(['root', 'condition'])
    expect(ids(source, 'body')).toEqual(['root', 'condition', 'yes', 'loop', 'body'])
    expect(ids(source, 'deep')).toEqual(['root', 'condition', 'yes', 'loop', 'body', 'nested'])
    expect(ids(source, 'race-leaf')).toEqual(['root', 'parallel', 'right', 'race', 'winner'])
    expect(ids(source, 'unknown')).toEqual(['root'])
    for (const id of ['timer', 'missing', '', 'opaque-container']) expect(ids(source, id)).toEqual([])
  })

  it('restricts batch folding to descendants and never falls back for missing, removed or leaf scopes', () => {
    const source = fixture()
    const all = automationFlowContainers(source).map(item => item.node.id)
    expect(automationCollapsibleIds(source)).toEqual(all.slice(1))
    expect(automationCollapsibleIds(source, 'root')).toEqual(all.slice(1))
    expect(automationCollapsibleIds(source, 'condition')).toEqual(['yes', 'loop', 'body', 'nested', 'no'])
    expect(automationCollapsibleIds(source, 'body')).toEqual(['nested'])
    expect(automationCollapsibleIds(source, 'parallel')).toEqual(['left', 'right', 'race', 'winner', 'runner-up'])
    for (const id of ['timer', 'missing', '', 'unknown', 'deep', 'no']) expect(automationCollapsibleIds(source, id)).toEqual([])
    if (source.flow.type !== 'block') throw new Error('Invalid fixture')
    source.flow.steps = source.flow.steps.filter(node => node.id !== 'condition')
    expect(automationCollapsibleIds(source, 'condition')).toEqual([])
    expect(ids(source, 'deep')).toEqual([])
  })

  it('includes non-Block structural roots for folding while excluding their identity from scoped descendants', () => {
    const source: AutomationSource = { triggers: [], flow: { type: 'if', id: 'single', condition: { type: 'literal', value: true }, then: block('then', [leaf('child')]) } }
    expect(automationFlowContainers(source).map(({ node, ...context }) => ({ id: node.id, ...context }))).toEqual([
      { id: 'single', role: 'root' }, { id: 'then', parentId: 'single', role: 'then' },
    ])
    expect(automationCollapsibleIds(source)).toEqual(['single', 'then'])
    expect(automationCollapsibleIds(source, 'single')).toEqual(['then'])
    expect(ids(source, 'child')).toEqual(['single', 'then'])
    const flat: AutomationSource = { triggers: [], flow: leaf('single-leaf') }
    expect(automationFlowContainers(flat)).toEqual([])
    expect(automationCollapsibleIds(flat)).toEqual([])
    expect(ids(flat, 'single-leaf')).toEqual([])
  })

  it('keeps Source and unknown extension payloads opaque, including future node fields', () => {
    const source = fixture(), before = structuredClone(source)
    const inaccessible = () => { throw new Error('Opaque payload was read') }
    if (source.flow.type !== 'block') throw new Error('Invalid fixture')
    const unknown = source.flow.steps.find(node => node.id === 'unknown')!
    Object.defineProperty(unknown, 'input', { get: inaccessible })
    Object.defineProperty(source, 'inputs', { get: inaccessible })
    Object.defineProperty(source.triggers[0]!, 'config', { get: inaccessible })
    const future = { type: 'future', id: 'future' } as unknown as ControlSource
    Object.defineProperty(future, 'children', { get: inaccessible })
    source.flow.steps.push(future)
    Object.freeze(source.flow.steps); Object.freeze(source.flow); Object.freeze(source)
    expect(automationFlowContainers(source).map(item => item.node.id)).not.toContain('opaque-container')
    expect(ids(source, 'unknown')).toEqual(['root'])
    expect(ids(source, 'future')).toEqual(['root'])
    expect(automationCollapsibleIds(source, 'unknown')).toEqual([])
    expect(source.flow.steps[0]).toEqual(before.flow.type === 'block' ? before.flow.steps[0] : undefined)
    expect(source.flow.steps).toHaveLength(5)
  })
})
