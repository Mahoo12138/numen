import type { AutomationSource, GraphSource } from '@numenjs/core'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { GraphNodeFocus } from '../src/GraphNodeFocus.js'
import { completeInspectedValue, graphContainingNode, graphFocusInputSources, observedValuePaths } from '../src/graph-node-focus-model.js'
import { captureConnectionReturn, connectionReturnAdapters, connectionReturnError } from '../src/automation-connection-return.js'
import { projectMagicVariables } from '../src/automation-variable-catalog.js'
import type { WorkbenchAutomationConnectionOption, WorkbenchAutomationInsertCatalog, WorkbenchAutomationVariableCatalog, WorkbenchConnectionAdapter } from '../src/contracts.js'

const node = (id: string) => ({ type: 'capability' as const, id, capability: { id: 'demo:echo', version: 1 }, input: {} })
const edge = (id: string, from: string, to: string, port = 'out') => ({ id, from: { nodeId: from, port }, to: { nodeId: to, port: 'in' } })
const source: AutomationSource = { triggers: [], inputs: { title: { type: 'string' } }, flow: { type: 'graph', id: 'graph', version: 1,
  nodes: [node('upstream'), node('target'), node('disconnected'), { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: { type: 'graph', id: 'body', version: 1, nodes: [node('inner'), node('inner-later')], edges: [edge('inner-start', 'body', 'inner', 'start')], output: { type: 'literal', value: null } } }],
  edges: [edge('start', 'graph', 'upstream', 'start'), edge('to-target', 'upstream', 'target'), edge('to-loop', 'upstream', 'loop')],
} }
const graph = source.flow as GraphSource
const catalog: WorkbenchAutomationInsertCatalog = { items: [{ kind: 'capability', capability: { id: 'demo:echo', version: 1 }, capabilityKind: 'query', semantics: { retrySafe: true }, title: 'Echo', providerAvailable: true,
  inputSchemaSupported: true, inputFields: [{ name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true }], connectionSlots: ['account'], connectionRequirements: [{ name: 'account', required: true, accepts: ['demo:account@1'] }],
}], connections: [] }
const variables: WorkbenchAutomationVariableCatalog = { definitions: [{ capability: { id: 'demo:echo', version: 1 }, capabilityKind: 'query', title: 'Echo', outputSchemaSupported: true, outputFields: [
  { path: [], label: 'Output', valueType: 'object', schemaType: 'object' }, { path: ['message'], label: 'Message', valueType: 'string', schemaType: 'string' }, { path: ['dynamic'], label: 'Dynamic', valueType: 'unknown', schemaType: 'any' },
] }] }
const connection: WorkbenchAutomationConnectionOption = { id: 'new-connection', name: 'New', typeId: 'demo:account', typeVersion: 1, adapterId: 'demo:adapter', adapterVersion: 1, enabled: false, adapterAvailable: true, status: 'DISABLED' }

describe('Graph node workspace data boundaries', () => {
  it('groups actual upstream inputs by named port and uses runtime reference paths without an invented output segment', () => {
    expect(graphFocusInputSources(source, 'target', catalog, variables)).toEqual([{ nodeId: 'upstream', title: 'Echo', ports: ['out → in'], fields: [
      { path: 'steps.upstream', label: 'Output', type: 'object', verified: true }, { path: 'steps.upstream.message', label: 'Message', type: 'string', verified: true }, { path: 'steps.upstream.dynamic', label: 'Dynamic', type: 'any', verified: false },
    ] }])
    expect(graphFocusInputSources(source, 'upstream', catalog, variables)).toEqual([])
    expect(graphContainingNode(source, 'inner')?.id).toBe('body')
    expect(graphContainingNode(source, 'body')?.id).toBe('body')
    expect(graphContainingNode(source, 'loop')?.id).toBe('graph')
    const available = graphFocusInputSources(source, 'target', catalog, variables, true)
    expect(available.find(item => item.nodeId === 'disconnected')).toMatchObject({ needsDependency: true, ports: [] })
    expect(available.find(item => item.nodeId === 'upstream')).not.toHaveProperty('needsDependency')
    expect(available.some(item => item.nodeId === 'target')).toBe(false)
  })

  it('treats null and empty arrays as complete values while refusing hidden, missing or truncated copies', () => {
    for (const value of [null, [], {}, '', false]) expect(completeInspectedValue({ value, available: true, hidden: 0, truncated: false })).toBe(true)
    for (const state of [{ available: false, hidden: 0, truncated: false }, { available: true, hidden: 1, truncated: false }, { available: true, hidden: 0, truncated: true }]) expect(completeInspectedValue({ value: '[Redacted]', ...state })).toBe(false)
    expect(observedValuePaths({ messages: [null, { label: 'ok' }], 'literal.dot': 1, '': 2 }, 'steps.node').map(item => item.path)).toEqual(['steps.node', 'steps.node.messages', 'steps.node.messages.0', 'steps.node.messages.1', 'steps.node.messages.1.label'])
    expect(observedValuePaths(Array.from({ length: 200 }, (_, index) => index), 'steps.node')).toHaveLength(100)
  })

  it('shows contracts and the existing parameter renderer without requiring any run', async () => {
    const markup = await renderToString(createSSRApp(() => h(GraphNodeFocus, { automationId: 'automation', nodeId: 'target', source, draftVersion: 7, draftDirty: true, canEdit: true, catalog, variableCatalog: variables, parameters: h('label', 'existing expression fields'), onClose: () => true })))
    expect(markup).toContain('existing expression fields')
    expect(markup).toContain('steps.upstream.message')
    expect(markup).toContain('input.title')
    expect(markup).toContain('steps.target.message')
    expect(markup).toContain('No execution reference selected')
    expect(markup).toContain('Dynamic path — not verified')
    expect(markup).not.toContain('steps.target.output.message')
  })

  it('projects Graph candidates independently of node array order and flags missing dependencies without inventing edges', () => {
    const before = structuredClone(source)
    const field = { name: 'message', label: 'Message', type: 'json' as const, schemaType: 'any', required: false }
    const values = projectMagicVariables({ source, nodeId: 'target', catalog: variables, field, mode: 'reference', includeUnavailable: true })
    expect(values.find(item => item.path === 'steps.upstream.message')).toMatchObject({ sourceNodeId: 'upstream' })
    expect(values.find(item => item.path === 'steps.upstream.message')).not.toHaveProperty('warning')
    expect(values.find(item => item.path === 'steps.disconnected.message')).toMatchObject({ warning: 'missing-dependency' })
    expect(values.find(item => item.path === 'steps.upstream.dynamic')).toMatchObject({ warning: 'dynamic-path' })
    expect(values.find(item => item.path === 'steps.inner.message')).toMatchObject({ unavailableReason: 'out-of-scope' })
    expect(values.find(item => item.path === 'steps.target.message')).toMatchObject({ unavailableReason: 'out-of-scope' })
    const reordered = { ...source, flow: { ...graph, nodes: [...graph.nodes].reverse() } }
    const paths = (value: AutomationSource) => projectMagicVariables({ source: value, nodeId: 'target', catalog: variables, field, mode: 'reference' }).map(item => [item.path, item.warning]).sort()
    expect(paths(reordered)).toEqual(paths(source))
    expect(source).toEqual(before)
  })

  it('inherits only visible outer dependencies inside loops and leaves sibling scopes unavailable', () => {
    const field = { name: 'value', label: 'Value', type: 'json' as const, schemaType: 'any', required: false }
    const values = projectMagicVariables({ source, nodeId: 'inner', catalog: variables, field, mode: 'reference', includeUnavailable: true })
    expect(values.find(item => item.path === 'steps.upstream.message')).not.toHaveProperty('unavailableReason')
    expect(values.find(item => item.path === 'steps.target.message')).toMatchObject({ unavailableReason: 'out-of-scope' })
    expect(values.find(item => item.path === 'steps.inner-later.message')).toMatchObject({ warning: 'missing-dependency' })
    expect(values.find(item => item.path === 'loop.item')).not.toHaveProperty('unavailableReason')
    const loopInput = projectMagicVariables({ source, nodeId: 'loop', catalog: variables, field, mode: 'reference', includeUnavailable: true })
    expect(loopInput.find(item => item.path === 'loop.item')).toMatchObject({ unavailableReason: 'requires-loop' })
  })
})

describe('Connection create and repair return guards', () => {
  it('returns only to the same Automation, node, contract, Slot and original binding', () => {
    const ticket = captureConnectionReturn('automation', source, catalog, 'target', 'account')!
    expect(ticket).toEqual({ automationId: 'automation', nodeId: 'target', slotName: 'account', capability: { id: 'demo:echo', version: 1 }, originalBinding: undefined })
    expect(connectionReturnError(ticket, 'automation', source, catalog, connection)).toBeUndefined()
    const modifiedInput = structuredClone(source), target = (modifiedInput.flow as GraphSource).nodes.find(item => item.id === 'target')!
    if (target.type === 'capability') target.input = { message: { type: 'literal', value: 'unrelated parameter edit' } }
    expect(connectionReturnError(ticket, 'automation', modifiedInput, catalog, connection)).toBeUndefined()
    if (target.type === 'capability') target.connections = { account: 'chosen-elsewhere' }
    expect(connectionReturnError(ticket, 'automation', modifiedInput, catalog, connection)).toBe('targetChanged')
    expect(connectionReturnError(ticket, 'different', source, catalog, connection)).toBe('targetChanged')
    expect(connectionReturnError(ticket, 'automation', { ...source, flow: { ...graph, nodes: graph.nodes.filter(item => item.id !== 'target') } }, catalog, connection)).toBe('targetChanged')
    expect(connectionReturnError(ticket, 'automation', source, { ...catalog, items: [] }, connection)).toBe('targetChanged')
    expect(connectionReturnError(ticket, 'automation', source, catalog, { ...connection, typeVersion: 2 })).toBe('incompatible')
    expect(connectionReturnError(ticket, 'automation', source, catalog, undefined)).toBe('incompatible')
  })

  it('handles repair of the legacy default binding and reevaluates changed type requirements', () => {
    const legacy = structuredClone(source), target = (legacy.flow as GraphSource).nodes.find(item => item.id === 'target')!
    if (target.type === 'capability') target.connection = 'old-connection'
    const ticket = captureConnectionReturn('automation', legacy, catalog, 'target', 'account')!
    expect(ticket.originalBinding).toBe('old-connection')
    expect(connectionReturnError(ticket, 'automation', legacy, catalog, { ...connection, id: 'old-connection' })).toBeUndefined()
    const changed = structuredClone(catalog)
    const definition = changed.items[0]!
    if (definition.kind === 'capability') definition.connectionRequirements[0]!.accepts = ['another:type']
    expect(connectionReturnError(ticket, 'automation', legacy, changed, connection)).toBe('incompatible')
    expect(captureConnectionReturn('automation', legacy, catalog, 'target', 'deleted-slot')).toBeUndefined()
    const adapters = [{ id: 'matching', typeId: 'demo:account', typeVersion: 1 }, { id: 'wrong-version', typeId: 'demo:account', typeVersion: 2 }] as WorkbenchConnectionAdapter[]
    expect(connectionReturnAdapters(ticket, legacy, catalog, adapters).map(item => item.id)).toEqual(['matching'])
    expect(connectionReturnAdapters(ticket, legacy, changed, adapters)).toEqual([])
  })
})
