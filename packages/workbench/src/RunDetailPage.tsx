import { Button } from '@numenjs/components'
import { diagnosticText, t, metadataText, formatDateTime, statusLabel } from './i18n.js'
import { Ban, Braces, ChevronLeft, Clock3, GitBranch, ListTree, RotateCcw, ScrollText } from '@lucide/vue'
import { computed, nextTick, onScopeDispose, reactive, ref, shallowReactive, watch } from 'vue'
import { ExecutionDataPanel } from './ExecutionDataPanel.js'
import { ReadonlyAutomationFlow } from './ReadonlyAutomationFlow.js'
import { PluginOwnership } from './PluginOwnership.js'
import { useExecutionData } from './useExecutionData.js'
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
  coreWorkbenchAutomationSnapshotRoute,
  coreWorkbenchRunContextRoute,
  coreWorkbenchRunFlowRoute,
  coreWorkbenchRunTimelineRoute,
} from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

const formatTime = formatDateTime

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
    const sourceFilter = ref<string>()
    const executionFilter = ref<string>()
    const selectedSourceNode = ref<string>()
    const inspection = useExecutionData(() => props.consoleClient, runId)
    let inspectionTrigger: HTMLElement | undefined
    watch(runId, () => {
      sourceFilter.value = undefined
      executionFilter.value = undefined
      selectedSourceNode.value = undefined
      delete position.executionCursor
      position.executionHistory.splice(0)
      delete position.eventCursor
      position.eventHistory.splice(0)
    }, { flush: 'sync' })
    const input = computed<WorkbenchRunDetailQueryInput>(() => ({
      runId: runId.value,
      ...(sourceFilter.value ? { sourceNodeId: sourceFilter.value } : {}),
      ...(executionFilter.value ? { executionId: executionFilter.value } : {}),
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
    const returnQuery = () => {
      const source = new URLSearchParams(props.navigation?.route.search ?? '').get('from') ?? ''
      const search = new URLSearchParams(source)
      return Object.fromEntries([...search].filter(([key]) => ['status', 'automationId', 'cursor', 'history'].includes(key)))
    }
    const openRuns = () => props.navigation?.navigate(coreWorkbenchRoutes.runs, { query: returnQuery() })
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
      props.navigation?.navigate(route, { parameters: { id: runId.value }, query: { from: new URLSearchParams(props.navigation.route.search).get('from') ?? undefined } })
    }
    const clearExecutionPage = () => { delete position.executionCursor; position.executionHistory.splice(0) }
    const selectSource = (id: string) => {
      inspection.close()
      selectedSourceNode.value = id
      selectView('flow')
    }
    const filterExecutions = (sourceNodeId?: string, executionId?: string) => {
      inspection.close()
      clearExecutionPage()
      sourceFilter.value = sourceNodeId
      executionFilter.value = executionId
      selectView('timeline')
    }
    const inspect = (executionId: string, attemptId?: string) => {
      inspectionTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      inspection.open(executionId, attemptId)
      void nextTick(() => { const panel = document.querySelector<HTMLElement>('.run-data-panel'); panel?.focus(); panel?.scrollIntoView({ block: 'nearest' }) })
    }
    const closeInspection = () => { inspection.close(); inspectionTrigger?.focus() }
    watch(() => [activeView.value, selectedSourceNode.value, detail.status], () => {
      if (activeView.value !== 'flow' || !selectedSourceNode.value) return
      void nextTick(() => {
        const target = Array.from(document.querySelectorAll<HTMLElement>('[data-run-source-id]'))
          .find(element => element.dataset.runSourceId === selectedSourceNode.value)
        target?.focus()
        target?.scrollIntoView({ block: 'nearest' })
      })
    }, { flush: 'post' })
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
        <RunDetailHeader onSnapshot={() => { if (detail.status === 'READY' && detail.data) props.navigation?.navigate(coreWorkbenchAutomationSnapshotRoute, { parameters: { automationId: detail.data.run.automationId, snapshotId: detail.data.run.revisionId }, query: { fromRun: detail.data.run.id } }) }} onAutomation={() => { if (detail.status === 'READY' && detail.data) props.navigation?.navigate(coreWorkbenchRoutes.automations, { query: { automation: detail.data.run.automationId } }) }} onLogs={() => props.navigation?.navigate(coreWorkbenchRoutes.system, { query: { runId: runId.value, from: new URLSearchParams(props.navigation?.route.search ?? '').get('from') ?? undefined } })} cancellation={cancellation} onBack={openRuns} onCancel={cancelRun} state={detail} />
        <ExecutionDataPanel state={inspection.state.value} onClose={closeInspection} onLocate={selectSource} />
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
          onInspect={inspect}
          onLocate={selectSource}
          onSelectNode={id => filterExecutions(id)}
          onSelectExecution={id => filterExecutions(undefined, id)}
          onClearFilter={() => filterExecutions()}
          filterLabel={sourceFilter.value ?? executionFilter.value}
          selectedSourceNodeId={selectedSourceNode.value}
          ownership={props}
          state={detail}
        />
      </main>
    )
  },
)

function RunDetailHeader({ state, cancellation, onBack, onCancel, onLogs, onAutomation, onSnapshot }: {
  state: ConsoleQueryState<WorkbenchRunDetail | null>
  cancellation: { pending: boolean; error?: string; confirmedStatus?: WorkbenchCancelRunResult['status'] }
  onBack(): void
  onCancel(): void
  onLogs(): void
  onAutomation(): void
  onSnapshot(): void
}) {
  const run = state.status === 'READY' ? state.data?.run : undefined
  const status = cancellation.confirmedStatus ?? run?.status
  const cancellable = status === 'QUEUED' || status === 'RUNNING' || status === 'CANCELLING'
  return (
    <header class="core-page-header run-detail-header">
      <button aria-label={t('workbench.backToRuns')} class="run-detail-back" onClick={onBack} type="button">
        <ChevronLeft aria-hidden="true" size={18} />
      </button>
      <div class="run-detail-heading">
        <h1>{run?.automationName ?? t('workbench.runDetail')}</h1>
        <p>{run ? run.snapshotPurpose === 'draft-test' ? `${run.id} · ${t('workbench.draftTest.target', { version: run.sourceDraftVersion })}` : t('workbench.value0RevisionValue1', { value0: run.id, value1: run.revisionNumber ?? run.revisionId }) : t('workbench.durableExecutionTimelineAndDiagnostics')}</p>
      </div>
      {run ? (
        <div class="run-detail-actions">
          <Button variant="secondary" class="secondary-button" type="button" onClick={onSnapshot}>{t('workbench.snapshots.view')}</Button>
          <Button variant="secondary" class="secondary-button" type="button" onClick={onAutomation}>{t('workbench.navigation.openAutomation')}</Button>
          <Button variant="secondary" class="secondary-button" type="button" onClick={onLogs}>{t('workbench.logs.viewRun')}</Button>
          {cancellable ? (
            <Button
              class="run-cancel-button"
              disabled={cancellation.pending || status === 'CANCELLING'}
              onClick={onCancel}
              type="button"
            ><Ban aria-hidden="true" size={14} />{cancellation.pending ? t('workbench.cancelling') : status === 'CANCELLING' ? t('workbench.cancellationPending') : t('workbench.cancelRun')}</Button>
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
  onInspect,
  onLocate,
  onSelectNode,
  onSelectExecution,
  onClearFilter,
  filterLabel,
  selectedSourceNodeId,
  ownership,
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
  onInspect?(executionId: string, attemptId?: string): void
  onLocate?(nodeId: string): void
  onSelectNode?(nodeId: string): void
  onSelectExecution?(executionId: string): void
  onClearFilter?(): void
  filterLabel?: string | undefined
  selectedSourceNodeId?: string | undefined
  ownership?: WorkbenchPageProps
}) {
  if (state.status === 'DISABLED') {
    return <RunDetailState title={t('workbench.runtimePreview')} message={t('workbench.openThisPageFromARunningNumenRuntimeToInspectADurableRun')} />
  }
  if (state.status === 'LOADING') {
    return <RunDetailState busy title={t('workbench.loadingRun')} message={t('workbench.readingDurableExecutionAttemptAndJournalState')} />
  }
  if (state.status === 'ERROR') {
    return <RunDetailState action={t('workbench.tryAgain')} message={diagnosticText(state)} onAction={onReload} title={t('workbench.runUnavailable')} tone="error" />
  }
  if (!state.data) {
    return <RunDetailState title={t('workbench.runNotFound')} message={t('workbench.thisRunDoesNotExistOrIsNoLongerAvailable')} />
  }
  const detail = state.data
  return (
    <div class="run-detail-content">
      <RunFacts detail={detail} />
      <nav aria-label={t('workbench.runDetailViews')} class="run-context-tabs">
        <RunViewTab active={activeView === 'flow'} icon={ListTree} label={t('workbench.flow')} onClick={() => onSelectView('flow')} />
        <RunViewTab active={activeView === 'timeline'} icon={ScrollText} label={t('workbench.timeline')} onClick={() => onSelectView('timeline')} />
        <RunViewTab active={activeView === 'context'} icon={Braces} label={t('workbench.context')} onClick={() => onSelectView('context')} />
      </nav>
      {activeView === 'flow' ? <RunFlowView detail={detail} onSelectNode={onSelectNode} selectedNodeId={selectedSourceNodeId} /> : null}
      {activeView === 'context' ? <RunContextView detail={detail} /> : null}
      {activeView === 'timeline' ? (
      <div class="run-detail-columns">
        <section aria-labelledby="run-timeline-title" class="run-detail-section run-timeline">
          <div class="run-detail-section-heading">
            <div><h2 id="run-timeline-title">{t('workbench.timeline')}</h2><span>{t('workbench.semanticJournalNewestFirst')}</span></div>
            <strong>{detail.timeline.total}</strong>
          </div>
          {detail.timeline.items.length ? (
            <ol class="run-timeline-list">
              {detail.timeline.items.map(event => (
                <li key={event.sequence}>
                  <span aria-hidden="true" class="timeline-marker" data-event-type={event.type} />
                  <div>
                    <strong>{metadataText(`workbench.events.${event.type}`, event.title)}</strong>
                    {event.detail ? <p>{event.detail}</p> : null}
                    <small>#{event.sequence} · {formatTime(event.occurredAt)}</small>
                    {event.executionId && onSelectExecution ? <Button type="button" onClick={() => onSelectExecution(event.executionId!)}>{t('workbench.runData.showExecution')}</Button> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p class="run-detail-empty">{t('workbench.noJournalEventsHaveBeenRecorded')}</p>}
          <PageControls
            canGoNewer={canShowNewerEvents}
            canGoOlder={!!detail.timeline.nextCursor}
            label={t('workbench.timelinePages')}
            onNewer={onNewerEvents}
            onOlder={onOlderEvents}
          />
        </section>
        <section aria-labelledby="execution-diagnostics-title" class="run-detail-section execution-diagnostics">
          <div class="run-detail-section-heading">
            <div><h2 id="execution-diagnostics-title">{t('workbench.executionDiagnostics')}</h2><span>{t('workbench.newestDurableUnitsFirst')}</span></div>
            <strong>{detail.executionSummary.total}</strong>
          </div>
          {filterLabel ? <p class="run-execution-filter"><code>{filterLabel}</code><Button type="button" onClick={() => onClearFilter?.()}>{t('workbench.runData.clearFilter')}</Button></p> : null}
          {detail.executions.length ? (
            <div class="execution-records">
              {detail.executions.map(execution => <ExecutionRecord execution={execution} key={execution.id} onInspect={onInspect} onLocate={onLocate} ownership={ownership} runId={detail.run.id} />)}
            </div>
          ) : <p class="run-detail-empty">{t(filterLabel ? 'workbench.noExecutionsMatchCurrentFilter' : 'workbench.noExecutionsHaveBeenCreatedForThisRun')}</p>}
          <PageControls
            canGoNewer={canShowNewerExecutions}
            canGoOlder={!!detail.nextExecutionCursor}
            label={t('workbench.executionDiagnosticPages')}
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

function RunFlowView({ detail, onSelectNode, selectedNodeId }: { detail: WorkbenchRunDetail; onSelectNode?: ((id: string) => void) | undefined; selectedNodeId?: string | undefined }) {
  return (
    <section aria-labelledby="run-flow-title" class="run-detail-section run-flow-view">
      <div class="run-detail-section-heading">
        <div><h2 id="run-flow-title">{t('workbench.flow')}</h2><span>{t('workbench.immutableRevisionStructureDurableExecutionStatus')}</span></div>
        <strong>{detail.flow.root.executionCount}</strong>
      </div>
      <ReadonlyAutomationFlow flow={detail.flow} showExecutionState onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} />
      {detail.flow.truncated ? <p class="run-projection-note">{t('workbench.thisFlowExceedsThe250NodeInspectionLimitTheRemainingStructureIsHidden')}</p> : null}
    </section>
  )
}

function RunContextView({ detail }: { detail: WorkbenchRunDetail }) {
  return (
    <section aria-labelledby="run-context-title" class="run-detail-section run-context-view">
      <div class="run-detail-section-heading">
        <div><h2 id="run-context-title">{t('workbench.context')}</h2><span>{t('workbench.rebuildableBindingPathsPayloadScalarsAreSummarized')}</span></div>
        <strong>{detail.context.length}</strong>
      </div>
      <div class="run-context-groups">
        {detail.context.map(group => (
          <details key={group.name} open={group.name === 'run' || group.name === 'input' || group.name === 'steps'}>
            <summary><code>{group.name}.*</code>{group.truncated ? <span>{t('workbench.inspectionLimitReached')}</span> : null}</summary>
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
    <section aria-label={t('workbench.runFacts')} class="run-facts">
      <div><span>{t('workbench.started')}</span><strong>{run.startedAt ? formatTime(run.startedAt) : t('workbench.notStarted')}</strong></div>
      <div><span>{t('workbench.duration')}</span><strong>{formatDuration(run.startedAt, run.finishedAt)}</strong></div>
      <div><span>{t('workbench.executions2')}</span><strong>{executionSummary.total} · {executionSummary.completed}{t('workbench.completed2')}</strong></div>
      <div><span>{t('workbench.attempts2')}</span><strong>{executionSummary.attempts}</strong></div>
      {executionSummary.blocked || executionSummary.failed || executionSummary.timedOut ? (
        <div data-tone="warning"><span>{t('workbench.attention')}</span><strong>{executionSummary.blocked}{t('workbench.blocked')}{executionSummary.failed + executionSummary.timedOut}{t('workbench.failed2')}</strong></div>
      ) : null}
    </section>
  )
}

function ExecutionRecord({ execution, onInspect, onLocate, ownership, runId }: { execution: WorkbenchRunExecution; onInspect?: ((id: string, attemptId?: string) => void) | undefined; onLocate?: ((id: string) => void) | undefined; ownership: WorkbenchPageProps | undefined; runId: string }) {
  return (
    <article class="execution-record" data-status={execution.status}>
      <header>
        <span class="execution-operation"><GitBranch aria-hidden="true" size={13} />{operationLabel(execution.operation)}</span>
        <em data-status={execution.status}>{statusLabel(execution.status)}</em>
      </header>
      <h3>{execution.title}</h3>
      <code>{execution.instructionId}</code>
      <div class="run-execution-actions">
        {onInspect ? <Button type="button" onClick={() => onInspect(execution.id)}>{t('workbench.runData.inspect')}</Button> : null}
        {onLocate && execution.sourceNodeId ? <Button type="button" onClick={() => onLocate(execution.sourceNodeId!)}>{t('workbench.runData.locate')}</Button> : null}
      </div>
      {execution.blockedReason ? <p class="execution-warning">{t('workbench.blocked2')}{statusLabel(execution.blockedReason)}</p> : null}
      {execution.operation === 'invoke' ? <PluginOwnership {...ownership} target={{ kind: 'execution', runId, executionId: execution.id }} /> : null}
      <dl>
        <div><dt>{t('workbench.updated')}</dt><dd>{formatTime(execution.updatedAt)}</dd></div>
        <div><dt>{t('workbench.generation')}</dt><dd>{execution.generation}</dd></div>
        {execution.loopIndex === undefined ? null : <div><dt>{t('workbench.loopItem')}</dt><dd>{execution.loopIndex + 1}</dd></div>}
        {execution.scopeBranch === undefined ? null : <div><dt>{t('workbench.branch')}</dt><dd>{execution.scopeBranch + 1}</dd></div>}
      </dl>
      {execution.attempts.length ? (
        <details class="execution-attempts" open={execution.attempts.some(attempt => attempt.status !== 'SUCCEEDED')}>
          <summary><RotateCcw aria-hidden="true" size={13} />{execution.attempts.length} {execution.attempts.length === 1 ? t('workbench.attempt') : t('workbench.attempts3')}</summary>
          <div>
            {execution.attempts.map(attempt => (
              <article key={attempt.id}>
                <span>{t('workbench.attempt2')}{attempt.number}</span>
                <em data-attempt-status={attempt.status}>{statusLabel(attempt.status)}</em>
                <small>{attempt.providerRef} · {formatDuration(attempt.startedAt, attempt.finishedAt)}</small>
                {attempt.errorSummary ? <p>{attempt.errorSummary}</p> : null}
                {onInspect ? <Button type="button" onClick={() => onInspect(execution.id, attempt.id)}>{t('workbench.runData.attemptData')}</Button> : null}
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
      <Button disabled={!canGoNewer} onClick={onNewer} type="button">{t('workbench.newer')}</Button>
      <Button disabled={!canGoOlder} onClick={onOlder} type="button">{t('workbench.older')}</Button>
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
      {action ? <Button {...(onAction ? { onClick: onAction } : {})} type="button">{action}</Button> : null}
    </section>
  )
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return t('workbench.notStarted')
  if (!finishedAt) return t('workbench.inProgress')
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`
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
