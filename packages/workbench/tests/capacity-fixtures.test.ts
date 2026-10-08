import { compileAutomation, AutomationCompileError } from '@numenjs/automation'
import { createRuntimeEntries, flattenRuntimeEntries, validateConfig, type NumenConfig } from '@numenjs/config'
import type { CapabilityDefinition, CapabilitySource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { createAutomationCapacityFixture, createPluginCapacityFixture, type AutomationCapacity } from '../../../benchmarks/workbench/fixtures.js'
import { echoCapability } from '../../integration-demo/src/index.js'
import { scheduleCronTrigger } from '../../integration-schedule/src/index.js'
import { evaluateExpression, type EvaluationBindings } from '../../scheduler/src/evaluator.js'

const definitions = new Map<string, CapabilityDefinition>([
  ['demo:echo@1', echoCapability], ['schedule:cron@1', scheduleCronTrigger],
])
const resolver = {
  get(ref: { id: string; version: number }) {
    const definition = definitions.get(`${ref.id}@${ref.version}`)
    return definition ? { definition, providerAvailable: true } : undefined
  },
}

/** Independent breadth-first traversal: count actual Source slots, not projected rows. */
function controls(root: ControlSource) {
  const queue = [{ node: root, depth: 0 }]
  for (let index = 0; index < queue.length; index++) {
    const { node, depth } = queue[index]!
    const children = node.type === 'block' ? node.steps
      : node.type === 'if' ? [node.then, ...(node.else ? [node.else] : [])]
        : node.type === 'foreach' ? [node.body]
          : node.type === 'parallel' || node.type === 'race' ? node.branches : []
    queue.push(...children.map(child => ({ node: child, depth: depth + 1 })))
  }
  return queue
}

function capability(nodes: ReturnType<typeof controls>, id: string): CapabilitySource {
  const node = nodes.find(item => item.node.id === id)?.node
  if (node?.type !== 'capability') throw Error(`Expected a Capability target: ${id}`)
  return node
}

describe('Workbench fixed capacity fixtures', () => {
  it.each([100, 300, 1000] as const)('creates a deterministic, publishable %i-node tree with real nested branches', size => {
    const fixture = createAutomationCapacityFixture(size), { source, metadata } = fixture
    const nodes = controls(source.flow), ids = nodes.map(({ node }) => node.id)
    expect(nodes).toHaveLength(size)
    expect(new Set([...ids, ...source.triggers.map(trigger => trigger.id)]).size).toBe(size + 1)
    expect(Math.max(...nodes.map(item => item.depth))).toBe(6)
    expect(metadata).toMatchObject({ nodeCount: size, maxDepth: 6, triggerCount: 1, depthConvention: 'root=0' })
    expect(metadata.countsByType).toEqual({
      block: size === 100 ? 31 : size === 300 ? 111 : 361,
      capability: size === 100 ? 57 : size === 300 ? 145 : 495,
      if: Math.floor((size - 3) / 27), foreach: Math.floor((size - 3) / 27),
      parallel: Math.floor((size - 3) / 27), race: Math.floor((size - 3) / 27), wait: 0, extension: 0,
    })
    for (const { node } of nodes) {
      if (node.type === 'if') expect(node.else?.steps.length).toBeGreaterThan(0)
      if (node.type === 'parallel' || node.type === 'race') {
        expect(node.branches).toHaveLength(3)
        expect(node.branches.every(branch => branch.steps.length > 0)).toBe(true)
      }
    }
    expect(source.flow.type).toBe('block')
    if (source.flow.type !== 'block') throw Error('Expected root Block')
    expect(source.flow.steps[0]).toMatchObject({ id: metadata.targets.editNodeId, type: 'capability', input: { message: { type: 'literal', value: expect.any(String) } } })
    expect(source.flow.steps[1]?.id).toBe(metadata.targets.selectionNodeId)
    expect(nodes.find(item => item.node.id === metadata.targets.deepNodeId)?.depth).toBe(6)
    for (const id of Object.values(metadata.targets)) expect(ids).toContain(id)
    expect(createAutomationCapacityFixture(size)).toEqual(fixture)
    const before = JSON.stringify(source), compiled = compileAutomation(source, resolver)
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.plan.entry).toBe(metadata.targets.editNodeId)
    expect(compiled.dependencyManifest.capabilities.map(item => item.id).sort()).toEqual(['demo:echo', 'schedule:cron'])
    expect(JSON.stringify(source)).toBe(before)
  })

  it('resolves Literal, previous-step Ref, template and loop Call values with the real evaluator', () => {
    const { source, metadata } = createAutomationCapacityFixture(1000), nodes = controls(source.flow)
    const bindings: EvaluationBindings = {
      run: {}, trigger: {}, vars: {}, error: null, steps: {}, loop: { item: 'east', index: 1 },
      input: Object.fromEntries(Object.entries(source.inputs!).map(([name, declaration]) => [name, declaration.default!])),
    }
    const value = (id: string) => evaluateExpression(capability(nodes, id).input.message!, bindings)
    const edited = value(metadata.targets.editNodeId)
    expect(edited).toBe('Capacity fixture editable message')
    bindings.steps[metadata.targets.editNodeId] = { message: edited }
    expect(value(metadata.targets.referenceNodeId)).toBe(edited)
    expect(value(metadata.targets.deepNodeId)).toBe('east')
    expect(value('bench-0001-loop-message')).toBe('Item 1: Capacity fixture editable message')
    expect(value('bench-0001-then-message')).toBe('Capacity fixture · 容量基线 · Capacity fixture editable message')
  })

  it('detects illegal branch and loop references in fixture mutations rather than accepting placeholder bindings', () => {
    const { source } = createAutomationCapacityFixture(100), nodes = controls(source.flow)
    capability(nodes, 'bench-0001-parallel-2-copy').input.message = { type: 'ref', path: 'steps.bench-0001-parallel-1-seed.message' }
    capability(nodes, 'bench-selection').input.message = { type: 'ref', path: 'loop.item' }
    expect.assertions(2)
    try { compileAutomation(source, resolver) } catch (error) {
      expect(error).toBeInstanceOf(AutomationCompileError)
      expect((error as AutomationCompileError).diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['STEP_REFERENCE_OUT_OF_SCOPE', 'LOOP_REFERENCE_OUT_OF_SCOPE']))
    }
  })

  it.each([100, 300] as const)('counts the actual %i configured entries including bootstrap entries and groups', size => {
    const basePlugins: NumenConfig['plugins'] = {
      database: { path: ':memory:' }, capabilities: {}, console: {},
      server: { host: '127.0.0.1', port: 0 }, workbench: {}, demo: {},
    }
    const original = structuredClone(basePlugins)
    const fixture = createPluginCapacityFixture(size, '/temporary/capacity-plugin.mjs', basePlugins)
    const { metadata } = fixture
    const config = validateConfig({ version: 2, dataDir: 'data', plugins: fixture.plugins })
    const entries = flattenRuntimeEntries(createRuntimeEntries(config, new Set(Object.keys(basePlugins))))
    const groups = entries.filter(entry => entry.children), instances = entries.filter(entry => !entry.children)
    expect(entries).toHaveLength(size)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(size)
    expect(metadata).toMatchObject({ entryCount: size, groupCount: 18, instanceCount: size - 18, fixtureInstanceCount: size - 24, maxGroupDepth: 6 })
    expect(groups).toHaveLength(metadata.groupCount)
    expect(instances).toHaveLength(metadata.instanceCount)
    expect(groups.every(group => group.collapsed === false)).toBe(true)
    const target = entries.find(entry => entry.id === metadata.targets.entryId)!
    expect(target).toMatchObject({ key: metadata.targets.instanceKey, parentId: metadata.targets.groupId, name: '/temporary/capacity-plugin.mjs', effectiveEnabled: true,
      config: { label: 'Fixture 0001', enabled: true, settings: { value: 'local-0001', retries: 1 } } })
    const ancestors: string[] = []
    for (let parent = target.parentId; parent; parent = entries.find(entry => entry.id === parent)?.parentId) ancestors.unshift(parent)
    expect(ancestors).toEqual(metadata.targets.groupPathIds)
    expect(ancestors).toHaveLength(6)
    expect(instances.filter(entry => entry.id.startsWith('bench-fixture-'))).toHaveLength(metadata.fixtureInstanceCount)
    expect(basePlugins).toEqual(original)
    expect(createPluginCapacityFixture(size, '/temporary/capacity-plugin.mjs', basePlugins)).toEqual(fixture)
    fixture.plugins.database!.path = 'changed'
    expect(basePlugins).toEqual(original)
  })

  it('accounts for nested base groups and never adds bootstrap counts on top of the target', () => {
    const fixture = createPluginCapacityFixture(100, '/temporary/fixture.mjs', { 'group:existing': { plugins: { existing: {} } } })
    expect(fixture.metadata).toMatchObject({ entryCount: 100, groupCount: 19, instanceCount: 81, fixtureInstanceCount: 80, maxGroupDepth: 6 })
    expect(createPluginCapacityFixture(300, '/temporary/fixture.mjs').metadata).toMatchObject({ entryCount: 300, groupCount: 18, instanceCount: 282, fixtureInstanceCount: 282 })
    expect(() => validateConfig({ version: 2, dataDir: 'data', plugins: fixture.plugins })).not.toThrow()
  })

  it('rejects mislabeled sizes, ID collisions and bootstrap trees that cannot fit the fixed fixture', () => {
    expect(() => createAutomationCapacityFixture(99 as AutomationCapacity)).toThrow(RangeError)
    expect(() => createPluginCapacityFixture(100, '')).toThrow(TypeError)
    expect(() => createPluginCapacityFixture(100, '/temporary/fixture.mjs', { 'bench-fixture-0001': {} })).toThrow('Reserved fixture key')
    expect(() => createPluginCapacityFixture(100, '/temporary/fixture.mjs', { 'group:bench-fixture:1:6': { plugins: {} } })).toThrow('Reserved fixture key')
    const tooLarge = Object.fromEntries(Array.from({ length: 82 }, (_, index) => [`base:${index}`, {}]))
    expect(() => createPluginCapacityFixture(100, '/temporary/fixture.mjs', tooLarge)).toThrow(RangeError)
    let tooDeep: NumenConfig['plugins'] = { base: {} }
    for (let index = 1; index <= 7; index++) tooDeep = { [`group:base-${index}`]: { plugins: tooDeep } }
    expect(() => createPluginCapacityFixture(100, '/temporary/fixture.mjs', tooDeep)).toThrow(RangeError)
  })
})
