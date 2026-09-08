import { CapabilityRegistry } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutomationService, AutomationNotFoundError, DraftCopyRequestConflictError } from '../src/index.js'

async function context(path: string) {
  const root = new Context()
  await root.plugin(DatabaseService, { path })
  await root.plugin(CapabilityRegistry)
  await root.plugin(AutomationService)
  return root
}

describe('Draft copy recovery', () => {
  it('preserves the whole invalid local document without inheriting activation, Revisions, or baseRevisionId', async () => {
    const root = await context(':memory:')
    try {
      const original = root.automations.create({ name: 'Original' })
      const revision = root.automations.publishDraft(original.automation.id, 1)
      root.automations.activateRevision(original.automation.id, revision.id)
      root.automations.setEnabled(original.automation.id, true)
      const before = { automation: root.automations.get(original.automation.id), draft: root.automations.getDraft(original.automation.id) }
      const input = {
        automationId: original.automation.id, requestId: 'copy-request-00001', name: ' Local copy ',
        source: { triggers: [], flow: { type: 'extension' as const, id: 'unknown', control: { id: 'missing:control', version: 1 }, input: {} } },
        presentation: { collapsed: ['unknown'], viewport: { x: 10, y: 20 } },
      }
      const events: string[] = []
      root.on('numen/automation-change', id => { events.push(id) })
      const copy = root.automations.saveDraftCopy(input)
      expect(copy.automation).toMatchObject({ name: 'Local copy', enabled: false, activationGeneration: 0 })
      expect(copy.automation.activeRevisionId).toBeUndefined()
      expect(copy.draft).toMatchObject({ source: input.source, presentation: input.presentation, version: 1 })
      expect(copy.draft.baseRevisionId).toBeUndefined()
      expect(root.automations.listRevisions(copy.automation.id)).toEqual([])
      expect({ automation: root.automations.get(original.automation.id), draft: root.automations.getDraft(original.automation.id) }).toEqual(before)
      expect(root.automations.saveDraftCopy({ ...input, presentation: { viewport: { y: 20, x: 10 }, collapsed: ['unknown'] } }).automation.id).toBe(copy.automation.id)
      expect(events).toEqual([copy.automation.id])
      expect(() => root.automations.saveDraftCopy({ ...input, name: 'Different' })).toThrow(DraftCopyRequestConflictError)
      expect(root.automations.count()).toBe(2)
    } finally { await root.fiber.dispose() }
  })

  it('deduplicates uncertain requests after restart and rolls back missing originals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-draft-copy-'))
    const path = join(directory, 'data.db')
    let root = await context(path)
    try {
      const original = root.automations.create({ name: 'Original' })
      const input = { automationId: original.automation.id, requestId: 'copy-request-00002', name: 'Copy', source: original.draft.source, presentation: {} }
      const copy = root.automations.saveDraftCopy(input)
      await root.fiber.dispose()
      root = await context(path)
      expect(root.automations.saveDraftCopy(input).automation.id).toBe(copy.automation.id)
      expect(root.automations.count()).toBe(2)
      expect(() => root.automations.saveDraftCopy({ ...input, requestId: 'copy-request-missing', automationId: 'missing' })).toThrow(AutomationNotFoundError)
      expect(root.database.db.prepare('SELECT COUNT(*) AS count FROM automation_draft_copy_requests').get()).toEqual({ count: 1 })
      expect(() => root.automations.saveDraftCopy({ ...input, requestId: 'short' })).toThrow('request id')
      expect(() => root.automations.saveDraftCopy({ ...input, name: '   ' })).toThrow('name')
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
