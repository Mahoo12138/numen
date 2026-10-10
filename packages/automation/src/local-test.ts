import {
  evaluateExpression, resolveAutomationInputs,
  type CoreInstruction, type CorePlan, type GraphEdge, type LocalTestPreview, type LocalTestRequest, type OutputSample, type ValueExpr,
} from '@numenjs/core'
import type { PreparedDraftTestSnapshot } from './service.js'
import { assertSampleValue, dataHash, OutputSampleError, sampleContract, sampleContractHash, validateFrozenValue } from './output-samples.js'

export class LocalTestError extends Error {
  override name = 'LocalTestError'
  constructor(public readonly code: string, message: string) { super(message) }
}

function references(expression: ValueExpr): string[] {
  switch (expression.type) {
    case 'ref': return [expression.path]
    case 'template': return expression.parts.flatMap(part => typeof part === 'string' ? [] : [part.ref])
    case 'array': return expression.items.flatMap(references)
    case 'object': return Object.values(expression.entries).flatMap(references)
    case 'call': return expression.arguments.flatMap(references)
    default: return []
  }
}

export function buildLocalTest(prepared: PreparedDraftTestSnapshot, request: LocalTestRequest, samples: OutputSample[]): { preview: LocalTestPreview; plan: CorePlan } {
  if (request.mode !== 'to-node' && request.mode !== 'only-node') throw new LocalTestError('LOCAL_TEST_MODE', 'Unknown local test mode.')
  if (!Array.isArray(request.sampleIds) || request.sampleIds.length > 1024 || new Set(request.sampleIds).size !== request.sampleIds.length) throw new LocalTestError('LOCAL_TEST_SAMPLES', 'Choose unique output samples.')
  assertSampleValue(request.input, true)
  assertSampleValue(request.trigger, true)
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) throw new LocalTestError('LOCAL_TEST_INPUT', 'Test input must be an object.')
  const graph = prepared.source.flow
  if (graph.type !== 'graph') throw new LocalTestError('LOCAL_TEST_GRAPH_REQUIRED', 'Local testing requires a root Graph.')
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const target = nodes.get(request.targetNodeId)
  if (target?.type !== 'capability') throw new LocalTestError('LOCAL_TEST_SCOPE_UNSUPPORTED', 'Local testing requires an ordinary Capability subgraph; loop-internal targets are unsupported.')
  const selectedSamples = new Map<string, OutputSample>()
  for (const sample of samples) {
    if (sample.automationId !== request.automationId || !request.sampleIds.includes(sample.id) || selectedSamples.has(sample.nodeId)) throw new LocalTestError('LOCAL_TEST_SAMPLES', 'A node may use only one sample from this Automation.')
    if (sample.nodeId === target.id) throw new LocalTestError('LOCAL_TEST_TARGET_SAMPLED', 'The target must execute and cannot be replaced by a sample.')
    const contract = sampleContract(prepared, sample.nodeId)
    if (sample.integrity !== 'complete' || sample.contractHash !== sampleContractHash(contract)
      || sample.contractHash !== sampleContractHash(sample.contract) || sample.valueHash !== dataHash(sample.value)) {
      throw new OutputSampleError('SAMPLE_STALE', 'Sample integrity or its capability contract no longer matches.')
    }
    assertSampleValue(sample.value)
    validateFrozenValue(sample.value, contract.outputSchema)
    selectedSamples.set(sample.nodeId, sample)
  }
  if (samples.length !== request.sampleIds.length) throw new OutputSampleError('SAMPLE_NOT_FOUND', 'A selected sample was deleted or is unavailable.')
  const scope = new Set<string>()
  const inputs = new Map<string, string[]>()
  const visit = (nodeId: string): void => {
    if (nodeId === graph.id || scope.has(nodeId)) return
    const node = nodes.get(nodeId)
    if (node?.type !== 'capability') throw new LocalTestError('LOCAL_TEST_SCOPE_UNSUPPORTED', 'Local testing requires an ordinary Capability subgraph; Condition, Merge, and ForEach boundaries are unsupported.')
    scope.add(nodeId)
    if (selectedSamples.has(nodeId)) return
    const instruction = prepared.compiledPlan.instructions[nodeId]
    if (instruction?.op !== 'invoke') throw new LocalTestError('LOCAL_TEST_SCOPE_UNSUPPORTED', 'An ordinary Capability instruction is required.')
    const refs = references(instruction.input)
    inputs.set(nodeId, refs)
    for (const edge of graph.edges) if (edge.to.nodeId === nodeId) visit(edge.from.nodeId)
    for (const path of refs) if (path.startsWith('steps.')) visit(path.split('.')[1]!)
  }
  visit(target.id)
  if (samples.some(sample => !scope.has(sample.nodeId))) throw new LocalTestError('LOCAL_TEST_SAMPLE_UNUSED', 'A selected sample is outside the requested dependency closure.')
  const called = [...scope].filter(nodeId => !selectedSamples.has(nodeId)).sort()
  if (request.mode === 'only-node' && (called.length !== 1 || called[0] !== target.id)) throw new LocalTestError('LOCAL_TEST_INPUT_REQUIRED', 'Only-node testing requires fixed samples for every upstream dependency and referenced output.')
  const resolvedInput = resolveAutomationInputs(prepared.source, request.input)
  if (request.mode === 'only-node') {
    if (inputs.get(target.id)!.some(path => !path.startsWith('steps.') && !path.startsWith('input.') && !path.startsWith('trigger.'))) {
      throw new LocalTestError('LOCAL_TEST_INPUT_UNFIXED', 'Only-node inputs must be fixed by samples, Automation inputs, or the test trigger.')
    }
    const instruction = prepared.compiledPlan.instructions[target.id] as Extract<CoreInstruction, { op: 'invoke' }>
    try {
      const value = evaluateExpression(instruction.input, { input: resolvedInput, trigger: request.trigger,
        steps: Object.fromEntries(samples.map(sample => [sample.nodeId, sample.value])), run: {}, vars: {}, loop: {}, error: null })
      validateFrozenValue(value, sampleContract(prepared, target.id).inputSchema)
    } catch { throw new LocalTestError('LOCAL_TEST_INPUT_INVALID', 'Fixed target input does not satisfy its capability contract.') }
  }
  const edges: GraphEdge[] = []
  const endpoints = new Set<string>()
  const add = (edge: GraphEdge): void => {
    const key = JSON.stringify([edge.from, edge.to])
    if (!endpoints.has(key)) { endpoints.add(key); edges.push(edge) }
  }
  for (const edge of graph.edges) if (scope.has(edge.to.nodeId) && !selectedSamples.has(edge.to.nodeId)
    && (edge.from.nodeId === graph.id || scope.has(edge.from.nodeId))) add(structuredClone(edge))
  for (const nodeId of scope) {
    if (selectedSamples.has(nodeId)) add({ id: `__sample-${nodeId}`, from: { nodeId: graph.id, port: 'start' }, to: { nodeId, port: 'in' } })
    else for (const path of inputs.get(nodeId) ?? []) if (path.startsWith('steps.')) {
      const producer = path.split('.')[1]!
      add({ id: `__reference-${producer}-${nodeId}`, from: { nodeId: producer, port: 'out' }, to: { nodeId, port: 'in' } })
    }
  }
  const instructions: Record<string, CoreInstruction> = {
    [graph.id]: { op: 'graph_scope', id: graph.id, version: 1, members: [...scope].sort(), edges: edges.sort((a, b) =>
      JSON.stringify([a.from, a.to]).localeCompare(JSON.stringify([b.from, b.to]))).map((edge, index) => ({ ...edge, id: `__local-edge-${index}` })),
      output: { type: 'ref', path: `steps.${target.id}` }, next: '__complete' },
    __complete: { op: 'complete', id: '__complete', output: { type: 'ref', path: `steps.${graph.id}` } },
  }
  for (const nodeId of [...scope].sort()) {
    const sample = selectedSamples.get(nodeId)
    instructions[nodeId] = sample ? { op: 'graph_value', id: nodeId, sampleId: sample.id, value: structuredClone(sample.value) }
      : structuredClone(prepared.compiledPlan.instructions[nodeId]!)
  }
  const fixedRequest = structuredClone({ ...request, sampleIds: [...request.sampleIds].sort() })
  const fixedSamples = structuredClone([...samples].sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
  const calls: LocalTestPreview['calls'] = called.map(nodeId => {
    const contract = sampleContract(prepared, nodeId)
    return { nodeId, capability: { id: contract.id, version: contract.version }, sideEffect: contract.semantics.sideEffect,
      retrySafe: contract.semantics.retrySafe, inputValidation: request.mode === 'only-node' ? 'validated' : 'runtime' }
  })
  const details = { request: fixedRequest,
    scope: { version: 1 as const, request: fixedRequest, mode: request.mode, targetNodeId: target.id, sourceContentHash: prepared.contentHash, nodeIds: [...scope].sort(), samples: fixedSamples },
    calls, substitutions: fixedSamples.map(sample => ({ nodeId: sample.nodeId, sampleId: sample.id, provenance: sample.provenance, createdAt: sample.createdAt })),
    externalWrites: calls.filter(call => call.sideEffect).map(call => call.nodeId) }
  const plan: CorePlan = { irVersion: 2, entry: graph.id, instructions }
  return { preview: { ...details, previewHash: dataHash({ ...details, plan }) }, plan }
}
