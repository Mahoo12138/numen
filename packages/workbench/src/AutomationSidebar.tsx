import { Filter, MoreVertical, Network, Plus } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import type { WorkbenchAutomationsIndex } from './contracts.js'
import { automations } from './model.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export interface AutomationSidebarProps {
  activeId?: string
  onChange(id: string): void
  onCreate?(name: string): Promise<boolean>
  onCreateDismiss?(): void
  onReload?(): void
  createError?: string
  creating?: boolean
  state?: ConsoleQueryState<WorkbenchAutomationsIndex>
}

export const AutomationSidebar = defineSetupComponent<AutomationSidebarProps>('AutomationSidebar', [
  'activeId', 'onChange', 'onCreate', 'onCreateDismiss', 'onReload', 'createError', 'creating', 'state',
], props => {
  const createOpen = ref(false)
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
          <button aria-label="Filter automations" class="icon-button" type="button"><Filter size={15} /></button>
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
      <div class="automation-list">
        {preview ? automations.map(({ id, label, icon: Icon }) => (
          <div class="automation-row" data-active={props.activeId === id} key={id}>
            <button class="automation-select" onClick={() => props.onChange(id)} type="button">
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
            <button aria-label={`More actions for ${label}`} class="row-menu" type="button">
              <MoreVertical size={16} />
            </button>
          </div>
        )) : null}
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
        {props.state?.status === 'READY' ? props.state.data.items.map(item => (
          <div class="automation-row automation-row-live" data-active={props.activeId === item.id} key={item.id}>
            <button class="automation-select" onClick={() => props.onChange(item.id)} type="button">
              <Network aria-hidden="true" size={17} strokeWidth={1.7} />
              <span>
                <strong>{item.name}</strong>
                <small>Draft v{item.draftVersion} · {item.revisionCount} revision{item.revisionCount === 1 ? '' : 's'}</small>
              </span>
            </button>
            <button aria-label={`More actions for ${item.name}`} class="row-menu" type="button">
              <MoreVertical size={16} />
            </button>
          </div>
        )) : null}
      </div>
      <button class="collapse-sidebar" type="button" aria-label="Collapse sidebar">‹‹</button>
    </aside>
  )
  }
})
