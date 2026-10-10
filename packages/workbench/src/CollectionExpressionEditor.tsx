import { Button, Input } from '@numenjs/components'
import { AlertCircle, ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue'
import { ref, watch } from 'vue'
import { t } from './i18n.js'
import { useAutomationFieldDraft } from './automation-field-draft.js'
import { collectionMemberKey, renameCollectionField, type CollectionExpression } from './collection-expression.js'
import { ValueExpressionField, type ValueExpressionFieldProps } from './ValueExpressionEditor.js'
import { defineSetupComponent } from './vue-component.js'

interface MemberNameProps {
  nodeId: string
  fieldName: string
  label: string
  name: string
  index: number
  names: string[]
  canEdit: boolean
  onRename(name: string): void
}

const MemberName = defineSetupComponent<MemberNameProps>('CollectionMemberName', ['nodeId', 'fieldName', 'label', 'name', 'index', 'names', 'canEdit', 'onRename'], props => {
  const text = ref(props.name)
  const draft = useAutomationFieldDraft(() => props.nodeId, () => `${props.fieldName}/key/${collectionMemberKey(props.name)}`)
  const duplicate = () => text.value !== props.name && props.names.includes(text.value)
  const report = () => draft.report({ dirty: text.value !== props.name, invalid: duplicate() })
  watch(() => props.name, (next, previous) => { if (text.value === previous || text.value === next) text.value = next; report() })
  watch(() => props.names, report)
  const commit = () => {
    if (!props.canEdit || text.value === props.name || duplicate()) return report()
    // The name itself is valid and is about to be committed. Protect any pending
    // member values before a rename changes their document identities.
    draft.report({ dirty: false, invalid: false })
    if (!draft.confirmDiscard()) return report()
    props.onRename(text.value)
  }
  return () => <div class="collection-member-name">
    <Input aria-label={t('workbench.collection.fieldName', { label: props.label, index: props.index + 1 })}
      aria-invalid={duplicate()} disabled={!props.canEdit} value={text.value}
      onInput={event => { text.value = (event.target as HTMLInputElement).value; report() }}
      onBlur={commit} onKeydown={event => { if (event.key === 'Enter' && !event.isComposing) (event.target as HTMLElement).blur() }} />
    {duplicate() ? <p class="inspector-field-error" role="alert">{t('workbench.collection.duplicateName')}</p> : null}
  </div>
})

type CollectionProps = ValueExpressionFieldProps & { expression: CollectionExpression; depth: number }

function renderCollection(props: Readonly<CollectionProps>) {
  if (props.depth >= 8) return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>{t('workbench.collection.depthLimit')}</span></div>
  const expression = props.expression
  const rows = expression.type === 'object'
    ? Object.entries(expression.entries)
    : expression.items.map((value, index) => [String(index), value] as const)
  const guarded = (change: () => void) => {
    if (!props.canEdit || (props.confirmDiscard && !props.confirmDiscard())) return
    change()
  }
  return <div class="collection-expression-editor" data-collection-type={expression.type}>
    {!rows.length ? <p class="collection-empty">{t(expression.type === 'object' ? 'workbench.collection.emptyObject' : 'workbench.collection.emptyArray')}</p> : null}
    {rows.map(([key, value], index) => {
      const label = expression.type === 'object' ? key || t('workbench.collection.emptyKey') : t('workbench.collection.item', { index: index + 1 })
      const childName = `${props.field.name}/${expression.type}/${collectionMemberKey(key)}`
      return <div class="collection-member" key={key} data-collection-member={key}>
        <div class="collection-member-toolbar">
          {expression.type === 'object' ? <MemberName nodeId={props.nodeId} fieldName={props.field.name} label={props.field.label}
            name={key} index={index} names={rows.map(([name]) => name)} canEdit={props.canEdit}
            onRename={name => props.onChange(renameCollectionField(expression, key, name))} /> : <span>{label}</span>}
          <div class="collection-member-actions">
            {expression.type === 'array' ? <>
              <Button aria-label={t('workbench.collection.moveUp', { index: index + 1 })} disabled={!props.canEdit || index === 0} type="button"
                onClick={() => guarded(() => { const items = [...expression.items]; [items[index - 1], items[index]] = [items[index]!, items[index - 1]!]; props.onChange({ type: 'array', items }) })}><ArrowUp aria-hidden="true" size={13} /></Button>
              <Button aria-label={t('workbench.collection.moveDown', { index: index + 1 })} disabled={!props.canEdit || index === rows.length - 1} type="button"
                onClick={() => guarded(() => { const items = [...expression.items]; [items[index], items[index + 1]] = [items[index + 1]!, items[index]!]; props.onChange({ type: 'array', items }) })}><ArrowDown aria-hidden="true" size={13} /></Button>
            </> : null}
            <Button aria-label={expression.type === 'object' ? t('workbench.collection.removeField', { name: label }) : t('workbench.collection.removeItem', { index: index + 1 })}
              disabled={!props.canEdit} type="button" onClick={() => guarded(() => props.onChange(expression.type === 'object'
                ? { type: 'object', entries: Object.fromEntries(rows.filter(([name]) => name !== key)) }
                : { type: 'array', items: expression.items.filter((_item, itemIndex) => itemIndex !== index) }))}><Trash2 aria-hidden="true" size={13} /></Button>
          </div>
        </div>
        <ValueExpressionField canEdit={props.canEdit} nodeId={props.nodeId} depth={props.depth + 1}
          field={{ name: childName, label, type: 'json', schemaType: 'any', required: true }} expression={value}
          {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
          {...(props.source ? { source: props.source } : {})}
          {...(props.variableCatalog ? { variableCatalog: props.variableCatalog } : {})}
          onChange={next => props.onChange(expression.type === 'object'
            ? { type: 'object', entries: Object.fromEntries(rows.map(([name, entry]) => [name, name === key ? next ?? { type: 'literal', value: null } : entry])) }
            : { type: 'array', items: expression.items.map((item, itemIndex) => itemIndex === index ? next ?? { type: 'literal', value: null } : item) })} />
      </div>
    })}
    <Button class="structured-call-add" disabled={!props.canEdit} type="button" onClick={() => {
      if (!props.canEdit) return
      if (expression.type === 'array') props.onChange({ type: 'array', items: [...expression.items, { type: 'literal', value: null }] })
      else {
        let name = 'field', suffix = 2
        while (Object.hasOwn(expression.entries, name)) name = `field${suffix++}`
        props.onChange({ type: 'object', entries: Object.fromEntries([...rows, [name, { type: 'literal', value: null }]]) })
      }
    }}><Plus aria-hidden="true" size={13} />{t(expression.type === 'object' ? 'workbench.collection.addField' : 'workbench.collection.addItem')}</Button>
  </div>
}

export const CollectionExpressionEditor = defineSetupComponent<CollectionProps>('CollectionExpressionEditor',
  ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'source', 'variableCatalog', 'variables', 'focusRequest', 'depth', 'discardEpoch', 'onDraftStateChange', 'confirmDiscard', 'onChange'],
  props => () => renderCollection(props))
