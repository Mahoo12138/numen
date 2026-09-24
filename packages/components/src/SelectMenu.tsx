import { Check, ChevronDown } from '@lucide/vue'
import { computed, nextTick, onMounted, onScopeDispose, ref, useId, watch } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface SelectMenuOption {
  value: string
  label: string
  description?: string
}

export interface SelectMenuProps {
  ariaLabel: string
  disabled?: boolean
  options: SelectMenuOption[]
  placement?: 'bottom' | 'top'
  value: string
  onChange(value: string): void
}

export const SelectMenu = defineSetupComponent<SelectMenuProps>('SelectMenu', [
  'ariaLabel', 'disabled', 'options', 'placement', 'value', 'onChange',
], props => {
  const open = ref(false)
  const listId = useId()
  const close = (restoreFocus = false) => {
    open.value = false
    if (restoreFocus) root.value?.querySelector<HTMLButtonElement>('.select-menu-trigger')?.focus()
  }
  watch(() => props.disabled, disabled => { if (disabled) close() })
  const root = ref<HTMLElement>()
  let optionElements: HTMLElement[] = []
  const selected = computed(() => props.options.find(option => option.value === props.value))

  const focusOption = async (index: number) => {
    await nextTick()
    const options = optionElements
    if (!options.length) return
    options[(index + options.length) % options.length]?.focus()
  }
  const show = (focusIndex?: number) => {
    if (props.disabled || !props.options.length) return
    open.value = true
    if (focusIndex !== undefined) void focusOption(focusIndex)
  }
  const choose = (value: string) => {
    if (props.disabled) return
    close(true)
    props.onChange(value)
  }
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (open.value && !root.value?.contains(event.target as Node)) open.value = false
  }
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (open.value && event.key === 'Escape') {
      event.preventDefault()
      open.value = false
      root.value?.querySelector<HTMLButtonElement>('.select-menu-trigger')?.focus()
    }
  }
  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown)
    document.addEventListener('keydown', onDocumentKeyDown)
  })
  onScopeDispose(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    document.removeEventListener('keydown', onDocumentKeyDown)
  })

  return () => {
    optionElements = []
    const selectedIndex = Math.max(0, props.options.findIndex(option => option.value === props.value))
    return <div class="select-menu" data-open={open.value} data-placement={props.placement ?? 'bottom'} ref={root} onFocusout={() => {
      void nextTick(() => { if (!root.value?.contains(document.activeElement)) close() })
    }}>
      <button
        aria-controls={open.value ? listId : undefined}
        aria-expanded={open.value}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        class="select-menu-trigger"
        disabled={props.disabled || !props.options.length}
        onClick={() => { open.value ? open.value = false : show() }}
        onKeydown={(event: KeyboardEvent) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show(event.key === 'ArrowDown' ? selectedIndex : selectedIndex - 1)
          }
        }}
        type="button"
      >
        <span>{selected.value?.label ?? props.value}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open.value ? <div aria-label={props.ariaLabel} class="select-menu-popover" id={listId} role="listbox">
        {props.options.map((option, index) => <button
          aria-selected={option.value === props.value}
          class="select-menu-option"
          key={option.value}
          onClick={() => choose(option.value)}
          onKeydown={(event: KeyboardEvent) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              void focusOption(index + (event.key === 'ArrowDown' ? 1 : -1))
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              void focusOption(event.key === 'Home' ? 0 : props.options.length - 1)
            }
          }}
          ref={(element: unknown) => { if (element instanceof HTMLElement) optionElements[index] = element }}
          role="option"
          type="button"
        >
          <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
          {option.value === props.value ? <Check aria-hidden="true" size={14} /> : null}
        </button>)}
      </div> : null}
    </div>
  }
})
