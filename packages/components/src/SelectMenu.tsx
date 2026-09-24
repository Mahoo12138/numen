import { Check, ChevronDown } from '@lucide/vue'
import { computed, nextTick, onMounted, onScopeDispose, ref, Teleport, useId, watch, type ButtonHTMLAttributes, type CSSProperties } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface SelectMenuOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export interface SelectMenuProps extends Omit<ButtonHTMLAttributes, 'onChange' | 'value' | 'disabled'> {
  ariaLabel: string
  disabled?: boolean
  options: SelectMenuOption[]
  placement?: 'bottom' | 'top'
  value: string
  onChange(value: string): void
}

export const SelectMenu = defineSetupComponent<SelectMenuProps>('SelectMenu', [
  'ariaLabel', 'disabled', 'options', 'placement', 'value', 'onChange',
], (props, context) => {
  const open = ref(false)
  const listId = useId()
  const root = ref<HTMLElement>()
  const list = ref<HTMLElement>()
  const popupStyle = ref<CSSProperties>({})
  let optionElements: HTMLElement[] = []
  const selected = computed(() => props.options.find(option => option.value === props.value))
  const enabled = computed(() => props.options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0))
  const contains = (node: Node | null) => !!node && (root.value?.contains(node) || list.value?.contains(node))
  const close = (restoreFocus = false) => {
    open.value = false
    if (restoreFocus) root.value?.querySelector<HTMLButtonElement>('.select-menu-trigger')?.focus()
  }
  watch(() => props.disabled || !enabled.value.length, disabled => { if (disabled) close() })

  // Portal the popup out of scrollable panels. Keep it inside the viewport and
  // aligned with its trigger when an inspector or the window scrolls/resizes.
  const position = () => {
    if (!open.value || !root.value || !list.value) return
    const rect = root.value.getBoundingClientRect()
    const margin = 8
    const below = Math.max(0, window.innerHeight - rect.bottom - 4 - margin)
    const above = Math.max(0, rect.top - 4 - margin)
    const preferredTop = props.placement === 'top'
    const top = preferredTop ? above >= Math.min(240, list.value.scrollHeight) || above > below : below < Math.min(240, list.value.scrollHeight) && above > below
    const height = Math.min(240, top ? above : below)
    const width = Math.min(Math.max(rect.width, list.value.scrollWidth), window.innerWidth - margin * 2)
    popupStyle.value = {
      position: 'fixed', width: `${width}px`, minWidth: 0, maxHeight: `${height}px`,
      left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
      top: top ? 'auto' : `${rect.bottom + 4}px`,
      bottom: top ? `${window.innerHeight - rect.top + 4}px` : 'auto',
    }
  }
  const focusOption = async (index: number) => {
    await nextTick()
    optionElements[index]?.focus()
  }
  const show = (last = false) => {
    if (props.disabled || !enabled.value.length) return
    open.value = true
    const selectedIndex = props.options.findIndex(option => option.value === props.value && !option.disabled)
    void nextTick(() => {
      position()
      void focusOption(selectedIndex >= 0 ? selectedIndex : enabled.value[last ? enabled.value.length - 1 : 0]!)
    })
  }
  const choose = (option: SelectMenuOption) => {
    if (props.disabled || option.disabled) return
    close(true)
    props.onChange(option.value)
  }
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (open.value && !contains(event.target as Node)) close()
  }
  const onFocusout = (event: FocusEvent) => {
    // activeElement is temporarily body during blur; relatedTarget is stable.
    if (!contains(event.relatedTarget as Node | null)) close()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    if (event.key === 'Tab' && list.value?.contains(event.target as Node)) {
      // Restore DOM tab order to the trigger before the browser moves focus.
      close(true)
    }
  }
  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
  })
  onScopeDispose(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    window.removeEventListener('resize', position)
    document.removeEventListener('scroll', position, true)
  })

  return () => {
    optionElements = []
    const { class: className, style, ...triggerAttrs } = context.attrs
    return <div class={['select-menu', className]} style={style as CSSProperties} data-open={open.value} ref={root} onFocusout={onFocusout} onKeydown={onKeydown}>
      <button {...triggerAttrs}
        aria-controls={open.value ? listId : undefined} aria-expanded={open.value} aria-haspopup="listbox"
        aria-label={props.ariaLabel} class="select-menu-trigger"
        disabled={props.disabled || !enabled.value.length}
        onClick={() => { open.value ? close() : show() }}
        onKeydown={(event: KeyboardEvent) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp') }
        }} type="button">
        <span>{selected.value?.label ?? props.value}</span><ChevronDown aria-hidden="true" size={14} />
      </button>
      {open.value ? <Teleport to="body"><div aria-label={props.ariaLabel} class="select-menu-popover" style={popupStyle.value}
        id={listId} ref={list} role="listbox" onFocusout={onFocusout} onKeydown={onKeydown}>
        {props.options.map((option, index) => <button
          aria-selected={option.value === props.value} disabled={option.disabled} aria-disabled={option.disabled || undefined}
          class="select-menu-option" key={option.value} onClick={() => choose(option)}
          onKeydown={(event: KeyboardEvent) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const current = enabled.value.indexOf(index)
              void focusOption(enabled.value[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.value.length) % enabled.value.length]!)
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault(); void focusOption(enabled.value[event.key === 'Home' ? 0 : enabled.value.length - 1]!)
            }
          }}
          ref={(element: unknown) => { if (element instanceof HTMLElement) optionElements[index] = element }}
          role="option" tabindex={-1} type="button">
          <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
          {option.value === props.value ? <Check aria-hidden="true" size={14} /> : null}
        </button>)}
      </div></Teleport> : null}
    </div>
  }
})
