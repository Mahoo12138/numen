import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { ConsoleAuthenticationError, ConsoleService, consoleHttpPlugin, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, type CapabilityDefinition } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { SchedulerService } from '@numenjs/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceService } from '../../resources/src/index.js'
import { provideExecutionData, workbenchExecutionDataQuery } from '../src/execution-data-provider.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const visible = <T extends z>(schema: T): T => schema.extra('extra', { numen: { execution: 'public' } }) as T
function request(authenticated = true): ConsoleRequestContext {
  return { requestId: 'inspection-request', principal: { subject: { type: 'user', id: 'owner' }, authenticated },
    signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger }
}

async function fixture() {
  const root = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'numen-inspection-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CapabilityRegistry)
  const fields = () => z.object({
    safe: visible(z.string().required()), secret: visible(z.string().required()),
    arbitrary: z.any(), nested: z.object({ allowed: visible(z.number()), confidential: z.string().role('secret') }),
  })
  const action: CapabilityDefinition = { id: 'test:inspect', version: 1, kind: 'query', title: 'Inspect fixture',
    input: fields(), output: fields(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unloadDefinition = root.capabilities.define(root, action)
  root.capabilities.provide(root, action, { async invoke({ input }) { return input } })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchExecutionDataQuery)
  provideExecutionData(root)
  const created = root.automations.create({ name: 'Inspection', source: { triggers: [], flow: {
    type: 'capability', id: 'inspect', capability: { id: action.id, version: action.version }, input: {
      safe: { type: 'literal', value: '<img src=x onerror=alert(1)>' },
      secret: { type: 'literal', value: 'KNOWN_SECRET' },
      arbitrary: { type: 'literal', value: { innocent: 'UNKNOWN_SECRET' } },
      nested: { type: 'literal', value: { allowed: 42, confidential: 'ROLE_SECRET' } },
    },
  } } })
  const revision = root.automations.publishDraft(created.automation.id, 1)
  root.automations.activateRevision(created.automation.id, revision.id)
  const run = root.scheduler.startManual(created.automation.id)
  await root.scheduler.dispatchUntilIdle()
  const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'inspect')!
  const attempt = root.scheduler.listAttempts(run.id).find(item => item.executionId === execution.id)!
  return { root, run, execution, attempt, created, revision, unloadDefinition }
}

describe('Execution data Provider', () => {
  it('uses immutable metadata after definition changes/unload and never includes opaque or sensitive values', async () => {
    const { root, run, execution, attempt, revision, unloadDefinition } = await fixture()
    expect(JSON.stringify(revision.contractSnapshot)).toContain('"execution":"public"')
    unloadDefinition()
    const context = request()
    const result = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: execution.id, attemptId: attempt.id }, context)
    expect(result).toMatchObject({ sourceNodeId: 'inspect', provenance: 'execution-current', attempt: { id: attempt.id, number: 1 },
      input: { value: { safe: '<img src=x onerror=alert(1)>', nested: { allowed: 42 } }, hidden: 3 },
      output: { value: { safe: '<img src=x onerror=alert(1)>', nested: { allowed: 42 } }, hidden: 3 } })
    expect(JSON.stringify(result)).not.toContain('_SECRET')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) expect(context.logger[method]).not.toHaveBeenCalled()
  })

  it('checks authenticated principal and Run / Execution / Attempt membership before returning data', async () => {
    const { root, run, execution, attempt, created } = await fixture()
    const second = root.scheduler.startManual(created.automation.id)
    await root.scheduler.dispatchUntilIdle()
    const secondExecution = root.scheduler.listExecutions(second.id).find(item => item.instructionId === 'inspect')!
    await expect(root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: execution.id }, request(false))).rejects.toMatchObject({ status: 401 })
    await expect(root.console.query(workbenchExecutionDataQuery, { runId: second.id, executionId: execution.id }, request())).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' })
    await expect(root.console.query(workbenchExecutionDataQuery, { runId: second.id, executionId: secondExecution.id, attemptId: attempt.id }, request())).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' })
    await expect(root.console.query(workbenchExecutionDataQuery, { runId: 'missing', executionId: execution.id }, request())).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' })
  })

  it('bounds stored JSON bytes before parsing and summarizes an absent contract instead of falling back to live metadata', async () => {
    const { root, run, execution, revision } = await fixture()
    root.database.db.prepare('UPDATE executions SET output_json = ? WHERE id = ?').run(JSON.stringify({ safe: '🙂'.repeat(20_000) }), execution.id)
    const result = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: execution.id }, request())
    expect(result.output).toMatchObject({ truncated: true, available: true })
    expect(JSON.stringify(result)).not.toContain('🙂')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24_576)
    root.database.db.prepare('UPDATE automation_revisions SET contract_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ capabilities: [] }), revision.id)
    const unknown = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: execution.id }, request())
    expect(unknown.input.hidden).toBe(1)
    expect(JSON.stringify(unknown)).not.toContain('<img')
  })

  it('serves authenticated POST-only inspection with no-store, including authentication failure', async () => {
    const { root, run, execution } = await fixture()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    root.console.provideAuthenticator(root, { authenticate({ headers }) {
      if (headers.get('authorization') !== 'Bearer fixture-token') throw new ConsoleAuthenticationError('Authentication required')
      return { principal: { subject: { type: 'user', id: 'owner' }, authenticated: true } }
    } })
    await root.plugin(consoleHttpPlugin)
    const body = JSON.stringify({ kind: 'query', procedure: 'numen:execution-data@1', input: { runId: run.id, executionId: execution.id } })
    const url = `${root.server.baseUrl}/api/console/call`
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(denied.status).toBe(401)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    const allowed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-token' }, body })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(await allowed.text()).not.toContain('_SECRET')
    expect((await fetch(url)).status).toBe(405)
    root.database.db.prepare('UPDATE executions SET output_json = ? WHERE id = ?').run('CORRUPT_PRIVATE_FRAGMENT', execution.id)
    const corrupted = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-token' }, body })
    expect(corrupted.status).toBe(409)
    expect(corrupted.headers.get('cache-control')).toBe('no-store')
    const failure = await corrupted.json()
    expect(failure).toMatchObject({ error: { code: 'EXECUTION_DATA_UNAVAILABLE', message: 'Execution data could not be inspected.' } })
    expect(failure.error.details).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain('CORRUPT_PRIVATE_FRAGMENT')
  })
})
