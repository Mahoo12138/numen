import { AutomationService } from '@numenjs/automation'
import { ConnectionService } from '@numenjs/connections'
import { CapabilityRegistry } from '@numenjs/core'
import { CredentialService } from '@numenjs/credentials'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import scheduleIntegrationPlugin, { nextCronOccurrence, parseCron, scheduleCronTrigger } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createContext(databasePath: string, resourcesPath: string): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path: databasePath })
  await root.plugin(CapabilityRegistry)
  await root.plugin(CredentialService)
  await root.plugin(ConnectionService)
  scheduleIntegrationPlugin(root)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: resourcesPath })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(TriggerService)
  return root
}

describe('Schedule Integration', () => {
  it('parses five-field cron expressions with timezone and standard day matching', () => {
    expect(parseCron('*/15 8-10 * * 1-5').minute.values).toEqual(new Set([0, 15, 30, 45]))
    expect(nextCronOccurrence('0 8 * * *', new Date('2026-09-16T23:59:30.000Z'), 'Asia/Shanghai').toISOString())
      .toBe('2026-09-17T00:00:00.000Z')
    expect(nextCronOccurrence('0 8 * * 7', new Date('2026-09-19T00:00:00.000Z'), 'UTC').toISOString())
      .toBe('2026-09-20T08:00:00.000Z')
    expect(() => parseCron('0 25 * * *')).toThrow('hour')
    expect(() => parseCron('* * *')).toThrow('minute')
  })

  it('accepts a deterministic scheduled Run and restores the next subscription after restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T07:59:30.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'numen-schedule-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const resourcesPath = join(directory, 'resources')
    let root = await createContext(databasePath, resourcesPath)
    const { automation } = root.automations.create({ name: 'Daily heartbeat', source: {
      triggers: [{ id: 'daily', capability: scheduleCronTrigger, config: { cron: '0 8 * * *', timezone: 'UTC' } }],
      flow: { type: 'block', id: 'flow', steps: [] },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    root.automations.setEnabled(automation.id, true)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(root.scheduler.listRuns()).toHaveLength(1)
    const run = root.scheduler.listRuns()[0]!
    expect(run).toMatchObject({
      status: 'QUEUED',
      trigger: { scheduledAt: '2026-09-16T08:00:00.000Z' },
    })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')

    await root.fiber.dispose()
    vi.setSystemTime(new Date('2026-09-16T08:01:00.000Z'))
    root = await createContext(databasePath, resourcesPath)
    expect(root.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await root.fiber.dispose()
  })
})
