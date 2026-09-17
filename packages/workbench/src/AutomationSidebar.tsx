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
  createError?: string
  creating?: boolean
  state?: ConsoleQueryState<WorkbenchAutomationsIndex>
}

interface AutomationSidebarItem {
  id: string
  label: string
  icon: typeof Network
  meta?: string
  enabled?: boolean
  published?: boolean
}

export const AutomationSidebar = defineSetupComponent<AutomationSidebarProps>('AutomationSidebar', [
  'activeId', 'onChange', 'onOpen', 'onCreate', 'onCreateDismiss', 'onReload', 'createError', 'creating', 'state',
], props => {
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
          meta: `Draft v${item.draftVersion} · ${item.revisionCount} revision${item.revisionCount === 1 ? '' : 's'}`,
          enabled: item.enabled,
          published: item.revisionCount > 0,
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
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (menuAutomationId.value && !(event.target as Element).closest('.automation-row-actions')) menuAutomationId.value = undefined
  }
  onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
  onScopeDispose(() => document.removeEventListener('pointerdown', onDocumentPointerDown))
  watch(() => props.activeId, () => { menuAutomationId.value = undefined })
  return () => {
  const preview = !props.state || props.state.status === 'DISABLED'
  return (
    <aside class="primary-sidebar" aria-label="Automations">
      <div class="sidebar-heading">
        <span>AUTOMATIONS</span>
        <div class="sidebar-actions">
          <button
            aria-expanded={createOpen.value}
            aria-label="Create automation"
            class="icon-button"
            disabled={!props.onCreate || props.creating}
            onClick={() => { createOpen.value = !createOpen.value; props.onCreateDismiss?.() }}
            type="button"
          ><Plus size={16} /></button>
          <button
            aria-expanded={filterOpen.value}
            aria-label="Filter automations"
            class="icon-button"
            data-active={filterOpen.value || filtersActive.value}
            onClick={() => { filterOpen.value = !filterOpen.value }}
            type="button"
          ><Filter size={15} /></button>
        </div>
      </div>
      {createOpen.value ? <form class="automation-create-form" onSubmit={event => { event.preventDefault(); void submit() }}>
        <label for="automation-create-name">Automation name</label>
        <input
          id="automation-create-name"
          maxlength="200"
          onInput={event => { name.value = (event.target as HTMLInputElement).value }}
          placeholder="Morning heartbeat"
          ref={nameInput}
          value={name.value}
        />
        {props.createError ? <p role="alert">{props.createError}</p> : null}
        <div>
          <button disabled={!name.value.trim() || props.creating} type="submit">{props.creating ? 'Creating…' : 'Create'}</button>
          <button disabled={props.creating} onClick={closeCreate} type="button">Cancel</button>
        </div>
      </form> : null}
      {filterOpen.value ? <section class="automation-filter-panel" aria-label="Automation filters">
        <label><span>Search</span><input
          aria-label="Search automations"
          onInput={event => { filterQuery.value = (event.target as HTMLInputElement).value }}
          placeholder="Name or ID"
          value={filterQuery.value}
        /></label>
        <label><span>Status</span><SelectMenu
          ariaLabel="Automation status"
          options={[
            { value: 'all', label: 'All automations' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'disabled', label: 'Disabled' },
            { value: 'published', label: 'Published' },
            { value: 'draft', label: 'Draft only' },
          ]}
          value={filterStatus.value}
          onChange={value => { filterStatus.value = value }}
        /></label>
        <footer><span>{items.value.length} shown</span><button
          disabled={!filtersActive.value}
          onClick={() => { filterQuery.value = ''; filterStatus.value = 'all' }}
          type="button"
        >Clear</button></footer>
      </section> : null}
      <div class="automation-list">
        {props.state?.status === 'LOADING' ? <p class="automation-sidebar-state" role="status">Loading automations…</p> : null}
        {props.state?.status === 'ERROR' ? (
          <div class="automation-sidebar-state" role="alert">
            <strong>Automations unavailable</strong>
            <span>{props.state.message}</span>
            <button {...(props.onReload ? { onClick: props.onReload } : {})} type="button">Try again</button>
          </div>
        ) : null}
        {props.state?.status === 'READY' && !props.state.data.items.length ? (
          <p class="automation-sidebar-state">No automations yet.</p>
        ) : null}
        {(preview || props.state?.status === 'READY') && !items.value.length && filtersActive.value ? <p class="automation-sidebar-state">No automations match these filters.</p> : null}
        {(preview || props.state?.status === 'READY') ? items.value.map(item => {
          const Icon = item.icon
          const menuOpen = menuAutomationId.value === item.id
          return <div class={['automation-row', item.meta ? 'automation-row-live' : '']} data-active={props.activeId === item.id} key={item.id}>
            <button class="automation-select" onClick={() => props.onChange(item.id)} type="button">
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              {item.meta ? <span><strong>{item.label}</strong><small>{item.meta}</small></span> : <span>{item.label}</span>}
            </button>
            <div class="automation-row-actions">
              <button
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`More actions for ${item.label}`}
                class="row-menu"
                data-active={menuOpen}
                onClick={() => { menuAutomationId.value = menuOpen ? undefined : item.id }}
                type="button"
              ><MoreVertical size={16} /></button>
              {menuOpen ? <div aria-label={`Actions for ${item.label}`} class="automation-row-menu" role="menu">
                <button onClick={() => openAutomation(item.id, 'Editor')} role="menuitem" type="button">Open editor</button>
                <button onClick={() => openAutomation(item.id, 'Runs')} role="menuitem" type="button">View runs</button>
              </div> : null}
            </div>
          </div>
        }) : null}
      </div>
      <button class="collapse-sidebar" type="button" aria-label="Collapse sidebar">‹‹</button>
    </aside>
  )
  }
})
