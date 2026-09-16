import { AutomationService, AutomationActivationConflictError, type AutomationSource } from '@numen/automation'
import {
  CapabilityRegistry,
  type CapabilityDefinition,
  type TriggerActivation,
} from '@numen/core'
import { DatabaseService } from '@numen/database'
import { ConnectionService } from '@numen/connections'
import { CredentialService } from '@numen/credentials'
import { ResourceService } from '@numen/resources'
import { SchedulerService } from '@numen/scheduler'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { TriggerService } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const definition: CapabilityDefinition = {
  id: 'test:event',
  version: 1,
  kind: 'trigger',
  title: 'Test event',
  input: z.object({ channel: z.string().required() }),
  output: z.object({ value: z.string().required() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
  connections: [{ name: 'account', required: false, accepts: [] }],
}

const source = (connectionId: string): AutomationSource => ({
  triggers: [{
    id: 'event',
    capability: { id: 'test:event', version: 1 },
    connections: { account: connectionId },
    config: { channel: 'updates' },
  }],
  flow: { type: 'block', id: 'flow', steps: [] },
})

async function createReadyConnection(root: Context): Promise<string> {
  await root.plugin(CredentialService)
  await root.plugin(ConnectionService)
  const type = { id: 'test:event-client', version: 1, title: 'Event Client' }
  const adapter = { id: 'test:event-adapter', version: 1, title: 'Event Adapter', type, config: z.object({}) }
  root.connections.defineType(root, type)
  root.connections.defineAdapter(root, adapter)
  root.connections.provideAdapter(root, adapter, { async open() { return { value: { channel: 'updates' } } } })
  const connection = root.connections.create({ name: 'Event account', adapter, config: {}, enabled: true })
  await root.connections.reconcile()
  return connection.id
}

describe('TriggerService', () => {
  it('owns active-revision subscriptions and durably accepts emissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-triggers-'))
    directories.push(directory)
    const root = new Context()
    await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
    const connectionId = await createReadyConnection(root)
    await root.plugin(CapabilityRegistry)
    root.capabilities.define(root, definition)
    const activations: TriggerActivation[] = []
    let disposals = 0
    root.capabilities.provideTrigger(root, definition, {
      activate(activation) {
        activations.push(activation)
        return () => {
          disposals += 1
        }
      },
    })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    await root.plugin(TriggerService)

    const created = root.automations.create({ name: 'Triggered automation', source: source(connectionId) })
    const revision = root.automations.publishDraft(created.automation.id, 1)
    root.automations.activateRevision(created.automation.id, revision.id)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 0, activeSubscriptions: 0 })
    const enabled = root.automations.setEnabled(created.automation.id, true)
    expect(root.triggers.health()).toMatchObject({
      ready: true,
      desiredSubscriptions: 1,
      activeSubscriptions: 1,
      unavailableSubscriptions: 0,
    })
    expect(activations[0]?.binding).toMatchObject({
      automationId: created.automation.id,
      revisionId: revision.id,
      activationGeneration: enabled.activationGeneration,
      triggerId: 'event',
      config: { channel: 'updates' },
      connectionIds: { account: connectionId },
    })
    expect(activations[0]?.connections).toEqual({ account: { channel: 'updates' } })

    const accepted = await activations[0]!.emit({ data: { value: 'first' }, eventId: 'event-1' })
    expect(accepted).toMatchObject({ status: 'accepted', runId: expect.any(String) })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(accepted.runId!)?.status).toBe('COMPLETED')

    expect(() => root.automations.setEnabled(created.automation.id, false, enabled.activationGeneration - 1))
      .toThrow(AutomationActivationConflictError)
    root.automations.activateRevision(created.automation.id, revision.id, enabled.activationGeneration)
    expect(activations).toHaveLength(1)
    expect(disposals).toBe(0)

    const nextRevision = root.automations.publishDraft(created.automation.id, 1)
    root.automations.activateRevision(created.automation.id, nextRevision.id)
    expect(disposals).toBe(1)
    expect(activations).toHaveLength(2)
    expect(activations[0]!.signal.aborted).toBe(true)
    expect(await activations[0]!.emit({ data: { value: 'stale' }, eventId: 'event-2' }))
      .toEqual({ status: 'stale' })

    root.automations.setEnabled(created.automation.id, false)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 0, activeSubscriptions: 0 })
    expect(disposals).toBe(2)
    await root.fiber.dispose()
  })

  it('waits for an unavailable provider and subscribes when it appears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-triggers-'))
    directories.push(directory)
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })
    const connectionId = await createReadyConnection(root)
    await root.plugin(CapabilityRegistry)
    root.capabilities.define(root, definition)
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    await root.plugin(TriggerService)
    const created = root.automations.create({ name: 'Late provider', source: source(connectionId) })
    const revision = root.automations.publishDraft(created.automation.id, 1)
    root.automations.activateRevision(created.automation.id, revision.id)
    root.automations.setEnabled(created.automation.id, true)
    expect(root.triggers.health()).toMatchObject({
      desiredSubscriptions: 1,
      activeSubscriptions: 0,
      unavailableSubscriptions: 1,
    })

    root.capabilities.provideTrigger(root, definition, { activate() {} })
    expect(root.triggers.health()).toMatchObject({
      desiredSubscriptions: 1,
      activeSubscriptions: 1,
      unavailableSubscriptions: 0,
    })
    await root.fiber.dispose()
  })
})
