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
import { computed, nextTick, ref, shallowRef, Teleport, watch } from 'vue'
import type { AutomationInsertTarget } from './automation-source-editing.js'
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
  target?: AutomationInsertTarget
  triggerTarget?: AutomationInsertTarget
  label?: string
  compact?: boolean
  onInsert?(item: WorkbenchAutomationInsertItem, target: AutomationInsertTarget): boolean | void
  onReload?(): void
}

export const AutomationQuickPicker = defineSetupComponent<AutomationQuickPickerProps>('AutomationQuickPicker', ['state', 'disabled', 'target', 'triggerTarget', 'label', 'compact', 'onInsert', 'onReload'], props => {
  const open = ref(false)
  const query = ref('')
  const inputRef = ref<HTMLInputElement>()
  const anchorRef = ref<HTMLElement>()
  const capturedTarget = shallowRef<AutomationInsertTarget>()
  const capturedTriggerTarget = shallowRef<AutomationInsertTarget>()
  const failed = ref(false)
  const openPicker = () => {
    capturedTarget.value = props.target ? { ...props.target } : undefined
    capturedTriggerTarget.value = props.triggerTarget ? { ...props.triggerTarget } : undefined
    failed.value = false
    open.value = true
  }
  const closePicker = () => {
    open.value = false
    nextTick(() => anchorRef.value?.querySelector('button')?.focus())
  }

  watch(open, async (isOpen) => {
    if (!isOpen) {
      query.value = ''
      return
    }
    await nextTick()
    inputRef.value?.focus()
  })

  const filtered = computed(() => {
    const items = props.state?.status === 'READY' ? props.state.data.items.filter(item => item.kind !== 'trigger' || !!capturedTriggerTarget.value) : []
    const normalized = query.value.trim().toLowerCase()
    return normalized ? items.filter(item => searchableText(item).includes(normalized)) : items
  })

  const insert = (item: WorkbenchAutomationInsertItem) => {
    const target = item.kind === 'trigger' ? capturedTriggerTarget.value : capturedTarget.value
    if (!target || !props.onInsert || props.onInsert(item, target) === false) {
      failed.value = true
      return
    }
    open.value = false
  }

  return () => {
    const state = props.state
    const live = !!state && state.status !== 'DISABLED'
    const controls = filtered.value.filter(item => item.kind === 'control' || item.kind === 'extension')
    const triggers = filtered.value.filter(item => item.kind === 'trigger')
    const capabilities = filtered.value.filter(item => item.kind === 'capability')
    if (!live) {
      return <Button class="add-step-button" disabled type="button"><Plus size={15} />{props.label ?? t('workbench.addStep')}</Button>
    }
    return (
    <div class="quick-picker-anchor" data-compact={props.compact ?? false} ref={anchorRef}>
      <Button
        aria-expanded={open.value}
        aria-haspopup="dialog"
        aria-label={props.label ?? t('workbench.addStep')}
        class="add-step-button"
        disabled={props.disabled || !props.target}
        onClick={openPicker}
        type="button"
      ><Plus size={15} />{props.compact ? null : props.label ?? t('workbench.addStep')}</Button>
      {open.value ? (
        <Teleport to="body"><div class="quick-picker-overlay" onClick={event => { if (event.target === event.currentTarget) closePicker() }} onKeydown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closePicker() }
          if (event.key === 'Tab') {
            const focusable = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
            const first = focusable[0], last = focusable.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}><section aria-label={t('workbench.addAutomationStep')} aria-modal="true" class="quick-picker" role="dialog">
          <header>
            <div><strong>{props.label ?? t('workbench.addStep2')}</strong><small>{t('workbench.controlsAndRegisteredCapabilities')}</small></div>
            <Button aria-label={t('workbench.closeStepPicker')} onClick={closePicker} type="button"><X size={16} /></Button>
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
          {failed.value ? <p class="quick-picker-error" role="alert">{t('workbench.structure.insertionFailed')}</p> : null}
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
        </section></div></Teleport>
      ) : null}
    </div>
    )
  }
})
