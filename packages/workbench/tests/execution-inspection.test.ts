import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { inspectExecutionValue } from '../src/execution-inspection.js'

const visible = <T extends z>(schema: T): T => schema.extra('extra', { numen: { execution: 'public' } }) as T
const snapshot = (schema: z): unknown => JSON.parse(JSON.stringify(schema.toJSON()))

describe('Execution inspection classification', () => {
  it('uses frozen leaf opt-ins, suppresses secret carriers despite opt-in, and never reveals unknown keys', () => {
    const schema = snapshot(z.object({
      text: visible(z.string()), number: visible(z.number()), ordinary: z.string(),
      password: visible(z.string()), accessToken: visible(z.string()), cookie: visible(z.string()),
      key: visible(z.string().role('secret')),
      private: z.string().extra('extra', { numen: { execution: 'sensitive' } }),
      nested: visible(z.object({ shown: visible(z.boolean()), unknown: z.string() })),
      arbitrary: visible(z.any()), dict: visible(z.dict(visible(z.string()))),
      headers: z.object({ Authorization: visible(z.string()), 'Set-Cookie': visible(z.string()) }),
    }))
    const result = inspectExecutionValue({ text: '<img src=x onerror=alert(1)>', number: 42, ordinary: 'UNKNOWN_SECRET',
      password: 'PASSWORD_SECRET', accessToken: 'TOKEN_SECRET', cookie: 'COOKIE_SECRET', key: 'ROLE_SECRET', private: 'META_SECRET',
      nested: { shown: true, unknown: 'NESTED_SECRET' }, arbitrary: 'ANY_SECRET', dict: { innocent: 'DICT_SECRET' },
      headers: { Authorization: 'AUTH_SECRET', 'Set-Cookie': 'SETCOOKIE_SECRET' },
      'UNKNOWN_KEY_SECRET': 'UNDECLARED_SECRET',
    }, schema)
    expect(result.value).toMatchObject({ text: '<img src=x onerror=alert(1)>', number: 42, nested: { shown: true } })
    expect(result.hidden).toBe(12)
    expect(JSON.stringify(result)).not.toContain('_SECRET')
    expect(result.truncated).toBe(false)
  })

  it('keeps absent metadata, missing contracts, public containers, resources and mismatched types opaque', () => {
    expect(inspectExecutionValue('unknown data', undefined).hidden).toBe(1)
    expect(inspectExecutionValue(undefined, undefined).available).toBe(false)
    const result = inspectExecutionValue({ data: { $resource: 'RESOURCE_SECRET' }, wrong: { token: 'WRONG_SECRET' }, nested: { value: 'INHERITED_SECRET' } },
      snapshot(visible(z.object({ data: visible(z.object({ $resource: visible(z.string()) })), wrong: visible(z.string()), nested: z.object({ value: z.string() }) }))))
    expect(JSON.stringify(result)).not.toContain('_SECRET')
    expect(result.hidden).toBe(3)
    expect(inspectExecutionValue('ignored', undefined, true)).toMatchObject({ available: true, truncated: true })
  })

  it('bounds total UTF-8 strings, depth, arrays and schema recursion without rendering object key data', () => {
    const array = inspectExecutionValue(Array.from({ length: 80 }, () => '🙂'.repeat(900)), snapshot(z.array(visible(z.string()))))
    expect(array.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(array))).toBeLessThan(11_000)
    let nested: z = visible(z.string())
    let data: unknown = 'DEEP_SECRET'
    for (let i = 0; i < 20; i++) { nested = z.object({ next: nested }); data = { next: data } }
    const depth = inspectExecutionValue(data, snapshot(nested))
    expect(depth.truncated).toBe(true)
    expect(JSON.stringify(depth)).not.toContain('DEEP_SECRET')
    const cyclic: Record<string, unknown> = {}; cyclic.next = cyclic
    expect(inspectExecutionValue(cyclic, { uid: 1, refs: { 1: { type: 'object', dict: { next: 1 } } } }).hidden).toBe(1)
  })
})
