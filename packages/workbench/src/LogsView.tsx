import type { LogCursor, LogQuery } from '@numenjs/logging/contracts'
import { computed, ref } from 'vue'
import { useWorkbenchI18n } from './i18n.js'
import type { WorkbenchConsoleClient } from './types.js'
import { defineSetupComponent, useTextDraft } from './vue-component.js'
import { useLogFeed } from './useLogFeed.js'

export interface LogsViewProps { consoleClient?: WorkbenchConsoleClient; automationId?: string; runId?: string; compact?: boolean }
export const LogsView = defineSetupComponent<LogsViewProps>('LogsView', ['consoleClient', 'automationId', 'runId', 'compact'], props => {
  const { t, locale } = useWorkbenchI18n()
  const timestamp = computed(() => new Intl.DateTimeFormat(locale.value, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }))
  const namespace = ref(''), search = ref(''), correlation = ref('')
  const namespaceDraft = useTextDraft(() => namespace.value), searchDraft = useTextDraft(() => search.value), correlationDraft = useTextDraft(() => correlation.value)
  const maxLevel = ref(2), following = ref(true)
  const before = ref<LogCursor>()
  const parameters = computed<LogQuery>(() => ({ limit: 100, maxLevel: maxLevel.value,
    ...(namespace.value ? { namespace: namespace.value } : {}), ...(search.value ? { search: search.value } : {}),
    ...(props.automationId ? { automationId: props.automationId } : {}),
    ...(props.runId || correlation.value ? { runId: props.runId || correlation.value } : {}),
    ...(before.value ? { before: before.value } : {}),
  }))
  const feed = useLogFeed(() => props.consoleClient, parameters, following)
  const newest = () => { before.value = undefined; following.value = true; feed.reload() }
  const filter = () => { before.value = undefined }
  return () => <section class={['logs-view', props.compact ? 'logs-compact' : '']} aria-label={t('workbench.logs.title')}>
    <div class="logs-toolbar">
      <label>{t('workbench.logs.level')}<select aria-label={t('workbench.logs.level')} value={maxLevel.value} onChange={event => { maxLevel.value = Number((event.target as HTMLSelectElement).value); filter() }}>
        {[0, 1, 2, 3].map(level => <option value={level}>{t(`workbench.logs.level${level}`)}</option>)}
      </select></label>
      <label>{t('workbench.logs.namespace')}<input aria-label={t('workbench.logs.namespace')} value={namespaceDraft.text.value} onInput={namespaceDraft.onInput} maxlength={200} onChange={event => { namespace.value = (event.target as HTMLInputElement).value.trim(); filter() }} placeholder="scheduler" /></label>
      <label>{t('workbench.logs.search')}<input aria-label={t('workbench.logs.search')} value={searchDraft.text.value} onInput={searchDraft.onInput} maxlength={200} onChange={event => { search.value = (event.target as HTMLInputElement).value.trim(); filter() }} /></label>
      {!props.runId ? <label>{t('workbench.logs.run')}<input aria-label={t('workbench.logs.run')} value={correlationDraft.text.value} onInput={correlationDraft.onInput} maxlength={200} onChange={event => { correlation.value = (event.target as HTMLInputElement).value.trim(); filter() }} placeholder="run_…" /></label> : null}
      <button class="secondary-button" onClick={() => { following.value = !following.value }} type="button">{t(following.value ? 'workbench.logs.pause' : 'workbench.logs.follow')}</button>
      <button class="secondary-button" onClick={newest} type="button">{t('workbench.logs.latest')}</button>
    </div>
    {!props.consoleClient ? <p>{t('workbench.logs.disconnected')}</p> : <>
      <div class="logs-summary" role="status">
        <span>{t(following.value ? 'workbench.logs.following' : 'workbench.logs.paused')}</span>
        {feed.loading.value ? <span>{t('workbench.logs.loading')}</span> : null}
        {feed.snapshot.value ? <span>{t('workbench.logs.retention', { count: feed.snapshot.value.retained, removed: feed.snapshot.value.evicted })}</span> : null}
      </div>
      {feed.failed.value ? <p role="alert">{t('workbench.logs.failed')} <button class="secondary-button" type="button" onClick={feed.reload}>{t('workbench.tryAgain')}</button></p> : null}
      {feed.snapshot.value?.persistence === 'failed' ? <p role="alert">{t('workbench.logs.diskFailed')}</p> : null}
      {feed.snapshot.value?.persistence === 'disabled' ? <p>{t('workbench.logs.memoryOnly')}</p> : null}
      {feed.snapshot.value?.malformed ? <p>{t('workbench.logs.malformed', { count: feed.snapshot.value.malformed })}</p> : null}
      {feed.snapshot.value?.expired ? <p role="status">{t('workbench.logs.expired')}</p> : null}
      {feed.snapshot.value?.reset ? <p role="status">{t('workbench.logs.reset')}</p> : null}
      <div class="logs-records" tabindex={0} aria-label={t('workbench.logs.records')}>
        {feed.snapshot.value?.records.map(record => <article class="log-record" data-level={record.type} key={record.id}>
          <header><time datetime={record.timestamp}>{timestamp.value.format(new Date(record.timestamp))}</time><strong>{record.type.toUpperCase()}</strong><code>{record.namespace}</code></header>
          <pre>{record.message}</pre>
          <footer>{record.pluginPath ? <span>{record.pluginPath}</span> : null}
            {(['automationId', 'runId', 'executionId', 'attemptId', 'connectionId', 'triggerId', 'requestId', 'traceId'] as const).filter(key => record[key]).map(key => <span><b>{key}</b> <code>{record[key]}</code></span>)}
          </footer>
        </article>)}
        {!feed.loading.value && feed.snapshot.value && !feed.snapshot.value.records.length ? <p>{t('workbench.logs.empty')}</p> : null}
      </div>
      <button class="secondary-button" disabled={!feed.snapshot.value?.next || feed.loading.value} onClick={() => { before.value = feed.snapshot.value?.next; following.value = false }} type="button">{t('workbench.logs.older')}</button>
    </>}
  </section>
})
