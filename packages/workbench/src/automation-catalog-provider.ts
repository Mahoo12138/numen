import type { ConsoleQueryDefinition } from '@numen/console'
import { isNumenValue, type CapabilityDefinition, type CapabilityStatus } from '@numen/core'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import {
  workbenchAutomationInsertCatalogQueryRef,
  type WorkbenchAutomationConnectionOption,
  type WorkbenchAutomationInputField,
  type WorkbenchAutomationInsertCatalog,
  type WorkbenchAutomationInsertItem,
} from './contracts.js'
import { projectWorkbenchConnection } from './connection-projection.js'

const coreControls: ReadonlyArray<WorkbenchAutomationInsertItem> = [
  { kind: 'control', control: 'wait', title: 'Wait', description: 'Pause for a literal duration or until a later expression.' },
  { kind: 'control', control: 'if', title: 'If', description: 'Branch into structured then and optional else blocks.' },
  { kind: 'control', control: 'parallel', title: 'Parallel', description: 'Run structured branches concurrently and join all results.' },
  { kind: 'control', control: 'race', title: 'Race', description: 'Run branches concurrently and keep the first successful result.' },
  { kind: 'control', control: 'foreach', title: 'For each', description: 'Iterate a structured body with bounded concurrency.' },
]

const capabilityRefSchema = z.object({
  id: z.string().required(),
  version: z.number().step(1).min(1).required(),
})

const inputOptionSchema = z.object({
  label: z.string().required(),
  value: z.any().required(),
})

const inputFieldSchema = z.object({
  name: z.string().required(),
  label: z.string().required(),
  type: z.union(['string', 'number', 'boolean', 'enum', 'json']).required(),
  schemaType: z.string().required(),
  required: z.boolean().required(),
  description: z.string(),
  role: z.string(),
  defaultValue: z.any(),
  options: z.array(inputOptionSchema),
  min: z.number(),
  max: z.number(),
  step: z.number(),
})

const connectionRequirementSchema = z.object({
  name: z.string().required(),
  required: z.boolean().required(),
  accepts: z.array(z.string().required()).required(),
})

const connectionStatusSchema = z.union([
  'DISABLED',
  'UNAVAILABLE',
  'STOPPED',
  'STARTING',
  'READY',
  'ERROR',
  'STOPPING',
]).required()

const connectionOptionSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  adapterId: z.string().required(),
  adapterVersion: z.number().required(),
  enabled: z.boolean().required(),
  adapterAvailable: z.boolean().required(),
  status: connectionStatusSchema,
})

const insertItemSchema = z.union([
  z.object({
    kind: z.const('control').required(),
    control: z.union(['wait', 'if', 'parallel', 'race', 'foreach']).required(),
    title: z.string().required(),
    description: z.string().required(),
  }),
  z.object({
    kind: z.const('capability').required(),
    capability: capabilityRefSchema.required(),
    capabilityKind: z.union(['query', 'action']).required(),
    title: z.string().required(),
    description: z.string(),
    providerAvailable: z.boolean().required(),
    connectionSlots: z.array(z.string().required()).required(),
    connectionRequirements: z.array(connectionRequirementSchema).required(),
    inputFields: z.array(inputFieldSchema).required(),
    inputSchemaSupported: z.boolean().required(),
  }),
])

export const workbenchAutomationInsertCatalogQuery: ConsoleQueryDefinition<
  Record<string, unknown>,
  WorkbenchAutomationInsertCatalog
> = {
  ...workbenchAutomationInsertCatalogQueryRef,
  kind: 'query',
  title: 'Automation insert catalog',
  description: 'Core structured controls plus live query/action Capability definitions for the Automation Quick Picker.',
  input: z.object({}),
  output: z.object({
    items: z.array(insertItemSchema).required(),
    connections: z.array(connectionOptionSchema).required(),
  }),
}

function humanizeFieldName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

function enumOptions(schema: Schema): WorkbenchAutomationInputField['options'] | undefined {
  if (schema.type !== 'union' || !schema.list?.length) return
  const values = schema.list.map(item => item.type === 'const' ? item.value : undefined)
  if (values.some(value => !isNumenValue(value))) return
  return values.map(value => ({ label: String(value), value }))
}

function projectInputField(name: string, schema: Schema): WorkbenchAutomationInputField {
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

function projectInputSchema(definition: CapabilityDefinition): {
  inputFields: WorkbenchAutomationInputField[]
  inputSchemaSupported: boolean
} {
  if (definition.input.type !== 'object' || !definition.input.dict) {
    return { inputFields: [], inputSchemaSupported: false }
  }
  return {
    inputFields: Object.entries(definition.input.dict).map(([name, schema]) => projectInputField(name, schema)),
    inputSchemaSupported: true,
  }
}

/** @internal Projects runtime contracts without exposing schemas or Provider implementations to the browser. */
export function projectAutomationInsertCatalog(
  statuses: CapabilityStatus[],
  connections: WorkbenchAutomationConnectionOption[] = [],
): WorkbenchAutomationInsertCatalog {
  const capabilities = statuses
    .filter(status => status.definition.kind !== 'trigger')
    .map<WorkbenchAutomationInsertItem>(status => {
      const input = projectInputSchema(status.definition)
      return {
        kind: 'capability',
        capability: { id: status.definition.id, version: status.definition.version },
        capabilityKind: status.definition.kind as 'query' | 'action',
        title: status.definition.title,
        ...(status.definition.description ? { description: status.definition.description } : {}),
        providerAvailable: status.providerAvailable,
        connectionSlots: status.definition.connections?.map(slot => slot.name) ?? [],
        connectionRequirements: status.definition.connections?.map(slot => ({
          name: slot.name,
          required: slot.required,
          accepts: [...slot.accepts],
        })) ?? [],
        ...input,
      }
    })
    .sort((left, right) => (
      left.title.localeCompare(right.title)
      || (left.kind === 'capability' && right.kind === 'capability'
        ? `${left.capability.id}@${left.capability.version}`.localeCompare(`${right.capability.id}@${right.capability.version}`)
        : 0)
    ))
  return {
    items: [...coreControls, ...capabilities],
    connections: [...connections].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  }
}

export function workbenchAutomationCatalogProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationInsertCatalogQueryRef, {
    query(): WorkbenchAutomationInsertCatalog {
      const connections = ctx.connections.list().map(connection => {
        const runtime = ctx.connections.getRuntimeState(connection.id)
        const adapter = ctx.connections.getAdapter(connection.adapter)
        const projected = projectWorkbenchConnection(connection, runtime, adapter?.title ?? connection.adapter.id)
        return {
          id: projected.id,
          name: projected.name,
          adapterId: projected.adapterId,
          adapterVersion: projected.adapterVersion,
          enabled: projected.enabled,
          adapterAvailable: projected.adapterAvailable,
          status: projected.status,
        }
      })
      return projectAutomationInsertCatalog(ctx.capabilities.list(), connections)
    },
  })
}

workbenchAutomationCatalogProviderPlugin.inject = ['workbench', 'console', 'capabilities', 'connections']

export default workbenchAutomationCatalogProviderPlugin
