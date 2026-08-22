import type { CapabilityDefinition, CapabilityStatus } from '@numen/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { projectAutomationInsertCatalog } from '../src/automation-catalog-provider.js'

function definition(
  id: string,
  kind: CapabilityDefinition['kind'],
  title: string,
  connections?: CapabilityDefinition['connections'],
): CapabilityDefinition {
  return {
    id,
    version: 1,
    kind,
    title,
    input: z.object({}),
    output: z.object({}),
    semantics: { sideEffect: kind === 'action', idempotent: true, retrySafe: true },
    ...(connections ? { connections } : {}),
  }
}

describe('Automation insert catalog projection', () => {
  it('combines core controls with sorted query/action metadata and excludes triggers', () => {
    const statuses: CapabilityStatus[] = [
      { definition: definition('test:send', 'action', 'Send', [{ name: 'account', required: true, accepts: ['mail'] }]), providerAvailable: false },
      { definition: definition('test:event', 'trigger', 'Event'), providerAvailable: true },
      { definition: definition('test:lookup', 'query', 'Lookup'), providerAvailable: true },
    ]

    const catalog = projectAutomationInsertCatalog(statuses)

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
      }),
    ])
    expect(catalog.items).not.toContainEqual(expect.objectContaining({ title: 'Event' }))
  })
})
