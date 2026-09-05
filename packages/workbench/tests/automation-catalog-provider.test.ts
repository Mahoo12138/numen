import { Context } from 'cordis'
import { ControlRegistry, type CapabilityDefinition, type CapabilityStatus } from '@numen/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import {
  projectAutomationInsertCatalog,
  projectAutomationVariableCatalog,
} from '../src/automation-catalog-provider.js'

function definition(
  id: string,
  kind: CapabilityDefinition['kind'],
  title: string,
  connections?: CapabilityDefinition['connections'],
  input: CapabilityDefinition['input'] = z.object({}),
): CapabilityDefinition {
  return {
    id,
    version: 1,
    kind,
    title,
    input,
    output: z.object({}),
    semantics: { sideEffect: kind === 'action', idempotent: true, retrySafe: true },
    ...(connections ? { connections } : {}),
  }
}

describe('Automation insert catalog projection', () => {
  it('projects only live plugin Controls and their input fields without compiler functions', async () => {
    const root = new Context()
    await root.plugin(ControlRegistry)
    const dispose = root.controls.defineControl(root, {
      kind: 'extension', id: 'test:pause', version: 1, title: 'Pause', description: 'Durable pause',
      input: z.object({ milliseconds: z.number().min(0).default(1000) }),
      lower: ({ nodeId, input }) => ({ type: 'wait', id: nodeId, durationMs: input.milliseconds! }),
    })
    const catalog = projectAutomationInsertCatalog([], [], root.controls.list())
    expect(catalog.items).toEqual([expect.objectContaining({
      kind: 'extension', control: { id: 'test:pause', version: 1 }, inputSchemaSupported: true,
      inputFields: [expect.objectContaining({ name: 'milliseconds', type: 'number', min: 0, defaultValue: 1000 })],
    })])
    expect(catalog.items[0]).not.toHaveProperty('lower')
    dispose()
    expect(projectAutomationInsertCatalog([], [], root.controls.list()).items).toEqual([])
    await root.fiber.dispose()
  })

  it('combines core controls with sorted query/action metadata and excludes triggers', () => {
    const statuses: CapabilityStatus[] = [
      {
        definition: definition(
          'test:send',
          'action',
          'Send',
          [{ name: 'account', required: true, accepts: ['mail:adapter'] }],
          z.object({
            message: z.string().description('Message body.').role('numen/expression').required(),
            attempts: z.number().min(1).max(5).step(1),
            urgent: z.boolean().default(false),
            channel: z.union(['email', 'chat']).required(),
            payload: z.object({ subject: z.string() }),
          }),
        ),
        providerAvailable: false,
      },
      { definition: definition('test:event', 'trigger', 'Event'), providerAvailable: true },
      { definition: definition('test:lookup', 'query', 'Lookup'), providerAvailable: true },
    ]

    const catalog = projectAutomationInsertCatalog(statuses, [{
      id: 'conn-mail',
      name: 'Mail account',
      adapterId: 'mail:adapter',
      adapterVersion: 1,
      enabled: true,
      adapterAvailable: true,
      status: 'READY',
    }])

    expect(catalog.items.slice(0, 5).map(item => item.kind === 'control' ? item.control : '')).toEqual([
      'wait', 'if', 'parallel', 'race', 'foreach',
    ])
    expect(catalog.items.slice(5)).toEqual([
      expect.objectContaining({
        kind: 'capability',
        capability: { id: 'test:lookup', version: 1 },
        capabilityKind: 'query',
        providerAvailable: true,
        connectionSlots: [],
      }),
      expect.objectContaining({
        kind: 'capability',
        capability: { id: 'test:send', version: 1 },
        capabilityKind: 'action',
        providerAvailable: false,
        connectionSlots: ['account'],
        connectionRequirements: [{ name: 'account', required: true, accepts: ['mail:adapter'] }],
        inputSchemaSupported: true,
        inputFields: [
          expect.objectContaining({ name: 'message', type: 'string', required: true, role: 'numen/expression', description: 'Message body.' }),
          expect.objectContaining({ name: 'attempts', type: 'number', min: 1, max: 5, step: 1 }),
          expect.objectContaining({ name: 'urgent', type: 'boolean', defaultValue: false }),
          expect.objectContaining({ name: 'channel', type: 'enum', options: [{ label: 'email', value: 'email' }, { label: 'chat', value: 'chat' }] }),
          expect.objectContaining({ name: 'payload', type: 'json', schemaType: 'object' }),
        ],
      }),
    ])
    expect(catalog.connections).toEqual([expect.objectContaining({ id: 'conn-mail', adapterId: 'mail:adapter' })])
    expect(catalog.items).not.toContainEqual(expect.objectContaining({ title: 'Event' }))
  })

  it('projects nested output contracts for triggers, queries, and actions', () => {
    const trigger = definition('test:event', 'trigger', 'Event')
    trigger.output = z.object({
      title: z.string().description('Event title.'),
      payload: z.object({ count: z.number(), ready: z.boolean() }),
      internal: z.string().hidden(),
      'invalid.path': z.string(),
    })
    const lookup = definition('test:lookup', 'query', 'Lookup')
    lookup.output = z.array(z.string())

    const catalog = projectAutomationVariableCatalog([
      { definition: lookup, providerAvailable: true },
      { definition: trigger, providerAvailable: false },
    ])

    expect(catalog.definitions).toEqual([
      expect.objectContaining({
        capability: { id: 'test:event', version: 1 },
        capabilityKind: 'trigger',
        outputFields: [
          expect.objectContaining({ path: [], valueType: 'object' }),
          expect.objectContaining({ path: ['title'], valueType: 'string', description: 'Event title.' }),
          expect.objectContaining({ path: ['payload'], valueType: 'object' }),
          expect.objectContaining({ path: ['payload', 'count'], valueType: 'number' }),
          expect.objectContaining({ path: ['payload', 'ready'], valueType: 'boolean' }),
        ],
      }),
      expect.objectContaining({
        capability: { id: 'test:lookup', version: 1 },
        capabilityKind: 'query',
        outputFields: [expect.objectContaining({ path: [], valueType: 'array' })],
      }),
    ])
    expect(catalog.definitions[0]!.outputFields.map(field => field.path.join('.'))).not.toContain('internal')
    expect(catalog.definitions[0]!.outputFields.map(field => field.path.join('.'))).not.toContain('invalid.path')
  })
})
