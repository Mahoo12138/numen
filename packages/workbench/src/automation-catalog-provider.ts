import type { ConsoleQueryDefinition } from '@numen/console'
import type { CapabilityStatus } from '@numen/core'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchAutomationInsertCatalogQueryRef,
  type WorkbenchAutomationInsertCatalog,
  type WorkbenchAutomationInsertItem,
} from './contracts.js'

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
  }),
}

/** @internal Projects runtime contracts without exposing schemas or Provider implementations to the browser. */
export function projectAutomationInsertCatalog(statuses: CapabilityStatus[]): WorkbenchAutomationInsertCatalog {
  const capabilities = statuses
    .filter(status => status.definition.kind !== 'trigger')
    .map<WorkbenchAutomationInsertItem>(status => ({
      kind: 'capability',
      capability: { id: status.definition.id, version: status.definition.version },
      capabilityKind: status.definition.kind as 'query' | 'action',
      title: status.definition.title,
      ...(status.definition.description ? { description: status.definition.description } : {}),
      providerAvailable: status.providerAvailable,
      connectionSlots: status.definition.connections?.map(slot => slot.name) ?? [],
    }))
    .sort((left, right) => (
      left.title.localeCompare(right.title)
      || (left.kind === 'capability' && right.kind === 'capability'
        ? `${left.capability.id}@${left.capability.version}`.localeCompare(`${right.capability.id}@${right.capability.version}`)
        : 0)
    ))
  return { items: [...coreControls, ...capabilities] }
}

export function workbenchAutomationCatalogProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationInsertCatalogQueryRef, {
    query(): WorkbenchAutomationInsertCatalog {
      return projectAutomationInsertCatalog(ctx.capabilities.list())
    },
  })
}

workbenchAutomationCatalogProviderPlugin.inject = ['workbench', 'console', 'capabilities']

export default workbenchAutomationCatalogProviderPlugin
