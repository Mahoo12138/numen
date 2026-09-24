import { t } from './i18n.js'
import type { NumenValue } from '@numenjs/core'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { AlertCircle, Save, Trash2, X } from '@lucide/vue'
import { computed, h, ref, type VNodeChild } from 'vue'
import {
  workbenchCreateConnectionActionRef,
  workbenchDeleteConnectionActionRef,
  workbenchUpdateConnectionActionRef,
  type WorkbenchConnectionAdapter,
  type WorkbenchConnectionIndexItem,
  type WorkbenchCreateConnectionInput,
  type WorkbenchCreateConnectionResult,
  type WorkbenchDeleteConnectionInput,
  type WorkbenchDeleteConnectionResult,
  type WorkbenchSchemaField,
  type WorkbenchUpdateConnectionInput,
  type WorkbenchUpdateConnectionResult,
} from './contracts.js'
import type { SchemaLiteralRenderer } from './SchemaRenderers.js'
import type { WorkbenchConsoleClient } from './types.js'
import { defineSetupComponent } from './vue-component.js'

interface ConnectionConfigurationPanelProps {
  client?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  adapters: WorkbenchConnectionAdapter[]
  connection?: WorkbenchConnectionIndexItem
  onClose(): void
  onChanged(connectionId?: string): void
}

function defaultValue(field: WorkbenchSchemaField): NumenValue | undefined {
  return field.defaultValue
}

function mutationMessage(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined
  if (code === 'CONNECTION_GENERATION_CONFLICT') return 'workbench.connectionConflict'
  if (code === 'CONNECTION_NOT_FOUND') return 'workbench.connectionGone'
  if (code === 'CONNECTION_INVALID') return error instanceof Error ? error.message : 'workbench.connectionInvalid'
  return error instanceof Error ? error.message : 'workbench.connectionFailed'
}

function adapterKey(adapter: Pick<WorkbenchConnectionAdapter, 'id' | 'version'>): string {
  return `${adapter.id}@${adapter.version}`
}

function connectionAdapter(
  adapters: WorkbenchConnectionAdapter[],
  connection: WorkbenchConnectionIndexItem | undefined,
): WorkbenchConnectionAdapter | undefined {
  return connection
    ? adapters.find(adapter => adapter.id === connection.adapterId && adapter.version === connection.adapterVersion)
    : adapters[0]
}

export const ConnectionConfigurationPanel = defineSetupComponent<ConnectionConfigurationPanelProps>(
  'ConnectionConfigurationPanel',
  ['client', 'schemaUI', 'adapters', 'connection', 'onClose', 'onChanged'],
  props => {
    const initialAdapter = connectionAdapter(props.adapters, props.connection)
    const selectedAdapterKey = ref(initialAdapter ? adapterKey(initialAdapter) : '')
    const name = ref(props.connection?.name ?? '')
    const config = ref<Record<string, NumenValue>>({ ...(props.connection?.config ?? {}) })
    const credentialId = ref(props.connection?.credentialId ?? '')
    const expectedGeneration = ref(props.connection?.generation)
    const pending = ref(false)
    const error = ref<string>()
    const confirmDelete = ref(false)
    const adapter = computed(() => props.adapters.find(item => adapterKey(item) === selectedAdapterKey.value))
    const mode = props.connection ? 'edit' : 'create'

    const resetForAdapter = (next: WorkbenchConnectionAdapter) => {
      selectedAdapterKey.value = adapterKey(next)
      config.value = Object.fromEntries(next.configFields.flatMap(field => {
        const value = defaultValue(field)
        return value === undefined ? [] : [[field.name, value]]
      }))
      credentialId.value = next.credentials[0]?.id ?? ''
      error.value = undefined
    }
    if (!props.connection && initialAdapter) resetForAdapter(initialAdapter)

    const canSave = computed(() => !!props.client
      && !!adapter.value
      && !!name.value.trim()
      && adapter.value.configSchemaSupported
      && (!adapter.value.credentialType || !!credentialId.value)
      && !pending.value)

    const save = async () => {
      const client = props.client
      const selected = adapter.value
      if (!client || !selected || !canSave.value) return
      pending.value = true
      error.value = undefined
      try {
        if (mode === 'create') {
          const input: WorkbenchCreateConnectionInput = {
            name: name.value,
            adapterId: selected.id,
            adapterVersion: selected.version,
            config: config.value,
            ...(credentialId.value ? { credentialId: credentialId.value } : {}),
          }
          const result = await client.action<WorkbenchCreateConnectionInput, WorkbenchCreateConnectionResult>(
            workbenchCreateConnectionActionRef,
            input,
          )
          expectedGeneration.value = result.connection.generation
          props.onChanged(result.connection.id)
        } else if (props.connection && expectedGeneration.value !== undefined) {
          const input: WorkbenchUpdateConnectionInput = {
            connectionId: props.connection.id,
            expectedGeneration: expectedGeneration.value,
            name: name.value,
            config: config.value,
            ...(credentialId.value ? { credentialId: credentialId.value } : {}),
          }
          const result = await client.action<WorkbenchUpdateConnectionInput, WorkbenchUpdateConnectionResult>(
            workbenchUpdateConnectionActionRef,
            input,
          )
          expectedGeneration.value = result.connection.generation
          props.onChanged(result.connection.id)
        }
      } catch (nextError) {
        error.value = mutationMessage(nextError)
      } finally {
        pending.value = false
      }
    }

    const remove = async () => {
      const client = props.client
      const connection = props.connection
      if (!client || !connection || expectedGeneration.value === undefined || pending.value) return
      pending.value = true
      error.value = undefined
      try {
        const input: WorkbenchDeleteConnectionInput = {
          connectionId: connection.id,
          expectedGeneration: expectedGeneration.value,
        }
        await client.action<WorkbenchDeleteConnectionInput, WorkbenchDeleteConnectionResult>(
          workbenchDeleteConnectionActionRef,
          input,
        )
        props.onChanged()
        props.onClose()
      } catch (nextError) {
        error.value = mutationMessage(nextError)
        confirmDelete.value = false
      } finally {
        pending.value = false
      }
    }

    const renderField = (field: WorkbenchSchemaField): VNodeChild => {
      const Renderer = props.schemaUI?.resolveRenderer<SchemaLiteralRenderer>({
        ...(field.role ? { role: field.role } : {}),
        type: field.type,
      }, 'editor')
      if (!Renderer) return <p class="connection-config-notice">{t('workbench.noEditorIsRegisteredFor')}{field.role ?? field.type}{t('workbench.itsCurrentValueIsPreserved')}</p>
      const inputId = `connection-config-${field.name}`
      return <label class="connection-config-field" data-required={field.required}>
        <span>{field.label}{field.required ? <em>{t('workbench.required')}</em> : null}</span>
        {h(Renderer, {
          canEdit: !pending.value,
          controlId: props.connection?.id ?? 'new-connection',
          field,
          inputId,
          invalid: false,
          ...(config.value[field.name] !== undefined ? { value: config.value[field.name] } : {}),
          onCommit: (value?: NumenValue) => {
            const next = { ...config.value }
            if (value === undefined) delete next[field.name]
            else next[field.name] = value
            config.value = next
          },
        })}
        {field.description ? <small>{field.description}</small> : null}
      </label>
    }

    return () => {
      const selected = adapter.value
      return <aside aria-label={t('workbench.connectionConfiguration')} class="connection-config-panel">
        <header>
          <div><h2>{mode === 'create' ? t('workbench.newConnection') : t('workbench.connectionSettings')}</h2><p>{mode === 'create' ? t('workbench.chooseAnAdapterAndConfigureOneDurableConnection') : props.connection?.name}</p></div>
          <button aria-label={t('workbench.closeConnectionConfiguration')} class="icon-button" onClick={props.onClose} type="button"><X size={16} /></button>
        </header>
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          <label class="connection-config-field">
            <span>{t('workbench.name')}<em>{t('workbench.required')}</em></span>
            <input autofocus value={name.value} disabled={pending.value} maxlength="120" onInput={event => { name.value = (event.target as HTMLInputElement).value }} placeholder={t('workbench.personalWorkspace')} type="text" />
          </label>
          <label class="connection-config-field">
            <span>{t('workbench.adapter')}<em>{t('workbench.required')}</em></span>
            <select
              disabled={mode === 'edit' || pending.value}
              onChange={event => {
                const next = props.adapters.find(item => adapterKey(item) === (event.target as HTMLInputElement).value)
                if (next) resetForAdapter(next)
              }}
              value={selectedAdapterKey.value}
            >
              {!props.adapters.length ? <option value="">{t('workbench.noAdaptersAvailable')}</option> : null}
              {props.adapters.map(item => <option key={adapterKey(item)} value={adapterKey(item)}>{item.title}</option>)}
            </select>
            {selected ? <small>{selected.id}@{selected.version}{selected.providerAvailable ? '' : t('workbench.providerUnavailable2')}</small> : null}
          </label>
          {selected?.credentialType ? <label class="connection-config-field">
            <span>{t('workbench.credential')}<em>{t('workbench.required')}</em></span>
            <select disabled={pending.value || !selected.credentials.length} onChange={event => { credentialId.value = (event.target as HTMLInputElement).value }} value={credentialId.value}>
              {!selected.credentials.length ? <option value="">{t('workbench.noCompatibleCredentials')}</option> : null}
              {selected.credentials.map(credential => <option key={credential.id} value={credential.id}>{credential.name} · v{credential.secretVersion}</option>)}
            </select>
            <small>{t('workbench.onlyMetadataIsShownSecretMaterialNeverEntersWorkbenchReads')}</small>
          </label> : null}
          {selected?.configSchemaSupported ? <div class="connection-config-fields">{selected.configFields.map(renderField)}</div> : selected ? (
            <p class="connection-config-notice"><AlertCircle size={15} />{t('workbench.thisAdapterUsesAConfigurationShapeWithoutAGenericEditorExistingValuesRemainPreserved')}</p>
          ) : null}
          {error.value ? <p class="connection-config-error" role="alert"><AlertCircle size={15} />{t(error.value)}</p> : null}
          <footer>
            {mode === 'edit' ? (
              confirmDelete.value ? <span class="connection-delete-confirm"><span>{t('workbench.deleteThisConnectionConfiguration')}</span><button disabled={pending.value} onClick={() => { confirmDelete.value = false }} type="button">{t('workbench.cancel')}</button><button class="danger-button" disabled={pending.value} onClick={() => { void remove() }} type="button">{t('workbench.deleteConnection')}</button></span>
                : <button class="danger-text-button" disabled={pending.value} onClick={() => { confirmDelete.value = true }} type="button"><Trash2 size={14} />{t('workbench.delete')}</button>
            ) : <span />}
            {!confirmDelete.value ? <button class="primary-button connection-save-button" disabled={!canSave.value} type="submit"><Save size={14} />{pending.value ? t('workbench.saving') : mode === 'create' ? t('workbench.createConnection') : t('workbench.saveChanges')}</button> : null}
          </footer>
        </form>
      </aside>
    }
  },
)
