import { Button, Input } from '@numenjs/components'
import { diagnosticText, t } from './i18n.js'
import {
  Braces,
  Clock3,
  GitBranch,
  Layers3,
  ListTree,
  Plus,
  Search,
  Radio,
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
  if (item.kind === 'extension') return `${item.title} ${item.description} ${item.control.id}@${item.control.version}`.toLowerCase()
  return [
    item.title,
    item.description,
    item.capability.id,
    item.capability.version,
    item.kind === 'capability' ? item.capabilityKind : 'trigger',
    ...item.connectionSlots,
  ].filter(Boolean).join(' ').toLowerCase()
}

function PickerItem({ item, onInsert }: {
  item: WorkbenchAutomationInsertItem
  onInsert(item: WorkbenchAutomationInsertItem): void
}) {
  const Icon = item.kind === 'control' ? controlIcons[item.control] : item.kind === 'trigger' ? Radio : Sparkles
  const ref = item.kind === 'capability' || item.kind === 'trigger' ? `${item.capability.id}@${item.capability.version}` : item.kind === 'extension' ? `${item.control.id}@${item.control.version}` : item.control
  return (
    <button class="quick-picker-item" onClick={() => onInsert(item)} role="option" type="button">
      <span class="quick-picker-item-icon" data-kind={item.kind}><Icon size={16} /></span>
      <span class="quick-picker-item-copy">
        <span><strong>{item.title}</strong><em>{item.kind === 'capability' ? item.capabilityKind : item.kind === 'trigger' ? t('workbench.trigger') : t('workbench.control')}</em></span>
        <small>{item.description ?? ref}</small>
        <code>{ref}</code>
      </span>
      {item.kind === 'capability' || item.kind === 'trigger' ? (
        <span class="quick-picker-item-meta">
          {!item.providerAvailable ? <em data-tone="warning">{t('workbench.providerUnavailable')}</em> : null}
          {item.connectionSlots.length ? <small>{item.connectionSlots.length}{t('workbench.connection')}{item.connectionSlots.length === 1 ? t('workbench.slot') : t('workbench.slots')}</small> : null}
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
    const controls = filtered.value.filter(item => item.kind === 'control' || item.kind === 'extension')
    const triggers = filtered.value.filter(item => item.kind === 'trigger')
    const capabilities = filtered.value.filter(item => item.kind === 'capability')
    if (!live) {
      return <Button class="add-step-button" disabled={props.disabled ?? false} type="button"><Plus size={15} />{t('workbench.addStep')}</Button>
    }
    return (
    <div class="quick-picker-anchor" onKeydown={event => {
      if (event.key === 'Escape') open.value = false
    }}>
      <Button
        aria-expanded={open.value}
        aria-haspopup="dialog"
        class="add-step-button"
        disabled={props.disabled ?? false}
        onClick={() => { open.value = !open.value }}
        type="button"
      ><Plus size={15} />{t('workbench.addStep')}</Button>
      {open.value ? (
        <section aria-label={t('workbench.addAutomationStep')} class="quick-picker" role="dialog">
          <header>
            <div><strong>{t('workbench.addStep2')}</strong><small>{t('workbench.controlsAndRegisteredCapabilities')}</small></div>
            <Button aria-label={t('workbench.closeStepPicker')} onClick={() => { open.value = false }} type="button"><X size={16} /></Button>
          </header>
          <label class="quick-picker-search">
            <Search aria-hidden="true" size={15} />
            <Input
              aria-label={t('workbench.searchControlsAndCapabilities')}
              onInput={event => { query.value = (event.target as HTMLInputElement).value }}
              placeholder={t('workbench.searchControlsAndCapabilities2')}
              inputRef={inputRef}
              value={query.value}
            />
          </label>
          <div class="quick-picker-results" role="listbox">
            {state.status === 'LOADING' ? <p class="quick-picker-state">{t('workbench.loadingInsertCatalog')}</p> : null}
            {state.status === 'ERROR' ? (
              <div class="quick-picker-state" role="alert">
                <Braces size={18} />
                <p>{diagnosticText(state)}</p>
                {props.onReload ? <Button onClick={props.onReload} type="button">{t('workbench.tryAgain')}</Button> : null}
              </div>
            ) : null}
            {state.status === 'READY' && controls.length ? (
              <section class="quick-picker-group">
                <h3>{t('workbench.controls')}</h3>
                {controls.map(item => <PickerItem item={item} key={`control:${item.kind === 'control' ? item.control : item.kind === 'extension' ? `${item.control.id}@${item.control.version}` : ''}`} onInsert={insert} />)}
              </section>
            ) : null}
            {state.status === 'READY' && triggers.length ? (
              <section class="quick-picker-group">
                <h3>{t('workbench.triggers')}</h3>
                {triggers.map(item => (
                  <PickerItem item={item} key={item.kind === 'trigger' ? `trigger:${item.capability.id}@${item.capability.version}` : ''} onInsert={insert} />
                ))}
              </section>
            ) : null}
            {state.status === 'READY' && capabilities.length ? (
              <section class="quick-picker-group">
                <h3>{t('workbench.capabilities')}</h3>
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
              <p class="quick-picker-state">{t('workbench.noControlsOrCapabilitiesMatch')}{query.value.trim()}”.</p>
            ) : null}
          </div>
          <footer>{t('workbench.unavailableProvidersCanStillBeComposedInADraftAndResolvedBeforePublish')}</footer>
        </section>
      ) : null}
    </div>
    )
  }
})
