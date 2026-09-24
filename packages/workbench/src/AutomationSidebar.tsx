import { Button, Input } from '@numenjs/components'
import { diagnosticText, useWorkbenchI18n } from './i18n.js'
import { Filter, MoreVertical, Network, Plus } from '@lucide/vue'
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import type { WorkbenchAutomationsIndex } from './contracts.js'
import { automations } from './model.js'
import { SelectMenu } from './SelectMenu.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export interface AutomationSidebarProps {
  activeId?: string
  onChange(id: string): void
  onOpen?(id: string, tab: 'Editor' | 'Runs'): void
  onCreate?(name: string): Promise<boolean>
  onCreateDismiss?(): void
  onReload?(): void
  onArchiveViewChange?(archived: boolean): void
  onArchive?(id: string, expectedActivationGeneration: number): Promise<boolean>
  onRestore?(id: string, expectedActivationGeneration: number): Promise<boolean>
  onRemoveArchived?(id: string, expectedArchivedAt: string): Promise<boolean>
  createError?: string
  creating?: boolean
  mutationPending?: boolean
  mutationError?: string
  state?: ConsoleQueryState<WorkbenchAutomationsIndex>
}

interface AutomationSidebarItem {
  id: string
  label: string
  icon: typeof Network
  activationGeneration?: number
  meta?: string
  enabled?: boolean
  published?: boolean
  archived?: boolean
  archivedAt?: string
  activeRunCount?: number
  runCount?: number
}

export const AutomationSidebar = defineSetupComponent<AutomationSidebarProps>('AutomationSidebar', [
  'activeId', 'onChange', 'onOpen', 'onCreate', 'onCreateDismiss', 'onReload', 'createError', 'creating', 'state',
  'onArchiveViewChange', 'onArchive', 'onRestore', 'onRemoveArchived', 'mutationPending', 'mutationError',
], props => {
  const { t } = useWorkbenchI18n()
  const createOpen = ref(false)
  const filterOpen = ref(false)
  const filterQuery = ref('')
  const filterStatus = ref('all')
  const menuAutomationId = ref<string>()
  const name = ref('')
  const nameInput = ref<HTMLInputElement>()
  watch(createOpen, async open => {
    if (!open) return
    await nextTick()
    nameInput.value?.focus()
  })
  const closeCreate = () => {
    if (props.creating) return
    createOpen.value = false
    name.value = ''
    props.onCreateDismiss?.()
  }
  const submit = async () => {
    const normalized = name.value.trim()
    if (!normalized || !props.onCreate || props.creating) return
    if (await props.onCreate(normalized)) {
      createOpen.value = false
      name.value = ''
      filterStatus.value = 'all'
      props.onArchiveViewChange?.(false)
    }
  }
  const items = computed<AutomationSidebarItem[]>(() => {
    const source: AutomationSidebarItem[] = !props.state || props.state.status === 'DISABLED'
      ? automations.map(({ id, label, icon }) => ({ id, label, icon }))
      : props.state.status === 'READY'
        ? props.state.data.items.map(item => ({
          id: item.id,
          label: item.name,
          icon: Network,
          activationGeneration: item.activationGeneration,
          meta: t(`workbench.projection.draft.${item.revisionCount === 1 ? 'one' : 'other'}`, { version: item.draftVersion, count: item.revisionCount }),
          enabled: item.enabled,
          published: item.revisionCount > 0,
          archived: !!item.archivedAt,
          archivedAt: item.archivedAt,
          activeRunCount: item.activeRunCount,
          runCount: item.runCount,
        }))
        : []
    const query = filterQuery.value.trim().toLocaleLowerCase()
    return source.filter(item => {
      if (query && !`${item.label} ${item.id}`.toLocaleLowerCase().includes(query)) return false
      if (filterStatus.value === 'enabled') return item.enabled === true
      if (filterStatus.value === 'disabled') return item.enabled === false
      if (filterStatus.value === 'published') return item.published === true
      if (filterStatus.value === 'draft') return item.published === false
      return true
    })
  })
  const filtersActive = computed(() => !!filterQuery.value.trim() || filterStatus.value !== 'all')
  const openAutomation = (id: string, tab: 'Editor' | 'Runs') => {
    menuAutomationId.value = undefined
    if (props.onOpen) props.onOpen(id, tab)
    else props.onChange(id)
  }
  const archive = async (item: AutomationSidebarItem) => {
    if (!props.onArchive || !window.confirm(t('workbench.archiveAutomationConfirm', { value0: item.label }))) return
    if (await props.onArchive(item.id, item.activationGeneration ?? 0)) { filterStatus.value = 'archived'; menuAutomationId.value = undefined }
  }
  const restore = async (item: AutomationSidebarItem) => {
    if (props.onRestore && await props.onRestore(item.id, item.activationGeneration ?? 0)) { filterStatus.value = 'all'; menuAutomationId.value = undefined }
  }
  const removeArchived = async (item: AutomationSidebarItem) => {
    if (!item.archivedAt || !props.onRemoveArchived || props.mutationPending || item.activeRunCount) return
    if (!window.confirm(t('workbench.permanentlyRemoveAutomationConfirm', { value0: item.label, count: item.runCount ?? 0 }))) return
    if (await props.onRemoveArchived(item.id, item.archivedAt)) menuAutomationId.value = undefined
  }
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (menuAutomationId.value && !(event.target as Element).closest('.automation-row-actions')) menuAutomationId.value = undefined
  }
  onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
  onScopeDispose(() => document.removeEventListener('pointerdown', onDocumentPointerDown))
  watch(() => props.activeId, () => { menuAutomationId.value = undefined })
  return () => {
  const preview = !props.state || props.state.status === 'DISABLED'
  return (
    <aside class="primary-sidebar" aria-label={t('workbench.automations2')}>
      <div class="sidebar-heading">
        <span>{t('workbench.automations3')}</span>
        <div class="sidebar-actions">
          <Button variant="ghost" size="icon"
            aria-expanded={createOpen.value}
            aria-label={t('workbench.createAutomation')}
            class="icon-button"
            disabled={!props.onCreate || props.creating}
            onClick={() => { createOpen.value = !createOpen.value; props.onCreateDismiss?.() }}
            type="button"
          ><Plus size={16} /></Button>
          <Button variant="ghost" size="icon"
            aria-expanded={filterOpen.value}
            aria-label={t('workbench.filterAutomations')}
            class="icon-button"
            data-active={filterOpen.value || filtersActive.value}
            onClick={() => { filterOpen.value = !filterOpen.value }}
            type="button"
          ><Filter size={15} /></Button>
        </div>
      </div>
      {createOpen.value ? <form class="automation-create-form" onSubmit={event => { event.preventDefault(); void submit() }}>
        <label for="automation-create-name">{t('workbench.automationName')}</label>
        <Input
          id="automation-create-name"
          maxlength="200"
          onInput={event => { name.value = (event.target as HTMLInputElement).value }}
          placeholder={t('workbench.morningHeartbeat')}
          inputRef={nameInput}
          value={name.value}
        />
        {props.createError ? <p role="alert">{props.createError}</p> : null}
        <div>
          <Button disabled={!name.value.trim() || props.creating} type="submit">{props.creating ? t('workbench.creating') : t('workbench.create')}</Button>
          <Button disabled={props.creating} onClick={closeCreate} type="button">{t('workbench.cancel')}</Button>
        </div>
      </form> : null}
      {filterOpen.value ? <section class="automation-filter-panel" aria-label={t('workbench.automationFilters')}>
        <label><span>{t('workbench.search')}</span><Input
          aria-label={t('workbench.searchAutomations')}
          onInput={event => { filterQuery.value = (event.target as HTMLInputElement).value }}
          placeholder={t('workbench.nameOrId')}
          value={filterQuery.value}
        /></label>
        <label><span>{t('workbench.status')}</span><SelectMenu
          ariaLabel={t('workbench.automationStatus')}
          options={[
            { value: 'all', label: t('workbench.allAutomations') },
            { value: 'enabled', label: t('workbench.enabled') },
            { value: 'disabled', label: t('workbench.disabled') },
            { value: 'published', label: t('workbench.published') },
            { value: 'draft', label: t('workbench.draftOnly') },
            { value: 'archived', label: t('workbench.archived') },
          ]}
          value={filterStatus.value}
          onChange={value => { filterStatus.value = value; props.onArchiveViewChange?.(value === 'archived') }}
        /></label>
        <footer><span>{items.value.length}{t('workbench.shown')}</span><Button
          disabled={!filtersActive.value}
          onClick={() => { filterQuery.value = ''; filterStatus.value = 'all'; props.onArchiveViewChange?.(false) }}
          type="button"
        >{t('workbench.clear')}</Button></footer>
      </section> : null}
      {props.mutationError ? <p class="automation-sidebar-state" role="alert">{props.mutationError}</p> : null}
      <div class="automation-list">
        {props.state?.status === 'LOADING' ? <p class="automation-sidebar-state" role="status">{t('workbench.loadingAutomations')}</p> : null}
        {props.state?.status === 'ERROR' ? (
          <div class="automation-sidebar-state" role="alert">
            <strong>{t('workbench.automationsUnavailable')}</strong>
            <span>{diagnosticText(props.state)}</span>
            <Button {...(props.onReload ? { onClick: props.onReload } : {})} type="button">{t('workbench.tryAgain')}</Button>
          </div>
        ) : null}
        {props.state?.status === 'READY' && !items.value.length && !filtersActive.value ? (
          <p class="automation-sidebar-state">{t('workbench.noAutomationsYet2')}</p>
        ) : null}
        {props.state?.status === 'READY' && !items.value.length && filterStatus.value === 'archived' && !filterQuery.value.trim() ? (
          <p class="automation-sidebar-state">{t('workbench.noArchivedAutomations')}</p>
        ) : null}
        {(preview || props.state?.status === 'READY') && !items.value.length && filtersActive.value && !(filterStatus.value === 'archived' && !filterQuery.value.trim()) ? <p class="automation-sidebar-state">{t('workbench.noAutomationsMatchTheseFilters')}</p> : null}
        {(preview || props.state?.status === 'READY') ? items.value.map(item => {
          const Icon = item.icon
          const menuOpen = menuAutomationId.value === item.id
          return <div class={['automation-row', item.meta ? 'automation-row-live' : '']} data-active={props.activeId === item.id} key={item.id}>
            <button class="automation-select" onClick={() => item.archived ? openAutomation(item.id, 'Runs') : props.onChange(item.id)} type="button">
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              {item.meta ? <span><strong>{item.label}</strong><small>{item.archived ? t('workbench.archived') : item.meta}</small></span> : <span>{item.label}</span>}
            </button>
            <div class="automation-row-actions">
              <Button variant="ghost" size="icon"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={t('workbench.moreActionsForValue0', { value0: item.label })}
                class="row-menu"
                data-active={menuOpen}
                onClick={() => { menuAutomationId.value = menuOpen ? undefined : item.id }}
                type="button"
              ><MoreVertical size={16} /></Button>
              {menuOpen ? <div aria-label={t('workbench.actionsForValue0', { value0: item.label })} class="automation-row-menu" role="menu">
                <button onClick={() => openAutomation(item.id, 'Runs')} role="menuitem" type="button">{t('workbench.viewRuns')}</button>
                {item.archived ? <>
                  <button disabled={props.mutationPending} onClick={() => void restore(item)} role="menuitem" type="button">{t('workbench.restoreAutomation')}</button>
                  <button disabled={props.mutationPending || !!item.activeRunCount} onClick={() => void removeArchived(item)} role="menuitem" type="button">{t('workbench.permanentlyRemoveAutomation')}</button>
                  {item.activeRunCount ? <small role="status">{t('workbench.activeRunsPreventPermanentRemoval', { count: item.activeRunCount })}</small> : null}
                </> : <>
                  <button onClick={() => openAutomation(item.id, 'Editor')} role="menuitem" type="button">{t('workbench.openEditor')}</button>
                  <button disabled={props.mutationPending} onClick={() => void archive(item)} role="menuitem" type="button">{t('workbench.archiveAutomation')}</button>
                </>}
              </div> : null}
            </div>
          </div>
        }) : null}
      </div>
      <button class="collapse-sidebar" type="button" aria-label={t('workbench.collapseSidebar')}>‹‹</button>
    </aside>
  )
  }
})
