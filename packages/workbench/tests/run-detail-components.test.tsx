import { describe, expect, it, vi } from 'vitest'
import { RunDetailContent } from '../src/RunDetailPage.js'
import type { WorkbenchRunDetail } from '../src/contracts.js'
import { renderToMarkup } from './render.js'

const detail: WorkbenchRunDetail = {
  run: {
    id: 'run_11111111111111111111111111111111',
    automationId: 'auto_11111111111111111111111111111111',
    automationName: '跨区域服务恢复与客户通知自动化流程',
    revisionId: 'rev_11111111111111111111111111111111',
    revisionNumber: 4,
    status: 'FAILED',
    createdAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:01.000Z',
    finishedAt: '2026-09-01T00:00:03.000Z',
  },
  executionSummary: {
    total: 1,
    attempts: 2,
    runnable: 0,
    running: 0,
    waiting: 0,
    blocked: 0,
    completed: 0,
    failed: 1,
    cancelling: 0,
    cancelled: 0,
    timedOut: 0,
  },
  flow: {
    truncated: false,
    root: {
      id: 'recovery-flow',
      type: 'block',
      title: 'Flow',
      detail: '1 step',
      status: 'FAILED',
      executionCount: 1,
      children: [{
        id: 'notify-customer',
        type: 'capability',
        title: 'Send recovery notice',
        detail: 'notifications:send@1 · 1 connection binding',
        status: 'FAILED',
        executionCount: 1,
        children: [],
      }],
    },
  },
  context: [{ name: 'run', value: { id: 'run_11111111111111111111111111111111' }, truncated: false }, {
    name: 'input', value: { customer: '[string · 18 chars]' }, truncated: false,
  }, {
    name: 'steps', value: { 'notify-customer': { message: '[string · 84 chars]' } }, truncated: false,
  }],
  executions: [{
    id: 'exec_11111111111111111111111111111111',
    instructionId: 'notify-customer-with-an-intentionally-long-stable-identifier',
    title: 'Send a detailed recovery notice to every affected customer',
    operation: 'invoke',
    status: 'FAILED',
    blockedReason: 'PROVIDER_UNAVAILABLE',
    generation: 2,
    createdAt: '2026-09-01T00:00:01.000Z',
    updatedAt: '2026-09-01T00:00:03.000Z',
    attempts: [{
      id: 'attempt_11111111111111111111111111111111',
      number: 2,
      status: 'FAILED',
      providerRef: 'notifications:send@1',
      errorSummary: 'The notification Provider remained unavailable after retrying.',
      startedAt: '2026-09-01T00:00:02.000Z',
      finishedAt: '2026-09-01T00:00:03.000Z',
    }],
  }],
  nextExecutionCursor: 'next-executions',
  timeline: {
    total: 2,
    nextCursor: 8,
    items: [{
      sequence: 9,
      type: 'ExecutionFailed',
      title: 'Execution Failed',
      detail: 'The notification Provider remained unavailable after retrying.',
      executionId: 'exec_11111111111111111111111111111111',
      occurredAt: '2026-09-01T00:00:03.000Z',
    }],
  },
}

describe('Run detail UI', () => {
  it('renders durable facts, Execution diagnostics, Attempts, and semantic Timeline paging', async () => {
    const markup = await renderToMarkup(<RunDetailContent
      activeView="timeline"
      canShowNewerEvents
      canShowNewerExecutions
      onNewerEvents={vi.fn()}
      onNewerExecutions={vi.fn()}
      onOlderEvents={vi.fn()}
      onOlderExecutions={vi.fn()}
      onReload={vi.fn()}
      onSelectView={vi.fn()}
      state={{ status: 'READY', data: detail }}
    />)

    expect(markup).toContain('Execution diagnostics')
    expect(markup).toContain('Timeline')
    expect(markup).toContain('Send a detailed recovery notice')
    expect(markup).toContain('Provider remained unavailable')
    expect(markup).toContain('Attempt 2')
    expect(markup).toContain('aria-label="Execution diagnostic pages"')
    expect(markup).toContain('aria-label="Timeline pages"')
    expect(markup).not.toContain('resolvedInput')
  })

  it('renders Flow structure and sanitized Context as separate stable views', async () => {
    const shared = {
      canShowNewerEvents: false,
      canShowNewerExecutions: false,
      onNewerEvents: vi.fn(),
      onNewerExecutions: vi.fn(),
      onOlderEvents: vi.fn(),
      onOlderExecutions: vi.fn(),
      onReload: vi.fn(),
      onSelectView: vi.fn(),
      state: { status: 'READY', data: detail } as const,
    }
    const flow = await renderToMarkup(<RunDetailContent {...shared} activeView="flow" />)
    const context = await renderToMarkup(<RunDetailContent {...shared} activeView="context" />)

    expect(flow).toContain('aria-current="page"')
    expect(flow).toContain('Send recovery notice')
    expect(flow).toContain('Failed')
    expect(context).toContain('run.*')
    expect(context).toContain('input.*')
    expect(context).toContain('[string · 18 chars]')
    expect(context).not.toContain('Execution diagnostics')
  })

  it('renders loading, retryable error, and not-found states without fake diagnostics', async () => {
    const loading = await renderToMarkup(<RunDetailContent
      activeView="flow"
      canShowNewerEvents={false}
      canShowNewerExecutions={false}
      onNewerEvents={vi.fn()}
      onNewerExecutions={vi.fn()}
      onOlderEvents={vi.fn()}
      onOlderExecutions={vi.fn()}
      onReload={vi.fn()}
      onSelectView={vi.fn()}
      state={{ status: 'LOADING' }}
    />)
    const failed = await renderToMarkup(<RunDetailContent
      activeView="flow"
      canShowNewerEvents={false}
      canShowNewerExecutions={false}
      onNewerEvents={vi.fn()}
      onNewerExecutions={vi.fn()}
      onOlderEvents={vi.fn()}
      onOlderExecutions={vi.fn()}
      onReload={vi.fn()}
      onSelectView={vi.fn()}
      state={{ status: 'ERROR', message: 'Runtime disconnected.' }}
    />)
    const missing = await renderToMarkup(<RunDetailContent
      activeView="flow"
      canShowNewerEvents={false}
      canShowNewerExecutions={false}
      onNewerEvents={vi.fn()}
      onNewerExecutions={vi.fn()}
      onOlderEvents={vi.fn()}
      onOlderExecutions={vi.fn()}
      onReload={vi.fn()}
      onSelectView={vi.fn()}
      state={{ status: 'READY', data: null }}
    />)

    expect(loading).toContain('Loading Run')
    expect(failed).toContain('Runtime disconnected.')
    expect(failed).toContain('Try again')
    expect(missing).toContain('Run not found')
    expect(missing).not.toContain('Execution diagnostics')
  })
})
