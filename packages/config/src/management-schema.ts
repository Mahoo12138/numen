import { redactText } from '@numenjs/logging'
import type { HostConfigSchemaNode } from './management-types.js'

export const sensitiveConfigKey = /secret|token|password|credential|authorization|cookie|private.?key|api.?key|^auth$|^key$/i
const maxDepth = 12
const maxNodes = 256
const maxFields = 64
const maxText = 2048
const unsafe = Symbol('unsafe metadata')
const objectLike = (value: unknown): value is object => !!value && (typeof value === 'object' || typeof value === 'function')
// Schemastery schemas are callable objects. Inspect their own data properties only:
// callbacks, getters, toJSON, validators and lazy builders must not run during a read.
function own(value: unknown, key: string): unknown {
  if (!objectLike(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && !('value' in descriptor) ? unsafe : descriptor?.value
  } catch { return unsafe }
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null } catch { return false }
}
function dataKeys(value: unknown, allOwn = false): string[] | undefined {
  if (!plainRecord(value)) return undefined
  try { return allOwn ? Object.getOwnPropertyNames(value) : Object.keys(value) } catch { return undefined }
}
function safeText(value: unknown, maximum = maxText): string | undefined {
  return typeof value === 'string' && redactText(value) === value ? value.slice(0, maximum) : undefined
}
const fallback = (reason: NonNullable<HostConfigSchemaNode['fallbackReason']>, metadata: Partial<HostConfigSchemaNode> = {}): HostConfigSchemaNode => ({ type: 'json', required: false, ...metadata, fallbackReason: reason })

export interface HostConfigSchemaInspection {
  /** Missing or unsafe schema metadata cannot establish an editable configuration. */
  schema?: HostConfigSchemaNode
  sensitive: boolean
}

/** Safely project public schema metadata, never resolved configuration or default values. */
export function inspectHostConfigSchema(schema: unknown): HostConfigSchemaInspection {
  if (typeof own(schema, 'type') !== 'string') return { sensitive: false }
  let sensitive = false
  let uncertain = false
  let inspected = 0
  const visited = new Set<object>()
  const classify = (value: unknown, depth: number): void => {
    if (value === undefined) return
    if (!objectLike(value) || depth > maxDepth || ++inspected > maxNodes * 4) { uncertain = true; return }
    if (visited.has(value)) return
    visited.add(value)
    const type = own(value, 'type')
    const meta = own(value, 'meta')
    if (typeof type !== 'string' || meta === unsafe || (meta !== undefined && !plainRecord(meta))) { uncertain = true; return }
    const role = own(meta, 'role')
    if (role === unsafe) uncertain = true
    if (role === 'secret') sensitive = true
    const dictionary = own(value, 'dict')
    if (dictionary !== undefined) {
      const keys = dataKeys(dictionary, true)
      if (!keys || keys.length > maxNodes * 4) uncertain = true
      else for (const key of keys) {
        if (sensitiveConfigKey.test(key)) sensitive = true
        classify(own(dictionary, key), depth + 1)
      }
    }
    const list = own(value, 'list')
    if (list !== undefined) {
      if (!Array.isArray(list) || list.length > maxNodes * 4) uncertain = true
      else for (let index = 0; index < list.length; index++) classify(own(list, String(index)), depth + 1)
    }
    const inner = own(value, 'inner')
    if (inner !== undefined) classify(inner, depth + 1)
    const keySchema = own(value, 'sKey')
    if (keySchema !== undefined) classify(keySchema, depth + 1)
    // Lazy builders and arbitrary validators do not describe the accepted input.
    if (type === 'lazy') uncertain = true
  }
  classify(schema, 0)
  if (sensitive || uncertain) return { sensitive }

  let remaining = maxNodes
  const ancestors = new Set<object>()
  const project = (value: unknown, depth: number): HostConfigSchemaNode => {
    if (!objectLike(value)) return fallback('unsafe-metadata')
    if (--remaining < 0 || depth > maxDepth) return fallback('limit')
    if (ancestors.has(value)) return fallback('cycle')
    ancestors.add(value)
    try {
      const meta = own(value, 'meta')
      const metadata: Partial<HostConfigSchemaNode> = { required: own(meta, 'required') === true }
      if (own(meta, 'default') !== undefined && own(meta, 'default') !== unsafe) metadata.hasDefault = true
      const description = safeText(own(meta, 'description'))
      if (description) metadata.description = description
      for (const key of ['min', 'max', 'step'] as const) {
        const bound = own(meta, key)
        if (typeof bound === 'number' && Number.isFinite(bound)) metadata[key] = bound
      }
      const type = own(value, 'type')
      if (type === 'string' || type === 'number' || type === 'boolean') return { type, required: false, ...metadata }
      if (type === 'object') {
        const dictionary = own(value, 'dict')
        const keys = dataKeys(dictionary)
        if (!keys) return fallback('unsafe-metadata', metadata)
        if (keys.length > maxFields || keys.length > remaining) return fallback('limit', metadata)
        if (keys.some(key => key.length > 160 || safeText(key, 160) !== key || ['__proto__', 'constructor', 'prototype'].includes(key))) return fallback('unsafe-metadata', metadata)
        return { type, required: false, ...metadata, fields: keys.map(name => {
          const child = own(dictionary, name)
          return { ...project(child, depth + 1), name, label: safeText(own(own(child, 'meta'), 'title'), 160) || name }
        }) }
      }
      if (type === 'array') return { type, required: false, ...metadata, item: project(own(value, 'inner'), depth + 1) }
      if (type === 'const' || type === 'union') {
        const alternatives = type === 'const' ? [value] : own(value, 'list')
        if (!Array.isArray(alternatives) || !alternatives.length) return fallback('unsupported', metadata)
        if (alternatives.length > maxFields) return fallback('limit', metadata)
        const options: NonNullable<HostConfigSchemaNode['options']> = []
        for (let index = 0; index < alternatives.length; index++) {
          const alternative = own(alternatives, String(index))
          if (own(alternative, 'type') !== 'const') return fallback('unsupported', metadata)
          const literal = own(alternative, 'value')
          if (!(literal === null || typeof literal === 'boolean' || typeof literal === 'number' && Number.isFinite(literal) || typeof literal === 'string')) return fallback('unsupported', metadata)
          if (typeof literal === 'string' && (literal.length > maxText || safeText(literal) !== literal)) return fallback('unsafe-metadata', metadata)
          options.push({ value: literal, label: String(literal) })
        }
        return { type: 'enum', required: false, ...metadata, options }
      }
      if (type === 'intersect') {
        const list = own(value, 'list')
        if (!Array.isArray(list) || !list.length) return fallback('unsupported', metadata)
        if (list.length > maxFields) return fallback('limit', metadata)
        const fields: NonNullable<HostConfigSchemaNode['fields']> = []
        const names = new Set<string>()
        for (let index = 0; index < list.length; index++) {
          const child = own(list, String(index))
          const node = project(child, depth + 1)
          if (node.type !== 'object') return fallback('unsupported', metadata)
          for (const field of node.fields ?? []) {
            if (names.has(field.name)) return fallback('unsupported', metadata)
            names.add(field.name); fields.push(field)
          }
        }
        return fields.length > maxFields ? fallback('limit', metadata) : { type: 'object', required: false, ...metadata, fields }
      }
      return fallback('unsupported', metadata)
    } finally { ancestors.delete(value) }
  }
  const projected = project(schema, 0)
  // Bound repeated metadata as well as the structural traversal budget.
  return { schema: Buffer.byteLength(JSON.stringify(projected), 'utf8') > 64 * 1024 ? fallback('limit') : projected, sensitive: false }
}
