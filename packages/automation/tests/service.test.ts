import { CapabilityRegistry, type AutomationSource, type CapabilityDefinition } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationService, DraftConflictError, AutomationActivationConflictError, AutomationNotFoundError, AutomationRevisionNotFoundError } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const action: CapabilityDefinition = {
  id: 'test:record',
  version: 1,
  kind: 'action',
  title: 'Record value',
  input: z.object({ value: z.string().required() }),
  output: z.object({}),
  semantics: { sideEffect: true, idempotent: true, retrySafe: true },
}

const source: AutomationSource = {
  triggers: [],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [{
      type: 'capability',
      id: 'record',
      capability: { id: 'test:record', version: 1 },
      input: { value: { type: 'literal', value: 'first' } },
    }],
  },
}

async function createContext(path: string): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, action)
  await root.plugin(AutomationService)
  return root
}

describe('AutomationService', () => {
  it('persists draft, immutable revision, activation, and optimistic conflicts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-automation-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const changes: string[] = []
    root.on('numen/automation-change', automationId => changes.push(automationId))

    const created = root.automations.create({ name: 'Morning note', source })
    expect(created.draft.version).toBe(1)
    const updatedSource = structuredClone(source)
    if (updatedSource.flow.type !== 'block' || updatedSource.flow.steps[0]?.type !== 'capability') throw new Error('invalid fixture')
    updatedSource.flow.steps[0].input.value = { type: 'literal', value: 'updated' }
    const draft = root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 1,
      source: updatedSource,
    })
    expect(draft.version).toBe(2)
    expect(() => root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 1,
      source,
    })).toThrow(DraftConflictError)

    const revision = root.automations.publishDraft(created.automation.id, 2)
    expect(revision.number).toBe(1)
    expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(revision.compiledPlan.entry).toBe('record')
    root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 2,
      source: updatedSource,
      presentation: { viewport: 'wide' },
    })
    const presentationRevision = root.automations.publishDraft(created.automation.id, 3)
    expect(presentationRevision).toMatchObject({ number: 2, contentHash: revision.contentHash })
    const activated = root.automations.activateRevision(created.automation.id, presentationRevision.id)
    expect(activated).toMatchObject({ enabled: false, activeRevisionId: presentationRevision.id, activationGeneration: 1 })
    const enabled = root.automations.setEnabled(created.automation.id, true)
    expect(enabled).toMatchObject({ enabled: true, activationGeneration: 2 })
    expect(root.automations.listSummaries()).toEqual([expect.objectContaining({
      id: created.automation.id,
      draftVersion: 3,
      revisionCount: 2,
      latestRevisionNumber: 2,
    })])
    expect(changes).toEqual(Array.from({ length: 7 }, () => created.automation.id))
    await root.fiber.dispose()

    const restarted = await createContext(databasePath)
    expect(restarted.automations.get(created.automation.id)).toMatchObject({
      activeRevisionId: presentationRevision.id,
      activationGeneration: 2,
    })
    expect(restarted.automations.getRevision(revision.id)?.contentHash).toBe(revision.contentHash)
    await restarted.fiber.dispose()
  })
  it('fences both desired-state operations and rejects foreign revisions without changing Drafts or history', async () => {
    const root = await createContext(':memory:')
    try {
      const first = root.automations.create({ name: 'First', source })
      const other = root.automations.create({ name: 'Other', source })
      const revision = root.automations.publishDraft(first.automation.id, 1)
      const foreign = root.automations.publishDraft(other.automation.id, 1)
      const draft = root.automations.getDraft(first.automation.id)
      const changes: string[] = []
      root.on('numen/automation-change', id => changes.push(id))
      expect(() => root.automations.activateRevision(first.automation.id, foreign.id, 0)).toThrow(AutomationRevisionNotFoundError)
      expect(() => root.automations.activateRevision('missing', revision.id, 0)).toThrow(AutomationNotFoundError)
      const activated = root.automations.activateRevision(first.automation.id, revision.id, 0)
      expect(activated).toMatchObject({ activationGeneration: 1, enabled: false, activeRevisionId: revision.id })
      expect(() => root.automations.setEnabled(first.automation.id, true, 0)).toThrow(AutomationActivationConflictError)
      expect(() => root.automations.activateRevision(first.automation.id, revision.id, 0)).toThrow(AutomationActivationConflictError)
      expect(root.automations.activateRevision(first.automation.id, revision.id, 1)).toEqual(activated)
      expect(root.automations.setEnabled(first.automation.id, false, 1)).toEqual(activated)
      expect(changes).toEqual([first.automation.id])
      const enabled = root.automations.setEnabled(first.automation.id, true, 1)
      expect(enabled).toMatchObject({ enabled: true, activationGeneration: 2 })
      expect(() => root.automations.setEnabled(first.automation.id, true, 1)).toThrow(AutomationActivationConflictError)
      const disabled = root.automations.setEnabled(first.automation.id, false, 2)
      expect(disabled).toMatchObject({ enabled: false, activeRevisionId: revision.id, activationGeneration: 3 })
      for (const expected of [-1, 0.5, NaN]) expect(() => root.automations.setEnabled(first.automation.id, true, expected)).toThrow(TypeError)
      expect(root.automations.getDraft(first.automation.id)).toEqual(draft)
      expect(root.automations.getRevision(revision.id)).toEqual(revision)
      expect(root.automations.get(other.automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
      expect(changes).toHaveLength(3)
    } finally { await root.fiber.dispose() }
  })

})
