import type { CapabilityDefinition, CapabilityStatus } from '@numen/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { projectAutomationInsertCatalog } from '../src/automation-catalog-provider.js'

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
})
