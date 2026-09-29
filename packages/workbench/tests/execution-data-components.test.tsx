import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionDataPanel } from '../src/ExecutionDataPanel.js'
import type { WorkbenchExecutionData } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { useExecutionData } from '../src/useExecutionData.js'
import { renderToMarkup } from './render.js'

const result: WorkbenchExecutionData = {
  runId: 'run-a', executionId: 'exec-a', sourceNodeId: 'source-a', provenance: 'execution-current',
  attempt: { id: 'attempt-a', number: 2 },
  input: { value: { content: '<img src=x onerror=alert(1)>' }, available: true, hidden: 1, truncated: false },
  output: { value: '[Hidden]', available: true, hidden: 1, truncated: true },
}
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe('Execution data panel lifecycle', () => {
  it('fetches only when requested and discards closed, stale, switched-Run, and disposed responses', async () => {
    const pending: Array<{ resolve(data: WorkbenchExecutionData): void; signal: AbortSignal }> = []
    const query = vi.fn((_ref, _input, signal) => new Promise<WorkbenchExecutionData>(resolve => pending.push({ resolve, signal })))
    const runId = ref('run-a')
    const scope = effectScope()
    const inspection = scope.run(() => useExecutionData({ query } as unknown as WorkbenchConsoleClient, runId))!
    expect(query).not.toHaveBeenCalled()
    inspection.open('exec-a', 'attempt-a')
    expect(query.mock.calls[0]?.[1]).toEqual({ runId: 'run-a', executionId: 'exec-a', attemptId: 'attempt-a' })
    inspection.close()
    expect(pending[0]!.signal.aborted).toBe(true)
    pending[0]!.resolve(result)
    await tick()
    expect(inspection.state.value).toEqual({ status: 'CLOSED' })
    inspection.open('exec-a')
    inspection.open('exec-b')
    pending[1]!.resolve(result)
    pending[2]!.resolve({ ...result, executionId: 'exec-b' })
    await tick()
    expect(inspection.state.value).toMatchObject({ status: 'READY', data: { executionId: 'exec-b' } })
    runId.value = 'run-b'
    expect(inspection.state.value).toEqual({ status: 'CLOSED' })
    inspection.open('exec-c')
    scope.stop()
    pending[3]!.resolve(result)
    await tick()
    expect(pending[3]!.signal.aborted).toBe(true)
    expect(inspection.state.value).toEqual({ status: 'CLOSED' })
  })

  it('does not render server failure bodies and only renders classified values as escaped text', async () => {
    const scope = effectScope()
    const query = vi.fn().mockRejectedValue(new Error('PRIVATE_ERROR_BODY'))
    const inspection = scope.run(() => useExecutionData({ query } as unknown as WorkbenchConsoleClient, 'run-a'))!
    inspection.open('exec-a')
    await tick()
    expect(inspection.state.value).toEqual({ status: 'ERROR' })
    const failed = await renderToMarkup(<ExecutionDataPanel state={inspection.state.value} onClose={vi.fn()} onLocate={vi.fn()} />)
    expect(failed).not.toContain('PRIVATE_ERROR_BODY')
    const markup = await renderToMarkup(<ExecutionDataPanel state={{ status: 'READY', data: result }} onClose={vi.fn()} onLocate={vi.fn()} />)
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('separate Attempt input/output snapshots are not stored')
    expect(markup).toContain('Attempt 2')
    expect(markup).toContain('Inspection size or depth limit reached')
    expect(markup).not.toContain('href=')
    const internal = structuredClone(result)
    delete internal.sourceNodeId
    const internalMarkup = await renderToMarkup(<ExecutionDataPanel state={{ status: 'READY', data: internal }} onClose={vi.fn()} onLocate={vi.fn()} />)
    expect(internalMarkup).not.toContain('Locate source node')
    scope.stop()
  })
})
