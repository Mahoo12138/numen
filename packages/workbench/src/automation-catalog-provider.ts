import type { ConsoleQueryDefinition } from '@numen/console'
import { coreControlDefinitions, type ControlDefinition, type CapabilityStatus } from '@numen/core'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'
import {
  workbenchAutomationInsertCatalogQueryRef,
  workbenchAutomationVariableCatalogQueryRef,
  type WorkbenchAutomationConnectionOption,
  type WorkbenchAutomationInputField,
  type WorkbenchAutomationInsertCatalog,
  type WorkbenchAutomationInsertItem,
  type WorkbenchAutomationVariableCatalog,
  type WorkbenchAutomationVariableDefinition,
  type WorkbenchAutomationVariableField,
  type WorkbenchAutomationVariableValueType,
} from './contracts.js'
import { projectWorkbenchConnection } from './connection-projection.js'
import { humanizeFieldName, projectObjectSchema, workbenchSchemaFieldSchema } from './schema-field-projection.js'

const capabilityRefSchema = z.object({
  id: z.string().required(),
  version: z.number().step(1).min(1).required(),
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
    kind: z.const('extension').required(),
    control: capabilityRefSchema.required(),
    title: z.string().required(),
    description: z.string().required(),
    inputFields: z.array(workbenchSchemaFieldSchema).required(),
    inputSchemaSupported: z.boolean().required(),
  }),
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
    inputFields: z.array(workbenchSchemaFieldSchema).required(),
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

const variableValueTypeSchema = z.union([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
  'unknown',
]).required()

const variableFieldSchema = z.object({
  path: z.array(z.string().required()).required(),
  label: z.string().required(),
  valueType: variableValueTypeSchema,
  schemaType: z.string().required(),
  description: z.string(),
})

const variableDefinitionSchema = z.object({
  capability: capabilityRefSchema.required(),
  capabilityKind: z.union(['trigger', 'query', 'action']).required(),
  title: z.string().required(),
  outputFields: z.array(variableFieldSchema).required(),
  outputSchemaSupported: z.boolean().required(),
})

export const workbenchAutomationVariableCatalogQuery: ConsoleQueryDefinition<
  Record<string, unknown>,
  WorkbenchAutomationVariableCatalog
> = {
  ...workbenchAutomationVariableCatalogQueryRef,
  kind: 'query',
  title: 'Automation variable catalog',
  description: 'Presentation-safe Capability output contracts for scope-aware Automation variable authoring.',
  input: z.object({}),
  output: z.object({
    definitions: z.array(variableDefinitionSchema).required(),
  }),
}

function projectInputSchema(definition: { input: Schema }): {
  inputFields: WorkbenchAutomationInputField[]
  inputSchemaSupported: boolean
} {
  const projection = projectObjectSchema(definition.input)
  return {
    inputFields: projection.fields,
    inputSchemaSupported: projection.supported,
  }
}

function schemaValueType(schema: Schema): WorkbenchAutomationVariableValueType {
  if (schema.type === 'string' || schema.type === 'number' || schema.type === 'boolean') return schema.type
  if (schema.type === 'object') return 'object'
  if (schema.type === 'array' || schema.type === 'tuple') return 'array'
  if (schema.type === 'const') {
    if (schema.value === null) return 'null'
    if (typeof schema.value === 'string') return 'string'
    if (typeof schema.value === 'number') return 'number'
    if (typeof schema.value === 'boolean') return 'boolean'
    if (Array.isArray(schema.value)) return 'array'
    if (schema.value && typeof schema.value === 'object') return 'object'
  }
  if (schema.type === 'union' && schema.list?.length) {
    const types = new Set(schema.list.map(schemaValueType))
    if (types.size === 1) return [...types][0]!
  }
  return 'unknown'
}

function projectOutputField(path: string[], schema: Schema): WorkbenchAutomationVariableField {
  const description = typeof schema.meta.description === 'string' ? schema.meta.description : undefined
  return {
    path,
    label: path.length ? humanizeFieldName(path[path.length - 1]!) : 'Output',
    valueType: schemaValueType(schema),
    schemaType: schema.type,
    ...(description ? { description } : {}),
  }
}

function projectOutputFields(schema: Schema): WorkbenchAutomationVariableField[] {
  const fields: WorkbenchAutomationVariableField[] = []
  const visiting = new Set<Schema>()
  const segmentPattern = /^[a-zA-Z0-9_$-]+$/
  const visit = (current: Schema, path: string[], depth: number): void => {
    fields.push(projectOutputField(path, current))
    if (current.type !== 'object' || !current.dict || depth >= 8 || visiting.has(current)) return
    visiting.add(current)
    for (const [name, child] of Object.entries(current.dict)) {
      if (!segmentPattern.test(name) || child.meta.hidden) continue
      visit(child, [...path, name], depth + 1)
    }
    visiting.delete(current)
  }
  visit(schema, [], 0)
  return fields
}

/** @internal Projects Capability output schemas without exposing Schemastery to the browser. */
export function projectAutomationVariableCatalog(statuses: CapabilityStatus[]): WorkbenchAutomationVariableCatalog {
  const definitions = statuses.map<WorkbenchAutomationVariableDefinition>(status => ({
    capability: { id: status.definition.id, version: status.definition.version },
    capabilityKind: status.definition.kind,
    title: status.definition.title,
    outputFields: projectOutputFields(status.definition.output),
    outputSchemaSupported: true,
  })).sort((left, right) => (
    left.title.localeCompare(right.title)
    || `${left.capability.id}@${left.capability.version}`.localeCompare(`${right.capability.id}@${right.capability.version}`)
  ))
  return { definitions }
}

/** @internal Projects runtime contracts without exposing schemas or Provider implementations to the browser. */
export function projectAutomationInsertCatalog(
  statuses: CapabilityStatus[],
  connections: WorkbenchAutomationConnectionOption[] = [],
  definitions: readonly ControlDefinition[] = coreControlDefinitions,
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
    items: [...definitions.map<WorkbenchAutomationInsertItem>(definition => definition.kind === 'core'
      ? { kind: 'control', control: definition.control, title: definition.title, description: definition.description }
      : { kind: 'extension', control: { id: definition.id, version: definition.version }, title: definition.title, description: definition.description, ...projectInputSchema(definition) }), ...capabilities],
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
      return projectAutomationInsertCatalog(ctx.capabilities.list(), connections, ctx.controls.list())
    },
  })
  ctx.console.provideQuery(ctx, workbenchAutomationVariableCatalogQueryRef, {
    query(): WorkbenchAutomationVariableCatalog {
      return projectAutomationVariableCatalog(ctx.capabilities.list())
    },
  })
}

workbenchAutomationCatalogProviderPlugin.inject = ['workbench', 'console', 'capabilities', 'connections', 'controls']

export default workbenchAutomationCatalogProviderPlugin
