import { writeConfig } from '@numen/config'
import {
  workbenchInvalidationSubscriptionRef,
  type WorkbenchInvalidationEvent,
} from '@numen/workbench/contracts'
import z from 'schemastery'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const workbenchRoot = join(directory, 'workbench')
    const workbenchEntry = join(workbenchRoot, 'core-entry.js')
    await mkdir(workbenchRoot)
    await writeFile(join(workbenchRoot, 'index.html'), '<main id="root">Runtime Workbench</main>')
    await writeFile(workbenchEntry, 'export default function coreWorkbench() {}\n')
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
        workbench: { root: workbenchRoot, entrySource: workbenchEntry },
        workbenchAutomationAuthoring: {},
        workbenchAutomationCatalog: {},
        workbenchAutomations: {},
        workbenchConnections: {},
        workbenchHome: {},
        workbenchInvalidation: {},
        workbenchRuns: {},
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
    expect(application.context.console.list()).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:automation-detail', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:automation-insert-catalog', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:automation-publish-draft', version: 1, kind: 'action' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:automation-save-draft', version: 1, kind: 'action' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:automations-index', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:connections-index', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:home-overview', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:runs-index', version: 1, kind: 'query' }),
        providerAvailable: true,
      }),
      expect.objectContaining({
        definition: expect.objectContaining({ id: 'numen:workbench-invalidation', version: 1, kind: 'subscription' }),
        providerAvailable: true,
      }),
    ])
    const invalidations: WorkbenchInvalidationEvent[] = []
    const invalidationController = new AbortController()
    const disposeInvalidation = await application.context.console.subscribe(
      workbenchInvalidationSubscriptionRef,
      {},
      {
        requestId: 'runtime-invalidation-test',
        principal: { subject: { type: 'user', id: 'runtime-owner' }, authenticated: true },
        signal: invalidationController.signal,
        logger: application.context.logger('runtime:invalidation-test'),
      },
      event => invalidations.push(event),
    )
    expect(invalidations).toEqual([{ scopes: ['home', 'automations', 'automationCatalog', 'runs', 'connections'] }])
    invalidations.length = 0
    application.context.emit('numen/run-change', 'synthetic-run')
    application.context.emit('numen/automation-change', 'synthetic-automation')
    await vi.waitFor(() => expect(invalidations).toEqual([{ scopes: ['home', 'automations', 'runs'] }]))
    invalidations.length = 0
    application.context.emit('numen/capability-change', { id: 'synthetic:capability', version: 1 })
    await vi.waitFor(() => expect(invalidations).toEqual([{ scopes: ['automationCatalog'] }]))
    expect(application.context.consoleEntries.list()).toEqual([{
      id: 'numen:workbench-core',
      prod: workbenchEntry,
    }])
    expect(application.entries).toContainEqual(expect.objectContaining({
      key: 'consoleWs', builtin: true, disabled: false,
    }))
    expect(application.entries).toContainEqual(expect.objectContaining({
      key: 'workbench', builtin: true, disabled: false,
    }))
    const baseUrl = application.serverUrl!
    const launchUrl = new URL(application.workbenchUrl!)
    expect(launchUrl.origin).toBe(new URL(baseUrl).origin)
    expect(launchUrl.pathname).toBe('/')
    expect(launchUrl.search).toBe('')
    expect(new URLSearchParams(launchUrl.hash.slice(1)).get('numen-bootstrap')).toBe('runtime-console-token')
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
    const entryDocument = await entryManifest.json() as {
      entries: Array<{ id: string; url: string }>
      unavailable: unknown[]
    }
    expect(entryDocument).toMatchObject({
      entries: [{ id: 'numen:workbench-core' }],
      unavailable: [],
    })
    const coreEntryUrl = new URL(entryDocument.entries[0]!.url, baseUrl)
    expect((await fetch(coreEntryUrl)).status).toBe(401)
    const coreEntry = await fetch(coreEntryUrl, {
      headers: { authorization: 'Bearer runtime-console-token' },
    })
    expect(coreEntry.status).toBe(200)
    expect(await coreEntry.text()).toContain('coreWorkbench')
    expect((await fetch(`${baseUrl}/workbench/core-entry.js`)).status).toBe(404)
    const workbenchDocument = await fetch(`${baseUrl}/automations`)
    expect(workbenchDocument.status).toBe(200)
    expect(await workbenchDocument.text()).toContain('Runtime Workbench')
    const created = application.context.automations.create({ name: 'Runtime smoke test' })
    const invalidSource = {
      triggers: [],
      flow: {
        type: 'block' as const,
        id: 'flow',
        steps: [{ type: 'wait' as const, id: 'incomplete-wait' }],
      },
    }
    const saveDraft = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'action',
        procedure: 'numen:automation-save-draft@1',
        input: {
          automationId: created.automation.id,
          expectedVersion: 1,
          source: invalidSource,
          presentation: {},
        },
      }),
    })
    expect(saveDraft.status).toBe(200)
    expect(await saveDraft.json()).toMatchObject({ result: { draft: { version: 2, source: invalidSource } } })
    const staleSave = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'action',
        procedure: 'numen:automation-save-draft@1',
        input: {
          automationId: created.automation.id,
          expectedVersion: 1,
          source: invalidSource,
          presentation: {},
        },
      }),
    })
    expect(staleSave.status).toBe(409)
    expect(await staleSave.json()).toMatchObject({
      error: {
        code: 'DRAFT_VERSION_CONFLICT',
        details: { expectedVersion: 1, actualVersion: 2 },
      },
    })
    const invalidPublish = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'action',
        procedure: 'numen:automation-publish-draft@1',
        input: { automationId: created.automation.id, expectedVersion: 2 },
      }),
    })
    expect(invalidPublish.status).toBe(422)
    expect(await invalidPublish.json()).toMatchObject({
      error: {
        code: 'AUTOMATION_PUBLISH_INVALID',
        details: { diagnostics: [expect.objectContaining({ code: 'WAIT_SOURCE_INVALID' })] },
      },
    })
    const repairDraft = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'action',
        procedure: 'numen:automation-save-draft@1',
        input: {
          automationId: created.automation.id,
          expectedVersion: 2,
          source: created.draft.source,
          presentation: {},
        },
      }),
    })
    expect(repairDraft.status).toBe(200)
    expect(await repairDraft.json()).toMatchObject({ result: { draft: { version: 3 } } })
    const publishDraft = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'action',
        procedure: 'numen:automation-publish-draft@1',
        input: { automationId: created.automation.id, expectedVersion: 3 },
      }),
    })
    expect(publishDraft.status).toBe(200)
    const publishDocument = await publishDraft.json() as {
      result: { revision: { id: string; number: number; active: boolean } }
    }
    expect(publishDocument.result.revision).toMatchObject({ number: 1, active: false })
    const revision = publishDocument.result.revision
    application.context.automations.activateRevision(created.automation.id, revision.id)
    application.context.automations.setEnabled(created.automation.id, true)
    const automationsIndex = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:automations-index@1', input: {} }),
    })
    expect(automationsIndex.status).toBe(200)
    expect(await automationsIndex.json()).toMatchObject({
      result: {
        summary: { total: 1, enabled: 1, published: 1 },
        items: [{
          id: created.automation.id,
          name: 'Runtime smoke test',
          enabled: true,
          activeRevisionId: revision.id,
          draftVersion: 3,
          revisionCount: 1,
          latestRevisionNumber: 1,
        }],
      },
    })
    const automationDetail = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'query',
        procedure: 'numen:automation-detail@1',
        input: { automationId: created.automation.id },
      }),
    })
    expect(automationDetail.status).toBe(200)
    expect(await automationDetail.json()).toMatchObject({
      result: {
        automation: { id: created.automation.id, activeRevisionId: revision.id },
        draft: {
          version: 3,
          source: { triggers: [], flow: { type: 'block', id: 'flow', steps: [] } },
        },
        revisions: [{ id: revision.id, number: 1, active: true }],
      },
    })
    const run = application.context.scheduler.startManual(created.automation.id)
    await application.context.scheduler.dispatchUntilIdle()
    expect(application.context.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    const homeOverview = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:home-overview@1', input: {} }),
    })
    expect(homeOverview.status).toBe(200)
    expect(await homeOverview.json()).toMatchObject({
      result: {
        automations: {
          total: 1,
          enabled: 1,
          recent: [{ id: created.automation.id, name: 'Runtime smoke test', enabled: true }],
        },
        runs: {
          queued: 0,
          active: 0,
          recent: [{ id: run.id, automationName: 'Runtime smoke test', status: 'COMPLETED' }],
        },
        connections: { ready: true, total: 0, enabled: 0, runtimeReady: 0, unavailable: 0, errors: 0 },
      },
    })
    const runsIndex = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:runs-index@1', input: { limit: 20 } }),
    })
    expect(runsIndex.status).toBe(200)
    expect(await runsIndex.json()).toMatchObject({
      result: {
        summary: { total: 1, queued: 0, active: 0, completed: 1, failed: 0, cancelled: 0 },
        items: [{
          id: run.id,
          automationId: created.automation.id,
          automationName: 'Runtime smoke test',
          status: 'COMPLETED',
          executionCount: 1,
          attemptCount: 0,
        }],
      },
    })
    const secondRun = application.context.scheduler.startManual(created.automation.id)
    await application.context.scheduler.dispatchUntilIdle()
    const firstRunPage = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:runs-index@1', input: { limit: 1 } }),
    })
    expect(firstRunPage.status).toBe(200)
    const firstRunPageBody = await firstRunPage.json() as {
      result: { summary: { total: number }; items: Array<{ id: string }>; nextCursor?: string }
    }
    expect(firstRunPageBody.result.summary.total).toBe(2)
    expect(firstRunPageBody.result.items).toHaveLength(1)
    expect(firstRunPageBody.result.nextCursor).toEqual(expect.any(String))
    const secondRunPage = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'query',
        procedure: 'numen:runs-index@1',
        input: { limit: 1, cursor: firstRunPageBody.result.nextCursor },
      }),
    })
    expect(secondRunPage.status).toBe(200)
    const secondRunPageBody = await secondRunPage.json() as {
      result: { items: Array<{ id: string }>; nextCursor?: string }
    }
    expect(secondRunPageBody.result.items).toHaveLength(1)
    expect([
      firstRunPageBody.result.items[0]!.id,
      secondRunPageBody.result.items[0]!.id,
    ].sort()).toEqual([run.id, secondRun.id].sort())
    expect(secondRunPageBody.result.nextCursor).toBeUndefined()
    const invalidRunsPage = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:runs-index@1', input: { limit: 51 } }),
    })
    expect(invalidRunsPage.status).toBe(422)
    expect(await invalidRunsPage.json()).toMatchObject({ error: { code: 'PROCEDURE_VALIDATION_FAILED' } })
    const invalidRunsCursor = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'query',
        procedure: 'numen:runs-index@1',
        input: { limit: 20, cursor: 'not-a-valid-cursor' },
      }),
    })
    expect(invalidRunsCursor.status).toBe(422)
    expect(await invalidRunsCursor.json()).toMatchObject({ error: { code: 'PROCEDURE_VALIDATION_FAILED' } })

    const readyAdapter = { id: 'runtime:ready', version: 1, title: 'Ready Adapter', config: z.object({}) }
    const unavailableAdapter = { id: 'runtime:unavailable', version: 1, title: 'Unavailable Adapter', config: z.object({}) }
    const failingAdapter = { id: 'runtime:failing', version: 1, title: 'Failing Adapter', config: z.object({}) }
    application.context.connections.defineAdapter(application.context, readyAdapter)
    application.context.connections.defineAdapter(application.context, unavailableAdapter)
    application.context.connections.defineAdapter(application.context, failingAdapter)
    application.context.connections.provideAdapter(application.context, readyAdapter, { async open() {} })
    application.context.connections.provideAdapter(application.context, failingAdapter, {
      async open() {
        throw new Error('runtime authentication failed')
      },
    })
    const disabledConnection = application.context.connections.create({
      name: 'Disabled account', adapter: readyAdapter, config: {}, enabled: false,
    })
    const readyConnection = application.context.connections.create({
      name: 'Ready account', adapter: readyAdapter, config: {}, enabled: true,
    })
    const unavailableConnection = application.context.connections.create({
      name: 'Unavailable account', adapter: unavailableAdapter, config: {}, enabled: true,
    })
    const failingConnection = application.context.connections.create({
      name: 'Failing account', adapter: failingAdapter, config: {}, enabled: true,
    })
    await application.context.connections.reconcile()
    const connectionsIndex = await fetch(`${baseUrl}/api/console/call`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer runtime-console-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'query', procedure: 'numen:connections-index@1', input: {} }),
    })
    expect(connectionsIndex.status).toBe(200)
    const connectionsDocument = await connectionsIndex.json()
    expect(connectionsDocument).toMatchObject({
      result: {
        summary: { total: 4, enabled: 3, ready: 1, unavailable: 1, errors: 1 },
        items: expect.arrayContaining([
          expect.objectContaining({
            id: disabledConnection.id,
            name: 'Disabled account',
            adapterTitle: 'Ready Adapter',
            enabled: false,
            adapterAvailable: true,
            credentialBound: false,
            status: 'DISABLED',
          }),
          expect.objectContaining({ id: readyConnection.id, status: 'READY' }),
          expect.objectContaining({
            id: unavailableConnection.id,
            adapterAvailable: false,
            status: 'UNAVAILABLE',
          }),
          expect.objectContaining({
            id: failingConnection.id,
            status: 'ERROR',
            statusDetail: 'Runtime failed to start',
          }),
        ]),
      },
    })
    expect(JSON.stringify(connectionsDocument)).not.toContain('runtime authentication failed')
    await disposeInvalidation()
    const invalidationCount = invalidations.length
    application.context.emit('numen/run-change', 'disposed-run')
    await Promise.resolve()
    await Promise.resolve()
    expect(invalidations).toHaveLength(invalidationCount)

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
          total: 4,
          enabled: 3,
          unavailable: 1,
          starting: 0,
          runtimeReady: 1,
          errors: 1,
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
