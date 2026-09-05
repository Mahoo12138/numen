import type { AutomationSource, CoreControlSource, ExtensionControlDefinition } from '@numen/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/index.js'

const definition: ExtensionControlDefinition = {
  kind: 'extension', id: 'test:pause', version: 2, title: 'Pause twice', description: 'Two durable waits',
  input: z.object({ milliseconds: z.number().min(0).required() }),
  lower: ({ nodeId, input }) => ({ type: 'block', id: nodeId, steps: [
    { type: 'wait', id: `${nodeId}.first`, durationMs: input.milliseconds! },
    { type: 'wait', id: `${nodeId}.second`, durationMs: input.milliseconds! },
  ] }),
}
const source: AutomationSource = { triggers: [], flow: {
  type: 'extension', id: 'pause', control: { id: definition.id, version: 2 },
  input: { milliseconds: { type: 'literal', value: 5 } },
} }
const capabilities = { get: () => undefined }
function compile(input = source, control = definition) {
  return compileAutomation(input, capabilities, undefined, { get: ref => ref.id === control.id && ref.version === control.version ? control : undefined })
}
function diagnostics(action: () => unknown) {
  try { action() } catch (error) {
    expect(error).toBeInstanceOf(AutomationCompileError)
    return (error as AutomationCompileError).diagnostics
  }
  throw new Error('Expected compile failure')
}

describe('extension Control compilation', () => {
  it('emits deterministic core-only IR with versioned contracts and authored Source mappings', () => {
    const result = compile()
    expect(compile()).toEqual(result)
    expect(result.plan.entry).toBe('pause.first')
    expect(result.plan.instructions['pause.first']).toMatchObject({ op: 'suspend', next: 'pause.second' })
    expect(result.plan.sourceMap).toEqual({ 'pause.first': { nodeId: 'pause' }, 'pause.second': { nodeId: 'pause' } })
    expect(result.dependencyManifest.controls).toEqual([{ id: 'test:pause', version: 2 }])
    expect(result.contractSnapshot.controls).toEqual([expect.objectContaining({ id: 'test:pause', version: 2, title: 'Pause twice', inputSchema: expect.any(Object) })])
    expect(source.flow.type).toBe('extension')
  })

  it('requires the exact plugin version and validates inputs before calling lower', () => {
    expect(diagnostics(() => compile(source, { ...definition, version: 1 }))).toContainEqual(expect.objectContaining({ code: 'CONTROL_UNAVAILABLE', source: { nodeId: 'pause', fieldPath: 'control' } }))
    const invalid = structuredClone(source)
    if (invalid.flow.type !== 'extension') throw new Error('fixture')
    invalid.flow.input.milliseconds = { type: 'literal', value: -1 }
    let invoked = false
    expect(diagnostics(() => compile(invalid, { ...definition, lower: () => { invoked = true; throw Error() } }))).toContainEqual(expect.objectContaining({ code: 'INPUT_SCHEMA_INVALID', source: { nodeId: 'pause', fieldPath: 'input.milliseconds' } }))
    expect(invoked).toBe(false)
  })

  it('passes frozen cloned expressions and sanitizes plugin errors without changing Source', () => {
    const before = structuredClone(source)
    const problems = diagnostics(() => compile(source, { ...definition, lower: ({ input }) => {
      expect(Object.isFrozen(input.milliseconds)).toBe(true)
      input.milliseconds!.type = 'ref'
      throw Error('private plugin detail')
    } }))
    expect(source).toEqual(before)
    expect(problems).toContainEqual(expect.objectContaining({ code: 'CONTROL_LOWER_FAILED', source: { nodeId: 'pause' } }))
    expect(JSON.stringify(problems)).not.toContain('private plugin detail')
  })

  it.each(['foreign-id', 'nested-extension', 'cycle', 'async', 'oversized'] as const)('rejects %s lowering output', kind => {
    const lower = (): CoreControlSource => {
      if (kind === 'foreign-id') return { type: 'wait', id: 'another-source', durationMs: { type: 'literal', value: 0 } }
      if (kind === 'nested-extension') return source.flow as CoreControlSource
      if (kind === 'async') return Promise.resolve({}) as never
      if (kind === 'oversized') return { type: 'block', id: 'pause', steps: Array.from({ length: 257 }, (_, i) => ({ type: 'block', id: `pause.${i}`, steps: [] })) }
      const block: CoreControlSource = { type: 'block', id: 'pause', steps: [] }
      block.steps.push(block)
      return block
    }
    expect(diagnostics(() => compile(source, { ...definition, lower }))).toContainEqual(expect.objectContaining({ code: 'CONTROL_LOWER_FAILED' }))
  })

  it('maps diagnostics in generated controls back to the authored extension', () => {
    expect(diagnostics(() => compile(source, { ...definition, lower: () => ({ type: 'block', id: 'pause', steps: [
      { type: 'wait', id: 'pause.child', durationMs: { type: 'literal', value: -10 } },
    ] }) }))).toContainEqual(expect.objectContaining({ code: 'WAIT_DURATION_INVALID', source: { nodeId: 'pause' } }))
  })
})
