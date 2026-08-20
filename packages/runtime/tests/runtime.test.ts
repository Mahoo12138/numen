import { writeConfig } from '@numen/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startRuntime, type NumenApplication } from '../src/index.js'

const applications: NumenApplication[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Numen runtime', () => {
  it('boots the configured Cordis tree and exposes operational health', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-runtime-'))
    temporaryDirectories.push(directory)
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
        automations: {},
        scheduler: { autoDispatch: false },
        triggers: {},
        server: { host: '127.0.0.1', port: 0 },
        health: {},
        readiness: {},
      },
    })

    const application = await startRuntime({ configPath })
    applications.push(application)
    const baseUrl = application.serverUrl!
    const created = application.context.automations.create({ name: 'Runtime smoke test' })
    const revision = application.context.automations.publishDraft(created.automation.id, 1)
    application.context.automations.activateRevision(created.automation.id, revision.id)
    application.context.automations.setEnabled(created.automation.id, true)
    const run = application.context.scheduler.startManual(created.automation.id)
    await application.context.scheduler.dispatchUntilIdle()
    expect(application.context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')

    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', name: 'numen' })

    const ready = await fetch(`${baseUrl}/api/ready`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { migrationVersion: 10 },
        automations: { ready: true, count: 1 },
        connections: {
          ready: true,
          total: 0,
          enabled: 0,
          unavailable: 0,
          starting: 0,
          runtimeReady: 0,
          errors: 0,
        },
        credentials: {
          ready: true,
          encryptionConfigured: false,
          count: 0,
          unavailableTypes: 0,
        },
        resources: {
          ready: true,
          staged: 0,
          committed: 0,
          deleting: 0,
          gone: 0,
          activeLeases: 0,
        },
        scheduler: {
          ready: true,
          queuedRuns: 0,
          runnableExecutions: 0,
          waitingExecutions: 0,
          blockedExecutions: 0,
        },
        triggers: {
          ready: true,
          desiredSubscriptions: 0,
          activeSubscriptions: 0,
          unavailableSubscriptions: 0,
        },
      },
    })
  })
})
