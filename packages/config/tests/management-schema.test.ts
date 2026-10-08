import { describe, expect, it, vi } from 'vitest'
import { inspectHostConfigSchema } from '../src/management-schema.js'

const string = (meta = {}) => ({ type: 'string', meta })
const object = (dict: Record<string, unknown>) => ({ type: 'object', dict, meta: {} })
const constant = (value: unknown) => ({ type: 'const', value, meta: {} })

describe('public configuration schema projection', () => {
  it('projects a bounded pure DTO with scalar, enum, object and array metadata while withholding all defaults', () => {
    const schema = object({
      endpoint: string({ required: true, default: 'withheld-default', description: 'Destination URL', title: 'Destination' }),
      attempts: { type: 'number', meta: { min: 0, max: 10, step: 1 } },
      enabled: { type: 'boolean', meta: {} },
      mode: { type: 'union', list: [constant('fast'), constant(2), constant(false), constant(null)], meta: {} },
      section: object({ labels: { type: 'array', inner: string(), meta: { default: ['withheld-array'] } } }),
    })
    const output = inspectHostConfigSchema(schema)
    expect(output.sensitive).toBe(false)
    expect(output.schema).toMatchObject({ type: 'object', fields: [
      { name: 'endpoint', label: 'Destination', type: 'string', required: true, hasDefault: true, description: 'Destination URL' },
      { name: 'attempts', type: 'number', min: 0, max: 10, step: 1 },
      { name: 'enabled', type: 'boolean' },
      { name: 'mode', type: 'enum', options: [{ value: 'fast' }, { value: 2 }, { value: false }, { value: null }] },
      { name: 'section', type: 'object', fields: [{ name: 'labels', type: 'array', item: { type: 'string' }, hasDefault: true }] },
    ] })
    expect(JSON.stringify(output)).not.toContain('withheld')
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  })

  it('inspects callable schema metadata without invoking functions, builders or serialization hooks', () => {
    const invoked = vi.fn(() => { throw new Error('must never run') })
    const schema = Object.assign(invoked, object({ dynamic: { type: 'transform', inner: string(), callback: invoked }, handler: { type: 'function', meta: {} } }), { toJSON: invoked, builder: invoked })
    expect(inspectHostConfigSchema(schema).schema).toMatchObject({ type: 'object', fields: [{ name: 'dynamic', type: 'json', fallbackReason: 'unsupported' }, { name: 'handler', type: 'json' }] })
    expect(invoked).not.toHaveBeenCalled()
    expect(JSON.stringify(inspectHostConfigSchema(schema))).not.toContain('callback')
    expect(inspectHostConfigSchema(invoked).schema).toBeDefined()
    expect(inspectHostConfigSchema(() => ({})).schema).toBeUndefined()
  })

  it.each([
    object({ accessCode: string({ role: 'secret', default: 'never-expose' }) }),
    object({ nested: object({ apiKey: string() }) }),
    { type: 'union', list: [object({ visible: string() }), object({ passphrase: string({ role: 'secret' }) })] },
    { type: 'array', inner: object({ session: string({ role: 'secret' }) }) },
    { type: 'transform', inner: object({ cookie: string() }), callback() {} },
  ])('withholds entire metadata for schema-declared or named secrets even when no value exists', schema => {
    expect(inspectHostConfigSchema(schema)).toEqual({ sensitive: true, schema: undefined })
  })

  it('omits credential fragments, non-finite bounds and runtime objects in display metadata', () => {
    const output = inspectHostConfigSchema(object({ field: string({
      title: 'password=private-title', description: 'https://alice:private-description@example.com',
      min: Infinity, max: new Date(), step: () => 1, default: { secret: 'private-default' },
      extra: Buffer.from('node-object'), link: 'https://alice:private-link@example.com',
    }) }))
    expect(output.schema?.fields?.[0]).toEqual({ name: 'field', label: 'field', type: 'string', required: false, hasDefault: true })
    expect(JSON.stringify(output)).not.toContain('private')
    expect(inspectHostConfigSchema({ type: 'union', list: [constant('safe'), constant('Bearer private-choice')] }).schema).toEqual({ type: 'json', required: false, fallbackReason: 'unsafe-metadata' })
  })

  it('does not invoke accessor metadata or leak config when classification is unknowable', () => {
    const access = vi.fn(() => string({ role: 'secret' }))
    const dict = Object.defineProperty({}, 'value', { enumerable: true, get: access })
    const meta = Object.defineProperty({}, 'role', { get: access })
    expect(inspectHostConfigSchema(object(dict)).schema).toBeUndefined()
    expect(inspectHostConfigSchema({ type: 'string', meta }).schema).toBeUndefined()
    expect(inspectHostConfigSchema({ type: 'lazy', builder: access }).schema).toBeUndefined()
    expect(access).not.toHaveBeenCalled()
  })

  it('bounds cycles and shared schemas without executing or expanding them indefinitely', () => {
    const recursive = object({})
    recursive.dict.child = recursive
    const shared = string()
    expect(inspectHostConfigSchema(recursive).schema?.fields?.[0]).toMatchObject({ type: 'json', fallbackReason: 'cycle' })
    expect(inspectHostConfigSchema(object({ first: shared, second: shared })).schema?.fields?.map(field => field.type)).toEqual(['string', 'string'])
  })

  it('uses explicit bounded fallback for large objects and metadata and rejects unclassifiable depth', () => {
    expect(inspectHostConfigSchema(object(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, string()])))).schema).toEqual({ type: 'json', required: false, fallbackReason: 'limit' })
    const large = object(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, string({ description: 'x'.repeat(3000) })])))
    expect(inspectHostConfigSchema(large).schema).toEqual({ type: 'json', required: false, fallbackReason: 'limit' })
    const wideCharacters = object(Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field${index}`, string({ description: '字'.repeat(2048) })])))
    expect(inspectHostConfigSchema(wideCharacters).schema).toEqual({ type: 'json', required: false, fallbackReason: 'limit' })
    let deep = object({ value: string() })
    for (let index = 0; index < 15; index++) deep = object({ section: deep })
    expect(inspectHostConfigSchema(deep).schema).toBeUndefined()
  })

  it('merges only disjoint static object intersections, retaining local JSON fallback for unsupported fields', () => {
    const merged = inspectHostConfigSchema({ type: 'intersect', list: [object({ name: string() }), object({ extra: { type: 'dict', inner: string() } })] })
    expect(merged.schema).toMatchObject({ type: 'object', fields: [{ name: 'name', type: 'string' }, { name: 'extra', type: 'json', fallbackReason: 'unsupported' }] })
    for (const list of [[object({ name: string() }), object({ name: string() })], [object({ name: string() }), { type: 'transform', inner: string() }]]) {
      expect(inspectHostConfigSchema({ type: 'intersect', list }).schema).toMatchObject({ type: 'json', fallbackReason: 'unsupported' })
    }
    expect(inspectHostConfigSchema({ type: 'union', list: [object({ name: string() }), object({ count: { type: 'number' } })] }).schema).toMatchObject({ type: 'json', fallbackReason: 'unsupported' })
  })
})
