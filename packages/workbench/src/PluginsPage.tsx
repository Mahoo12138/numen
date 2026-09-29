import { Button, StatePanel } from '@numenjs/components'
import type { HostConfigMutationRequest, HostConfigMutationResult, HostConfigOperation, HostConfigPreview, HostConfigSnapshot, HostPluginEntry } from '@numenjs/config'
import { Boxes, RefreshCw } from '@lucide/vue'
import { computed, nextTick, onScopeDispose, ref } from 'vue'
import { diagnosticText, t } from './i18n.js'
import { workbenchPluginApplyRef, workbenchPluginPreviewRef, workbenchPluginsQueryRef } from './management-contracts.js'
import { coreWorkbenchRoutes } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export const PluginsPage = defineSetupComponent<WorkbenchPageProps>('PluginsPage', ['consoleClient', 'navigation'], props => {
  const [query, reload, refresh] = useConsoleQuery<Record<string, never>, HostConfigSnapshot>(() => props.consoleClient, workbenchPluginsQueryRef, {})
  const selected = ref(''), operation = ref<'setConfig' | 'setLabel' | 'move' | 'createGroup'>('setConfig')
  const label = ref(''), groupId = ref(''), parentId = ref(''), config = ref('')
  const editing = ref(false), busy = ref(false), error = ref(''), result = ref('')
  const preview = ref<HostConfigPreview>(), request = ref<HostConfigMutationRequest>()
  const snapshot = computed(() => query.status === 'READY' ? query.data : undefined)
  const selectedEntry = computed(() => snapshot.value?.entries.find(entry => entry.id === selected.value))
  let controller: AbortController | undefined
  onScopeDispose(() => controller?.abort())
  const writable = computed(() => !!snapshot.value?.writable && !snapshot.value.restartRequired && !busy.value)
  const openEditor = (entry?: HostPluginEntry) => {
    if (busy.value) return
    selected.value = entry?.id ?? ''; operation.value = entry ? 'setLabel' : 'createGroup'
    label.value = entry?.label ?? ''; parentId.value = entry?.parentId ?? ''; groupId.value = ''
    config.value = JSON.stringify(entry?.config ?? {}, null, 2)
    editing.value = true; preview.value = undefined; request.value = undefined; error.value = ''; result.value = ''
    void nextTick(() => { const panel = document.querySelector<HTMLElement>('.plugin-editor'); panel?.scrollIntoView({ block: 'nearest' }); panel?.querySelector<HTMLElement>('input, select, textarea')?.focus() })
  }
  const prepare = async (next: HostConfigOperation) => {
    if (!props.consoleClient || !writable.value || !snapshot.value) return
    controller?.abort(); controller = new AbortController()
    busy.value = true; error.value = ''; result.value = ''; preview.value = undefined; request.value = undefined
    const proposed = { fingerprint: snapshot.value.fingerprint, operation: next }
    try {
      const value = await props.consoleClient.query<HostConfigMutationRequest, HostConfigPreview>(workbenchPluginPreviewRef, proposed, controller.signal)
      if (controller.signal.aborted) return
      preview.value = value; request.value = proposed
      void nextTick(() => document.querySelector<HTMLElement>('.plugin-preview')?.scrollIntoView({ block: 'nearest' }))
    } catch (cause) {
      if (!controller.signal.aborted) { error.value = message(cause); refresh() }
    } finally { busy.value = false }
  }
  const prepareForm = () => {
    error.value = ''
    if (operation.value === 'createGroup') void prepare({ kind: 'createGroup', id: groupId.value.trim(), ...(label.value.trim() ? { label: label.value.trim() } : {}), ...(parentId.value ? { parentId: parentId.value } : {}) })
    else if (operation.value === 'setLabel') void prepare({ kind: 'setLabel', id: selected.value, label: label.value.trim() })
    else if (operation.value === 'move') void prepare({ kind: 'move', id: selected.value, ...(parentId.value ? { parentId: parentId.value } : {}) })
    else {
      try {
        const value: unknown = JSON.parse(config.value)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        void prepare({ kind: 'setConfig', id: selected.value, config: value as Record<string, unknown> })
      } catch { error.value = t('workbench.management.invalidJson') }
    }
  }
  const apply = async () => {
    if (!props.consoleClient || !request.value || !preview.value || preview.value.blockedReason || busy.value) return
    const approved = request.value
    controller?.abort(); controller = new AbortController(); busy.value = true; error.value = ''
    try {
      const value = await props.consoleClient.action<HostConfigMutationRequest, HostConfigMutationResult>(workbenchPluginApplyRef, approved, controller.signal)
      if (controller.signal.aborted) return
      result.value = t(value.saved ? value.runtimeApplied ? 'workbench.management.applied' : 'workbench.management.savedOnly' : 'workbench.management.notSaved')
      if (value.error) error.value = value.error.message
      if (value.saved) editing.value = false
    } catch (cause) {
      if (!controller.signal.aborted) {
        // A failed transport does not establish whether the host committed. Never invert or replay the mutation.
        const conflict = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'CONFIG_CONFLICT'
        result.value = t(conflict ? 'workbench.management.notSaved' : 'workbench.management.uncertain')
        error.value = message(cause)
      }
    } finally {
      preview.value = undefined; request.value = undefined; busy.value = false; refresh()
    }
  }
  const visible = computed(() => {
    const entries = snapshot.value?.entries ?? [], byId = new Map(entries.map(entry => [entry.id, entry]))
    return entries.filter(entry => {
      let parent = entry.parentId, depth = 0
      while (parent && depth++ <= entries.length) { const row = byId.get(parent); if (row?.collapsed) return false; parent = row?.parentId }
      return true
    })
  })
  return () => <main class="main-workbench core-page plugins-page">
    <header class="core-page-header"><Boxes size={22} /><div><h1>{t('workbench.plugins')}</h1><p>{t('workbench.management.description')}</p></div>
      <Button variant="secondary" disabled={busy.value} onClick={reload} type="button" aria-label={t('workbench.management.refresh')}><RefreshCw size={16} /></Button>
      <Button variant="secondary" disabled={!writable.value} onClick={() => openEditor()} type="button">{t('workbench.management.createGroup')}</Button>
    </header>
    {query.status === 'ERROR' ? <StatePanel title={t('workbench.management.unavailable')} message={diagnosticText(query)} action={t('workbench.tryAgain')} onAction={reload} tone="error" /> : null}
    {query.status === 'DISABLED' ? <StatePanel title={t('workbench.runtimePreview')} message={t('workbench.management.unavailable')} /> : null}
    {query.status === 'LOADING' ? <StatePanel message="" busy title={t('workbench.management.loading')} /> : null}
    {snapshot.value ? <>
      {!snapshot.value.writable ? <p role="status">{snapshot.value.readOnlyReason ?? t('workbench.management.readOnly')}</p> : null}
      {snapshot.value.restartRequired ? <p role="alert">{t('workbench.management.restartRequired')}</p> : null}
      <div class="management-layout">
        <section class="core-page-section plugin-list" aria-label={t('workbench.management.instances')}>
          {visible.value.map(entry => <article class="plugin-row" key={entry.id} data-parent={!!entry.parentId} data-entry-id={entry.id}>
            <header><div><strong>{entry.label || entry.id}</strong><small>{entry.parentId ? `${entry.parentId} / ` : ''}{entry.id}</small></div>
              <span class="plugin-state" data-state={entry.actualState}>{t(`workbench.management.state.${entry.actualState}`)}</span>
            </header>
            <p class="plugin-package">{entry.group ? t('workbench.management.group') : `${entry.packageName} · ${entry.packageVersion ?? t('workbench.management.versionUnknown')}`}</p>
            {!entry.group ? <small>{t('workbench.management.source')}: {entry.name} · {t(entry.installed === true ? 'workbench.management.installed' : entry.installed === false ? 'workbench.management.notInstalled' : 'workbench.management.installUnknown')}</small> : null}
            <p>{t(entry.selfEnabled ? 'workbench.management.desiredOn' : 'workbench.management.desiredOff')} · {t(entry.effectiveEnabled ? 'workbench.management.effectiveOn' : entry.selfEnabled && entry.parentId ? 'workbench.management.parentDisabled' : 'workbench.management.effectiveOff')}</p>
            {entry.protected ? <p class="plugin-protected">{t('workbench.management.protected')}</p> : null}
            <div class="plugin-actions">
              <Button variant="secondary" disabled={!writable.value || entry.protected} type="button" onClick={() => prepare({ kind: 'setEnabled', id: entry.id, enabled: !entry.selfEnabled })}>{t(entry.selfEnabled ? 'workbench.disable' : 'workbench.enable')}</Button>
              <Button variant="secondary" disabled={!writable.value} type="button" onClick={() => openEditor(entry)}>{t('workbench.management.edit')}</Button>
              {entry.group ? <>
                <Button variant="secondary" disabled={!writable.value} type="button" onClick={() => prepare({ kind: 'setCollapsed', id: entry.id, collapsed: !entry.collapsed })}>{t(entry.collapsed ? 'workbench.management.expand' : 'workbench.management.collapse')}</Button>
                <Button variant="secondary" disabled={!writable.value || entry.protected || !!entry.children?.length} type="button" onClick={() => prepare({ kind: 'removeGroup', id: entry.id })}>{t('workbench.management.removeGroup')}</Button>
              </> : null}
            </div>
            {entry.internal.length ? <details><summary>{t('workbench.management.internal', { count: entry.internal.length })}</summary><ul>{entry.internal.map(child => <li key={child.diagnosticId}><strong>{child.name}</strong> · {t(`workbench.management.state.${child.state}`)}<small>{child.dependencies.join(', ')}</small></li>)}</ul></details> : null}
          </article>)}
        </section>
        {editing.value ? <section class="core-page-section plugin-editor" aria-label={t('workbench.management.edit')}>
          <h2>{selectedEntry.value?.label || selectedEntry.value?.id || t('workbench.management.createGroup')}</h2>
          <form onInput={() => { preview.value = undefined; request.value = undefined }} onChange={() => { preview.value = undefined; request.value = undefined }} onSubmit={event => { event.preventDefault(); prepareForm() }}>
            {operation.value !== 'createGroup' ? <label>{t('workbench.management.operation')}<select aria-label={t('workbench.management.operation')} disabled={busy.value} value={operation.value} onChange={event => { operation.value = (event.target as HTMLSelectElement).value as typeof operation.value; preview.value = undefined; request.value = undefined }}>
              <option value="setLabel">{t('workbench.management.rename')}</option><option value="move" disabled={selectedEntry.value?.protected}>{t('workbench.management.move')}</option><option value="setConfig" disabled={!selectedEntry.value?.configEditable || selectedEntry.value?.protected}>{t('workbench.management.config')}</option>
            </select></label> : <label>{t('workbench.management.id')}<input required maxlength={80} disabled={busy.value} value={groupId.value} onInput={event => { groupId.value = (event.target as HTMLInputElement).value }} /></label>}
            {operation.value === 'createGroup' || operation.value === 'setLabel' ? <label>{t('workbench.management.label')}<input disabled={busy.value} maxlength={160} value={label.value} onInput={event => { label.value = (event.target as HTMLInputElement).value }} /></label> : null}
            {operation.value === 'createGroup' || operation.value === 'move' ? <label>{t('workbench.management.parent')}<select aria-label={t('workbench.management.parent')} disabled={busy.value} value={parentId.value} onChange={event => { parentId.value = (event.target as HTMLSelectElement).value }}><option value="">{t('workbench.management.root')}</option>{snapshot.value.entries.filter(entry => entry.group && entry.id !== selected.value).map(entry => <option value={entry.id}>{entry.label || entry.id}</option>)}</select></label> : null}
            {operation.value === 'setConfig' ? <label>{t('workbench.management.config')}<textarea rows={12} disabled={busy.value} spellcheck={false} value={config.value} onInput={event => { config.value = (event.target as HTMLTextAreaElement).value }} /></label> : null}
            {selectedEntry.value?.configReadOnlyReason ? <p>{selectedEntry.value.configReadOnlyReason}</p> : null}
            <div class="plugin-actions"><Button variant="primary" disabled={!writable.value} type="submit">{t('workbench.management.preview')}</Button><Button disabled={busy.value} type="button" onClick={() => { editing.value = false; preview.value = undefined; request.value = undefined }}>{t('workbench.cancel')}</Button></div>
          </form>
        </section> : null}
      </div>
    </> : null}
    {preview.value ? <section class="core-page-section plugin-preview" aria-label={t('workbench.management.preview')}>
      <h2>{t('workbench.management.preview')}</h2><p>{t('workbench.management.affected')}: {preview.value.affectedEntryIds.join(', ')}</p>
      <pre>{JSON.stringify(preview.value.operation, null, 2)}</pre>
      <p>{t('workbench.management.impactUnknown')}</p>
      {(['connections', 'capabilities', 'triggers', 'automations'] as const).map(kind => preview.value!.impact[kind].length ? <p><strong>{t(kind === 'automations' ? 'workbench.pages.automations' : `workbench.${kind}`)}</strong>: {preview.value!.impact[kind].join(', ')}</p> : null)}
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
