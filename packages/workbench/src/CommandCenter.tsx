import { Input } from '@numenjs/components'
import { Search, X } from '@lucide/vue'
import { computed, nextTick, onScopeDispose, ref, Teleport, watch } from 'vue'
import { defineSetupComponent } from './vue-component.js'
import { shortcutLabel, type WorkbenchCommands } from './commands.js'
import { t } from './i18n.js'

interface CommandCenterProps { open: boolean; registry: WorkbenchCommands; onClose(): void }
export const CommandCenter = defineSetupComponent<CommandCenterProps>('CommandCenter', ['open', 'registry', 'onClose'], props => {
  const query = ref('')
  const input = ref<HTMLInputElement>()
  const dialog = ref<HTMLElement>()
  const selected = ref(0)
  let previousFocus: HTMLElement | undefined
  onScopeDispose(() => { if (props.open && previousFocus?.isConnected) previousFocus.focus() })
  const filtered = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase()
    return props.registry.commands.filter(command => command.id !== 'workbench.commandCenter' && (!needle || `${command.label} ${command.description ?? ''}`.toLocaleLowerCase().includes(needle)))
  })
  const close = async (restore = true) => {
    props.onClose()
    await nextTick()
    if (restore && previousFocus?.isConnected) previousFocus.focus()
  }
  watch(() => props.open, async open => {
    if (!open) return
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    query.value = ''; selected.value = 0
    await nextTick(); input.value?.focus()
  })
  watch(filtered, () => { selected.value = Math.min(selected.value, Math.max(0, filtered.value.length - 1)) })
  const choose = async (id: string) => {
    if (props.registry.find(id)?.disabledReason) return
    await close()
    props.registry.execute(id)
  }
  return () => props.open ? <Teleport to="body"><div class="command-center-overlay" onMousedown={event => { if (event.target === event.currentTarget) void close() }}>
    <section class="command-dialog" aria-label={t('workbench.commandCenter')} aria-modal="true" role="dialog" ref={dialog} onKeydown={event => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close() }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + filtered.value.length) % Math.max(1, filtered.value.length); void nextTick(() => dialog.value?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })) }
      else if (event.key === 'Enter' && event.target === input.value) { event.preventDefault(); const command = filtered.value[selected.value]; if (command && !event.repeat) void choose(command.id) }
      else if (event.key === 'Tab') {
        const targets = Array.from(dialog.value?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
        const index = targets.indexOf(document.activeElement as HTMLElement)
        if (event.shiftKey && index <= 0) { event.preventDefault(); targets.at(-1)?.focus() }
        else if (!event.shiftKey && index === targets.length - 1) { event.preventDefault(); targets[0]?.focus() }
      }
    }}>
      <div class="command-dialog-search"><Search aria-hidden="true" size={18} /><Input aria-label={t('workbench.commands.search')} placeholder={t('workbench.commands.search')} inputRef={input} value={query.value} onInput={event => { query.value = (event.target as HTMLInputElement).value; selected.value = 0 }} /><button type="button" aria-label={t('workbench.commands.close')} onClick={() => void close()}><X size={17} /></button></div>
      <span class="visually-hidden" role="status" aria-live="polite">{filtered.value[selected.value]?.label} {filtered.value[selected.value]?.disabledReason}</span>
      <div class="command-dialog-results" role="group" aria-label={t('workbench.commands.results')}>
        {filtered.value.map((command, index) => <button type="button" key={command.id} data-command-id={command.id} data-selected={selected.value === index} aria-disabled={!!command.disabledReason} onFocus={() => { selected.value = index }} onClick={() => void choose(command.id)}>
          <span><strong>{command.label}</strong>{command.description ? <small>{command.description}</small> : null}{command.disabledReason ? <small class="command-disabled-reason">{command.disabledReason}</small> : null}</span>
          {command.shortcut ? <kbd>{shortcutLabel(command.shortcut)}</kbd> : null}
        </button>)}
        {!filtered.value.length ? <p>{t('workbench.commands.empty')}</p> : null}
      </div>
    </section>
  </div></Teleport> : null
})
