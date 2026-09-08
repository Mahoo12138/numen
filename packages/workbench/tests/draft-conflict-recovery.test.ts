import { describe, expect, it, vi } from 'vitest'
import { compareAutomationDrafts } from '../src/draft-comparison.js'
import { createDraftConflictRecovery } from '../src/draft-conflict-recovery.js'
import type { AutomationDraftDocument } from '../src/useAutomationDraftDocument.js'
import type { WorkbenchConsoleClient } from '../src/types.js'

const document: AutomationDraftDocument = {
  automationId: 'auto_original', version: 1, updatedAt: '2026-09-08T00:00:00Z',
  source: { triggers: [], flow: { type: 'wait', id: 'pause', durationMs: { type: 'literal', value: 1000 } } },
  presentation: { collapsed: false },
}
const client = (query = vi.fn<WorkbenchConsoleClient['query']>(), action = vi.fn<WorkbenchConsoleClient['action']>()) => ({ query, action, subscribe: vi.fn() })

describe('Draft conflict comparison and copy lifecycle', () => {
  it('compares expression values, missing fields, array order, and presentation without mutating either document', () => {
    const server = structuredClone(document)
    server.source.flow = { type: 'wait', id: 'pause', durationMs: { type: 'ref', path: 'input.delay' } }
    server.presentation = { viewport: { x: 0 } }
    const result = compareAutomationDrafts(document, server)
    expect(result.truncated).toBe(false)
    expect(result.differences).toContainEqual({ path: '/source/flow/durationMs/type', local: '"literal"', server: '"ref"' })
    expect(result.differences).toContainEqual({ path: '/source/flow/durationMs/value', local: '1000', server: '(not present)' })
    expect(result.differences.some(item => item.path === '/presentation/collapsed')).toBe(true)
    expect(compareAutomationDrafts(document, structuredClone(document)).differences).toEqual([])
    expect(compareAutomationDrafts({ ...document, presentation: { 'a/b~c': [1, 2] } }, { ...document, presentation: { 'a/b~c': [2, 1] } }).differences.map(item => item.path)).toEqual(['/presentation/a~1b~0c/0', '/presentation/a~1b~0c/1'])
    expect(document.source.flow).toHaveProperty('durationMs.value', 1000)
  })

  it('bounds large comparisons and distinguishes null from missing values', () => {
    const large = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, i]))
    expect(compareAutomationDrafts({ ...document, presentation: large }, { ...document, presentation: {} })).toMatchObject({ truncated: true, differences: expect.any(Array) })
    expect(compareAutomationDrafts({ ...document, presentation: large }, { ...document, presentation: {} }).differences).toHaveLength(100)
    expect(compareAutomationDrafts({ ...document, presentation: { nullable: null } }, { ...document, presentation: {} }).differences[0]).toMatchObject({ local: 'null', server: '(not present)' })
  })

  it('fetches server snapshots without touching local content and refuses stale snapshots', async () => {
    const query = vi.fn<WorkbenchConsoleClient['query']>().mockResolvedValueOnce({ automation: { id: document.automationId }, draft: { ...document, version: 2 } })
      .mockResolvedValueOnce({ automation: { id: document.automationId }, draft: document })
    const recovery = createDraftConflictRecovery(client(query), document, 2)
    await recovery.compare()
    expect(recovery.state.server?.version).toBe(2)
    await recovery.compare()
    expect(recovery.state.server?.version).toBe(2)
    expect(recovery.state.compareError).toContain('older Draft')
    expect(recovery.local).toEqual(document)
    recovery.dispose()
  })

  it('serializes copying and retries the same immutable request after a lost response', async () => {
    const action = vi.fn<WorkbenchConsoleClient['action']>().mockRejectedValueOnce(new Error('Connection closed'))
      .mockResolvedValueOnce({ automationId: 'auto_copy', name: 'Copy' })
    const recovery = createDraftConflictRecovery(client(undefined, action), document, 2)
    const task = recovery.saveCopy('Copy')
    await recovery.saveCopy('Double click')
    expect(action).toHaveBeenCalledOnce()
    await task
    expect(recovery.state.copyError).toBe('Connection closed')
    await recovery.saveCopy('Changed name must not change the pending request')
    expect(action.mock.calls[1]?.[1]).toEqual(action.mock.calls[0]?.[1])
    expect(recovery.state.copy).toEqual({ automationId: 'auto_copy', name: 'Copy' })
    await recovery.saveCopy('Another click')
    expect(action).toHaveBeenCalledTimes(2)
    recovery.dispose()
  })

  it('aborts requests on disposal and ignores late successes', async () => {
    let resolveQuery!: (value: unknown) => void
    let resolveCopy!: (value: unknown) => void
    const query = vi.fn<WorkbenchConsoleClient['query']>(() => new Promise(resolve => { resolveQuery = resolve as typeof resolveQuery }))
    const action = vi.fn<WorkbenchConsoleClient['action']>(() => new Promise(resolve => { resolveCopy = resolve as typeof resolveCopy }))
    const recovery = createDraftConflictRecovery(client(query, action), document, 2)
    const tasks = [recovery.compare(), recovery.saveCopy('Copy')]
    recovery.dispose()
    expect(query.mock.calls[0]?.[2]?.aborted).toBe(true)
    expect(action.mock.calls[0]?.[2]?.aborted).toBe(true)
    resolveQuery({ automation: { id: document.automationId }, draft: { ...document, version: 2 } })
    resolveCopy({ automationId: 'auto_copy', name: 'Copy' })
    await Promise.all(tasks)
    expect(recovery.state.server).toBeUndefined()
    expect(recovery.state.copy).toBeUndefined()
  })
})
