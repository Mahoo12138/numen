import Server from '@cordisjs/plugin-server'
import { AutomationService, AutomationSnapshotInspectionLimitError } from '@numenjs/automation'
import { ConsoleAuthenticationError, ConsoleService, consoleHttpPlugin, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, ControlRegistry, type AutomationSource, type ControlSource, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { SchedulerService } from '@numenjs/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchAutomationAuthoringProviderPlugin, workbenchPublishAutomationDraftAction, workbenchSaveAutomationDraftAction, workbenchSaveAutomationDraftCopyAction } from '../src/automation-authoring-provider.js'
import { workbenchAutomationRestorationProviderPlugin, workbenchAutomationRestoreContentQuery } from '../src/automation-restoration-provider.js'
import { reduceAutomationDraftDocument, type AutomationDraftDocumentState } from '../src/useAutomationDraftDocument.js'
import { ResourceService } from '../../resources/src/index.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (authenticated = true): ConsoleRequestContext => ({ requestId: 'draft-restoration', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'current-root', steps: [] } }
const mutable = (value: unknown) => value as Record<string, any>

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'numen-restoration-provider-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CapabilityRegistry)
  await root.plugin(ControlRegistry)
  const definition = { id: 'test:restoration', version: 1, kind: 'action' as const, title: 'Historical action', input: z.object({ value: z.string().required() }), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unloadAction = root.capabilities.define(root, definition)
  const unloadTrigger = root.capabilities.define(root, { ...definition, id: 'test:trigger', kind: 'trigger', input: z.dict(z.any()) })
  const unloadControl = root.controls.defineControl(root, { kind: 'extension', id: 'test:control', version: 1, title: 'Historical control', description: '', input: z.object({ value: z.string() }), lower: ({ nodeId }) => ({ type: 'block', id: nodeId, steps: [] }) })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchAutomationRestoreContentQuery)
  root.console.define(root, workbenchSaveAutomationDraftAction)
  root.console.define(root, workbenchPublishAutomationDraftAction)
  root.console.define(root, workbenchSaveAutomationDraftCopyAction)
  workbenchAutomationRestorationProviderPlugin(root)
  workbenchAutomationAuthoringProviderPlugin(root)
  const source: AutomationSource = {
    inputs: { message: { type: 'string', default: 'DEFAULT_PRIVATE_CANARY' } },
    triggers: [{ id: 'historical-trigger', capability: { id: 'test:trigger', version: 1 }, config: { token: 'TRIGGER_PRIVATE_CANARY' } }],
    flow: { type: 'block', id: 'historical-root', steps: [
      { type: 'capability', id: 'historical-action', capability: { id: 'test:restoration', version: 1 }, input: { value: { type: 'literal', value: 'ACTION_PRIVATE_CANARY' } } },
      { type: 'extension', id: 'historical-extension', control: { id: 'test:control', version: 1 }, input: { value: { type: 'literal', value: 'EXTENSION_PRIVATE_CANARY' } } },
    ] },
  }
  mutable(source).futureExtension = { nested: ['UNKNOWN_PRIVATE_CANARY', { ref: 'steps.historical-action.private' }] }
  mutable(source.flow).steps[1].futureControlMetadata = { position: 17, opaque: { untouched: true } }
  const presentation: Record<string, NumenValue> = { collapsedNodes: ['historical-root', 'ABSENT_NODE'], privateLabel: 'PRESENTATION_PRIVATE_CANARY', futureLayout: { position: [1, 2], label: 'UNKNOWN_LAYOUT_PRIVATE_CANARY' } }
  const { automation } = root.automations.create({ name: 'Restoration workspace', source, presentation })
  const first = root.automations.publishDraft(automation.id, 1)
  const test = root.automations.createDraftTestSnapshot(root.automations.prepareDraftTestSnapshot(automation.id, 1))
  root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty, presentation: { current: true } })
  const second = root.automations.publishDraft(automation.id, 2)
  root.automations.activateRevision(automation.id, second.id)
  root.automations.setEnabled(automation.id, true)
  const run = root.scheduler.startRevisionTest(automation.id, first.id, {}, { type: 'manual' }, 'restoration-history-request')
  const prepare = (snapshotId = first.id, expectedDraftVersion = 2, context = request(), automationId = automation.id) => root.console.query(workbenchAutomationRestoreContentQuery, { automationId, snapshotId, expectedDraftVersion }, context)
  return { root, automation, first, second, test, run, source, presentation, prepare, unload: () => { unloadAction(); unloadTrigger(); unloadControl() } }
}

function documentState(automationId: string, draft: NonNullable<ReturnType<AutomationService['getDraft']>>): AutomationDraftDocumentState {
  const unavailable: AutomationDraftDocumentState = { selectedAutomationId: undefined, selectedNodeId: undefined, document: undefined, savePhase: 'UNAVAILABLE', editRevision: 0, undoStack: [], redoStack: [], pendingSave: undefined, conflict: undefined, saveError: undefined, publishPending: false, pendingPublish: undefined, publishError: undefined, problems: [] }
  const selected = reduceAutomationDraftDocument(unavailable, { type: 'SELECT', automationId })
  return reduceAutomationDraftDocument(selected, { type: 'SERVER', automationId, draft })
}

function history(root: Context) {
  return Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table, root.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

describe('Explicit restore-to-Draft authoring preparation', () => {
  it('restores a fixed Graph snapshot with exact ports, expressions and layout after providers are removed', async () => {
    const { root, automation, second, unload } = await fixture()
    const source: AutomationSource = { triggers: [], flow: {
      type: 'graph', id: 'graph-root', version: 1,
      nodes: [
        { type: 'condition', id: 'choose', condition: { type: 'literal', value: true } },
        ...['yes', 'no'].map(id => ({ type: 'capability' as const, id, capability: { id: 'test:restoration', version: 1 }, input: { value: { type: 'literal' as const, value: id } } })),
        { type: 'merge', id: 'selected', mode: 'selected', inputs: ['accepted', 'declined'] },
      ],
      edges: [
        { id: 'start', from: { nodeId: 'graph-root', port: 'start' }, to: { nodeId: 'choose', port: 'in' } },
        { id: 'true', from: { nodeId: 'choose', port: 'true' }, to: { nodeId: 'yes', port: 'in' } },
        { id: 'false', from: { nodeId: 'choose', port: 'false' }, to: { nodeId: 'no', port: 'in' } },
        { id: 'accepted', from: { nodeId: 'yes', port: 'out' }, to: { nodeId: 'selected', port: 'accepted' } },
        { id: 'declined', from: { nodeId: 'no', port: 'out' }, to: { nodeId: 'selected', port: 'declined' } },
      ],
      output: { type: 'ref', path: 'steps.selected' },
    } }
    const presentation: Record<string, NumenValue> = { graphPositions: { choose: { x: 24, y: -12 }, selected: { x: 640, y: 128 } }, futureLayout: ['retained'] }
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source, presentation })
    const snapshot = root.automations.publishDraft(automation.id, 3)
    expect(snapshot).toMatchObject({ protocolVersion: 2, irVersion: 2 })
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 3, source: empty, presentation: {} })
    unload()
    const before = history(root)
    const content = await root.console.query(workbenchAutomationRestoreContentQuery, { automationId: automation.id, snapshotId: snapshot.id, expectedDraftVersion: 4 }, request())
    expect(content).toMatchObject({ identity: { protocolVersion: 2, irVersion: 2 }, source, presentation })
    await root.console.action(workbenchSaveAutomationDraftAction, { automationId: automation.id, expectedVersion: 4, source: content.source, presentation: content.presentation }, request())
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 5, source, presentation })
    expect(root.automations.get(automation.id)?.activeRevisionId).toBe(second.id)
    expect(history(root)).toEqual(before)
  })

  it('returns exact Source and Presentation for a fixed snapshot without writes, live definitions or decoding unrelated IR', async () => {
    const { root, automation, first, test, source, presentation, prepare, unload } = await fixture()
    unload()
    root.database.db.prepare('UPDATE automation_revisions SET compiled_plan_json = ?, contract_snapshot_json = ?, dependency_manifest_json = ? WHERE id = ?').run('CORRUPT_IR_PRIVATE_CANARY', 'CORRUPT_CONTRACT_PRIVATE_CANARY', 'CORRUPT_DEPENDENCY_PRIVATE_CANARY', first.id)
    const before = { automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), history: history(root) }
    const writes = root.database.db.prepare('SELECT total_changes() AS count').get()
    const changed = vi.fn(), capabilities = vi.spyOn(root.capabilities, 'get'), controls = vi.spyOn(root.controls, 'get'), fullSnapshot = vi.spyOn(root.automations, 'getExecutionSnapshot'), currentDraft = vi.spyOn(root.automations, 'getDraft')
    root.on('numen/automation-change', changed)
    try {
      const context = request(), content = await prepare(first.id, 2, context)
      expect(content).toMatchObject({ automationId: automation.id, expectedDraftVersion: 2, identity: { id: first.id, automationId: automation.id, purpose: 'published', number: 1, protocolVersion: 1, contentHash: first.contentHash } })
      expect(content.source).toEqual(source); expect(content.presentation).toEqual(presentation)
      expect(mutable(content.source.flow).steps[1].futureControlMetadata).toEqual(mutable(source.flow).steps[1].futureControlMetadata)
      const testContent = await prepare(test.id)
      expect(testContent.identity).toMatchObject({ id: test.id, purpose: 'draft-test', sourceDraftVersion: 1 })
      expect(testContent.identity).not.toHaveProperty('number')
      expect(testContent.source).toEqual(source); expect(testContent.presentation).toEqual(presentation)
      expect(capabilities).not.toHaveBeenCalled(); expect(controls).not.toHaveBeenCalled(); expect(fullSnapshot).not.toHaveBeenCalled(); expect(currentDraft).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
      expect(root.database.db.prepare('SELECT total_changes() AS count').get()).toEqual(writes)
      for (const method of ['info', 'warn', 'error', 'debug'] as const) expect(context.logger[method]).not.toHaveBeenCalled()
    } finally { capabilities.mockRestore(); controls.mockRestore(); fullSnapshot.mockRestore(); currentDraft.mockRestore() }
    expect({ automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), history: history(root) }).toEqual(before)
  })

  it('applies one full document Undo entry and persists restoration/Undo/Redo only through existing CAS save while preserving lineage, activation and history', async () => {
    const { root, automation, first, second, source, presentation, prepare } = await fixture()
    const beforeAutomation = root.automations.get(automation.id), beforeHistory = history(root), baseline = root.automations.getDraft(automation.id)!
    let state = documentState(automation.id, baseline)
    const content = await prepare()
    state = reduceAutomationDraftDocument(state, { type: 'REPLACE_FROM_SNAPSHOT', automationId: automation.id, expectedVersion: content.expectedDraftVersion, expectedDocument: state.document!, source: content.source, presentation: content.presentation })
    expect(state).toMatchObject({ savePhase: 'DIRTY', document: { version: 2, baseRevisionId: second.id, source, presentation } })
    expect(state.undoStack).toHaveLength(1)
    const save = async () => {
      state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
      const pending = state.pendingSave!
      const result = await root.console.action(workbenchSaveAutomationDraftAction, { automationId: pending.automationId, expectedVersion: pending.expectedVersion, source: pending.source, presentation: pending.presentation }, request())
      state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result })
    }
    await save()
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 3, baseRevisionId: second.id, source, presentation })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document).toMatchObject({ version: 3, baseRevisionId: second.id, source: baseline.source, presentation: baseline.presentation })
    await save()
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 4, baseRevisionId: second.id, source: baseline.source, presentation: baseline.presentation })
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    await save()
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 5, baseRevisionId: second.id, source, presentation })
    expect({ ...root.automations.get(automation.id), updatedAt: beforeAutomation!.updatedAt }).toEqual(beforeAutomation)
    expect(history(root)).toEqual(beforeHistory)
    expect(root.automations.getRevision(first.id)?.source).toEqual(source)
  })

  it('rejects the existing save CAS if another client edits after preparation, retaining the restored local document for recovery', async () => {
    const { root, automation, source, presentation, prepare } = await fixture()
    let state = documentState(automation.id, root.automations.getDraft(automation.id)!)
    const content = await prepare()
    state = reduceAutomationDraftDocument(state, { type: 'REPLACE_FROM_SNAPSHOT', automationId: automation.id, expectedVersion: content.expectedDraftVersion, source: content.source, presentation: content.presentation })
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: empty, presentation: { editedByOtherClient: true } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const pending = state.pendingSave!
    const error = await root.console.action(workbenchSaveAutomationDraftAction, { automationId: pending.automationId, expectedVersion: pending.expectedVersion, source: pending.source, presentation: pending.presentation }, request()).catch(error => error)
    expect(error).toMatchObject({ status: 409, code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_FAILURE', error })
    expect(state).toMatchObject({ savePhase: 'CONFLICT', document: { version: 2, source, presentation } })
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 3, source: empty, presentation: { editedByOtherClient: true } })
  })

  it('checks auth, abort, foreign membership, archive and current Draft version before snapshot content decoding', async () => {
    const { root, automation, first, prepare } = await fixture()
    const other = root.automations.create({ name: 'Other', source: empty })
    const read = vi.spyOn(root.automations, 'getExecutionSnapshotContentForInspection')
    try {
      await expect(prepare(first.id, 2, request(false))).rejects.toMatchObject({ status: 401 })
      const aborted = request(), controller = new AbortController(); controller.abort(); aborted.signal = controller.signal
      await expect(prepare(first.id, 2, aborted)).rejects.toThrow()
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('CORRUPT_PRIVATE_CANARY', first.id)
      await expect(prepare(first.id, 1)).rejects.toMatchObject({ status: 409, code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } })
      expect(read).not.toHaveBeenCalled()
      await expect(prepare(first.id, 1, request(), other.automation.id)).rejects.toMatchObject({ status: 404, code: 'AUTOMATION_RESTORE_NOT_FOUND' })
      root.automations.archive(automation.id)
      read.mockClear()
      await expect(prepare()).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_ARCHIVED' })
      expect(read).not.toHaveBeenCalled()
      for (const invalid of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(prepare(first.id, invalid)).rejects.toThrow()
    } finally { read.mockRestore() }
  })

  it('does not decode corrupt or oversized current Draft JSON when checking a valid saved baseline', async () => {
    const { root, automation, source, prepare } = await fixture()
    root.database.db.prepare('UPDATE automation_drafts SET source_json = ?, presentation_json = ? WHERE automation_id = ?').run('CORRUPT_CURRENT_PRIVATE_CANARY', 'OVERSIZED_CURRENT_PRIVATE_CANARY'.repeat(400_000), automation.id)
    const currentRead = vi.spyOn(root.automations, 'getDraft')
    try { expect((await prepare()).source).toEqual(source); expect(currentRead).not.toHaveBeenCalled() } finally { currentRead.mockRestore() }
  })

  it('preserves unknown extension expressions and fields while checking recognized core expression shapes without definitions', async () => {
    const { root, first, source, prepare, unload } = await fixture()
    unload()
    const unknown = { type: 'future:expression', privateParts: 'OPAQUE_PRIVATE_CANARY', nested: { untouched: true } }
    mutable(source.flow).steps[1].input.future = unknown
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(JSON.stringify(source), first.id)
    const prepared = await prepare()
    expect(mutable(prepared.source.flow).steps[1].input.future).toEqual(unknown)
    expect(prepared.source).toEqual(source)
  })

  it('bounds UTF-8 bytes before parsing snapshot content and does not parse unsupported future protocols', async () => {
    const { root, automation, first, prepare } = await fixture()
    const oversized = JSON.stringify({ value: '🙂'.repeat(2_100_000) })
    expect(oversized.length).toBeLessThan(8 * 1024 * 1024); expect(Buffer.byteLength(oversized)).toBeGreaterThan(8 * 1024 * 1024)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(oversized, first.id)
    expect(() => root.automations.getExecutionSnapshotContentForInspection(first.id, automation.id)).toThrow(AutomationSnapshotInspectionLimitError)
    await expect(prepare()).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_RESTORE_LIMIT' })
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 2, source_json = ? WHERE id = ?').run('CORRUPT_FUTURE_PRIVATE_CANARY', first.id)
    const failure = await prepare().catch(error => error)
    expect(failure).toMatchObject({ status: 409, code: 'AUTOMATION_RESTORE_UNAVAILABLE' }); expect(failure.details).toBeUndefined(); expect(JSON.stringify(failure)).not.toContain('CANARY')
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 1 WHERE id = ?').run(first.id)
    const corrupt = await prepare().catch(error => error)
    expect(corrupt).toMatchObject({ status: 409, code: 'AUTOMATION_RESTORE_UNAVAILABLE' }); expect(corrupt.details).toBeUndefined(); expect(JSON.stringify(corrupt)).not.toContain('CANARY')
  })

  it.each([
    ['duplicate flow IDs', (source: AutomationSource) => { mutable(source.flow).steps[1].id = 'historical-action' }],
    ['duplicate Trigger and flow ID', (source: AutomationSource) => { source.triggers[0]!.id = 'historical-action' }],
    ['malformed flow children', (source: AutomationSource) => { mutable(source.flow).steps = 'PRIVATE_BAD_CHILDREN' }],
    ['invalid structural branch', (source: AutomationSource) => { source.flow = { type: 'if', id: 'if', condition: { type: 'literal', value: true }, then: { type: 'wait', id: 'not-block' } as any } }],
    ['malformed known expression', (source: AutomationSource) => { mutable(source.flow).steps[0].input.value = { type: 'literal' } }],
    ['malformed extension template expression', (source: AutomationSource) => { mutable(source.flow).steps[1].input.value = { type: 'template', parts: 'PRIVATE_BAD_PARTS' } }],
    ['malformed extension call expression', (source: AutomationSource) => { mutable(source.flow).steps[1].input.value = { type: 'call', function: 'core:concat', arguments: 'PRIVATE_BAD_ARGUMENTS' } }],
    ['malformed nested extension call argument', (source: AutomationSource) => { mutable(source.flow).steps[1].input.value = { type: 'call', function: 'core:concat', arguments: [{ type: 'template', parts: null }] } }],
    ['unknown control type', (source: AutomationSource) => { mutable(source.flow).steps[0].type = 'PRIVATE_UNKNOWN_TYPE' }],
    ['malformed input declarations', (source: AutomationSource) => { mutable(source).inputs = { value: { type: 'PRIVATE_UNKNOWN_DECLARATION' } } }],
  ])('rejects %s before it can enter the editor, with a generic private-value-free failure', async (_name, mutate) => {
    const { root, first, source, prepare } = await fixture()
    mutate(source)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(JSON.stringify(source), first.id)
    const failure = await prepare().catch(error => error)
    expect(failure).toMatchObject({ status: 409, code: 'AUTOMATION_RESTORE_UNAVAILABLE' }); expect(failure.details).toBeUndefined(); expect(JSON.stringify(failure)).not.toContain('PRIVATE_')
  })

  it('rejects excessive node/depth/entry/Presentation bounds instead of returning a partial restoration', async () => {
    const { root, first, prepare } = await fixture()
    const replace = (source: unknown, presentation: unknown = {}) => root.database.db.prepare('UPDATE automation_revisions SET source_json = ?, presentation_json = ? WHERE id = ?').run(JSON.stringify(source), JSON.stringify(presentation), first.id)
    replace({ triggers: [], flow: { type: 'block', id: 'root', steps: Array.from({ length: 10_000 }, (_, index) => ({ type: 'wait', id: `wait-${index}` })) } })
    await expect(prepare()).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_RESTORE_LIMIT' })
    let deep: ControlSource = { type: 'wait', id: 'leaf' }
    for (let index = 0; index < 65; index++) deep = { type: 'block', id: `depth-${index}`, steps: [deep] }
    replace({ triggers: [], flow: deep })
    await expect(prepare()).rejects.toMatchObject({ status: 413 })
    replace({ ...empty, future: Array.from({ length: 100_000 }, () => null) })
    await expect(prepare()).rejects.toMatchObject({ status: 413 })
    let presentation: NumenValue = null
    for (let index = 0; index < 65; index++) presentation = { child: presentation }
    replace(empty, presentation)
    await expect(prepare()).rejects.toMatchObject({ status: 413 })
    replace(empty, ['PRIVATE_BAD_PRESENTATION'])
    await expect(prepare()).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_RESTORE_UNAVAILABLE' })
  })

  it('serves no-store authenticated POST preparation and restores more than 1 MiB through the real existing save transport', async () => {
    const { root, automation, first } = await fixture()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    root.console.provideAuthenticator(root, { authenticate({ headers }) {
      if (headers.get('authorization') !== 'Bearer fixture-token') throw new ConsoleAuthenticationError('Authentication required')
      return { principal: { subject: { type: 'user', id: 'owner' }, authenticated: true } }
    } })
    await root.plugin(consoleHttpPlugin)
    root.database.db.prepare('UPDATE automation_revisions SET presentation_json = ? WHERE id = ?').run(JSON.stringify({ opaquePrivatePayload: 'PRIVATE_TRANSPORT_CANARY'.repeat(60_000) }), first.id)
    const url = `${root.server.baseUrl}/api/console/call`
    const post = (kind: 'query' | 'action', procedure: string, input: unknown, authenticated = false) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer fixture-token' } : {}) }, body: JSON.stringify({ kind, procedure, input }) })
    const input = { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 2 }
    const denied = await post('query', 'numen:automation-restore-content@1', input)
    expect(denied.status).toBe(401); expect(denied.headers.get('cache-control')).toBe('no-store')
    const writes = root.database.db.prepare('SELECT total_changes() AS count').get()
    const prepared = await post('query', 'numen:automation-restore-content@1', input, true)
    expect(prepared.status).toBe(200); expect(prepared.headers.get('cache-control')).toBe('no-store')
    const content = (await prepared.json()).result
    expect(Buffer.byteLength(JSON.stringify(content))).toBeGreaterThan(1024 * 1024)
    expect(root.database.db.prepare('SELECT total_changes() AS count').get()).toEqual(writes)
    const saved = await post('action', 'numen:automation-save-draft@1', { automationId: automation.id, expectedVersion: content.expectedDraftVersion, source: content.source, presentation: content.presentation }, true)
    expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store')
    expect((await saved.json()).result.draft).toMatchObject({ version: 3, presentation: content.presentation })
    expect((await fetch(url)).status).toBe(405)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('HTTP_CORRUPT_PRIVATE_CANARY', first.id)
    const corrupt = await post('query', 'numen:automation-restore-content@1', { ...input, expectedDraftVersion: 3 }, true)
    expect(corrupt.status).toBe(409); expect(corrupt.headers.get('cache-control')).toBe('no-store')
    expect(await corrupt.json()).toMatchObject({ error: { code: 'AUTOMATION_RESTORE_UNAVAILABLE', message: 'The snapshot content could not be prepared for Draft restoration.' } })
  })
})
