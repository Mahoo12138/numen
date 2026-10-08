import { Button } from '@numenjs/components'
import { computed, onScopeDispose, ref, watch } from 'vue'
import {
  workbenchAutomationComparisonQueryRef, workbenchAutomationComparisonStateQueryRef,
  type WorkbenchAutomationComparison, type WorkbenchAutomationComparisonIdentity,
  type WorkbenchAutomationComparisonQueryInput, type WorkbenchAutomationComparisonState,
  type WorkbenchAutomationComparisonTarget, type WorkbenchAutomationChangeCategory,
} from './contracts.js'
import { t } from './i18n.js'
import { coreWorkbenchRoutes, coreWorkbenchAutomationComparisonRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

const categories: WorkbenchAutomationChangeCategory[] = ['structure', 'parameters', 'bindings', 'policies', 'triggers', 'inputs', 'presentation', 'extensions']
const snapshotId = /^(?:rev|snap)_[a-f0-9]{32}$/
const parseVersion = (value: string | null) => value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
const target = (id: string, version?: number): WorkbenchAutomationComparisonTarget | undefined => id === 'draft'
  ? version ? { kind: 'draft', version } : undefined
  : snapshotId.test(id) ? { kind: 'snapshot', snapshotId: id } : undefined

export const AutomationComparisonPage = defineSetupComponent<WorkbenchPageProps>('AutomationComparisonPage', ['consoleClient', 'schemaUI', 'navigation'], props => {
  const automationId = computed(() => props.navigation?.route.parameters.automationId ?? '')
  const routeKey = computed(() => `${automationId.value}:${props.navigation?.route.search ?? ''}`)
  const [metadata, reloadMetadata] = useConsoleQuery<{ automationId: string }, WorkbenchAutomationComparisonState>(
    () => props.consoleClient && automationId.value ? props.consoleClient : undefined,
    workbenchAutomationComparisonStateQueryRef, () => ({ automationId: automationId.value }), 'automations',
  )
  const leftChoice = ref('')
  const rightChoice = ref('draft')
  const compared = ref<WorkbenchAutomationComparisonQueryInput>()
  const initialized = ref(false)
  const refreshedDraftVersion = ref<number>()
  const refreshPending = ref(false)
  const refreshFailed = ref(false)
  let refreshController: AbortController | undefined
  const cancelRefresh = () => { refreshController?.abort(); refreshController = undefined; refreshPending.value = false; refreshFailed.value = false }
  onScopeDispose(cancelRefresh)
  watch(automationId, () => { refreshedDraftVersion.value = undefined }, { flush: 'sync' })
  watch(routeKey, () => {
    cancelRefresh()
    const query = new URLSearchParams(props.navigation?.route.search ?? '')
    leftChoice.value = query.get('left') ?? ''
    rightChoice.value = query.get('right') ?? 'draft'
    initialized.value = false
    const version = parseVersion(query.get('draftVersion'))
    const left = target(leftChoice.value, version)
    const right = target(rightChoice.value, version)
    // Only a fully pinned bookmark may start a comparison without the form's Compare action.
    const next = left && right && !(left.kind === 'draft' && right.kind === 'draft')
      ? { automationId: automationId.value, left, right } : undefined
    if (JSON.stringify(next) !== JSON.stringify(compared.value)) compared.value = next
  }, { immediate: true, flush: 'sync' })
  watch(() => metadata.status === 'READY' ? metadata.data : undefined, data => {
    if (!data || data.automationId !== automationId.value) return
    // A later metadata transport failure cannot erase proof that a pinned Draft is stale.
    refreshedDraftVersion.value = Math.max(data.draftVersion, refreshedDraftVersion.value ?? data.draftVersion)
    if (initialized.value) return
    if (!leftChoice.value) leftChoice.value = data.revisions[0]?.id ?? ''
    initialized.value = true
  })
  const [comparison, reloadComparison] = useConsoleQuery<WorkbenchAutomationComparisonQueryInput, WorkbenchAutomationComparison>(
    () => props.consoleClient && compared.value ? props.consoleClient : undefined,
    workbenchAutomationComparisonQueryRef,
    () => compared.value ?? { automationId: automationId.value, left: { kind: 'draft', version: 1 }, right: { kind: 'draft', version: 1 } },
  )
  const draftVersion = computed(() => {
    const live = metadata.status === 'READY' && metadata.data.automationId === automationId.value ? metadata.data.draftVersion : undefined
    if (live === undefined) return refreshedDraftVersion.value
    return Math.max(live, refreshedDraftVersion.value ?? live)
  })
  const displayedDraft = computed(() => comparison.status === 'READY'
    ? [comparison.data.left, comparison.data.right].find(identity => identity.kind === 'draft') : undefined)
  const stale = computed(() => displayedDraft.value?.kind === 'draft' && draftVersion.value !== undefined && displayedDraft.value.version !== draftVersion.value)
  const canCompare = computed(() => metadata.status === 'READY'
    && !!target(leftChoice.value, draftVersion.value) && !!target(rightChoice.value, draftVersion.value)
    && !(leftChoice.value === 'draft' && rightChoice.value === 'draft') && comparison.status !== 'LOADING' && !refreshPending.value)
  const commitTargets = (input: WorkbenchAutomationComparisonQueryInput) => {
    compared.value = input
    const draftIdentity = [input.left, input.right].find(item => item.kind === 'draft')
    props.navigation?.navigate(coreWorkbenchAutomationComparisonRoute, {
      parameters: { automationId: input.automationId }, replace: true,
      query: { left: input.left.kind === 'draft' ? 'draft' : input.left.snapshotId,
        right: input.right.kind === 'draft' ? 'draft' : input.right.snapshotId,
        ...(draftIdentity?.kind === 'draft' ? { draftVersion: String(draftIdentity.version) } : {}),
      },
    })
  }
  const compare = () => {
    const left = target(leftChoice.value, draftVersion.value)
    const right = target(rightChoice.value, draftVersion.value)
    if (!left || !right || left.kind === 'draft' && right.kind === 'draft') return
    cancelRefresh()
    commitTargets({ automationId: automationId.value, left, right })
  }
  const refreshDraft = async () => {
    const current = compared.value
    const client = props.consoleClient
    if (!current || !client || refreshPending.value) return
    cancelRefresh()
    const controller = new AbortController()
    refreshController = controller
    refreshPending.value = true
    try {
      // Refresh re-reads the saved identity even if the live invalidation stream was interrupted.
      const latest = await client.query<{ automationId: string }, WorkbenchAutomationComparisonState>(workbenchAutomationComparisonStateQueryRef, { automationId: current.automationId }, controller.signal)
      if (controller.signal.aborted || current !== compared.value || latest.automationId !== current.automationId) return
      refreshedDraftVersion.value = Math.max(latest.draftVersion, refreshedDraftVersion.value ?? latest.draftVersion)
      commitTargets({ ...current,
        left: current.left.kind === 'draft' ? { kind: 'draft', version: latest.draftVersion } : current.left,
        right: current.right.kind === 'draft' ? { kind: 'draft', version: latest.draftVersion } : current.right,
      })
      reloadMetadata()
    } catch {
      if (!controller.signal.aborted && current === compared.value) refreshFailed.value = true
    } finally {
      if (refreshController === controller) { refreshController = undefined; refreshPending.value = false }
    }
  }
  const options = (selection: string) => {
    const revisions = metadata.status === 'READY' && metadata.data.automationId === automationId.value ? metadata.data.revisions : []
    return <>
      <option value="">{t('workbench.comparison.choose')}</option>
      <option value="draft">{t('workbench.comparison.savedDraft', { version: draftVersion.value ?? '…' })}</option>
      {revisions.map(revision => <option key={revision.id} value={revision.id}>{t('workbench.revisionValue0', { value0: revision.number })}</option>)}
      {selection && selection !== 'draft' && !revisions.some(revision => revision.id === selection) ? <option value={selection}>{selection}</option> : null}
    </>
  }
  return () => <main class="main-workbench core-page automation-comparison-page">
    <header class="core-page-header snapshot-header">
      <div><h1>{t('workbench.comparison.title')}</h1><p>{t('workbench.comparison.readonly')}</p></div>
      <Button type="button" variant="secondary" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.automations, { query: { automation: automationId.value, tab: 'Revisions' } })}>{t('workbench.navigation.openAutomation')}</Button>
    </header>
    <section class="comparison-picker" aria-label={t('workbench.comparison.targets')}>
      <label>{t('workbench.comparison.left')}<select aria-label={t('workbench.comparison.left')} value={leftChoice.value} onChange={event => { leftChoice.value = (event.target as HTMLSelectElement).value }}>{options(leftChoice.value)}</select></label>
      <label>{t('workbench.comparison.right')}<select aria-label={t('workbench.comparison.right')} value={rightChoice.value} onChange={event => { rightChoice.value = (event.target as HTMLSelectElement).value }}>{options(rightChoice.value)}</select></label>
      <Button type="button" onClick={compare} disabled={!canCompare.value}>{t('workbench.comparison.compare')}</Button>
    </section>
    {metadata.status === 'ERROR' ? <section role="alert" class="snapshot-notice"><p>{t('workbench.comparison.metadataUnavailable')}</p><Button type="button" onClick={reloadMetadata}>{t('workbench.tryAgain')}</Button></section> : null}
    {metadata.status === 'READY' && metadata.data.revisionsTruncated ? <p role="status">{t('workbench.comparison.revisionsLimit')}</p> : null}
    {refreshFailed.value ? <p role="alert" class="snapshot-notice">{t('workbench.comparison.metadataUnavailable')}</p> : null}
    {stale.value ? <section role="alert" class="comparison-stale"><p>{t('workbench.comparison.stale')}</p><Button type="button" onClick={refreshDraft} disabled={refreshPending.value}>{t('workbench.comparison.refreshDraft')}</Button></section> : null}
    {comparison.status === 'LOADING' ? <section class="snapshot-notice" role="status" aria-busy="true"><p>{t('workbench.comparison.loading')}</p></section>
      : comparison.status === 'ERROR' ? <section class="snapshot-notice" role="alert">
        <p>{t(comparison.code === 'AUTOMATION_COMPARISON_STALE' ? 'workbench.comparison.staleRequest' : comparison.code === 'AUTOMATION_COMPARISON_LIMIT' ? 'workbench.comparison.tooLarge' : 'workbench.comparison.unavailable')}</p>
        {comparison.code === 'AUTOMATION_COMPARISON_STALE' ? <Button type="button" onClick={refreshDraft} disabled={refreshPending.value}>{t('workbench.comparison.refreshDraft')}</Button>
          : <Button type="button" onClick={reloadComparison}>{t('workbench.tryAgain')}</Button>}
      </section>
      : comparison.status === 'READY' ? <section class="automation-comparison-result">
        <h2>{comparison.data.automationName}</h2>
        <div class="comparison-identities">
          {[comparison.data.left, comparison.data.right].map((identity, index) => <article key={index}>
            <span>{t(index ? 'workbench.comparison.right' : 'workbench.comparison.left')}</span><strong>{identityTitle(identity)}</strong>
            {identity.kind === 'snapshot' ? <code>{identity.snapshotId}</code> : null}
            {identity.kind === 'snapshot' ? <Button type="button" variant="secondary" aria-label={t('workbench.restoration.identity', { identity: identityTitle(identity) })}
              onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.automations, { query: { automation: comparison.data.automationId, tab: 'Revisions', restoreSnapshot: identity.snapshotId } })}>{t('workbench.restoration.title')}</Button> : null}
          </article>)}
        </div>
        <p>{t('workbench.comparison.hidden')}</p>
        {!comparison.data.changes.length ? <p role="status">{t('workbench.comparison.noChanges')}</p> : categories.map(category => {
          if (comparison.status !== 'READY') return null
          const changes = comparison.data.changes.filter(change => change.category === category)
          return changes.length ? <section class="comparison-category" data-category={category} key={category}>
            <h3>{t(`workbench.comparison.category.${category}`)} <span>({changes.length})</span></h3>
            <ul>{changes.map((change, index) => <li class="comparison-change" data-category={category} key={index}>
              <strong>{t(`workbench.comparison.kind.${change.kind}`)}</strong>
              {change.nodeId ? <code>{change.nodeId}</code> : null}
              {change.field ? <span>{t(`workbench.comparison.field.${change.field}`)}</span> : null}
            </li>)}</ul>
          </section> : null
        })}
      </section> : <section class="snapshot-notice" role="status"><p>{t(props.consoleClient ? 'workbench.comparison.chooseTargets' : 'workbench.snapshots.runtimeRequired')}</p></section>}
  </main>
})

function identityTitle(identity: WorkbenchAutomationComparisonIdentity): string {
  return identity.kind === 'draft' ? t('workbench.comparison.draft', { version: identity.version })
    : identity.purpose === 'draft-test' ? t('workbench.draftTest.target', { version: identity.sourceDraftVersion })
      : t('workbench.revisionValue0', { value0: identity.number })
}
