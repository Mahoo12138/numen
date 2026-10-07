import { writeConfig } from '@numenjs/config'
import { startRuntime, type NumenApplication } from '@numenjs/runtime'
import type { AutomationSource } from '@numenjs/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'

const applications: NumenApplication[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.useRealTimers()
})

describe('Draft tests in the real plugin runtime', () => {
  it('keeps published Cron subscriptions alive beside a Draft Wait/parallel Run through authoring, Console shutdown, compiler unload and process restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T00:59:30.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'numen-draft-runtime-')); directories.push(directory)
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: {
      server: { host: '127.0.0.1', port: 0 }, database: { path: 'data/numen.db' }, capabilities: {}, controls: {},
      credentials: {}, resources: { path: 'data/resources', gcGraceMs: 0 }, connections: {}, demo: {}, schedule: {},
      automations: {}, scheduler: { autoDispatch: false }, triggers: {}, console: { auth: { token: 'draft-runtime-token' } },
    } })
    const start = async () => { const app = await startRuntime({ configPath }); applications.push(app); return app }
    let app = await start()
    const root = app.context
    const { automation } = root.automations.create({ name: 'Published Cron and saved Draft', source: {
      triggers: [{ id: 'cron', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '* * * * *', timezone: 'UTC' } }],
      flow: { type: 'capability', id: 'published-echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'published' } } },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    root.automations.setEnabled(automation.id, true)
    const before = root.automations.get(automation.id)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    const resource = await root.resources.stage({ name: 'Draft default attachment', mediaType: 'text/plain', content: Buffer.from('saved attachment'), stagingTtlMs: 0 })
    const unload = root.controls.defineControl(root, {
      kind: 'extension', id: 'test:runtime-echo', version: 1, title: 'Saved runtime echo', description: '', input: z.object({}),
      lower: ({ nodeId }) => ({ type: 'capability', id: nodeId, capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'saved lowered test' } } }),
    })
    const draftSource: AutomationSource = {
      inputs: { file: { type: 'object', default: resource.ref } },
      triggers: [{ id: 'cron', capability: { id: 'schedule:cron', version: 1 }, config: { cron: '*/2 * * * *', timezone: 'UTC' } }],
      flow: { type: 'parallel', id: 'test-parallel', branches: [
        { type: 'block', id: 'wait-branch', steps: [
          { type: 'wait', id: 'test-wait', durationMs: { type: 'literal', value: 90_000 } },
          { type: 'extension', id: 'lowered-echo', control: { id: 'test:runtime-echo', version: 1 }, input: {} },
        ] },
        { type: 'block', id: 'immediate-branch', steps: [{ type: 'capability', id: 'test-echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'saved parallel test' } } }] },
      ] },
    }
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: draftSource, presentation: { file: resource.ref } })
    const requestId = 'draft-runtime-request-0001'
    const testRun = await root.scheduler.startDraftTest(automation.id, 2, {}, { type: 'draft-test', explicit: true }, requestId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(testRun.id)?.status).toBe('RUNNING')
    expect(root.scheduler.listExecutions(testRun.id)).toEqual(expect.arrayContaining([expect.objectContaining({ instructionId: 'test-wait', status: 'WAITING' })]))
    expect(root.automations.get(automation.id)).toEqual(before)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: { triggers: [], flow: { type: 'block', id: 'now-empty', steps: [] } }, presentation: {} })
    unload()
    await root.loader.update('console', { disabled: true }); await root.loader.await()
    expect(root.console).toBeUndefined()
    expect(root.scheduler.getRun(testRun.id)?.status).toBe('RUNNING')
    await root.resources.collectGarbage(new Date('2026-10-09T00:00:00.000Z'))
    expect(root.resources.get(resource.id)?.state).toBe('COMMITTED')
    await vi.advanceTimersByTimeAsync(30_000)
    await root.scheduler.dispatchUntilIdle()
    const firstCron = root.scheduler.listRuns().find(run => run.id !== testRun.id)!
    expect(firstCron).toMatchObject({ revisionId: revision.id, status: 'COMPLETED' })
    expect(root.scheduler.listExecutions(firstCron.id).find(execution => execution.instructionId === 'published-echo')?.output).toEqual({ message: 'published' })
    expect(root.database.db.prepare('SELECT revision_id FROM trigger_events').all()).toEqual([{ revision_id: revision.id }])
    await app.stop()
    vi.setSystemTime(new Date('2026-10-08T01:00:30.000Z'))
    app = await start()
    const restarted = app.context
    expect(restarted.controls.get({ id: 'test:runtime-echo', version: 1 })).toBeUndefined()
    expect(restarted.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    expect((await restarted.scheduler.startDraftTest(automation.id, 2, {}, { type: 'draft-test', explicit: true }, requestId)).id).toBe(testRun.id)
    expect(restarted.automations.getDraft(automation.id)?.version).toBe(3)
    await vi.advanceTimersByTimeAsync(30_000)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(testRun.id)?.status).toBe('COMPLETED')
    const tests = restarted.scheduler.listExecutions(testRun.id)
    expect(tests.find(execution => execution.instructionId === 'test-echo')?.output).toEqual({ message: 'saved parallel test' })
    expect(tests.find(execution => execution.instructionId === 'lowered-echo')?.output).toEqual({ message: 'saved lowered test' })
    const cronRuns = restarted.scheduler.listRuns().filter(run => run.id !== testRun.id)
    expect(cronRuns).toHaveLength(2)
    expect(cronRuns.every(run => run.revisionId === revision.id && run.status === 'COMPLETED')).toBe(true)
    expect(restarted.automations.get(automation.id)).toEqual(before)
    expect(restarted.automations.listRevisions(automation.id).map(item => item.number)).toEqual([1])
    expect(restarted.automations.getExecutionSnapshot(testRun.revisionId)).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: 2, baseRevisionId: revision.id, source: draftSource })
    const chunks: Buffer[] = []; for await (const chunk of restarted.resources.open(resource.id)) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('saved attachment')
  })
})
