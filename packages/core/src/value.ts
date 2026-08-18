export interface ResourceRef {
  $resource: string
}

export type NumenPrimitive = string | number | boolean | null
export type NumenValue = NumenPrimitive | ResourceRef | NumenValue[] | { [key: string]: NumenValue }

export function isResourceRef(value: unknown): value is ResourceRef {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as ResourceRef).$resource === 'string'
}

export function isNumenValue(value: unknown, seen = new Set<object>()): value is NumenValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (isResourceRef(value)) return true
  if (Array.isArray(value)) return value.every(item => isNumenValue(item, seen))
  return Object.values(value).every(item => isNumenValue(item, seen))
}
