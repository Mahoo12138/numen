import type { AutomationSource, BlockSource, CapabilitySource, ControlSource, ValueExpr } from '../../packages/core/dist/index.js'
import type { NumenConfig } from '../../packages/config/dist/index.js'

export type AutomationCapacity = 100 | 300 | 1000
export type PluginCapacity = 100 | 300

export interface AutomationCapacityFixture {
  name: string
  source: AutomationSource
  metadata: {
    /** Every ControlSource, including the root and structural slot Blocks. */
    nodeCount: number
    triggerCount: number
    maxDepth: number
    depthConvention: 'root=0'
    countsByType: Record<ControlSource['type'], number>
    targets: {
      rootId: string
      containerId: string
      deepNodeId: string
      editNodeId: string
      selectionNodeId: string
      searchNodeId: string
      referenceNodeId: string
      loopNodeId: string
    }
  }
}

const ordinal = (value: number) => String(value).padStart(4, '0')
const literal = (value: string | number | boolean): ValueExpr => ({ type: 'literal', value })
const reference = (path: string): ValueExpr => ({ type: 'ref', path })
const block = (id: string, steps: ControlSource[]): BlockSource => ({ type: 'block', id, steps })
const echo = (id: string, message: ValueExpr): CapabilitySource => ({
  type: 'capability', id, capability: { id: 'demo:echo', version: 1 }, input: { message },
})

/** A 27-node unit mixes sequential, conditional, loop and three-way branch scopes. */
function controlUnit(index: number): ControlSource[] {
  const prefix = `bench-${ordinal(index)}`
  return [
    {
      type: 'if', id: `${prefix}-if`,
      condition: { type: 'call', function: 'core:eq', arguments: [reference('input.enabled'), literal(true)] },
      then: block(`${prefix}-then`, [
        {
          type: 'foreach', id: `${prefix}-foreach`, items: reference('input.items'), concurrency: 2,
          body: block(`${prefix}-loop-body`, [
            block(`${prefix}-nested`, [echo(`${prefix}-deep`, {
              type: 'call', function: 'core:to-string', arguments: [reference('loop.item')],
            })]),
            echo(`${prefix}-loop-message`, {
              type: 'template', parts: ['Item ', { ref: 'loop.index' }, ': ', { ref: 'steps.bench-edit.message' }],
            }),
          ]),
        },
        echo(`${prefix}-then-message`, {
          type: 'template', parts: [{ ref: 'input.message' }, ' · ', { ref: 'steps.bench-edit.message' }],
        }),
      ]),
      else: block(`${prefix}-else`, [echo(`${prefix}-else-message`, reference('input.message'))]),
    },
    {
      type: 'parallel', id: `${prefix}-parallel`,
      branches: Array.from({ length: 3 }, (_, branch) => {
        const id = `${prefix}-parallel-${branch + 1}`
        return block(id, [
          echo(`${id}-seed`, { type: 'call', function: 'core:to-string', arguments: [literal(index * 10 + branch)] }),
          echo(`${id}-copy`, reference(`steps.${id}-seed.message`)),
        ])
      }),
    },
    {
      type: 'race', id: `${prefix}-race`,
      branches: Array.from({ length: 3 }, (_, branch) => {
        const id = `${prefix}-race-${branch + 1}`
        return block(id, [echo(`${id}-message`, { type: 'template', parts: [`Branch ${branch + 1}: `, { ref: 'input.message' }] })])
      }),
    },
  ]
}

function controlMetrics(root: ControlSource) {
  const countsByType: Record<ControlSource['type'], number> = { block: 0, capability: 0, if: 0, foreach: 0, parallel: 0, race: 0, wait: 0, extension: 0 }
  let nodeCount = 0, maxDepth = 0
  const visit = (node: ControlSource, depth: number): void => {
    nodeCount++; maxDepth = Math.max(maxDepth, depth); countsByType[node.type]++
    switch (node.type) {
      case 'block': node.steps.forEach(child => visit(child, depth + 1)); break
      case 'if': visit(node.then, depth + 1); if (node.else) visit(node.else, depth + 1); break
      case 'foreach': visit(node.body, depth + 1); break
      case 'parallel': case 'race': node.branches.forEach(child => visit(child, depth + 1)); break
    }
  }
  visit(root, 0)
  return { nodeCount, maxDepth, countsByType }
}

/** Pure deterministic Source data; the caller supplies demo and schedule integrations. */
export function createAutomationCapacityFixture(nodeCount: AutomationCapacity): AutomationCapacityFixture {
  if (![100, 300, 1000].includes(nodeCount)) throw new RangeError('Automation capacity must be 100, 300 or 1000')
  const root = block('bench-root', [
    echo('bench-edit', literal('Capacity fixture editable message')),
    echo('bench-selection', reference('steps.bench-edit.message')),
  ])
  const units = Math.floor((nodeCount - 3) / 27)
  for (let index = 1; index <= units; index++) root.steps.push(...controlUnit(index))
  const remainder = nodeCount - (3 + units * 27)
  for (let index = 1; index <= remainder; index++) {
    const values: ValueExpr[] = [
      literal(`Capacity tail ${index}`), reference('steps.bench-edit.message'),
      { type: 'template', parts: ['Tail: ', { ref: 'input.message' }] },
      { type: 'call', function: 'core:to-string', arguments: [literal(index)] },
    ]
    root.steps.push(echo(`bench-tail-${ordinal(index)}`, values[(index - 1) % values.length]!))
  }
  const source: AutomationSource = {
    inputs: {
      message: { type: 'string', required: true, default: 'Capacity fixture · 容量基线' },
      enabled: { type: 'boolean', default: true },
      items: { type: 'array', default: ['east', 'west'] },
    },
    triggers: [{ id: 'bench-annual', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '0 0 1 1 *', timezone: 'UTC' } }],
    flow: root,
  }
  return {
    name: `Capacity ${nodeCount} nodes`, source,
    metadata: {
      ...controlMetrics(root), triggerCount: source.triggers.length, depthConvention: 'root=0',
      targets: {
        rootId: root.id, containerId: 'bench-0001-if', deepNodeId: 'bench-0001-deep',
        editNodeId: 'bench-edit', selectionNodeId: 'bench-selection', searchNodeId: 'bench-0001-deep',
        referenceNodeId: 'bench-selection', loopNodeId: 'bench-0001-foreach',
      },
    },
  }
}

export interface PluginCapacityFixture {
  plugins: NumenConfig['plugins']
  metadata: {
    /** Includes caller-supplied base entries, instances and groups. */
    entryCount: number
    instanceCount: number
    groupCount: number
    maxGroupDepth: number
    fixtureInstanceCount: number
    targets: { entryId: string; instanceKey: string; groupId: string; deepEntryId: string; groupPathIds: string[] }
  }
}

const pluginEntryId = (key: string) => key.replace(/^~/, '').replace(/[^a-zA-Z0-9_.-]/g, '-')

function pluginMetrics(plugins: NumenConfig['plugins'], ids = new Set<string>()) {
  let instanceCount = 0, groupCount = 0, maxGroupDepth = 0
  const visit = (entries: NumenConfig['plugins'], depth: number): void => {
    for (const [key, value] of Object.entries(entries)) {
      const id = pluginEntryId(key)
      if (ids.has(id)) throw new TypeError(`Duplicate configured entry ID: ${id}`)
      ids.add(id)
      const normalized = key.replace(/^~/, '')
      if (normalized.startsWith('group:')) {
        groupCount++; maxGroupDepth = Math.max(maxGroupDepth, depth + 1)
        visit(value?.plugins as NumenConfig['plugins'], depth + 1)
      } else instanceCount++
    }
  }
  visit(plugins, 0)
  return { entryCount: instanceCount + groupCount, instanceCount, groupCount, maxGroupDepth }
}

/**
 * Three independent six-group chains and local no-op plugin instances. Pass the
 * Runtime's core entries as basePlugins so 100/300 means the actual configured
 * total, rather than that many fixture entries plus an unreported bootstrap.
 * The external module receives { label, enabled, settings: { value, retries } }.
 */
export function createPluginCapacityFixture(entryCount: PluginCapacity, modulePath: string, basePlugins: NumenConfig['plugins'] = {}): PluginCapacityFixture {
  if (![100, 300].includes(entryCount)) throw new RangeError('Plugin capacity must be 100 or 300')
  if (!modulePath.trim()) throw new TypeError('A local fixture module path is required')
  const plugins = structuredClone(basePlugins)
  const configuredIds = new Set<string>()
  const base = pluginMetrics(plugins, configuredIds)
  if (base.maxGroupDepth > 6) throw new RangeError('Base plugins exceed the six-group depth')
  const fixtureInstanceCount = entryCount - base.entryCount - 18
  if (fixtureInstanceCount < 1) throw new RangeError('Base plugins leave no room for the capacity fixture')
  const destinations: NumenConfig['plugins'][] = [plugins]
  const groupPathIds: string[] = []
  let deepDestination: NumenConfig['plugins'] = plugins
  for (let branch = 1; branch <= 3; branch++) {
    let parent = plugins
    for (let depth = 1; depth <= 6; depth++) {
      const key = `group:bench-fixture:${branch}:${depth}`
      if (configuredIds.has(pluginEntryId(key))) throw new TypeError(`Reserved fixture key already exists: ${key}`)
      configuredIds.add(pluginEntryId(key))
      const children: NumenConfig['plugins'] = {}
      parent[key] = { $label: `Capacity group ${branch} / ${depth}`, $collapsed: false, plugins: children }
      parent = children; destinations.push(children)
      if (branch === 1) groupPathIds.push(`group-bench-fixture-${branch}-${depth}`)
    }
    if (branch === 1) deepDestination = parent
  }
  for (let index = 1; index <= fixtureInstanceCount; index++) {
    const key = `bench:fixture:${ordinal(index)}`
    const destination = index === 1 ? deepDestination : destinations[index % destinations.length]!
    if (configuredIds.has(pluginEntryId(key))) throw new TypeError(`Reserved fixture key already exists: ${key}`)
    configuredIds.add(pluginEntryId(key))
    destination[key] = {
      $package: modulePath, $label: `Capacity instance ${ordinal(index)}`,
      label: `Fixture ${ordinal(index)}`, enabled: true, settings: { value: `local-${ordinal(index)}`, retries: index % 4 },
    }
  }
  return {
    plugins,
    metadata: {
      ...pluginMetrics(plugins), fixtureInstanceCount,
      targets: {
        entryId: 'bench-fixture-0001', instanceKey: 'bench:fixture:0001',
        groupId: groupPathIds.at(-1)!, deepEntryId: 'bench-fixture-0001', groupPathIds,
      },
    },
  }
}
