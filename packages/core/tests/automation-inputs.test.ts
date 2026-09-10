import { describe, expect, it } from 'vitest'
import { AutomationInputValidationError, resolveAutomationInputs, validateAutomationInputDeclarations, type AutomationSource } from '../src/index.js'

describe('Automation input contracts', () => {
  it('resolves defaults without coercing or aliasing declared values', () => {
    const inputs: AutomationSource['inputs'] = { text: { type: 'string', required: true }, count: { type: 'number', default: 0 }, enabled: { type: 'boolean', default: false }, options: { type: 'object', default: { nested: [] } }, absent: { type: 'array' } }
    const result = resolveAutomationInputs({ inputs }, { text: '' })
    expect(result).toEqual({ text: '', count: 0, enabled: false, options: { nested: [] } })
    expect(result.options).not.toBe(inputs.options!.default)
    expect(() => resolveAutomationInputs({ inputs }, { text: 'ok', count: '3' })).toThrow(AutomationInputValidationError)
  })
  it('preserves undeclared legacy inputs and treats an empty contract as closed', () => {
    expect(resolveAutomationInputs({}, { arbitrary: ['ok'] })).toEqual({ arbitrary: ['ok'] })
    expect(() => resolveAutomationInputs({ inputs: {} }, { arbitrary: 1 })).toThrow(AutomationInputValidationError)
  })
  it.each([null, [], 'text', { x: NaN }, { x: undefined }])('rejects invalid input objects: %j', input => {
    expect(() => resolveAutomationInputs({}, input)).toThrow(AutomationInputValidationError)
  })
  it('reports required, type, and unknown input errors without including submitted values', () => {
    try { resolveAutomationInputs({ inputs: { name: { type: 'string', required: true }, list: { type: 'array' } } }, { list: 'private-data', extra: true }) } catch (error) {
      expect(error).toBeInstanceOf(AutomationInputValidationError)
      expect((error as AutomationInputValidationError).issues.map(issue => issue.field)).toEqual(['extra', 'name', 'list'])
      expect(JSON.stringify(error)).not.toContain('private-data')
      return
    }
    throw Error('Expected rejection')
  })
  it.each([
    [], null, { 'with.dot': { type: 'string' } }, { constructor: { type: 'number' } },
    { value: { type: 'unknown' } }, { value: { type: 'number', default: '3' } },
    { value: { type: 'object', default: null } }, { value: { type: 'array', default: {} } },
    { value: { type: 'boolean', required: 'yes' } }, { value: { type: 'string', title: 1 } },
    { value: { type: 'string', secret: true } }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x${i}`, { type: 'string' }])),
  ])('diagnoses malformed declarations: %j', inputs => {
    expect(validateAutomationInputDeclarations(inputs).length).toBeGreaterThan(0)
  })
})
