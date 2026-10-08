import { Button, StatePanel } from '@numenjs/components'
import type { HostConfigMutationRequest, HostConfigMutationResult, HostConfigOperation, HostConfigPreview, HostConfigSnapshot, HostPluginEntry } from '@numenjs/config'
import { Boxes, RefreshCw } from '@lucide/vue'
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { pluginReturnTarget } from './plugin-navigation.js'
import { diagnosticText, t } from './i18n.js'
import { workbenchPluginApplyRef, workbenchPluginPreviewRef, workbenchPluginsQueryRef } from './management-contracts.js'
import { coreWorkbenchRoutes } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'
import { PluginDetails } from './PluginDetails.js'
import { PluginConfigurationForm } from './PluginConfigurationForm.js'
import { PluginImpactPreview } from './PluginImpactPreview.js'
import { parsePluginConfig } from './plugin-config-editing.js'

interface PluginEditSession {
  baseFingerprint: string
  entry?: HostPluginEntry
  initial: { label: string; groupId: string; parentId: string; config: string }
}

export const PluginsPage = defineSetupComponent<WorkbenchPageProps>('PluginsPage', ['consoleClient', 'navigation'], props => {
  const [query, , refresh] = useConsoleQuery<Record<string, never>, HostConfigSnapshot>(() => props.consoleClient, workbenchPluginsQueryRef, {}, 'plugins')
  const selected = ref(''), operation = ref<'setConfig' | 'setLabel' | 'move' | 'createGroup'>('setConfig')
  const label = ref(''), groupId = ref(''), parentId = ref(''), config = ref('')
  const editing = ref(false), busy = ref(false), error = ref(''), result = ref('')
  const preview = ref<HostConfigPreview>(), request = ref<HostConfigMutationRequest>()
  const session = shallowRef<PluginEditSession>()
  const sessionEpoch = ref(0)
  const configMode = ref<'form' | 'json'>('form')
  const configFields = ref({ dirty: false, invalid: false })
  const formValue = shallowRef<Record<string, unknown>>({})
  const parsedConfig = computed(() => parsePluginConfig(config.value))
  watch(parsedConfig, parsed => { if (parsed.ok) formValue.value = parsed.config }, { immediate: true, flush: 'sync' })
  // Keep the form mounted during a refresh failure; only a successful observation updates the remote state.
  const snapshot = shallowRef<HostConfigSnapshot>()
  watch(() => query.status === 'READY' ? query.data : undefined, value => { if (value) snapshot.value = value }, { immediate: true, flush: 'sync' })
  const targetId = computed(() => new URLSearchParams(props.navigation?.route.search ?? '').get('entryId'))
  const targetEntry = computed(() => snapshot.value?.entries.find(entry => entry.id === targetId.value))
  const returnTarget = computed(() => pluginReturnTarget(new URLSearchParams(props.navigation?.route.search ?? '').get('from')))
  const revealed = computed(() => {
    const ids = new Set<string>(), entries = snapshot.value?.entries ?? []
    let entry = targetEntry.value
    while (entry && !ids.has(entry.id)) { ids.add(entry.id); entry = entries.find(parent => parent.id === entry!.parentId) }
    return ids
  })
  watch([targetId, () => !!targetEntry.value], () => {
    if (typeof document === 'undefined') return
    void nextTick(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-entry-id]')).find(element => element.dataset.entryId === targetId.value)
      row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest' })
    })
  }, { immediate: true, flush: 'post' })
  const selectedEntry = computed(() => snapshot.value?.entries.find(entry => entry.id === selected.value))
  const detailEntry = computed(() => selectedEntry.value ?? (!editing.value ? targetEntry.value : undefined))
  const dirty = computed(() => !!session.value && (label.value !== session.value.initial.label || groupId.value !== session.value.initial.groupId || parentId.value !== session.value.initial.parentId || config.value !== session.value.initial.config))
  const hasOtherEdits = computed(() => {
    const initial = session.value?.initial
    if (!initial) return false
    return (operation.value !== 'setConfig' && (config.value !== initial.config || configFields.value.dirty || configFields.value.invalid))
      || (!['setLabel', 'createGroup'].includes(operation.value) && label.value !== initial.label)
      || (!['move', 'createGroup'].includes(operation.value) && parentId.value !== initial.parentId)
  })
  const needsProtection = computed(() => dirty.value || configFields.value.dirty || configFields.value.invalid || !!preview.value || busy.value)
  const stale = computed(() => !!session.value && !!snapshot.value && session.value.baseFingerprint !== snapshot.value.fingerprint)
  const allowDiscard = () => !needsProtection.value || globalThis.confirm(t('workbench.management.discardEdits'))
  watch(() => props.navigation, (navigation, _previous, cleanup) => {
    const dispose = navigation?.beforeLeave?.(() => allowDiscard())
    if (dispose) cleanup(dispose)
  }, { immediate: true })
  watch(needsProtection, (protect, _previous, cleanup) => {
    if (!protect || typeof window === 'undefined') return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    cleanup(() => window.removeEventListener('beforeunload', beforeUnload))
  }, { immediate: true, flush: 'sync' })
  let controller: AbortController | undefined
  onScopeDispose(() => controller?.abort())
  const writable = computed(() => query.status === 'READY' && !!snapshot.value?.writable && !snapshot.value.restartRequired && !busy.value)
  const clearPreview = () => { preview.value = undefined; request.value = undefined }
  const closeEditor = () => { editing.value = false; session.value = undefined; configFields.value = { dirty: false, invalid: false }; clearPreview() }
  const blurConfigInput = () => { if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur() }
  const configAllowed = computed(() => !!session.value?.entry?.configEditable && !!selectedEntry.value?.configEditable && !selectedEntry.value.protected)
  const setConfigMode = (mode: 'form' | 'json') => {
    if (mode === configMode.value || busy.value) return
    blurConfigInput()
    if (configFields.value.dirty || configFields.value.invalid) { error.value = t('workbench.pluginConfig.correctFields'); return }
    if (mode === 'form' && !parsedConfig.value.ok) { error.value = t('workbench.management.invalidJson'); return }
    configMode.value = mode; error.value = ''
  }
  const showDetails = (entry: HostPluginEntry) => {
    if (busy.value || (selected.value !== entry.id || editing.value) && !allowDiscard()) return
    closeEditor(); selected.value = entry.id
    void nextTick(() => document.querySelector<HTMLElement>('.plugin-detail')?.scrollIntoView({ block: 'nearest' }))
  }
  const loadEditor = (entry?: HostPluginEntry) => {
    if (!snapshot.value) return
    // Resolve the clicked ID against this observation so content and fingerprint are captured together.
    if (entry) {
      entry = snapshot.value.entries.find(current => current.id === entry!.id)
      if (!entry) return
    }
    selected.value = entry?.id ?? ''; operation.value = entry ? entry.configEditable ? 'setConfig' : 'setLabel' : 'createGroup'
    label.value = entry?.label ?? ''; parentId.value = entry?.parentId ?? ''; groupId.value = ''
    config.value = JSON.stringify(entry?.config ?? {}, null, 2)
    configFields.value = { dirty: false, invalid: false }; sessionEpoch.value += 1
    configMode.value = entry?.configSchema?.type === 'object' ? 'form' : 'json'
    session.value = { baseFingerprint: snapshot.value.fingerprint, ...(entry ? { entry: structuredClone(entry) } : {}), initial: { label: label.value, parentId: parentId.value, groupId: groupId.value, config: config.value } }
    editing.value = true; clearPreview(); error.value = ''; result.value = ''
    void nextTick(() => { const panel = document.querySelector<HTMLElement>('.plugin-editor'); panel?.scrollIntoView({ block: 'nearest' }); panel?.querySelector<HTMLElement>('input, select, textarea')?.focus() })
  }
  const openEditor = (entry?: HostPluginEntry) => {
    if (!writable.value || !allowDiscard()) return
    loadEditor(entry)
  }
  const reloadEditor = () => {
    if (!writable.value || (selected.value && !selectedEntry.value) || !allowDiscard()) return
    const previousOperation = operation.value
    const previousMode = configMode.value
    loadEditor(selectedEntry.value)
    if (previousOperation !== 'setConfig' || (selectedEntry.value?.configEditable && !selectedEntry.value.protected)) operation.value = previousOperation
    if (previousMode === 'json') configMode.value = 'json'
  }
  const prepare = async (next: HostConfigOperation, fingerprint: string) => {
    if (!props.consoleClient || !writable.value || !snapshot.value) return
    controller?.abort(); const pending = controller = new AbortController()
    busy.value = true; error.value = ''; result.value = ''; clearPreview()
    const proposed = { fingerprint, operation: next }
    try {
      const value = await props.consoleClient.query<HostConfigMutationRequest, HostConfigPreview>(workbenchPluginPreviewRef, proposed, pending.signal)
      if (pending.signal.aborted) return
      preview.value = value; request.value = proposed
      void nextTick(() => document.querySelector<HTMLElement>('.plugin-preview')?.scrollIntoView({ block: 'nearest' }))
    } catch (cause) {
      if (!pending.signal.aborted) { error.value = message(cause); refresh() }
    } finally { busy.value = false }
  }
  const prepareQuick = (next: HostConfigOperation) => {
    if (!writable.value || !snapshot.value || !allowDiscard()) return
    const fingerprint = snapshot.value.fingerprint
    closeEditor()
    void prepare(next, fingerprint)
  }
  const prepareForm = () => {
    if (!session.value) return
    blurConfigInput()
    const fingerprint = session.value.baseFingerprint
    error.value = ''
    if (operation.value === 'createGroup') void prepare({ kind: 'createGroup', id: groupId.value.trim(), ...(label.value.trim() ? { label: label.value.trim() } : {}), ...(parentId.value ? { parentId: parentId.value } : {}) }, fingerprint)
    else if (operation.value === 'setLabel') void prepare({ kind: 'setLabel', id: selected.value, label: label.value.trim() }, fingerprint)
    else if (operation.value === 'move') void prepare({ kind: 'move', id: selected.value, ...(parentId.value ? { parentId: parentId.value } : {}) }, fingerprint)
    else {
      if (!configAllowed.value) { error.value = t('workbench.pluginConfig.readonly'); return }
      if (configFields.value.dirty || configFields.value.invalid) { error.value = t('workbench.pluginConfig.correctFields'); return }
      const parsed = parsedConfig.value
      if (!parsed.ok) { error.value = t('workbench.management.invalidJson'); return }
      void prepare({ kind: 'setConfig', id: selected.value, config: parsed.config }, fingerprint)
    }
  }
  const apply = async () => {
    if (!props.consoleClient || !request.value || !preview.value || preview.value.blockedReason || busy.value) return
    if (hasOtherEdits.value && !globalThis.confirm(t('workbench.management.discardOtherEdits'))) return
    const approved = request.value
    controller?.abort(); const pending = controller = new AbortController(); busy.value = true; error.value = ''
    try {
      const value = await props.consoleClient.action<HostConfigMutationRequest, HostConfigMutationResult>(workbenchPluginApplyRef, approved, pending.signal)
      if (pending.signal.aborted) return
      result.value = t(value.saved ? value.runtimeApplied ? 'workbench.management.applied' : 'workbench.management.savedOnly' : 'workbench.management.notSaved')
      if (value.error) error.value = value.error.message
      if (value.saved) closeEditor()
    } catch (cause) {
      if (!pending.signal.aborted) {
        // A failed transport does not establish whether the host committed. Never invert or replay the mutation.
        const conflict = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'CONFIG_CONFLICT'
        result.value = t(conflict ? 'workbench.management.notSaved' : 'workbench.management.uncertain')
        error.value = message(cause)
      }
    } finally {
      clearPreview(); busy.value = false; refresh()
    }
  }
  const visible = computed(() => {
    const entries = snapshot.value?.entries ?? [], byId = new Map(entries.map(entry => [entry.id, entry]))
    return entries.filter(entry => {
      let parent = entry.parentId, depth = 0
      while (parent && depth++ <= entries.length) { const row = byId.get(parent); if (row?.collapsed && !revealed.value.has(row.id)) return false; parent = row?.parentId }
      return true
    })
  })
  return () => <main class="main-workbench core-page plugins-page">
    <header class="core-page-header"><Boxes size={22} /><div><h1>{t('workbench.plugins')}</h1><p>{t('workbench.management.description')}</p></div>
      <Button variant="secondary" disabled={busy.value} onClick={refresh} type="button" aria-label={t('workbench.management.refresh')}><RefreshCw size={16} /></Button>
      <Button variant="secondary" disabled={!writable.value} onClick={() => openEditor()} type="button">{t('workbench.management.createGroup')}</Button>
    </header>
    {returnTarget.value ? <Button type="button" onClick={() => props.navigation?.navigate(...returnTarget.value!)}>{t('workbench.ownership.back')}</Button> : null}
    {query.status === 'ERROR' ? <StatePanel title={t('workbench.management.unavailable')} message={diagnosticText(query)} action={t('workbench.tryAgain')} onAction={refresh} tone="error" /> : null}
    {query.status === 'DISABLED' ? <StatePanel title={t('workbench.runtimePreview')} message={t('workbench.management.unavailable')} /> : null}
    {query.status === 'LOADING' ? <StatePanel message="" busy title={t('workbench.management.loading')} /> : null}
    {snapshot.value ? <>
      {targetId.value && !targetEntry.value ? <p role="status">{t('workbench.ownership.targetMissing', { id: targetId.value })}</p> : null}
      {targetEntry.value ? <p role="status">{t('workbench.ownership.located', { name: targetEntry.value.label || targetEntry.value.id })}</p> : null}
      {!snapshot.value.writable ? <p role="status">{snapshot.value.readOnlyReason ?? t('workbench.management.readOnly')}</p> : null}
      {snapshot.value.restartRequired ? <p role="alert">{t('workbench.management.restartRequired')}</p> : null}
      <div class="management-layout">
        <section class="core-page-section plugin-list" aria-label={t('workbench.management.instances')}>
          {visible.value.map(entry => <article class="plugin-row" key={entry.id} data-parent={!!entry.parentId} data-entry-id={entry.id} data-selected={entry.id === (selected.value || targetId.value)} tabindex={-1}>
            <header><Button class="plugin-entry-name" variant="ghost" disabled={busy.value} type="button" aria-label={t('workbench.pluginConfig.viewDetails', { name: entry.label || entry.id })} onClick={() => showDetails(entry)}><strong>{entry.label || entry.id}</strong></Button>
              <span class="plugin-state" data-state={entry.actualState}>{t(`workbench.management.state.${entry.actualState}`)}</span>
            </header>
            {entry.protected ? <p class="plugin-row-reason">{t('workbench.pluginConfig.managementEntry')}</p>
              : entry.selfEnabled && !entry.effectiveEnabled && entry.parentId ? <p class="plugin-row-reason">{t('workbench.management.parentDisabled')}</p>
                : entry.group ? <p class="plugin-row-reason">{t('workbench.pluginConfig.groupCount', { count: entry.children?.length ?? 0 })}</p>
                  : !entry.configEditable ? <p class="plugin-row-reason">{t('workbench.pluginConfig.configurationReadonly')}</p> : null}
            <div class="plugin-actions">
              <Button variant="secondary" disabled={!writable.value || entry.protected} type="button" onClick={() => prepareQuick({ kind: 'setEnabled', id: entry.id, enabled: !entry.selfEnabled })}>{t(entry.selfEnabled ? 'workbench.disable' : 'workbench.enable')}</Button>
              <Button variant="secondary" disabled={!writable.value} type="button" onClick={() => openEditor(entry)}>{t('workbench.management.edit')}</Button>
              {entry.group ? <>
                <Button variant="secondary" disabled={!writable.value} type="button" onClick={() => prepareQuick({ kind: 'setCollapsed', id: entry.id, collapsed: !entry.collapsed })}>{t(entry.collapsed ? 'workbench.management.expand' : 'workbench.management.collapse')}</Button>
                <Button variant="secondary" disabled={!writable.value || entry.protected || !!entry.children?.length} type="button" onClick={() => prepareQuick({ kind: 'removeGroup', id: entry.id })}>{t('workbench.management.removeGroup')}</Button>
              </> : null}
            </div>
          </article>)}
        </section>
        {editing.value || detailEntry.value ? <div class="plugin-detail">
        {detailEntry.value ? <PluginDetails entry={detailEntry.value} /> : null}
        {editing.value ? <section class="core-page-section plugin-editor" aria-label={t('workbench.management.edit')}>
          <h2>{session.value?.entry?.label || session.value?.entry?.id || t('workbench.management.createGroup')}</h2>
          {stale.value ? <div class="plugin-baseline" role="status">
            <p>{t('workbench.management.changedElsewhere')}</p>
            <details><summary>{t('workbench.management.compareLatest')}</summary>
              {selected.value ? <>
                <p>{t('workbench.management.openedConfiguration')}</p><pre>{JSON.stringify(editableValues(session.value?.entry), null, 2)}</pre>
                <p>{t('workbench.management.latestConfiguration')}</p><pre>{selectedEntry.value ? JSON.stringify(editableValues(selectedEntry.value), null, 2) : t('workbench.management.entryMissing')}</pre>
              </> : <p>{t('workbench.management.groupBaselineChanged')}</p>}
              <p>{t('workbench.management.reloadExplanation')}</p>
              <Button disabled={!writable.value || (!!selected.value && !selectedEntry.value)} type="button" onClick={reloadEditor}>{t('workbench.management.reloadLatest')}</Button>
            </details>
          </div> : null}
          <form onInput={clearPreview} onChange={clearPreview} onSubmit={event => { event.preventDefault(); prepareForm() }}>
            {operation.value !== 'createGroup' ? <label>{t('workbench.management.operation')}<select aria-label={t('workbench.management.operation')} disabled={busy.value} value={operation.value} onChange={event => { operation.value = (event.target as HTMLSelectElement).value as typeof operation.value; preview.value = undefined; request.value = undefined }}>
              <option value="setLabel">{t('workbench.management.rename')}</option><option value="move" disabled={selectedEntry.value?.protected}>{t('workbench.management.move')}</option><option value="setConfig" disabled={!selectedEntry.value?.configEditable || selectedEntry.value?.protected}>{t('workbench.pluginConfig.operation')}</option>
            </select></label> : <label>{t('workbench.management.id')}<input required maxlength={80} disabled={busy.value} value={groupId.value} onInput={event => { groupId.value = (event.target as HTMLInputElement).value }} /></label>}
            {operation.value === 'createGroup' || operation.value === 'setLabel' ? <label>{t('workbench.management.label')}<input disabled={busy.value} maxlength={160} value={label.value} onInput={event => { label.value = (event.target as HTMLInputElement).value }} /></label> : null}
            {operation.value === 'createGroup' || operation.value === 'move' ? <label>{t('workbench.management.parent')}<select aria-label={t('workbench.management.parent')} disabled={busy.value} value={parentId.value} onChange={event => { parentId.value = (event.target as HTMLSelectElement).value }}><option value="">{t('workbench.management.root')}</option>{snapshot.value.entries.filter(entry => entry.group && entry.id !== selected.value).map(entry => <option value={entry.id}>{entry.label || entry.id}</option>)}</select></label> : null}
            {session.value?.entry?.configEditable ? <div class="plugin-configuration" style={{ display: operation.value === 'setConfig' ? undefined : 'none' }}>
              <div class="plugin-config-modes" role="group" aria-label={t('workbench.pluginConfig.mode')}>
                <Button type="button" variant="secondary" aria-pressed={configMode.value === 'form'} disabled={busy.value || session.value.entry.configSchema?.type !== 'object'} onMousedown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => setConfigMode('form')}>{t('workbench.pluginConfig.form')}</Button>
                <Button type="button" variant="secondary" aria-pressed={configMode.value === 'json'} disabled={busy.value} onMousedown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => setConfigMode('json')}>{t('workbench.pluginConfig.advancedJson')}</Button>
              </div>
              <p class="plugin-config-help">{t('workbench.pluginConfig.preservesValues')}</p>
              {session.value.entry.configSchema?.type !== 'object' ? <p role="status">{t('workbench.pluginConfig.rootFallback')}</p> : null}
              {session.value.entry.configSchema ? <div style={{ display: configMode.value === 'form' ? undefined : 'none' }}>
                <PluginConfigurationForm key={sessionEpoch.value} schema={session.value.entry.configSchema} value={formValue.value} disabled={busy.value || !configAllowed.value} sessionKey={String(sessionEpoch.value)}
                  onChange={value => { config.value = JSON.stringify(value, null, 2); clearPreview() }}
                  onDraftStateChange={state => { configFields.value = state; if (state.dirty || state.invalid) clearPreview() }} />
              </div> : null}
              <label style={{ display: configMode.value === 'json' ? undefined : 'none' }}>{t('workbench.management.config')}<textarea rows={12} disabled={busy.value || !configAllowed.value} spellcheck={false} value={config.value} onInput={event => { config.value = (event.target as HTMLTextAreaElement).value }} /></label>
            </div> : null}
            <div class="plugin-actions"><Button variant="primary" disabled={!writable.value || operation.value === 'setConfig' && !configAllowed.value} onMousedown={event => { if (event.button === 0) event.preventDefault() }} type="submit">{t('workbench.management.preview')}</Button><Button disabled={busy.value} type="button" onClick={() => { if (allowDiscard()) closeEditor() }}>{t('workbench.cancel')}</Button></div>
          </form>
        </section> : null}
        </div> : null}
      </div>
    </> : null}
    {preview.value ? <section class="core-page-section plugin-preview" aria-label={t('workbench.management.preview')}>
      <h2>{t('workbench.management.preview')}</h2><p>{t('workbench.management.affected')}: {preview.value.affectedEntryIds.join(', ')}</p>
      <pre>{JSON.stringify(preview.value.operation, null, 2)}</pre>
      <PluginImpactPreview impact={preview.value.impact} {...(props.navigation ? { navigation: props.navigation } : {})} />
      <div class="plugin-actions"><Button disabled={busy.value || !!preview.value.blockedReason} variant="primary" type="button" onClick={apply}>{t('workbench.management.apply')}</Button><Button disabled={busy.value} type="button" onClick={() => { preview.value = undefined; request.value = undefined }}>{t('workbench.cancel')}</Button><Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections)}>{t('workbench.connections')}</Button></div>
      {preview.value.blockedReason ? <p role="alert">{preview.value.blockedReason}</p> : null}
    </section> : null}
    {busy.value ? <p role="status">{t('workbench.management.working')}</p> : null}
    {result.value ? <p role="status">{result.value}</p> : null}
    {error.value ? <p role="alert">{error.value}</p> : null}
  </main>
})

function message(error: unknown): string {
  return error instanceof Error ? error.message : t('workbench.management.failed')
}

function editableValues(entry?: HostPluginEntry) {
  return { label: entry?.label ?? '', parentId: entry?.parentId ?? '', config: entry?.config ?? {} }
}
