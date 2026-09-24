import { inspect, stripVTControlCharacters } from 'node:util'

const sensitive = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|private[-_]?key|credential|credentials|ciphertext|input|output|payload|body|config)$/i
const limit = 4096
export function redactText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/(\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,'";]+/gi, 'Bearer [REDACTED]')
    .replace(/(\b(?:password|passwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|numen-bootstrap|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(?:\[REDACTED\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Snapshot values without calling getters, custom inspectors, or toJSON hooks. */
export function sanitize(value: unknown, secrets: readonly string[] = []): string | number | boolean | null | object {
  const seen = new Set<object>()
  let budget = 256
  const text = (value: string) => {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]')
    const redacted = redactText(value)
    return redacted.length > limit ? redacted.slice(0, limit) + '…[truncated]' : redacted
  }
  const visit = (value: unknown, depth: number): any => {
    if (--budget < 0) return '[truncated]'
    if (typeof value === 'string') return text(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value !== 'object') return `[${typeof value}]`
    if (depth > 5 || seen.has(value)) return '[circular or truncated]'
    seen.add(value)
    try {
      const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const key of Object.keys(descriptors).slice(0, 64)) {
        if (key === 'length' && Array.isArray(value)) continue
        const property = descriptors[key]!
        // V8 stores Error.stack as a lazy native accessor. Do not invoke arbitrary object getters.
        if (value instanceof Error && key === 'stack' && property.get && Function.prototype.toString.call(property.get).includes('[native code]')) {
          try { (result as Record<string, unknown>)[key] = text(String(property.get.call(value))) } catch { (result as Record<string, unknown>)[key] = '[stack unavailable]' }
          continue
        }
        ;(result as Record<string, unknown>)[text(key)] = sensitive.test(key) ? '[REDACTED]'
          : 'value' in property ? visit(property.value, depth + 1) : '[accessor]'
      }
      return result
    } finally { seen.delete(value) }
  }
  return visit(value, 0)
}

export function formatLogArgs(args: readonly unknown[], secrets: readonly string[]): string {
  const values = args.slice(0, 32).map((value, index) => index === 0 && typeof value === 'string' ? value : sanitize(value, secrets))
  const render = (value: unknown) => typeof value === 'string' ? value : inspect(value, { depth: 5, customInspect: false, getters: false, breakLength: Infinity })
  let output: string
  if (typeof values[0] === 'string') {
    let index = 1
    output = values[0].replace(/%([%sdijoO])/g, (match, type) => {
      if (type === '%') return '%'
      if (index >= values.length) return match
      return render(values[index++])
    })
    output += values.slice(index).map(value => ' ' + render(value)).join('')
  } else output = values.map(render).join(' ')
  // Second pass catches secrets assembled via format placeholders.
  return String(sanitize(output, secrets)).slice(0, limit)
}
