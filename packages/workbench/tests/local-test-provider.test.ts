import { AutomationService } from '@numenjs/automation'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, type AutomationSource, type LocalTestRequest, type NumenValue, type ValueExpr } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { SchedulerService } from '@numenjs/scheduler'
import { ResourceService } from '../../resources/src/index.js'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutputSampleAction, deleteOutputSampleAction, importOutputSampleAction, localTestPreviewQuery, localTestProviderPlugin, outputSamplesQuery, startLocalTestAction } from '../src/local-test-provider.js'
import type { OutputSamplesPage, OutputSampleSummary, StartLocalTestResult, WorkbenchLocalTestPreview } from '../src/local-test-contracts.js'
import { workbenchRunDetailQuery, workbenchRunsProviderPlugin, workbenchRunsIndexQuery, workbenchCancelRunAction } from '../src/runs-provider.js'
import { workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { workbenchExecutionDataQuery } from '../src/execution-data-provider.js'
import type { WorkbenchExecutionData, WorkbenchRunDetail } from '../src/contracts.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (authenticated = true, signal = new AbortController().signal): ConsoleRequestContext => ({ requestId: 'local-test-provider', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const literal = (value: NumenValue) => ({ type: 'literal' as const, value })
const ref = (path: string) => ({ type: 'ref' as const, path })
const node = (id: string, input: ValueExpr = literal(id), kind = 'query') => ({ type: 'capability' as const, id, capability: { id: `test:${kind}`, version: 1 }, input: { value: input } })
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from: { nodeId: from, port: from === 'graph' ? 'start' : 'out' }, to: { nodeId: to, port: 'in' } })
const source = (): AutomationSource => ({ triggers: [], flow: { type: 'graph', id: 'graph', version: 1,
  nodes: [node('upstream'), node('target', ref('steps.upstream'), 'write'), node('after', ref('steps.target')), node('unrelated')],
  edges: [edge('graph', 'upstream'), edge('upstream', 'target'), edge('target', 'after'), edge('graph', 'unrelated')], output: ref('steps.after') } })
const rows = (root: Context) => Object.fromEntries(['automation_output_samples', 'automation_revisions', 'runs', 'executions', 'attempts', 'manual_run_requests'].map(table => [table, root.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'numen-local-test-console-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = new Context(); cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  const invoke = vi.fn(async ({ input }: { input: { value: string } }) => input.value)
  for (const kind of ['query', 'write', 'private']) {
    const definition = { id: `test:${kind}`, version: 1, kind: kind === 'query' ? 'query' as const : 'action' as const, title: `Real ${kind} call`,
      input: z.object({ value: z.string().required() }), output: kind === 'private' ? z.string().role('secret') : z.string().extra('extra', { numen: { execution: 'public' } }),
      semantics: { sideEffect: kind === 'write', idempotent: kind !== 'write', retrySafe: kind !== 'write' } }
    root.capabilities.define(root, definition); root.capabilities.provide(root, definition, { invoke })
  }
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  for (const definition of [outputSamplesQuery, createOutputSampleAction, importOutputSampleAction, deleteOutputSampleAction, localTestPreviewQuery, startLocalTestAction,
    workbenchRunDetailQuery, workbenchRunsIndexQuery, workbenchCancelRunAction, workbenchManualRunFormQuery, workbenchStartManualRunAction, workbenchExecutionDataQuery]) root.console.define(root, definition)
  localTestProviderPlugin(root); workbenchRunsProviderPlugin(root)
  const { automation } = root.automations.create({ name: 'Local Console fixture', source: source() })
  const sample = root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'upstream', value: 'PRIVATE_SAMPLE_VALUE_CANARY' })
  const input: LocalTestRequest = { automationId: automation.id, expectedDraftVersion: 1, targetNodeId: 'target', mode: 'only-node', sampleIds: [sample.id], input: {}, trigger: null }
  const preview = () => root.console.query<LocalTestRequest, WorkbenchLocalTestPreview>(localTestPreviewQuery, input, request())
  return { root, automation, sample, input, preview, invoke }
}

describe('Local-test Console providers', () => {
  it.each(['list', 'create', 'import', 'delete', 'preview', 'start'] as const)('requires authentication before %s reads or changes data', async operation => {
    const { root, automation, sample, input, invoke } = await fixture()
    const preview = root.automations.previewLocalTest(input), before = rows(root)
    const calls = {
      list: () => root.console.query(outputSamplesQuery, { automationId: automation.id }, request(false)),
      create: () => root.console.action(createOutputSampleAction, { automationId: automation.id, expectedDraftVersion: 1, nodeId: 'upstream', value: 'unauthorized' }, request(false)),
      import: () => root.console.action(importOutputSampleAction, { automationId: automation.id, executionId: 'not-an-execution' }, request(false)),
      delete: () => root.console.action(deleteOutputSampleAction, { automationId: automation.id, sampleId: sample.id }, request(false)),
      preview: () => root.console.query(localTestPreviewQuery, input, request(false)),
      start: () => root.console.action(startLocalTestAction, { ...input, previewHash: preview.previewHash, requestId: 'unauthorized-start-01' }, request(false)),
    }
    await expect(calls[operation]()).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' })
    expect(rows(root)).toEqual(before); expect(invoke).not.toHaveBeenCalled()
  })

  it('returns only paginated sample metadata and a preview without stored sample values or contracts', async () => {
    const { root, automation, sample, preview, invoke } = await fixture()
    for (let i = 0; i < 50; i++) await root.console.action(createOutputSampleAction, { automationId: automation.id, expectedDraftVersion: 1, nodeId: 'upstream', value: `PRIVATE_EXTRA_CANARY_${i}` }, request())
    const first = await root.console.query<{ automationId: string }, OutputSamplesPage>(outputSamplesQuery, { automationId: automation.id }, request())
    const last = await root.console.query<{ automationId: string; offset: number }, OutputSamplesPage>(outputSamplesQuery, { automationId: automation.id, offset: first.nextOffset! }, request())
    expect(first.items).toHaveLength(50); expect(last.items).toHaveLength(1); expect(last.nextOffset).toBeUndefined()
    expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(51)
    const result = await preview()
    expect(result).toMatchObject({ nodeIds: ['target', 'upstream'], externalWrites: ['target'], calls: [{ nodeId: 'target', sideEffect: true, retrySafe: false, inputValidation: 'validated' }], substitutions: [{ sampleId: sample.id }] })
    for (const metadata of [...first.items, ...last.items]) { expect(metadata).not.toHaveProperty('value'); expect(metadata).not.toHaveProperty('contract') }
    expect(result).not.toHaveProperty('scope'); expect(JSON.stringify([first, last, result])).not.toContain('CANARY')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not decode sample values from later metadata pages', async () => {
    const { root, automation } = await fixture()
    for (let i = 0; i < 51; i++) root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'upstream', value: `later-${i}` })
    const last = root.database.db.prepare('SELECT id FROM automation_output_samples WHERE automation_id = ? ORDER BY created_at, id LIMIT 1 OFFSET 51').get(automation.id) as { id: string }
    root.database.db.prepare('UPDATE automation_output_samples SET sample_json = ? WHERE id = ?').run('PRIVATE_LATER_PAGE_CANARY', last.id)
    const first = await root.console.query<unknown, OutputSamplesPage>(outputSamplesQuery, { automationId: automation.id }, request())
    expect(first.items).toHaveLength(50); expect(first.nextOffset).toBe(50)
    const error = await root.console.query(outputSamplesQuery, { automationId: automation.id, offset: first.nextOffset }, request()).catch(error => error)
    expect(error).toMatchObject({ code: 'LOCAL_TEST_UNAVAILABLE' }); expect(String(error)).not.toContain('CANARY')
  })

  it('imports persisted public output only and rejects caller projections, foreign executions and sampled executions', async () => {
    const { root, automation, input, preview } = await fixture()
    const revision = root.automations.publishDraft(automation.id, 1)
    const run = root.scheduler.startRevisionTest(automation.id, revision.id, {}, null, 'public-import-run-01')
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'upstream')!
    const imported = await root.console.action<{ automationId: string; executionId: string }, OutputSampleSummary>(importOutputSampleAction, { automationId: automation.id, executionId: execution.id }, request())
    expect(imported).toMatchObject({ nodeId: 'upstream', provenance: { kind: 'execution', runId: run.id, executionId: execution.id, snapshotId: revision.id } })
    expect(imported).not.toHaveProperty('value'); expect(imported).not.toHaveProperty('contract')
    expect(root.automations.getOutputSample(automation.id, imported.id)?.value).toBe('upstream')
    const before = rows(root)
    for (const projected of [{ value: '[redacted]' }, { output: { value: 'forged', hidden: 1 } }, { complete: false }]) {
      await expect(root.console.action(importOutputSampleAction, { automationId: automation.id, executionId: execution.id, ...projected }, request())).rejects.toMatchObject({ code: 'SAMPLE_IMPORT_PROJECTION' })
    }
    const other = root.automations.create({ name: 'Other', source: source() })
    await expect(root.console.action(importOutputSampleAction, { automationId: other.automation.id, executionId: execution.id }, request())).rejects.toMatchObject({ code: 'SAMPLE_IMPORT_INCOMPLETE' })
    expect(rows(root)).toEqual(before)
    const result = await preview()
    const local = await root.console.action<unknown, StartLocalTestResult>(startLocalTestAction, { ...input, previewHash: result.previewHash, requestId: 'sampled-import-run-01' }, request())
    await root.scheduler.dispatchUntilIdle()
    const sampled = root.scheduler.listExecutions(local.runId).find(item => item.sampleId)!
    await expect(root.console.action(importOutputSampleAction, { automationId: automation.id, executionId: sampled.id }, request())).rejects.toMatchObject({ code: 'SAMPLE_NODE_UNSUPPORTED' })
  })

  it('does not import persisted private output into a reusable sample', async () => {
    const { root } = await fixture()
    const { automation } = root.automations.create({ name: 'Private output', source: { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [node('private', literal('PRIVATE_EXECUTION_CANARY'), 'private')], edges: [edge('graph', 'private')] } } })
    const revision = root.automations.publishDraft(automation.id, 1), run = root.scheduler.startRevisionTest(automation.id, revision.id, {}, null, 'private-import-run-01')
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'private')!
    await expect(root.console.action(importOutputSampleAction, { automationId: automation.id, executionId: execution.id }, request())).rejects.toMatchObject({ status: 422, code: 'SAMPLE_IMPORT_PRIVATE' })
    expect(root.automations.listOutputSamples(automation.id)).toEqual([])
  })

  it('permits a new preview after a definite stale rejection and keeps disabled formal state isolated', async () => {
    const { root, automation, input, preview, invoke } = await fixture()
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id); root.automations.setEnabled(automation.id, false)
    const old = await preview(), before = rows(root)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: source() })
    const formal = root.automations.get(automation.id)
    await expect(root.console.action(startLocalTestAction, { ...input, previewHash: old.previewHash, requestId: 'stale-local-run-01' }, request())).rejects.toMatchObject({ status: 409, code: 'DRAFT_VERSION_CONFLICT' })
    expect(rows(root)).toEqual(before); expect(invoke).not.toHaveBeenCalled()
    input.expectedDraftVersion = 2
    const next = await preview()
    const args = { ...input, previewHash: next.previewHash, requestId: 'fresh-local-run-01' }
    const accepted = await root.console.action<unknown, StartLocalTestResult>(startLocalTestAction, args, request())
    await expect(root.console.action(startLocalTestAction, { ...args, trigger: { changed: true } }, request())).rejects.toMatchObject({ status: 409, code: 'MANUAL_RUN_REQUEST_CONFLICT' })
    expect(await root.console.action(startLocalTestAction, args, request())).toEqual(accepted)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(accepted.runId)).toMatchObject({ status: 'COMPLETED' })
    expect(root.scheduler.listExecutions(accepted.runId).find(item => item.instructionId === '__complete')?.output).toBe('PRIVATE_SAMPLE_VALUE_CANARY')
    expect(root.automations.getExecutionSnapshot(accepted.snapshotId)).toMatchObject({ purpose: 'draft-test', localTest: { targetNodeId: 'target', mode: 'only-node' } })
    expect(root.automations.get(automation.id)).toEqual(formal)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(root.scheduler.listExecutions(accepted.runId).some(item => ['after', 'unrelated'].includes(item.instructionId))).toBe(false)
  })

  it('returns a definite resource refusal without accepting a Run, then previews corrected inputs', async () => {
    const { root, input, preview, invoke } = await fixture()
    const staged = await root.resources.stage({ name: 'Test trigger attachment', mediaType: 'text/plain', content: Buffer.from('attachment') })
    input.trigger = staged.ref
    const reviewed = await preview()
    await root.resources.store.delete(staged.digest)
    const before = rows(root)
    await expect(root.console.action(startLocalTestAction, { ...input, previewHash: reviewed.previewHash, requestId: 'missing-resource-run-01' }, request())).rejects.toMatchObject({ status: 422, code: 'RUN_RESOURCE_UNAVAILABLE' })
    expect(rows(root)).toEqual(before); expect(invoke).not.toHaveBeenCalled()
    input.trigger = null
    const corrected = await preview()
    const result = await root.console.action<unknown, StartLocalTestResult>(startLocalTestAction, { ...input, previewHash: corrected.previewHash, requestId: 'corrected-resource-run-01' }, request())
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(result.runId)?.status).toBe('COMPLETED'); expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('labels a frozen sample result from its actual Execution and never invents a Provider Attempt', async () => {
    const { root, automation, sample, input, preview, invoke } = await fixture()
    const reviewed = await preview(), accepted = await root.console.action<unknown, StartLocalTestResult>(startLocalTestAction, { ...input, previewHash: reviewed.previewHash, requestId: 'sample-label-run-01' }, request())
    await root.scheduler.dispatchUntilIdle()
    await root.console.action(deleteOutputSampleAction, { automationId: automation.id, sampleId: sample.id }, request())
    const detail = await root.console.query<unknown, WorkbenchRunDetail>(workbenchRunDetailQuery, { runId: accepted.runId, sourceNodeId: 'upstream', flowNodeId: 'upstream', executionLimit: 1, eventLimit: 1 }, request())
    expect(detail.executions).toMatchObject([{ sampleId: sample.id, operation: 'graph_value', title: 'Sample output', attempts: [] }])
    expect(detail.flow.root).toMatchObject({ sampledExecutionCount: 1, children: [{ sampledExecutionCount: 1 }] })
    const data = await root.console.query<unknown, WorkbenchExecutionData>(workbenchExecutionDataQuery, { runId: accepted.runId, executionId: detail.executions[0]!.id }, request())
    expect(data).toMatchObject({ sampleId: sample.id, output: { value: 'PRIVATE_SAMPLE_VALUE_CANARY' } }); expect(data.attempt).toBeUndefined()
    const target = await root.console.query<unknown, WorkbenchRunDetail>(workbenchRunDetailQuery, { runId: accepted.runId, sourceNodeId: 'target', flowNodeId: 'target', executionLimit: 1, eventLimit: 1 }, request())
    expect(target.executions[0]).toMatchObject({ operation: 'invoke', title: 'Real write call', attempts: [{ status: 'SUCCEEDED' }] })
    expect(target.executions[0]).not.toHaveProperty('sampleId'); expect(invoke).toHaveBeenCalledTimes(1)
    expect(target.flow.root.sampledExecutionCount).toBeUndefined()
  })

  it('sanitizes corrupt persisted sample errors and refuses aborted writes without effects', async () => {
    const { root, automation, sample, input, preview } = await fixture()
    const aborted = new AbortController(); aborted.abort()
    const before = rows(root)
    await expect(root.console.action(deleteOutputSampleAction, { automationId: automation.id, sampleId: sample.id }, request(true, aborted.signal))).rejects.toThrow()
    expect(rows(root)).toEqual(before)
    root.database.db.prepare('UPDATE automation_output_samples SET sample_json = ? WHERE id = ?').run('PRIVATE_CORRUPT_CANARY', sample.id)
    for (const operation of [() => root.console.query(outputSamplesQuery, { automationId: automation.id }, request()), preview]) {
      const error = await operation().catch(error => error)
      expect(error).toMatchObject({ status: 409, code: 'LOCAL_TEST_UNAVAILABLE' })
      expect(String(error)).not.toContain('CANARY')
    }
    await expect(root.console.query(localTestPreviewQuery, input, request(false))).rejects.toMatchObject({ status: 401 })
  })
})
