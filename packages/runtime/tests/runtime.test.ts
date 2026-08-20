import { writeConfig } from '@numen/config'
import z from 'schemastery'
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
        console: {},
        consoleEntries: {},
        consoleAuth: { token: 'runtime-console-token', ownerId: 'runtime-owner' },
        server: { host: '127.0.0.1', port: 0 },
        consoleSession: {},
        consoleAssets: { mode: 'prod' },
        consoleHttp: {},
        consoleWs: {},
        health: {},
        readiness: {},
      },
    })

    const application = await startRuntime({ configPath })
    applications.push(application)
    expect(application.context.console.list()).toEqual([])
    expect(application.context.consoleEntries.list()).toEqual([])
    expect(application.entries).toContainEqual(expect.objectContaining({
      key: 'consoleWs', builtin: true, disabled: false,
    }))
    const baseUrl = application.serverUrl!
    const currentUser = {
      id: 'runtime:current-user',
      version: 1,
      kind: 'query' as const,
      title: 'Current user',
      input: z.object({}),
      output: z.string(),
    }
    application.context.console.define(application.context, currentUser)
    application.context.console.provideQuery(application.context, currentUser, {
      query: ({ request }) => request.principal.subject.id,
    })
    const unauthorizedConsole = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'query', procedure: 'runtime:current-user@1', input: {} }),
    })
    expect(unauthorizedConsole.status).toBe(401)
    const browserSession = await fetch(`${baseUrl}/api/console/session`, {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-console-token' },
    })
    expect(browserSession.status).toBe(200)
    const sessionCookie = browserSession.headers.get('set-cookie')!.split(';')[0]!
    const cookieConsole = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        origin: baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'runtime:current-user@1', input: {} }),
    })
    expect(cookieConsole.status).toBe(200)
    expect(await cookieConsole.json()).toMatchObject({ result: 'runtime-owner' })
    const consoleResponse = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'runtime:current-user@1', input: {} }),
    })
    expect(consoleResponse.status).toBe(200)
    expect(await consoleResponse.json()).toMatchObject({ result: 'runtime-owner' })
    const entryManifest = await fetch(`${baseUrl}/api/console/entries`, {
      headers: { authorization: 'Bearer runtime-console-token' },
    })
    expect(entryManifest.status).toBe(200)
    expect(await entryManifest.json()).toMatchObject({ entries: [], unavailable: [] })
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
