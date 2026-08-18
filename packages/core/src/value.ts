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
