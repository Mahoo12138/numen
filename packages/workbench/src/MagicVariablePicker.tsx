import { Braces, Search, X } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { MagicVariableCandidate, MagicVariableGroup } from './automation-variable-catalog.js'
import { defineSetupComponent } from './vue-component.js'

const groupLabels: Record<MagicVariableGroup, string> = {
  trigger: 'Trigger',
  steps: 'Previous steps',
  loop: 'Loop',
  run: 'Run',
}

const groupOrder: MagicVariableGroup[] = ['trigger', 'steps', 'loop', 'run']

function searchableText(item: MagicVariableCandidate): string {
  return `${item.label} ${item.sourceLabel} ${item.path} ${item.valueType}`.toLowerCase()
}

interface MagicVariablePickerProps {
  candidates: MagicVariableCandidate[]
  disabled?: boolean
  onSelect(candidate: MagicVariableCandidate): void
}

export const MagicVariablePicker = defineSetupComponent<MagicVariablePickerProps>('MagicVariablePicker', ['candidates', 'disabled', 'onSelect'], props => {
  const open = ref(false)
  const query = ref('')
  const inputRef = ref<HTMLInputElement>()

  watch(open, async isOpen => {
    if (!isOpen) {
      query.value = ''
      return
    }
    await nextTick()
    inputRef.value?.focus()
  })

  const filtered = computed(() => {
    const normalized = query.value.trim().toLowerCase()
    return normalized ? props.candidates.filter(item => searchableText(item).includes(normalized)) : props.candidates
  })

  const select = (item: MagicVariableCandidate) => {
    props.onSelect(item)
    open.value = false
  }

  return () => (
    <div class="magic-variable-anchor" onKeydown={event => {
      if (event.key === 'Escape') open.value = false
    }}>
      <button
        aria-expanded={open.value}
        aria-label="Insert variable"
        class="magic-variable-trigger"
        disabled={props.disabled ?? false}
        onClick={() => { open.value = !open.value }}
        onMousedown={event => event.preventDefault()}
        title="Insert variable"
        type="button"
      ><Braces size={14} /></button>
      {open.value ? (
        <section aria-label="Available variables" class="magic-variable-picker">
          <header>
            <strong>Insert variable</strong>
            <button aria-label="Close variable picker" onClick={() => { open.value = false }} type="button"><X size={14} /></button>
          </header>
          <label class="magic-variable-search">
            <Search aria-hidden="true" size={13} />
            <input
              aria-label="Search available variables"
              onInput={event => { query.value = (event.target as HTMLInputElement).value }}
              placeholder="Search by name or path…"
              ref={inputRef}
              value={query.value}
            />
          </label>
          <div class="magic-variable-results">
            {groupOrder.map(group => {
              const items = filtered.value.filter(item => item.group === group)
              return items.length ? (
                <section class="magic-variable-group" key={group}>
                  <h4>{groupLabels[group]}</h4>
                  {items.map(item => (
                    <button class="magic-variable-item" key={`${item.path}:${item.conversion ?? 'direct'}`} onClick={() => select(item)} type="button">
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.sourceLabel}</small>
                      </span>
                      <code>{item.path}</code>
                      <span class="magic-variable-meta">
                        <em>{item.valueType}</em>
                        {item.conversion ? <small>Convert to text</small> : null}
                      </span>
                    </button>
                  ))}
                </section>
              ) : null
            })}
            {!filtered.value.length ? (
              <p class="magic-variable-empty">
                {query.value.trim() ? `No variables match “${query.value.trim()}”.` : 'No variables match this field type in the current scope.'}
              </p>
            ) : null}
          </div>
          <footer>Only variables visible before this step are shown. Paths use stable Source IDs.</footer>
        </section>
      ) : null}
    </div>
  )
})
