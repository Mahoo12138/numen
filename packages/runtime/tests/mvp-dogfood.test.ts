import { writeConfig } from '@numen/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRuntime, type NumenApplication } from '../src/index.js'

const applications: NumenApplication[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.useRealTimers()
})

async function startDogfoodRuntime(configPath: string): Promise<NumenApplication> {
  const application = await startRuntime({ configPath })
  applications.push(application)
  return application
}

describe('MVP Cron to Echo dogfood', () => {
  it('runs on schedule and restores the active subscription and output after restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T07:59:30.000Z'))
    const directory = await mkdtemp(join(tmpdir(), 'numen-mvp-dogfood-'))
    directories.push(directory)
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        database: { path: 'data/numen.db' },
        capabilities: {},
        credentials: {},
        resources: { path: 'data/resources' },
        connections: {},
        demo: {},
        schedule: {},
        automations: {},
        scheduler: { autoDispatch: false },
        triggers: {},
      },
    })

    let application = await startDogfoodRuntime(configPath)
    const { automation } = application.context.automations.create({
      name: 'Cron Echo Dogfood',
      source: {
        triggers: [{
          id: 'cron',
          capability: { id: 'schedule:cron', version: 1 },
          config: { cron: '* * * * *', timezone: 'UTC' },
        }],
        flow: {
          type: 'capability',
          id: 'echo',
          capability: { id: 'demo:echo', version: 1 },
          input: { message: { type: 'literal', value: 'Numen is alive.' } },
        },
      },
    })
    const revision = application.context.automations.publishDraft(automation.id, 1)
    application.context.automations.activateRevision(automation.id, revision.id)
    application.context.automations.setEnabled(automation.id, true)
    expect(application.context.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })

    await vi.advanceTimersByTimeAsync(30_000)
    await application.context.scheduler.dispatchUntilIdle()
    const firstRun = application.context.scheduler.listRuns()[0]!
    expect(firstRun.status).toBe('COMPLETED')
    expect(application.context.scheduler.listExecutions(firstRun.id).find(item => item.instructionId === 'echo')?.output)
      .toEqual({ message: 'Numen is alive.' })

    await application.stop()
    applications.splice(applications.indexOf(application), 1)
    vi.setSystemTime(new Date('2026-09-17T08:00:30.000Z'))
    application = await startDogfoodRuntime(configPath)
    expect(application.context.automations.get(automation.id)).toMatchObject({ enabled: true, activeRevisionId: revision.id })
    expect(application.context.triggers.health()).toMatchObject({ desiredSubscriptions: 1, activeSubscriptions: 1 })

    await vi.advanceTimersByTimeAsync(30_000)
    await application.context.scheduler.dispatchUntilIdle()
    const runs = application.context.scheduler.listRuns()
    expect(runs).toHaveLength(2)
    expect(runs.every(run => run.status === 'COMPLETED')).toBe(true)
    const restartedRun = runs.find(run => run.id !== firstRun.id)!
    expect(application.context.scheduler.listExecutions(restartedRun.id).find(item => item.instructionId === 'echo')?.output)
      .toEqual({ message: 'Numen is alive.' })
  })
})
