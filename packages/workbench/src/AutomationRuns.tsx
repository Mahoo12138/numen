import { Button } from '@numenjs/components'
import { diagnosticText, t, statusLabel, formatDateTime } from './i18n.js'
import { computed, reactive } from 'vue'
import { workbenchRunsIndexQueryRef, type WorkbenchRunsIndex, type WorkbenchRunsQueryInput, type WorkbenchRunStatus } from './contracts.js'
import { ManualRunForm } from './ManualRunForm.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import { SelectMenu } from './SelectMenu.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export interface RunHistoryPosition { status: WorkbenchRunStatus | ''; cursor?: string; history: Array<string | null> }
export function changeRunHistoryStatus(position: RunHistoryPosition, status: RunHistoryPosition['status']): void {
  position.status = status
  delete position.cursor
  position.history = []
}
export function advanceRunHistory(position: RunHistoryPosition, cursor: string): void {
  if (cursor === position.cursor) return
  position.history.push(position.cursor ?? null)
  position.cursor = cursor
}
export function previousRunHistory(position: RunHistoryPosition): void {
  const previous = position.history.pop()
  if (previous) position.cursor = previous
  else delete position.cursor
}
const statuses: WorkbenchRunStatus[] = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED']
const label = statusLabel
const statusOptions = () => [
  { value: '', label: t('workbench.allStatuses') },
  ...statuses.map(status => ({ value: status, label: label(status) })),
]
const time = formatDateTime

interface AutomationRunsProps extends WorkbenchPageProps { automationId: string; archived?: boolean }
export const AutomationRuns = defineSetupComponent<AutomationRunsProps>('AutomationRuns', ['automationId', 'archived', 'consoleClient', 'schemaUI', 'navigation'], props => {
  const position = reactive<RunHistoryPosition>({ status: '', history: [] })
  const input = computed<WorkbenchRunsQueryInput>(() => ({ automationId: props.automationId, limit: 20,
    ...(position.status ? { status: position.status } : {}), ...(position.cursor ? { cursor: position.cursor } : {}),
  }))
  const [index, reload] = useConsoleQuery<WorkbenchRunsQueryInput, WorkbenchRunsIndex>(() => props.consoleClient, workbenchRunsIndexQueryRef, input, 'runs')
  return () => <section class="automation-runs">
    {!props.archived ? <details class="automation-run-launcher">
      <summary>{t('workbench.runManually')}</summary>
      <ManualRunForm automationId={props.automationId} {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} {...(props.navigation ? { navigation: props.navigation } : {})} />
    </details> : null}
    <section aria-label={t('workbench.automationRunHistory')}>
      <div class="automation-run-heading"><div><h2>{t('workbench.runHistory')}</h2><p>{t('workbench.allRevisionsNewestFirst20PerPage')}</p></div>
        <Button variant="secondary" class="secondary-button" disabled={index.status === 'LOADING'} onClick={() => { delete position.cursor; position.history = []; reload() }} type="button">{t('workbench.latestRuns')}</Button>
      </div>
      <div class="automation-run-filter"><span id="run-status-label">{t('workbench.status')}</span><SelectMenu
        ariaLabel={t('workbench.runStatus')}
        options={statusOptions()}
        placement="top"
        value={position.status}
        onChange={value => changeRunHistoryStatus(position, value as RunHistoryPosition['status'])}
      /></div>
      {index.status === 'READY' ? <>
        <p class="automation-run-totals">{index.data.summary.total}{t('workbench.total')}{index.data.summary.active}{t('workbench.active2')}{index.data.summary.queued}{t('workbench.queued')}{index.data.summary.completed}{t('workbench.completed')}{index.data.summary.failed}{t('workbench.failed')}{index.data.summary.cancelled}{t('workbench.cancelled')}</p>
        {index.data.items.length ? <div class="runs-table-wrap"><table class="runs-table">
          <thead><tr><th>{t('workbench.runRevision')}</th><th>{t('workbench.status')}</th><th>{t('workbench.accepted')}</th><th>{t('workbench.work')}</th></tr></thead>
          <tbody>{index.data.items.map(run => <tr key={run.id}>
            <td><button class="run-detail-link" aria-label={t('workbench.openRunValue0', { value0: run.id })} disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: run.id } })} type="button"><strong>{run.id}</strong><small>{run.revisionId}</small></button></td>
            <td><em data-status={run.status}>{label(run.status)}</em></td><td>{time(run.createdAt)}</td>
            <td>{run.executionCount}{t('workbench.executions')}{run.attemptCount}{t('workbench.attempts')}</td>
          </tr>)}</tbody>
        </table></div> : <p class="home-empty">{position.status ? t('workbench.noRunsMatchThisStatusOnThisPage') : position.cursor ? t('workbench.noRunsRemainOnThisPage') : t('workbench.thisAutomationHasNoRunsYet')}</p>}
      </> : index.status === 'ERROR' ? <p role="alert">{diagnosticText(index)} <Button variant="secondary" class="secondary-button" onClick={reload} type="button">{t('workbench.tryAgain')}</Button></p>
        : <p role="status">{index.status === 'LOADING' ? t('workbench.loadingRunHistory') : t('workbench.connectToARuntimeToViewRuns')}</p>}
      <nav class="runs-pagination" aria-label={t('workbench.automationRunPages')}>
        <Button disabled={!position.history.length || index.status === 'LOADING'} onClick={() => previousRunHistory(position)} type="button">{t('workbench.previous')}</Button>
        <Button disabled={index.status !== 'READY' || !index.data.nextCursor} onClick={() => { if (index.status === 'READY' && index.data.nextCursor) advanceRunHistory(position, index.data.nextCursor) }} type="button">{t('workbench.next')}</Button>
      </nav>
    </section>
  </section>
})
