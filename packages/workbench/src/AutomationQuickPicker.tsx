import {
  Braces,
  Clock3,
  GitBranch,
  Layers3,
  ListTree,
  Plus,
  Search,
  Shuffle,
  Sparkles,
  X,
} from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type {
  WorkbenchAutomationControlKind,
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationInsertItem,
} from './contracts.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

const controlIcons = {
  wait: Clock3,
  if: GitBranch,
  parallel: Layers3,
  race: Shuffle,
  foreach: ListTree,
} satisfies Record<WorkbenchAutomationControlKind, typeof Clock3>

function searchableText(item: WorkbenchAutomationInsertItem): string {
  if (item.kind === 'control') return `${item.title} ${item.description} ${item.control}`.toLowerCase()
  return [
    item.title,
    item.description,
    item.capability.id,
    item.capability.version,
    item.capabilityKind,
    ...item.connectionSlots,
  ].filter(Boolean).join(' ').toLowerCase()
}

function PickerItem({ item, onInsert }: {
  item: WorkbenchAutomationInsertItem
  onInsert(item: WorkbenchAutomationInsertItem): void
}) {
  const Icon = item.kind === 'control' ? controlIcons[item.control] : Sparkles
  const ref = item.kind === 'capability' ? `${item.capability.id}@${item.capability.version}` : item.control
  return (
    <button class="quick-picker-item" onClick={() => onInsert(item)} role="option" type="button">
      <span class="quick-picker-item-icon" data-kind={item.kind}><Icon size={16} /></span>
      <span class="quick-picker-item-copy">
        <span><strong>{item.title}</strong><em>{item.kind === 'control' ? 'Control' : item.capabilityKind}</em></span>
        <small>{item.description ?? ref}</small>
        <code>{ref}</code>
      </span>
      {item.kind === 'capability' ? (
        <span class="quick-picker-item-meta">
          {!item.providerAvailable ? <em data-tone="warning">Provider unavailable</em> : null}
          {item.connectionSlots.length ? <small>{item.connectionSlots.length} connection {item.connectionSlots.length === 1 ? 'slot' : 'slots'}</small> : null}
        </span>
      ) : null}
    </button>
  )
}

interface AutomationQuickPickerProps {
  state?: ConsoleQueryState<WorkbenchAutomationInsertCatalog>
  disabled?: boolean
  onInsert?(item: WorkbenchAutomationInsertItem): void
  onReload?(): void
}

export const AutomationQuickPicker = defineSetupComponent<AutomationQuickPickerProps>('AutomationQuickPicker', ['state', 'disabled', 'onInsert', 'onReload'], props => {
  const open = ref(false)
  const query = ref('')
  const inputRef = ref<HTMLInputElement>()

  watch(open, async (isOpen) => {
    if (!isOpen) {
      query.value = ''
      return
    }
    await nextTick()
    inputRef.value?.focus()
  })

  const filtered = computed(() => {
    const items = props.state?.status === 'READY' ? props.state.data.items : []
    const normalized = query.value.trim().toLowerCase()
    return normalized ? items.filter(item => searchableText(item).includes(normalized)) : items
  })

  const insert = (item: WorkbenchAutomationInsertItem) => {
    props.onInsert?.(item)
    open.value = false
  }

  return () => {
    const state = props.state
    const live = !!state && state.status !== 'DISABLED'
    const controls = filtered.value.filter(item => item.kind === 'control')
    const capabilities = filtered.value.filter(item => item.kind === 'capability')
    if (!live) {
      return <button class="add-step-button" disabled={props.disabled ?? false} type="button"><Plus size={15} /> Add step</button>
    }
    return (
    <div class="quick-picker-anchor" onKeydown={event => {
      if (event.key === 'Escape') open.value = false
    }}>
      <button
        aria-expanded={open.value}
        aria-haspopup="dialog"
        class="add-step-button"
        disabled={props.disabled ?? false}
        onClick={() => { open.value = !open.value }}
        type="button"
      ><Plus size={15} /> Add step</button>
      {open.value ? (
        <section aria-label="Add automation step" class="quick-picker" role="dialog">
          <header>
            <div><strong>Add step</strong><small>Controls and registered capabilities</small></div>
            <button aria-label="Close step picker" onClick={() => { open.value = false }} type="button"><X size={16} /></button>
          </header>
          <label class="quick-picker-search">
            <Search aria-hidden="true" size={15} />
            <input
              aria-label="Search controls and capabilities"
              onInput={event => { query.value = (event.target as HTMLInputElement).value }}
              placeholder="Search controls and capabilities…"
              ref={inputRef}
              value={query.value}
            />
          </label>
          <div class="quick-picker-results" role="listbox">
            {state.status === 'LOADING' ? <p class="quick-picker-state">Loading insert catalog…</p> : null}
            {state.status === 'ERROR' ? (
              <div class="quick-picker-state" role="alert">
                <Braces size={18} />
                <p>{state.message}</p>
                {props.onReload ? <button onClick={props.onReload} type="button">Try again</button> : null}
              </div>
            ) : null}
            {state.status === 'READY' && controls.length ? (
              <section class="quick-picker-group">
                <h3>Controls</h3>
                {controls.map(item => <PickerItem item={item} key={`control:${item.kind === 'control' ? item.control : ''}`} onInsert={insert} />)}
              </section>
            ) : null}
            {state.status === 'READY' && capabilities.length ? (
              <section class="quick-picker-group">
                <h3>Capabilities</h3>
                {capabilities.map(item => (
                  <PickerItem
                    item={item}
                    key={item.kind === 'capability' ? `capability:${item.capability.id}@${item.capability.version}` : ''}
                    onInsert={insert}
                  />
                ))}
              </section>
            ) : null}
            {state.status === 'READY' && !filtered.value.length ? (
              <p class="quick-picker-state">No controls or capabilities match “{query.value.trim()}”.</p>
            ) : null}
          </div>
          <footer>Unavailable providers can still be composed in a Draft and resolved before publish.</footer>
        </section>
      ) : null}
    </div>
    )
  }
})
