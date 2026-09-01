import { ChevronLeft, Clock3, GitBranch, RotateCcw } from '@lucide/vue'
import { computed, reactive, watch } from 'vue'
import {
  workbenchRunDetailQueryRef,
  type WorkbenchRunDetail,
  type WorkbenchRunDetailQueryInput,
  type WorkbenchRunExecution,
} from './contracts.js'
import { coreWorkbenchRoutes } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

interface RunDetailPosition {
  executionCursor?: string
  executionHistory: Array<string | null>
  eventCursor?: number
  eventHistory: Array<number | null>
}

export const RunDetailPage = defineSetupComponent<WorkbenchPageProps>(
  'RunDetailPage',
  ['consoleClient', 'schemaUI', 'navigation'],
  props => {
    const position = reactive<RunDetailPosition>({ executionHistory: [], eventHistory: [] })
    const runId = computed(() => props.navigation?.route.parameters.id ?? '')
    watch(runId, () => {
      delete position.executionCursor
      position.executionHistory.splice(0)
      delete position.eventCursor
      position.eventHistory.splice(0)
    }, { flush: 'sync' })
    const input = computed<WorkbenchRunDetailQueryInput>(() => ({
      runId: runId.value,
      executionLimit: 25,
      ...(position.executionCursor ? { executionCursor: position.executionCursor } : {}),
      eventLimit: 50,
      ...(position.eventCursor ? { eventCursor: position.eventCursor } : {}),
    }))
    const [detail, reload] = useConsoleQuery<WorkbenchRunDetailQueryInput, WorkbenchRunDetail | null>(
      () => props.consoleClient && runId.value ? props.consoleClient : undefined,
      workbenchRunDetailQueryRef,
      input,
      'runs',
    )
    const openRuns = () => props.navigation?.navigate(coreWorkbenchRoutes.runs)
    const olderExecutions = () => {
      const next = detail.status === 'READY' ? detail.data?.nextExecutionCursor : undefined
      if (!next) return
      position.executionHistory.push(position.executionCursor ?? null)
      position.executionCursor = next
    }
    const newerExecutions = () => {
      const previous = position.executionHistory.pop()
      if (previous) position.executionCursor = previous
      else delete position.executionCursor
    }
    const olderEvents = () => {
      const next = detail.status === 'READY' ? detail.data?.timeline.nextCursor : undefined
      if (!next) return
      position.eventHistory.push(position.eventCursor ?? null)
      position.eventCursor = next
    }
    const newerEvents = () => {
      const previous = position.eventHistory.pop()
      if (previous) position.eventCursor = previous
      else delete position.eventCursor
    }

    return () => (
      <main class="main-workbench core-page run-detail-page">
        <RunDetailHeader onBack={openRuns} state={detail} />
        <RunDetailContent
          canShowNewerEvents={position.eventHistory.length > 0}
          canShowNewerExecutions={position.executionHistory.length > 0}
          onOlderEvents={olderEvents}
          onOlderExecutions={olderExecutions}
          onNewerEvents={newerEvents}
          onNewerExecutions={newerExecutions}
          onReload={reload}
          state={detail}
        />
      </main>
    )
  },
)

function RunDetailHeader({ state, onBack }: {
  state: ConsoleQueryState<WorkbenchRunDetail | null>
  onBack(): void
}) {
  const run = state.status === 'READY' ? state.data?.run : undefined
  return (
    <header class="core-page-header run-detail-header">
      <button aria-label="Back to Runs" class="run-detail-back" onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" size={18} />
      </button>
      <div class="run-detail-heading">
        <h1>{run?.automationName ?? 'Run detail'}</h1>
        <p>{run ? `${run.id} · Revision ${run.revisionNumber ?? run.revisionId}` : 'Durable execution timeline and diagnostics.'}</p>
      </div>
      {run ? <em class="run-detail-status" data-status={run.status}>{statusLabel(run.status)}</em> : null}
    </header>
  )
}

export function RunDetailContent({
  state,
  canShowNewerExecutions,
  canShowNewerEvents,
  onReload,
  onNewerExecutions,
  onOlderExecutions,
  onNewerEvents,
  onOlderEvents,
}: {
  state: ConsoleQueryState<WorkbenchRunDetail | null>
  canShowNewerExecutions: boolean
  canShowNewerEvents: boolean
  onReload(): void
  onNewerExecutions(): void
  onOlderExecutions(): void
  onNewerEvents(): void
  onOlderEvents(): void
}) {
  if (state.status === 'DISABLED') {
    return <RunDetailState title="Runtime preview" message="Open this Page from a running Numen Runtime to inspect a durable Run." />
  }
  if (state.status === 'LOADING') {
    return <RunDetailState busy title="Loading Run" message="Reading durable Execution, Attempt, and Journal state…" />
  }
  if (state.status === 'ERROR') {
    return <RunDetailState action="Try again" message={state.message} onAction={onReload} title="Run unavailable" tone="error" />
  }
  if (!state.data) {
    return <RunDetailState title="Run not found" message="This Run does not exist or is no longer available." />
  }
  const detail = state.data
  return (
    <div class="run-detail-content">
      <RunFacts detail={detail} />
      <div class="run-detail-columns">
        <section aria-labelledby="run-timeline-title" class="run-detail-section run-timeline">
          <div class="run-detail-section-heading">
            <div><h2 id="run-timeline-title">Timeline</h2><span>Semantic Journal · newest first</span></div>
            <strong>{detail.timeline.total}</strong>
          </div>
          {detail.timeline.items.length ? (
            <ol class="run-timeline-list">
              {detail.timeline.items.map(event => (
                <li key={event.sequence}>
                  <span aria-hidden="true" class="timeline-marker" data-event-type={event.type} />
                  <div>
                    <strong>{event.title}</strong>
                    {event.detail ? <p>{event.detail}</p> : null}
                    <small>#{event.sequence} · {formatTime(event.occurredAt)}</small>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p class="run-detail-empty">No Journal events have been recorded.</p>}
          <PageControls
            canGoNewer={canShowNewerEvents}
            canGoOlder={!!detail.timeline.nextCursor}
            label="Timeline pages"
            onNewer={onNewerEvents}
            onOlder={onOlderEvents}
          />
        </section>
        <section aria-labelledby="execution-diagnostics-title" class="run-detail-section execution-diagnostics">
          <div class="run-detail-section-heading">
            <div><h2 id="execution-diagnostics-title">Execution diagnostics</h2><span>Newest durable units first</span></div>
            <strong>{detail.executionSummary.total}</strong>
          </div>
          {detail.executions.length ? (
            <div class="execution-records">
              {detail.executions.map(execution => <ExecutionRecord execution={execution} key={execution.id} />)}
            </div>
          ) : <p class="run-detail-empty">No Executions have been created for this Run.</p>}
          <PageControls
            canGoNewer={canShowNewerExecutions}
            canGoOlder={!!detail.nextExecutionCursor}
            label="Execution diagnostic pages"
            onNewer={onNewerExecutions}
            onOlder={onOlderExecutions}
          />
        </section>
      </div>
    </div>
  )
}

function RunFacts({ detail }: { detail: WorkbenchRunDetail }) {
  const { run, executionSummary } = detail
  return (
    <section aria-label="Run facts" class="run-facts">
      <div><span>Started</span><strong>{run.startedAt ? formatTime(run.startedAt) : 'Not started'}</strong></div>
      <div><span>Duration</span><strong>{formatDuration(run.startedAt, run.finishedAt)}</strong></div>
      <div><span>Executions</span><strong>{executionSummary.total} · {executionSummary.completed} completed</strong></div>
      <div><span>Attempts</span><strong>{executionSummary.attempts}</strong></div>
      {executionSummary.blocked || executionSummary.failed || executionSummary.timedOut ? (
        <div data-tone="warning"><span>Attention</span><strong>{executionSummary.blocked} blocked · {executionSummary.failed + executionSummary.timedOut} failed</strong></div>
      ) : null}
    </section>
  )
}

function ExecutionRecord({ execution }: { execution: WorkbenchRunExecution }) {
  return (
    <article class="execution-record" data-status={execution.status}>
      <header>
        <span class="execution-operation"><GitBranch aria-hidden="true" size={13} />{operationLabel(execution.operation)}</span>
        <em data-status={execution.status}>{statusLabel(execution.status)}</em>
      </header>
      <h3>{execution.title}</h3>
      <code>{execution.instructionId}</code>
      {execution.blockedReason ? <p class="execution-warning">Blocked: {statusLabel(execution.blockedReason)}</p> : null}
      <dl>
        <div><dt>Updated</dt><dd>{formatTime(execution.updatedAt)}</dd></div>
        <div><dt>Generation</dt><dd>{execution.generation}</dd></div>
        {execution.loopIndex === undefined ? null : <div><dt>Loop item</dt><dd>{execution.loopIndex + 1}</dd></div>}
        {execution.scopeBranch === undefined ? null : <div><dt>Branch</dt><dd>{execution.scopeBranch + 1}</dd></div>}
      </dl>
      {execution.attempts.length ? (
        <details class="execution-attempts" open={execution.attempts.some(attempt => attempt.status !== 'SUCCEEDED')}>
          <summary><RotateCcw aria-hidden="true" size={13} />{execution.attempts.length} {execution.attempts.length === 1 ? 'attempt' : 'attempts'}</summary>
          <div>
            {execution.attempts.map(attempt => (
              <article key={attempt.id}>
                <span>Attempt {attempt.number}</span>
                <em data-attempt-status={attempt.status}>{statusLabel(attempt.status)}</em>
                <small>{attempt.providerRef} · {formatDuration(attempt.startedAt, attempt.finishedAt)}</small>
                {attempt.errorSummary ? <p>{attempt.errorSummary}</p> : null}
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  )
}

function PageControls({ canGoNewer, canGoOlder, label, onNewer, onOlder }: {
  canGoNewer: boolean
  canGoOlder: boolean
  label: string
  onNewer(): void
  onOlder(): void
}) {
  if (!canGoNewer && !canGoOlder) return null
  return (
    <nav aria-label={label} class="run-detail-pagination">
      <button disabled={!canGoNewer} onClick={onNewer} type="button">Newer</button>
      <button disabled={!canGoOlder} onClick={onOlder} type="button">Older</button>
    </nav>
  )
}

function RunDetailState({ title, message, busy = false, tone = 'default', action, onAction }: {
  title: string
  message: string
  busy?: boolean
  tone?: 'default' | 'error'
  action?: string
  onAction?(): void
}) {
  return (
    <section aria-busy={busy} class="run-detail-state" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Clock3 aria-hidden="true" size={18} />
      <div><strong>{title}</strong><p>{message}</p></div>
      {action ? <button {...(onAction ? { onClick: onAction } : {})} type="button">{action}</button> : null}
    </section>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date)
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return 'Not started'
  if (!finishedAt) return 'In progress'
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`
}

function statusLabel(status: string): string {
  return status.toLowerCase().replaceAll('_', ' ').replace(/^./, first => first.toUpperCase())
}

function operationLabel(operation: string): string {
  if (operation === 'invoke') return 'Capability'
  if (operation === 'suspend') return 'Wait'
  if (operation === 'fork') return 'Fork'
  if (operation === 'iterate') return 'For each'
  return statusLabel(operation)
}
