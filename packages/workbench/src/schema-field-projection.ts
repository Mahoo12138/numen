import { isNumenValue } from '@numen/core'
import type Schema from 'schemastery'
import z from 'schemastery'
import type { WorkbenchSchemaField } from './contracts.js'

export const workbenchSchemaFieldSchema: Schema<WorkbenchSchemaField> = z.object({
  name: z.string().required(),
  label: z.string().required(),
  type: z.union(['string', 'number', 'boolean', 'enum', 'json']).required(),
  schemaType: z.string().required(),
  required: z.boolean().required(),
  description: z.string(),
  role: z.string(),
  defaultValue: z.any(),
  options: z.array(z.object({ label: z.string().required(), value: z.any().required() })),
  min: z.number(),
  max: z.number(),
  step: z.number(),
})

export function humanizeFieldName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

function enumOptions(schema: Schema): WorkbenchSchemaField['options'] | undefined {
  if (schema.type !== 'union' || !schema.list?.length) return
  const values = schema.list.map(item => item.type === 'const' ? item.value : undefined)
  if (values.some(value => !isNumenValue(value))) return
  return values.map(value => ({ label: String(value), value }))
}

export function projectSchemaField(name: string, schema: Schema): WorkbenchSchemaField {
  const options = enumOptions(schema)
  const type = options
    ? 'enum'
    : schema.type === 'string' || schema.type === 'number' || schema.type === 'boolean'
      ? schema.type
      : 'json'
  const description = typeof schema.meta.description === 'string' ? schema.meta.description : undefined
  const defaultValue = isNumenValue(schema.meta.default) ? schema.meta.default : undefined
  return {
    name,
    label: humanizeFieldName(name),
    type,
    schemaType: schema.type,
    required: !!schema.meta.required,
    ...(description ? { description } : {}),
    ...(schema.meta.role ? { role: schema.meta.role } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(options ? { options } : {}),
    ...(schema.meta.min !== undefined ? { min: schema.meta.min } : {}),
    ...(schema.meta.max !== undefined ? { max: schema.meta.max } : {}),
    ...(schema.meta.step !== undefined ? { step: schema.meta.step } : {}),
  }
}

export function projectObjectSchema(schema: Schema): {
  fields: WorkbenchSchemaField[]
  supported: boolean
} {
  if (schema.type !== 'object' || !schema.dict) return { fields: [], supported: false }
  return {
    fields: Object.entries(schema.dict).map(([name, field]) => projectSchemaField(name, field)),
    supported: true,
  }
}
