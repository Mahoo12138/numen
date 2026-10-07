import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import { ConsoleAuthenticationError, ConsoleService, consoleHttpPlugin, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, ControlRegistry, type AutomationSource, type CapabilityDefinition } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { SchedulerService } from '@numenjs/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceService } from '../../resources/src/index.js'
import { workbenchExecutionDataQuery } from '../src/execution-data-provider.js'
import { workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { workbenchCancelRunAction, workbenchRunDetailQuery, workbenchRunsIndexQuery, workbenchRunsProviderPlugin } from '../src/runs-provider.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (authenticated = true): ConsoleRequestContext => ({ requestId: 'draft-test-provider', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger })
const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'saved-flow', steps: [] } }

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'numen-draft-provider-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function context(directoryPath?: string) {
  const path = directoryPath ?? await directory()
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: join(path, 'db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(ControlRegistry)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(path, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  for (const definition of [workbenchManualRunFormQuery, workbenchStartManualRunAction, workbenchRunDetailQuery, workbenchExecutionDataQuery, workbenchRunsIndexQuery, workbenchCancelRunAction]) root.console.define(root, definition)
  workbenchRunsProviderPlugin(root)
  return root
}

function acceptedCounts(root: Context) {
  return Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table,
    (root.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]))
}

const submit = (root: Context, automationId: string, expectedDraftVersion: number, requestId: string, input = {}, trigger: unknown = {}) => root.console.action(workbenchStartManualRunAction, { automationId, mode: 'draft-test', expectedDraftVersion, requestId, input, trigger: trigger as never }, request())

describe('Workbench saved Draft test contract', () => {
  it('does not echo sensitive literals in compiler validation diagnostics while preserving codes and Source locations', async () => {
    const root = await context()
    const action: CapabilityDefinition = { id: 'test:private-schema', version: 1, kind: 'action', title: 'Private input schema', input: z.object({ password: z.number().required() }), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
    const trigger: CapabilityDefinition = { id: 'test:private-trigger', version: 1, kind: 'trigger', title: 'Private trigger schema', input: z.object({ secret: z.number().required() }), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
    root.capabilities.define(root, action)
    root.capabilities.define(root, trigger)
    const { automation } = root.automations.create({ name: 'Safe compiler diagnostics', source: {
      triggers: [{ id: 'private-trigger', capability: { id: trigger.id, version: 1 }, config: { secret: 'PRIVATE_TRIGGER_CONFIG_LITERAL' } }],
      flow: { type: 'capability', id: 'private-step', capability: { id: action.id, version: 1 }, input: { password: { type: 'literal', value: 'PRIVATE_PASSWORD_LITERAL' } } },
    } })
    const before = acceptedCounts(root)
    const error = await submit(root, automation.id, 1, 'draft-provider-safe-diagnostics-01').catch(error => error)
    expect(error).toMatchObject({ status: 422, code: 'AUTOMATION_DRAFT_TEST_INVALID', details: { diagnostics: expect.arrayContaining([
      expect.objectContaining({ severity: 'error', code: 'INPUT_SCHEMA_INVALID', source: { nodeId: 'private-step', fieldPath: 'input.password' } }),
      expect.objectContaining({ severity: 'error', code: 'TRIGGER_SCHEMA_INVALID', source: { nodeId: 'private-trigger', fieldPath: 'config' } }),
    ]) } })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_')
    expect(acceptedCounts(root)).toEqual(before)
  })

  it('reads only snapshot identities for a mixed published and Draft-test history page', async () => {
    const root = await context()
    const { automation } = root.automations.create({ name: 'Bounded history metadata', source: empty })
    const accepted = await submit(root, automation.id, 1, 'draft-provider-bounded-index-01')
    const published = root.automations.publishDraft(automation.id, 1)
    const publishedRun = root.scheduler.startRevisionTest(automation.id, published.id, {}, {}, 'draft-provider-bounded-release-01')
    const fullSnapshot = vi.spyOn(root.automations, 'getExecutionSnapshot').mockImplementation(() => { throw new Error('History lists must not decode Source, IR or contracts') })
    const identity = vi.spyOn(root.automations, 'getExecutionSnapshotIdentity')
    try {
      const history = await root.console.query(workbenchRunsIndexQuery, { automationId: automation.id, limit: 25 }, request())
      expect(history.items).toHaveLength(2)
      expect(history.items.find(item => item.id === accepted.runId)).toMatchObject({ revisionId: accepted.snapshotId, snapshotPurpose: 'draft-test', sourceDraftVersion: 1 })
      expect(history.items.find(item => item.id === publishedRun.id)).toMatchObject({ revisionId: published.id, snapshotPurpose: 'published' })
      expect(history.items.find(item => item.id === publishedRun.id)).not.toHaveProperty('sourceDraftVersion')
      expect(identity).toHaveBeenCalledTimes(2)
      expect(identity).toHaveBeenCalledWith(accepted.snapshotId)
      expect(identity).toHaveBeenCalledWith(published.id)
      expect(fullSnapshot).not.toHaveBeenCalled()
    } finally { identity.mockRestore(); fullSnapshot.mockRestore() }
  })

  it('accepts unpublished disabled Drafts without adding published choices and labels their immutable version in both history queries', async () => {
    const root = await context()
    const source: AutomationSource = { ...empty, inputs: { message: { type: 'string', default: 'saved default' } } }
    const { automation } = root.automations.create({ name: 'Unpublished disabled', source })
    const before = root.automations.get(automation.id), draftBefore = root.automations.getDraft(automation.id)
    expect(before).toMatchObject({ enabled: false })
    await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test' }, request())).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_NO_REVISIONS' })
    expect(await root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'draft-test', expectedDraftVersion: 1 }, request())).toEqual({ automationId: automation.id, mode: 'draft-test', draftVersion: 1, inputs: source.inputs })
    const accepted = await submit(root, automation.id, 1, 'draft-provider-unpublished-01')
    expect(accepted).toMatchObject({ runId: expect.any(String), snapshotId: expect.any(String), sourceDraftVersion: 1 })
    expect(root.scheduler.getRun(accepted.runId)).toMatchObject({ revisionId: accepted.snapshotId, input: { message: 'saved default' }, status: 'QUEUED' })
    expect(root.automations.get(automation.id)).toEqual(before)
    expect(root.automations.getDraft(automation.id)).toEqual(draftBefore)
    expect(root.automations.listRevisions(automation.id)).toEqual([])
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { ...empty, flow: { type: 'block', id: 'edited-flow', steps: [] } } })
    const detail = await root.console.query(workbenchRunDetailQuery, { runId: accepted.runId, executionLimit: 25, eventLimit: 100 }, request())
    expect(detail?.run).toMatchObject({ revisionId: accepted.snapshotId, snapshotPurpose: 'draft-test', sourceDraftVersion: 1 })
    expect(detail?.run).not.toHaveProperty('revisionNumber')
    expect(detail?.flow.root).toMatchObject({ detail: 'Draft test · Draft v1 · IR 1', children: [expect.objectContaining({ id: 'saved-flow' })] })
    const history = await root.console.query(workbenchRunsIndexQuery, { automationId: automation.id, limit: 25 }, request())
    expect(history.items).toEqual([expect.objectContaining({ id: accepted.runId, snapshotPurpose: 'draft-test', sourceDraftVersion: 1 })])
    const published = root.automations.publishDraft(automation.id, 2)
    expect(published.number).toBe(1)
    const choices = await root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test' }, request())
    expect(choices).toMatchObject({ revisionId: published.id, revisions: [{ id: published.id, number: 1, active: false }] })
    await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test', revisionId: accepted.snapshotId }, request())).rejects.toBeInstanceOf(z.ValidationError)
    await expect(root.console.action(workbenchStartManualRunAction, { automationId: automation.id, mode: 'revision-test', revisionId: accepted.snapshotId!, requestId: 'draft-provider-release-fence-01', input: {}, trigger: {} }, request())).rejects.toBeInstanceOf(z.ValidationError)
    expect(root.scheduler.listRuns()).toHaveLength(1)
    expect(root.automations.publishDraft(automation.id, 2).number).toBe(2)
    expect(root.automations.get(automation.id)).toMatchObject({ enabled: false })
    expect(root.automations.get(automation.id)?.activeRevisionId).toBeUndefined()
  })

  it('returns version/compiler/input/resource rejections before accepting identities and exposes Source locations without private payloads', async () => {
    const root = await context()
    const { automation } = root.automations.create({ name: 'Rejections', source: empty })
    const before = acceptedCounts(root)
    await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'draft-test', expectedDraftVersion: 2 }, request())).rejects.toMatchObject({ status: 409, code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 1 } })
    await expect(submit(root, automation.id, 2, 'draft-provider-version-01')).rejects.toMatchObject({ status: 409, code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 1 } })
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { triggers: [], flow: { type: 'capability', id: 'missing-step', capability: { id: 'missing:action', version: 1 }, input: { secret: { type: 'literal', value: 'PRIVATE_LITERAL_VALUE' } } } } })
    const compileError = await submit(root, automation.id, 2, 'draft-provider-compiler-01').catch(error => error)
    expect(compileError).toMatchObject({ status: 422, code: 'AUTOMATION_DRAFT_TEST_INVALID', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'CAPABILITY_MISSING', source: { nodeId: 'missing-step', fieldPath: 'capability' } })]) } })
    expect(JSON.stringify(compileError)).not.toContain('PRIVATE_LITERAL_VALUE')
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: { ...empty, inputs: { required: { type: 'string', required: true } } } })
    await expect(submit(root, automation.id, 3, 'draft-provider-input-01')).rejects.toMatchObject({ status: 422, code: 'AUTOMATION_INPUT_INVALID', details: { issues: [expect.objectContaining({ field: 'required' })] } })
    const staged = await root.resources.stage({ name: 'Private attachment', mediaType: 'text/plain', content: Buffer.from('PRIVATE_RESOURCE_CONTENT') })
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 3, source: { ...empty, inputs: { file: { type: 'object', default: staged.ref } } } })
    await root.resources.store.delete(staged.digest)
    const missing = await submit(root, automation.id, 4, 'draft-provider-missing-bytes-01').catch(error => error)
    expect(missing).toMatchObject({ status: 422, code: 'RUN_RESOURCE_UNAVAILABLE', message: 'A referenced resource is unavailable.' })
    for (const privateValue of [staged.id, staged.digest, 'PRIVATE_RESOURCE_CONTENT']) expect(JSON.stringify(missing)).not.toContain(privateValue)
    await expect(root.console.action(workbenchStartManualRunAction, { automationId: automation.id, mode: 'draft-test', expectedDraftVersion: 4, requestId: 'draft-provider-invalid-trigger-01', input: {}, trigger: undefined as never }, request())).rejects.toMatchObject({ status: 422, code: 'RUN_TRIGGER_INVALID' })
    expect(acceptedCounts(root)).toEqual(before)
    expect(root.resources.get(staged.id)?.state).toBe('STAGED')
  })

  it('recovers exactly the accepted snapshot after response loss, changed Draft, archive, compiler unload and server restart', async () => {
    const path = await directory(), root = await context(path)
    const unload = root.controls.defineControl(root, { kind: 'extension', id: 'test:temporary', version: 1, title: 'Temporary saved compiler', description: '', input: z.object({}), lower: ({ nodeId }) => ({ type: 'block', id: nodeId, steps: [] }) })
    const source: AutomationSource = { inputs: { message: { type: 'string', default: 'original' } }, triggers: [], flow: { type: 'extension', id: 'original-control', control: { id: 'test:temporary', version: 1 }, input: {} } }
    const { automation } = root.automations.create({ name: 'Response recovery', source })
    const requestId = 'draft-provider-recovery-01'
    const accepted = await submit(root, automation.id, 1, requestId, {}, null)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty })
    unload()
    root.automations.archive(automation.id)
    await root.fiber.dispose()
    const restarted = await context(path)
    expect(await submit(restarted, automation.id, 1, requestId, {}, null)).toEqual(accepted)
    await expect(submit(restarted, automation.id, 1, requestId, { message: 'original' }, null)).rejects.toMatchObject({ status: 409, code: 'MANUAL_RUN_REQUEST_CONFLICT' })
    await expect(submit(restarted, automation.id, 2, 'draft-provider-after-archive-01')).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_ARCHIVED' })
    expect(acceptedCounts(restarted)).toMatchObject({ automation_revisions: 1, runs: 1, run_events: 1, manual_run_requests: 1 })
    expect(restarted.automations.getExecutionSnapshot(accepted.snapshotId!)?.source).toEqual(source)
    await restarted.scheduler.dispatchUntilIdle()
    const detail = await restarted.console.query(workbenchRunDetailQuery, { runId: accepted.runId, sourceNodeId: 'original-control', executionLimit: 25, eventLimit: 100 }, request())
    expect(detail?.run).toMatchObject({ snapshotPurpose: 'draft-test', sourceDraftVersion: 1, status: 'COMPLETED' })
    expect(detail?.flow.root.children[0]).toMatchObject({ id: 'original-control', title: 'Temporary saved compiler' })
    expect(restarted.scheduler.listEvents(accepted.runId).filter(event => event.type === 'RunAccepted')).toHaveLength(1)
  })

  it('uses saved Source and field classifications for execution inspection after Draft edits and definition unload', async () => {
    const root = await context()
    const visible = <T extends z>(schema: T): T => schema.extra('extra', { numen: { execution: 'public' } }) as T
    const fields = () => z.object({ safe: visible(z.string().required()), secret: visible(z.string().required()), opaque: z.any().required() })
    const definition: CapabilityDefinition = { id: 'test:draft-inspection', version: 1, kind: 'action', title: 'Saved inspection contract', input: fields(), output: fields(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
    const unloadDefinition = root.capabilities.define(root, definition)
    root.capabilities.provide(root, definition, { async invoke({ input }) { return input } })
    const { automation } = root.automations.create({ name: 'Private saved Source', source: { triggers: [], flow: { type: 'capability', id: 'saved-inspection', capability: { id: definition.id, version: 1 }, input: { safe: { type: 'literal', value: 'PUBLIC_VALUE' }, secret: { type: 'literal', value: 'PRIVATE_SECRET_VALUE' }, opaque: { type: 'literal', value: { harmlessName: 'PRIVATE_OPAQUE_VALUE' } } } } } })
    const accepted = await submit(root, automation.id, 1, 'draft-provider-inspection-01', {}, { password: 'PRIVATE_TRIGGER_VALUE' })
    await root.scheduler.dispatchUntilIdle()
    unloadDefinition()
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty })
    const detail = await root.console.query(workbenchRunDetailQuery, { runId: accepted.runId, sourceNodeId: 'saved-inspection', executionLimit: 25, eventLimit: 100 }, request())
    expect(detail?.flow.root.children[0]).toMatchObject({ id: 'saved-inspection', title: 'Saved inspection contract' })
    const execution = detail!.executions.find(item => item.instructionId === 'saved-inspection')!
    expect(execution.sourceNodeId).toBe('saved-inspection')
    const inspection = await root.console.query(workbenchExecutionDataQuery, { runId: accepted.runId, executionId: execution.id }, request())
    expect(inspection).toMatchObject({ sourceNodeId: 'saved-inspection', input: { value: { safe: 'PUBLIC_VALUE' }, hidden: 2 }, output: { value: { safe: 'PUBLIC_VALUE' }, hidden: 2 } })
    for (const privateValue of ['PRIVATE_SECRET_VALUE', 'PRIVATE_OPAQUE_VALUE', 'PRIVATE_TRIGGER_VALUE']) {
      expect(JSON.stringify(detail)).not.toContain(privateValue)
      expect(JSON.stringify(inspection)).not.toContain(privateValue)
    }
    await expect(root.console.query(workbenchExecutionDataQuery, { runId: accepted.runId, executionId: execution.id }, request(false))).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' })
  })

  it('requires the existing Console authenticator before accepting browser actions, ignoring forged principals', async () => {
    const root = await context()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    root.console.provideAuthenticator(root, { authenticate({ headers }) {
      if (headers.get('authorization') !== 'Bearer provider-token') throw new ConsoleAuthenticationError('Authentication required')
      return { principal: { subject: { type: 'user', id: 'owner' }, authenticated: true } }
    } })
    await root.plugin(consoleHttpPlugin)
    const { automation } = root.automations.create({ name: 'Authenticated Draft', source: empty })
    const body = JSON.stringify({ kind: 'action', procedure: 'numen:manual-run-start@1', input: { automationId: automation.id, mode: 'draft-test', expectedDraftVersion: 1, requestId: 'draft-provider-http-auth-01', input: {}, trigger: {} }, principal: { authenticated: true, subject: { type: 'user', id: 'attacker' } } })
    const url = `${root.server.baseUrl}/api/console/call`
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(denied.status).toBe(401)
    expect(root.scheduler.listRuns()).toHaveLength(0)
    const allowed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer provider-token' }, body })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ result: { runId: expect.any(String), snapshotId: expect.any(String), sourceDraftVersion: 1 } })
    expect(root.scheduler.listRuns()).toHaveLength(1)
  })
})
