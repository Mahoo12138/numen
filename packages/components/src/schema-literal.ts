import { isSchemaValue, type SchemaField, type SchemaValue } from './schema.js'

export type LiteralValidationError = 'validation.required' | 'validation.number' | 'validation.range' | 'validation.step' | 'validation.json' | 'validation.jsonType' | 'validation.dateTime'
export type ParsedLiteral = { value: SchemaValue | undefined; error?: never } | { error: LiteralValidationError; value?: never }

/** Parse a field's draft without changing its committed value. */
export function parseSchemaLiteral(text: string, field: SchemaField): ParsedLiteral {
  const raw = text.trim()
  if (!raw && (field.type !== 'string' || field.role === 'numen/iso-date-time')) return field.required ? { error: 'validation.required' } : { value: undefined }
  if (field.role === 'numen/iso-date-time') {
    const date = new Date(raw)
    if (!Number.isFinite(date.getTime())) return { error: 'validation.dateTime' }
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString()
    if (local.slice(0, raw.length) !== raw) return { error: 'validation.dateTime' }
    return { value: date.toISOString() }
  }
  if (field.type === 'number' || field.role === 'numen/duration-ms') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return { error: 'validation.number' }
    let value = Number(raw)
    if (!Number.isFinite(value)) return { error: 'validation.number' }
    if (field.role === 'numen/duration-ms') {
      const ms = value * 1_000
      if (value < 0 || !Number.isSafeInteger(Math.round(ms)) || Math.abs(ms - Math.round(ms)) > 1e-7) return { error: 'validation.range' }
      value = Math.round(ms)
    }
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) return { error: 'validation.range' }
    if (field.step !== undefined && field.step > 0) {
      const steps = (value - (field.min ?? 0)) / field.step
      if (Math.abs(steps - Math.round(steps)) > 1e-7) return { error: 'validation.step' }
    }
    return { value }
  }
  if (field.type === 'json') {
    try {
      const value: unknown = JSON.parse(text)
      if (!isSchemaValue(value)) return { error: 'validation.json' }
      if ((field.schemaType === 'array' && !Array.isArray(value))
        || (field.schemaType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))
        || (field.schemaType === 'null' && value !== null)) return { error: 'validation.jsonType' }
      return { value }
    } catch { return { error: 'validation.json' } }
  }
  if ((field.min !== undefined && text.length < field.min) || (field.max !== undefined && text.length > field.max)) return { error: 'validation.range' }
  return { value: text || (field.required ? '' : undefined) }
}
