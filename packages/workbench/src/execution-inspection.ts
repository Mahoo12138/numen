import type { NumenValue } from '@numenjs/core'
import type { WorkbenchInspectedValue } from './contracts.js'

// The allow rule is immutable field metadata, never a key-name heuristic.
// Names below are an additional deny rule for commonly recognized secret carriers.
const privateNames = new Set([
  'password', 'passwd', 'pwd', 'secret', 'secrets', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'privatekey', 'clientsecret', 'authorization', 'proxyauthorization',
  'cookie', 'cookies', 'setcookie', 'credential', 'credentials', 'credentialmaterial',
  'ciphertext', 'connection', 'connections', '$resource', '__proto__', 'prototype', 'constructor',
])
const privateRoles = new Set(['secret', 'password', 'credential', 'credentials', 'resource'])
const hidden = '[Hidden: field is not classified for inspection]'
const limited = '[Inspection limit reached]'
type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const own = (value: RecordValue, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined

/** Only explicitly public, schema-checked scalar leaves are returned. Containers never inherit public. */
export function inspectExecutionValue(value: unknown, snapshot: unknown, omitted = false): WorkbenchInspectedValue {
  if (omitted) return { value: limited, hidden: 0, truncated: true, available: true }
  if (value === undefined) return { value: '[No durable value]', hidden: 0, truncated: false, available: false }
  const root = object(snapshot)
  const refs = object(root?.refs)
  const state = { bytes: 8_192, nodes: 128, hidden: 0, truncated: false }
  const seen = new Set<object>()
  const resolve = (schema: unknown): RecordValue | undefined => {
    if (typeof schema === 'number' && refs) return object(own(refs, String(schema)))
    const candidate = object(schema)
    if (candidate && typeof candidate.uid === 'number' && refs && !candidate.type) return object(own(refs, String(candidate.uid)))
    return candidate
  }
  const conceal = (): string => { state.hidden += 1; return hidden }
  const truncate = (): string => { state.truncated = true; return limited }
  const charge = (text: string): boolean => {
    state.bytes -= Buffer.byteLength(text, 'utf8')
    return state.bytes >= 0
  }
  const project = (data: unknown, encodedSchema: unknown, depth: number, name = ''): NumenValue => {
    if (depth > 6 || state.nodes-- <= 0 || state.bytes < 128) return truncate()
    const schema = resolve(encodedSchema)
    const meta = object(schema?.meta)
    const numen = object(object(meta?.extra)?.numen)
    const normalized = name.toLowerCase().replace(/[-_\s]/g, '')
    if (!schema || privateNames.has(name) || privateNames.has(normalized)
      || privateRoles.has(String(meta?.role)) || meta?.sensitive === true || numen?.execution === 'sensitive') return conceal()
    if (data && typeof data === 'object') {
      if (seen.has(data) || Object.hasOwn(data, '$resource')) return conceal()
      seen.add(data)
      try {
        if (schema.type === 'array' && Array.isArray(data)) {
          if (!schema.inner) return conceal()
          if (data.length > 20) state.truncated = true
          return data.slice(0, 20).map(item => project(item, schema.inner, depth + 1))
        }
        if (schema.type !== 'object' || Array.isArray(data)) return conceal()
        const dict = object(schema.dict)
        if (!dict) return conceal()
        const output: Record<string, NumenValue> = Object.create(null)
        let visited = 0
        for (const key of Object.keys(dict)) {
          if (!Object.hasOwn(data, key)) continue
          if (++visited > 30 || key.length > 128 || !charge(JSON.stringify(key) + ':,')) { state.truncated = true; break }
          output[key] = project(own(data as RecordValue, key), dict[key], depth + 1, key)
        }
        // Unknown keys can themselves contain private data; neither names nor values leave the server.
        if (Object.keys(data).some(key => !Object.hasOwn(dict, key))) state.hidden += 1
        return output
      } finally { seen.delete(data) }
    }
    if (numen?.execution !== 'public') return conceal()
    const matches = (candidate: RecordValue | undefined): boolean => !!candidate && (
      candidate.type === 'string' && typeof data === 'string'
      || candidate.type === 'number' && typeof data === 'number' && Number.isFinite(data)
      || candidate.type === 'boolean' && typeof data === 'boolean'
      || candidate.type === 'const' && candidate.value === data
    )
    const allowed = matches(schema) || schema.type === 'union' && Array.isArray(schema.list)
      && schema.list.length <= 30 && schema.list.some(item => matches(resolve(item)))
    if (!allowed) return conceal()
    let result = data as NumenValue
    if (typeof data === 'string' && data.length > 1_024) { result = `${data.slice(0, 1_024)}…`; state.truncated = true }
    return charge(JSON.stringify(result)) ? result : truncate()
  }
  const projected = project(value, root, 0)
  // The final serialized cap includes placeholders and every key, not only revealed strings.
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > 10_240) return { value: limited, hidden: state.hidden, truncated: true, available: true }
  return { value: projected, hidden: state.hidden, truncated: state.truncated, available: true }
}
