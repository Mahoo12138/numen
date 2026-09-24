/** JSON-compatible values accepted by schema controls, independent of host services. */
export type SchemaValue = string | number | boolean | null | { $resource: string } | SchemaValue[] | { [key: string]: SchemaValue }
export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'json'
export interface SchemaOption { label: string; value: SchemaValue }
export interface SchemaField {
  name: string
  label: string
  type: SchemaFieldType
  schemaType: string
  required: boolean
  description?: string
  role?: string
  defaultValue?: SchemaValue
  options?: SchemaOption[]
  min?: number
  max?: number
  step?: number
}

/** JSON.parse accepts overflowing numbers; reject them before committing. */
export function isSchemaValue(value: unknown, ancestors = new Set<object>()): value is SchemaValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  ancestors.add(value)
  const valid = Object.values(value).every(item => isSchemaValue(item, ancestors))
  ancestors.delete(value)
  return valid
}
