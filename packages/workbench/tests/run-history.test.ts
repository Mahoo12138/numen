import { AutomationService } from '@numen/automation'
import { CapabilityRegistry } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { SchedulerService } from '@numen/scheduler'
import { ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResourceService } from '../../resources/src/index.js'
import { workbenchRunsIndexQuery, workbenchRunsProviderPlugin, workbenchCancelRunAction, workbenchRunDetailQuery } from '../src/runs-provider.js'
import { workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { advanceRunHistory, changeRunHistoryStatus, previousRunHistory, type RunHistoryPosition } from '../src/AutomationRuns.js'

const request = (): ConsoleRequestContext => ({ requestId: 'history-test', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true }, signal: new AbortController().signal, logger: {} as Logger })
describe('Automation Run history', () => {
  it('isolates Automation/status pages, scopes cursors, handles ties, and keeps totals across filters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'numen-run-history-'))
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: ':memory:' })
      await root.plugin(CapabilityRegistry)
      await root.plugin(AutomationService)
      await root.plugin(ResourceService, { path: join(dir, 'resources') })
      await root.plugin(SchedulerService, { autoDispatch: false })
      await root.plugin(ConsoleService)
      root.console.define(root, workbenchRunsIndexQuery)
      root.console.define(root, workbenchRunDetailQuery)
      root.console.define(root, workbenchCancelRunAction)
      root.console.define(root, workbenchManualRunFormQuery)
      root.console.define(root, workbenchStartManualRunAction)
      workbenchRunsProviderPlugin(root)
      const create = (name: string) => {
        const { automation } = root.automations.create({ name })
        const revision = root.automations.publishDraft(automation.id, 1)
        root.automations.activateRevision(automation.id, revision.id)
        return automation.id
      }
      const a = create('First'), b = create('Other'), empty = create('Empty')
      const firstRevision = root.automations.get(a)!.activeRevisionId
      const first = root.scheduler.startManual(a)
      root.automations.activateRevision(a, root.automations.publishDraft(a, 1).id)
      const rest = Array.from({ length: 4 }, () => root.scheduler.startManual(a))
      root.scheduler.startManual(b)
      root.database.db.prepare('UPDATE runs SET created_at = ?').run('2026-09-16T00:00:00.000Z')
      root.scheduler.cancelRun(rest[0]!.id, 'USER')
      const sorted = [first, ...rest.slice(1)].map(run => run.id).sort().reverse()
      const query = (input: Record<string, unknown>) => root.console.query(workbenchRunsIndexQuery, { limit: 2, ...input }, request())
      const page1 = await query({ automationId: a, status: 'QUEUED' })
      expect(page1.items.map(run => run.id)).toEqual(sorted.slice(0, 2))
      expect(page1.summary).toMatchObject({ total: 5, queued: 4, cancelled: 1 })
      expect(page1.nextCursor).toBeTruthy()
      // A newly accepted Run belongs to the first page, and must not displace older continuation rows.
      const latest = root.scheduler.startManual(a)
      root.database.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-09-17T00:00:00.000Z', latest.id)
      const page2 = await query({ automationId: a, status: 'QUEUED', cursor: page1.nextCursor })
      expect(page2.items.map(run => run.id)).toEqual(sorted.slice(2))
      expect(page2.nextCursor).toBeUndefined()
      expect([...page1.items, ...page2.items].find(run => run.id === first.id)?.revisionId).toBe(firstRevision)
      for (const change of [{ automationId: b, status: 'QUEUED' }, { automationId: a, status: 'CANCELLED' }, {}]) {
        await expect(query({ ...change, cursor: page1.nextCursor })).rejects.toMatchObject({ code: 'RUN_CURSOR_SCOPE_MISMATCH' })
      }
      expect((await query({ automationId: b })).summary.total).toBe(1)
      expect((await query({ automationId: empty })).items).toEqual([])
      expect((await query({ automationId: a, status: 'FAILED' })).summary.total).toBe(6)
      expect((await query({ automationId: a, status: 'FAILED' })).items).toEqual([])
      const global = await query({})
      expect(global.summary.total).toBe(7)
      expect((await query({ cursor: global.nextCursor })).items).toHaveLength(2)
      await expect(query({ status: 'INVALID' })).rejects.toThrow()
      await expect(query({ cursor: 'not-a-cursor' })).rejects.toThrow()
      await expect(query({ automationId: `auto_${'0'.repeat(32)}` })).rejects.toMatchObject({ code: 'AUTOMATION_NOT_FOUND' })
      expect(() => root.scheduler.listRunSummariesPage(2, undefined, { status: 'INVALID' as never })).toThrow()
    } finally { await root.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
  })

  it('resets pagination on filter changes and prevents duplicate Next actions', () => {
    const position: RunHistoryPosition = { status: '', history: [] }
    advanceRunHistory(position, 'first'); advanceRunHistory(position, 'first')
    expect(position.history).toEqual([null])
    advanceRunHistory(position, 'second'); previousRunHistory(position)
    expect(position.cursor).toBe('first')
    changeRunHistoryStatus(position, 'FAILED')
    expect(position).toEqual({ status: 'FAILED', history: [] })
    advanceRunHistory(position, 'filtered'); previousRunHistory(position)
    expect(position).toEqual({ status: 'FAILED', history: [] })
  })
})
