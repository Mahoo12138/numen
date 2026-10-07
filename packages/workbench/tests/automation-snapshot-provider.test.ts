import Server from '@cordisjs/plugin-server'
import { AutomationService, AutomationSnapshotInspectionLimitError } from '@numenjs/automation'
import { ConsoleAuthenticationError, ConsoleService, consoleHttpPlugin, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, ControlRegistry, type AutomationSource, type CapabilityDefinition, type ControlSource } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { Context, type Logger } from 'cordis'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchAutomationSnapshotProviderPlugin, workbenchAutomationSnapshotQuery } from '../src/automation-snapshot-provider.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const visible = <T extends z>(schema: T): T => schema.extra('extra', { numen: { execution: 'public' } }) as T
const request = (authenticated = true): ConsoleRequestContext => ({ requestId: 'snapshot-inspection', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'empty', steps: [] } }

async function fixture() {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CapabilityRegistry)
  await root.plugin(ControlRegistry)
  const fields = () => z.object({ safe: visible(z.string()), secret: visible(z.string()), dynamic: visible(z.string()), unknown: z.any(), nested: z.object({ shown: visible(z.number()), private: z.string().role('secret') }) })
  const definition: CapabilityDefinition = { id: 'test:snapshot', version: 1, kind: 'action', title: 'Frozen action name', input: fields(), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unloadAction = root.capabilities.define(root, definition)
  const unloadTrigger = root.capabilities.define(root, { ...definition, id: 'test:trigger', kind: 'trigger', title: 'Frozen trigger name' })
  const unloadControl = root.controls.defineControl(root, { kind: 'extension', id: 'test:control', version: 1, title: 'Frozen control name', description: '', input: z.object({ value: visible(z.string()) }), lower: ({ nodeId }) => ({ type: 'block', id: nodeId, steps: [] }) })
  await root.plugin(AutomationService)
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchAutomationSnapshotQuery)
  workbenchAutomationSnapshotProviderPlugin(root)
  const source: AutomationSource = {
    inputs: { message: { type: 'string', title: 'TITLE_SECRET', description: 'DESCRIPTION_SECRET', required: true, default: 'DEFAULT_SECRET' } },
    triggers: [{ id: 'fixed-trigger', capability: { id: 'test:trigger', version: 1 }, config: { safe: 'public trigger', secret: 'TRIGGER_SECRET', unknown: { innocent: 'UNKNOWN_TRIGGER_SECRET' } } }],
    flow: { type: 'block', id: 'fixed-flow', steps: [
      { type: 'capability', id: 'fixed-action', capability: { id: definition.id, version: 1 }, input: {
        safe: { type: 'literal', value: '<img src=x onerror=alert(1)>' }, secret: { type: 'literal', value: 'LITERAL_SECRET' },
        dynamic: { type: 'template', parts: ['TEMPLATE_SECRET', { ref: 'input.message' }] }, unknown: { type: 'literal', value: { innocent: 'UNKNOWN_SECRET' } },
        nested: { type: 'object', entries: { shown: { type: 'literal', value: 42 }, private: { type: 'literal', value: 'NESTED_SECRET' } } },
      }, policy: { timeoutMs: 500, retry: { maxAttempts: 3, backoffMs: 20 } } },
      { type: 'extension', id: 'fixed-control', control: { id: 'test:control', version: 1 }, input: { value: { type: 'literal', value: 'public control' } } },
    ] }, policy: { maxActive: 3, overflow: 'queue', groupBy: { type: 'literal', value: 'POLICY_SECRET' } },
  }
  const { automation } = root.automations.create({ name: 'Snapshot workspace', source, presentation: { collapsedNodes: ['fixed-flow', 'fixed-flow', 'ABSENT_SECRET'], label: 'PRESENTATION_SECRET', PRIVATE_PRESENTATION_KEY: 'UNKNOWN_PRESENTATION_SECRET' } })
  const published = root.automations.publishDraft(automation.id, 1)
  const draftTest = root.automations.createDraftTestSnapshot(root.automations.prepareDraftTestSnapshot(automation.id, 1))
  const query = (snapshotId = published.id, context = request(), automationId = automation.id) => root.console.query(workbenchAutomationSnapshotQuery, { automationId, snapshotId }, context)
  return { root, automation, published, draftTest, source, query, unload: () => { unloadAction(); unloadTrigger(); unloadControl() } }
}

describe('Immutable Automation snapshot inspection', () => {
  it('inspects published and Draft-test snapshots from frozen metadata after edits, archive and compiler unload, without writes', async () => {
    const { root, automation, published, draftTest, query, unload } = await fixture()
    root.automations.activateRevision(automation.id, published.id)
    root.automations.setEnabled(automation.id, true)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty, presentation: { collapsedNodes: [] } })
    root.automations.archive(automation.id)
    unload()
    const before = { automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), snapshots: root.database.db.prepare('SELECT * FROM automation_revisions ORDER BY id').all() }
    const changes = vi.fn(), registry = vi.spyOn(root.capabilities, 'get'), controls = vi.spyOn(root.controls, 'get')
    root.on('numen/automation-change', changes)
    try {
      const context = request()
      const result = await query(published.id, context)
      expect(result).toMatchObject({ identity: { id: published.id, automationId: automation.id, purpose: 'published', number: 1, contentHash: published.contentHash, protocolVersion: 1 }, compatibility: 'supported',
        presentation: { collapsedNodes: ['fixed-flow'], hiddenFields: 2, truncated: true }, inputs: [{ name: 'message', type: 'string', required: true, hasDefault: true }],
        source: { policy: { maxActive: 3, overflow: 'queue', hasGroupBy: true }, nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 'fixed-action', input: { value: { safe: '<img src=x onerror=alert(1)>', secret: expect.any(String), unknown: expect.any(String), nested: { shown: 42, private: expect.any(String) } }, hidden: 3, available: true, truncated: false }, expressionFields: expect.arrayContaining([{ field: 'dynamic', type: 'template' }]), policy: { timeoutMs: 500, retry: { maxAttempts: 3, backoffMs: 20 } } }),
          expect.objectContaining({ nodeId: 'fixed-control', input: { value: { value: 'public control' }, hidden: 0, available: true, truncated: false } }),
        ]), triggers: [expect.objectContaining({ config: { value: { safe: 'public trigger', secret: expect.any(String), unknown: expect.any(String) }, hidden: 2, available: true, truncated: false } })] },
      })
      expect(result.flow.root.children[0]?.children.map(node => node.title)).toEqual(['Frozen action name', 'Frozen control name'])
      expect(JSON.stringify(result)).not.toContain('_SECRET')
      const test = await query(draftTest.id)
      expect(test.identity).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: 1, id: draftTest.id })
      expect(test.identity).not.toHaveProperty('number')
      expect(test.flow.root.detail).toBe('Draft test · Draft v1 · IR 1')
      expect(registry).not.toHaveBeenCalled(); expect(controls).not.toHaveBeenCalled(); expect(changes).not.toHaveBeenCalled()
      expect({ automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), snapshots: root.database.db.prepare('SELECT * FROM automation_revisions ORDER BY id').all() }).toEqual(before)
      for (const method of ['info', 'warn', 'error', 'debug'] as const) expect(context.logger[method]).not.toHaveBeenCalled()
    } finally { registry.mockRestore(); controls.mockRestore() }
  })

  it('checks authentication, abort and Automation membership before parsing a foreign snapshot', async () => {
    const { root, published, query } = await fixture()
    const other = root.automations.create({ name: 'Other', source: empty })
    const read = vi.spyOn(root.automations, 'getExecutionSnapshot')
    try {
      await expect(query(published.id, request(false))).rejects.toMatchObject({ status: 401 })
      const aborted = request(), abort = new AbortController()
      abort.abort(); aborted.signal = abort.signal
      await expect(query(published.id, aborted)).rejects.toThrow()
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('CORRUPT_FOREIGN_SECRET', published.id)
      await expect(query(published.id, request(), other.automation.id)).rejects.toMatchObject({ status: 404, code: 'AUTOMATION_SNAPSHOT_NOT_FOUND' })
      await expect(query(`rev_${'0'.repeat(32)}`)).rejects.toMatchObject({ status: 404 })
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  })

  it('degrades an unsupported protocol without interpreting its unknown Source or contracts', async () => {
    const { root, published, query } = await fixture()
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 99, source_json = ?, presentation_json = ?, contract_snapshot_json = ? WHERE id = ?').run(JSON.stringify('FUTURE_SOURCE_SECRET'), JSON.stringify({ label: 'FUTURE_PRESENTATION_SECRET' }), JSON.stringify({ opaque: 'FUTURE_CONTRACT_SECRET' }), published.id)
    const result = await query()
    expect(result).toMatchObject({ compatibility: 'unsupported-protocol', identity: { protocolVersion: 99, id: published.id }, flow: { root: { id: '__unsupported-snapshot', children: [] } }, source: { nodes: [], triggers: [] }, inputs: [], presentation: { collapsedNodes: [], hiddenFields: 0 } })
    expect(JSON.stringify(result)).not.toContain('_SECRET')
  })

  it('bounds persisted UTF-8 bytes before decoding and returns only generic errors for corrupt data', async () => {
    const { root, automation, published, query } = await fixture()
    const read = vi.spyOn(root.automations, 'getExecutionSnapshot')
    try {
      const oversized = JSON.stringify({ text: '🙂'.repeat(2_100_000) })
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(oversized, published.id)
      expect(oversized.length).toBeLessThan(8 * 1024 * 1024)
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(8 * 1024 * 1024)
      expect(() => root.automations.getExecutionSnapshotForInspection(published.id, automation.id)).toThrow(AutomationSnapshotInspectionLimitError)
      await expect(query()).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_SNAPSHOT_LIMIT' })
      expect(read).not.toHaveBeenCalled()
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('CORRUPT_PRIVATE_FRAGMENT_SECRET', published.id)
      const failure = await query().catch(error => error)
      expect(failure).toMatchObject({ status: 409, code: 'AUTOMATION_SNAPSHOT_UNAVAILABLE' })
      expect(failure.details).toBeUndefined(); expect(JSON.stringify(failure)).not.toContain('_SECRET')
    } finally { read.mockRestore() }
  })

  it('bounds deep and wide Source trees, public values and unknown input field names', async () => {
    const { root, published, query, source } = await fixture()
    let deep: ControlSource = { type: 'block', id: 'too-deep', steps: [] }
    for (let index = 0; index < 80; index++) deep = { type: 'block', id: `depth-${index}`, steps: [deep] }
    const wide: ControlSource = { type: 'block', id: 'wide', steps: Array.from({ length: 400 }, (_, index) => ({ type: 'wait', id: `wait-${index}`, durationMs: { type: 'literal', value: index } })) }
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(JSON.stringify({ ...source, flow: { type: 'block', id: 'root', steps: [deep, wide] } }), published.id)
    const result = await query()
    expect(result.flow.truncated).toBe(true); expect(result.source.truncated).toBe(true)
    expect(result.source.nodes.length).toBeLessThanOrEqual(250)
    expect(JSON.stringify(result)).not.toContain('too-deep')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131_072)
    const unsafe = structuredClone(source)
    if (unsafe.flow.type !== 'block' || unsafe.flow.steps[0]?.type !== 'capability') throw new Error('fixture')
    unsafe.flow.steps[0].input.PRIVATE_KEY_SECRET = { type: 'literal', value: 'PRIVATE_VALUE_SECRET' }
    unsafe.flow.steps[0].input.safe = { type: 'literal', value: '🙂'.repeat(30_000) }
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(JSON.stringify(unsafe), published.id)
    const limited = await query()
    expect(limited.source.nodes.find(node => node.nodeId === 'fixed-action')?.input.truncated).toBe(true)
    expect(JSON.stringify(limited)).not.toContain('_SECRET')
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(131_072)
  })

  it('keeps values opaque when their saved contract is missing, without using a live definition', async () => {
    const { root, published, query } = await fixture()
    root.database.db.prepare('UPDATE automation_revisions SET contract_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ capabilities: [] }), published.id)
    const result = await query()
    const action = result.source.nodes.find(node => node.nodeId === 'fixed-action')!
    expect(action.input.hidden).toBe(1)
    expect(action.expressionFields).toEqual([])
    expect(result.flow.root.children[0]?.children[0]?.title).toBe('test:snapshot')
    expect(JSON.stringify(result)).not.toContain('<img')
    expect(JSON.stringify(result)).not.toContain('_SECRET')
  })

  it('serves authenticated POST-only no-store inspection and sanitizes parser failures before transport logging', async () => {
    const { root, automation, published } = await fixture()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    root.console.provideAuthenticator(root, { authenticate({ headers }) {
      if (headers.get('authorization') !== 'Bearer fixture-token') throw new ConsoleAuthenticationError('Authentication required')
      return { principal: { subject: { type: 'user', id: 'owner' }, authenticated: true } }
    } })
    await root.plugin(consoleHttpPlugin)
    const body = JSON.stringify({ kind: 'query', procedure: 'numen:automation-snapshot@1', input: { automationId: automation.id, snapshotId: published.id } })
    const url = `${root.server.baseUrl}/api/console/call`
    const post = (authenticated = false) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer fixture-token' } : {}) }, body })
    const denied = await post()
    expect(denied.status).toBe(401); expect(denied.headers.get('cache-control')).toBe('no-store')
    const allowed = await post(true)
    expect(allowed.status).toBe(200); expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(await allowed.text()).not.toContain('_SECRET')
    expect((await fetch(url)).status).toBe(405)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('HTTP_CORRUPT_FRAGMENT_SECRET', published.id)
    const corrupt = await post(true)
    expect(corrupt.status).toBe(409); expect(corrupt.headers.get('cache-control')).toBe('no-store')
    expect(await corrupt.json()).toMatchObject({ error: { code: 'AUTOMATION_SNAPSHOT_UNAVAILABLE', message: 'The snapshot could not be inspected.' } })
  })
})
