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
const label = (status: string) => status.charAt(0) + status.slice(1).toLowerCase()
const statusOptions = [
  { value: '', label: 'All statuses' },
  ...statuses.map(status => ({ value: status, label: label(status) })),
]
const time = (value: string) => new Date(value).toLocaleString()

interface AutomationRunsProps extends WorkbenchPageProps { automationId: string }
export const AutomationRuns = defineSetupComponent<AutomationRunsProps>('AutomationRuns', ['automationId', 'consoleClient', 'schemaUI', 'navigation'], props => {
  const position = reactive<RunHistoryPosition>({ status: '', history: [] })
  const input = computed<WorkbenchRunsQueryInput>(() => ({ automationId: props.automationId, limit: 20,
    ...(position.status ? { status: position.status } : {}), ...(position.cursor ? { cursor: position.cursor } : {}),
  }))
  const [index, reload] = useConsoleQuery<WorkbenchRunsQueryInput, WorkbenchRunsIndex>(() => props.consoleClient, workbenchRunsIndexQueryRef, input, 'runs')
  return () => <section class="automation-runs">
    <details class="automation-run-launcher">
      <summary>Run manually</summary>
      <ManualRunForm automationId={props.automationId} {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} {...(props.navigation ? { navigation: props.navigation } : {})} />
    </details>
    <section aria-label="Automation Run history">
      <div class="automation-run-heading"><div><h2>Run history</h2><p>All revisions · newest first · 20 per page</p></div>
        <button class="secondary-button" disabled={index.status === 'LOADING'} onClick={() => { delete position.cursor; position.history = []; reload() }} type="button">Latest runs</button>
      </div>
      <div class="automation-run-filter"><span id="run-status-label">Status</span><SelectMenu
        ariaLabel="Run status"
        options={statusOptions}
        placement="top"
        value={position.status}
        onChange={value => changeRunHistoryStatus(position, value as RunHistoryPosition['status'])}
      /></div>
      {index.status === 'READY' ? <>
        <p class="automation-run-totals">{index.data.summary.total} total · {index.data.summary.active} active · {index.data.summary.queued} queued · {index.data.summary.completed} completed · {index.data.summary.failed} failed · {index.data.summary.cancelled} cancelled</p>
        {index.data.items.length ? <div class="runs-table-wrap"><table class="runs-table">
          <thead><tr><th>Run / Revision</th><th>Status</th><th>Accepted</th><th>Work</th></tr></thead>
          <tbody>{index.data.items.map(run => <tr key={run.id}>
            <td><button class="run-detail-link" aria-label={`Open Run ${run.id}`} disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: run.id } })} type="button"><strong>{run.id}</strong><small>{run.revisionId}</small></button></td>
            <td><em data-status={run.status}>{label(run.status)}</em></td><td>{time(run.createdAt)}</td>
            <td>{run.executionCount} executions · {run.attemptCount} attempts</td>
          </tr>)}</tbody>
        </table></div> : <p class="home-empty">{position.status ? 'No runs match this status on this page.' : position.cursor ? 'No runs remain on this page.' : 'This Automation has no runs yet.'}</p>}
      </> : index.status === 'ERROR' ? <p role="alert">{index.message} <button class="secondary-button" onClick={reload} type="button">Try again</button></p>
        : <p role="status">{index.status === 'LOADING' ? 'Loading Run history…' : 'Connect to a Runtime to view Runs.'}</p>}
      <nav class="runs-pagination" aria-label="Automation Run pages">
        <button disabled={!position.history.length || index.status === 'LOADING'} onClick={() => previousRunHistory(position)} type="button">Previous</button>
        <button disabled={index.status !== 'READY' || !index.data.nextCursor} onClick={() => { if (index.status === 'READY' && index.data.nextCursor) advanceRunHistory(position, index.data.nextCursor) }} type="button">Next</button>
      </nav>
    </section>
  </section>
})
