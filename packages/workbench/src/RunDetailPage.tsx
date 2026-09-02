import { Ban, Braces, ChevronLeft, Clock3, GitBranch, ListTree, RotateCcw, ScrollText } from '@lucide/vue'
import { computed, onScopeDispose, reactive, shallowReactive, watch } from 'vue'
import {
  workbenchCancelRunActionRef,
  workbenchRunDetailQueryRef,
  type WorkbenchCancelRunInput,
  type WorkbenchCancelRunResult,
  type WorkbenchRunDetail,
  type WorkbenchRunDetailQueryInput,
  type WorkbenchRunExecution,
} from './contracts.js'
import {
  coreWorkbenchRoutes,
  coreWorkbenchRunContextRoute,
  coreWorkbenchRunFlowRoute,
  coreWorkbenchRunTimelineRoute,
} from './routes.js'
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

export type RunDetailView = 'flow' | 'timeline' | 'context'

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
    const [detail, reload, refresh] = useConsoleQuery<WorkbenchRunDetailQueryInput, WorkbenchRunDetail | null>(
      () => props.consoleClient && runId.value ? props.consoleClient : undefined,
      workbenchRunDetailQueryRef,
      input,
      'runs',
    )
    const activeView = computed<RunDetailView>(() => {
      if (props.navigation?.route.page?.id === coreWorkbenchRunContextRoute.id) return 'context'
      if (props.navigation?.route.page?.id === coreWorkbenchRunTimelineRoute.id) return 'timeline'
      return 'flow'
    })
    const cancellation = shallowReactive<{
      pending: boolean
      error?: string
      confirmedStatus?: WorkbenchCancelRunResult['status']
    }>({ pending: false })
    let cancellationController: AbortController | undefined
    onScopeDispose(() => cancellationController?.abort())
    watch(runId, () => {
      cancellationController?.abort()
      cancellationController = undefined
      cancellation.pending = false
      delete cancellation.error
      delete cancellation.confirmedStatus
    }, { flush: 'sync' })
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
    const selectView = (view: RunDetailView) => {
      const route = view === 'flow'
        ? coreWorkbenchRunFlowRoute
        : view === 'timeline' ? coreWorkbenchRunTimelineRoute : coreWorkbenchRunContextRoute
      props.navigation?.navigate(route, { parameters: { id: runId.value } })
    }
    const cancelRun = () => {
      const client = props.consoleClient
      if (!client || !runId.value || cancellation.pending) return
      cancellationController?.abort()
      const controller = new AbortController()
      cancellationController = controller
      cancellation.pending = true
      delete cancellation.error
      void client.action<WorkbenchCancelRunInput, WorkbenchCancelRunResult>(
        workbenchCancelRunActionRef,
        { runId: runId.value },
        controller.signal,
      ).then(result => {
        if (controller.signal.aborted) return
        cancellation.confirmedStatus = result.status
        refresh()
      }, error => {
        if (controller.signal.aborted) return
        cancellation.error = runCancellationError(error)
      }).finally(() => {
        if (cancellationController === controller) {
          cancellation.pending = false
          cancellationController = undefined
        }
      })
    }
    const newerEvents = () => {
      const previous = position.eventHistory.pop()
      if (previous) position.eventCursor = previous
      else delete position.eventCursor
    }

    return () => (
      <main class="main-workbench core-page run-detail-page">
        <RunDetailHeader cancellation={cancellation} onBack={openRuns} onCancel={cancelRun} state={detail} />
        <RunDetailContent
          activeView={activeView.value}
          canShowNewerEvents={position.eventHistory.length > 0}
          canShowNewerExecutions={position.executionHistory.length > 0}
          onOlderEvents={olderEvents}
          onOlderExecutions={olderExecutions}
          onNewerEvents={newerEvents}
          onNewerExecutions={newerExecutions}
          onReload={reload}
          onSelectView={selectView}
          state={detail}
        />
      </main>
    )
  },
)

function RunDetailHeader({ state, cancellation, onBack, onCancel }: {
  state: ConsoleQueryState<WorkbenchRunDetail | null>
  cancellation: { pending: boolean; error?: string; confirmedStatus?: WorkbenchCancelRunResult['status'] }
  onBack(): void
  onCancel(): void
}) {
  const run = state.status === 'READY' ? state.data?.run : undefined
  const status = cancellation.confirmedStatus ?? run?.status
  const cancellable = status === 'QUEUED' || status === 'RUNNING' || status === 'CANCELLING'
  return (
    <header class="core-page-header run-detail-header">
      <button aria-label="Back to Runs" class="run-detail-back" onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" size={18} />
      </button>
      <div class="run-detail-heading">
        <h1>{run?.automationName ?? 'Run detail'}</h1>
        <p>{run ? `${run.id} · Revision ${run.revisionNumber ?? run.revisionId}` : 'Durable execution timeline and diagnostics.'}</p>
      </div>
      {run ? (
        <div class="run-detail-actions">
          {cancellable ? (
            <button
              class="run-cancel-button"
              disabled={cancellation.pending || status === 'CANCELLING'}
              onClick={onCancel}
              type="button"
            ><Ban aria-hidden="true" size={14} />{cancellation.pending ? 'Cancelling…' : status === 'CANCELLING' ? 'Cancellation pending' : 'Cancel Run'}</button>
          ) : null}
          <em class="run-detail-status" data-status={status}>{statusLabel(status ?? run.status)}</em>
        </div>
      ) : null}
      {cancellation.error ? <p class="run-cancel-error" role="alert">{cancellation.error}</p> : null}
    </header>
  )
}

export function RunDetailContent({
  activeView,
  state,
  canShowNewerExecutions,
  canShowNewerEvents,
  onReload,
  onSelectView,
  onNewerExecutions,
  onOlderExecutions,
  onNewerEvents,
  onOlderEvents,
}: {
  activeView: RunDetailView
  state: ConsoleQueryState<WorkbenchRunDetail | null>
  canShowNewerExecutions: boolean
  canShowNewerEvents: boolean
  onReload(): void
  onSelectView(view: RunDetailView): void
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
      <nav aria-label="Run detail views" class="run-context-tabs">
        <RunViewTab active={activeView === 'flow'} icon={ListTree} label="Flow" onClick={() => onSelectView('flow')} />
        <RunViewTab active={activeView === 'timeline'} icon={ScrollText} label="Timeline" onClick={() => onSelectView('timeline')} />
        <RunViewTab active={activeView === 'context'} icon={Braces} label="Context" onClick={() => onSelectView('context')} />
      </nav>
      {activeView === 'flow' ? <RunFlowView detail={detail} /> : null}
      {activeView === 'context' ? <RunContextView detail={detail} /> : null}
      {activeView === 'timeline' ? (
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
      ) : null}
    </div>
  )
}

function RunViewTab({ active, icon: Icon, label, onClick }: {
  active: boolean
  icon: typeof ListTree
  label: string
  onClick(): void
}) {
  return (
    <button aria-current={active ? 'page' : undefined} onClick={onClick} type="button">
      <Icon aria-hidden="true" size={14} />{label}
    </button>
  )
}

function RunFlowView({ detail }: { detail: WorkbenchRunDetail }) {
  return (
    <section aria-labelledby="run-flow-title" class="run-detail-section run-flow-view">
      <div class="run-detail-section-heading">
        <div><h2 id="run-flow-title">Flow</h2><span>Immutable Revision structure · durable execution status</span></div>
        <strong>{detail.flow.root.executionCount}</strong>
      </div>
      <ol class="run-flow-tree">
        <RunFlowNode node={detail.flow.root} />
      </ol>
      {detail.flow.truncated ? <p class="run-projection-note">This Flow exceeds the 250-node inspection limit. The remaining structure is hidden.</p> : null}
    </section>
  )
}

function RunFlowNode({ node }: { node: WorkbenchRunDetail['flow']['root'] }) {
  return (
    <li>
      <div class="run-flow-node" data-status={node.status}>
        <span aria-hidden="true" class="run-flow-marker" />
        <div><strong>{node.title}</strong><p>{node.detail}</p><code>{node.id}</code></div>
        <em data-status={node.status}>{statusLabel(node.status)}</em>
      </div>
      {node.children.length ? <ol>{node.children.map(child => <RunFlowNode key={child.id} node={child} />)}</ol> : null}
    </li>
  )
}

function RunContextView({ detail }: { detail: WorkbenchRunDetail }) {
  return (
    <section aria-labelledby="run-context-title" class="run-detail-section run-context-view">
      <div class="run-detail-section-heading">
        <div><h2 id="run-context-title">Context</h2><span>Rebuildable binding paths · payload scalars are summarized</span></div>
        <strong>{detail.context.length}</strong>
      </div>
      <div class="run-context-groups">
        {detail.context.map(group => (
          <details key={group.name} open={group.name === 'run' || group.name === 'input' || group.name === 'steps'}>
            <summary><code>{group.name}.*</code>{group.truncated ? <span>Inspection limit reached</span> : null}</summary>
            <pre>{JSON.stringify(group.value, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
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

function runCancellationError(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined
  if (code === 'RUN_NOT_FOUND') return 'This Run no longer exists. Return to Runs and refresh the list.'
  return error instanceof Error ? error.message : 'The Run could not be cancelled. Try again.'
}
