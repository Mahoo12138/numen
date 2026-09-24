import { Button, Input } from '@numenjs/components'
import { t } from './i18n.js'
import { Braces, Search, X } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { MagicVariableCandidate, MagicVariableGroup } from './automation-variable-catalog.js'
import { defineSetupComponent } from './vue-component.js'

const groupOrder: MagicVariableGroup[] = ['input', 'trigger', 'steps', 'loop', 'run']

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
        aria-label={t('workbench.insertVariable2')}
        class="magic-variable-trigger"
        disabled={props.disabled ?? false}
        onClick={() => { open.value = !open.value }}
        onMousedown={event => event.preventDefault()}
        title={t('workbench.insertVariable2')}
        type="button"
      ><Braces size={14} /></button>
      {open.value ? (
        <section aria-label={t('workbench.availableVariables')} class="magic-variable-picker">
          <header>
            <strong>{t('workbench.insertVariable2')}</strong>
            <Button aria-label={t('workbench.closeVariablePicker')} onClick={() => { open.value = false }} type="button"><X size={14} /></Button>
          </header>
          <label class="magic-variable-search">
            <Search aria-hidden="true" size={13} />
            <Input
              aria-label={t('workbench.searchAvailableVariables')}
              onInput={event => { query.value = (event.target as HTMLInputElement).value }}
              placeholder={t('workbench.searchByNameOrPath')}
              inputRef={inputRef}
              value={query.value}
            />
          </label>
          <div class="magic-variable-results">
            {groupOrder.map(group => {
              const items = filtered.value.filter(item => item.group === group)
              return items.length ? (
                <section class="magic-variable-group" key={group}>
                  <h4>{t(`workbench.variableGroups.${group}`)}</h4>
                  {items.map(item => (
                    <button class="magic-variable-item" key={`${item.path}:${item.conversion ?? 'direct'}`} onClick={() => select(item)} type="button">
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.sourceLabel}</small>
                      </span>
                      <code>{item.path}</code>
                      <span class="magic-variable-meta">
                        <em>{item.valueType}</em>
                        {item.conversion ? <small>{t('workbench.convertToText')}</small> : null}
                      </span>
                    </button>
                  ))}
                </section>
              ) : null
            })}
            {!filtered.value.length ? (
              <p class="magic-variable-empty">
                {query.value.trim() ? t('workbench.noVariablesMatchValue0', { value0: query.value.trim() }) : t('workbench.noVariablesMatchThisFieldTypeInTheCurrentScope')}
              </p>
            ) : null}
          </div>
          <footer>{t('workbench.onlyVariablesVisibleBeforeThisStepAreShownPathsUseStableSourceIds')}</footer>
        </section>
      ) : null}
    </div>
  )
})
