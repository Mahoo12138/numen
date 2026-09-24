import { t } from './i18n.js'
import { isNumenValue, type NumenValue } from '@numenjs/core'
import { computed, onBeforeUnmount, ref } from 'vue'
import { X } from '@lucide/vue'
import {
  workbenchCreateCredentialActionRef, workbenchRotateCredentialActionRef, workbenchDeleteCredentialActionRef,
  type WorkbenchCredential, type WorkbenchCredentialType, type WorkbenchCredentialMutationResult,
  type WorkbenchCreateCredentialInput, type WorkbenchRotateCredentialInput,
  type WorkbenchDeleteCredentialInput, type WorkbenchDeleteCredentialResult,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'
import { defineSetupComponent } from './vue-component.js'

interface Props {
  client?: WorkbenchConsoleClient
  credential?: WorkbenchCredential
  types: WorkbenchCredentialType[]
  encryptionConfigured: boolean
  onClose(): void
  onChanged(): void
}

function message(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  switch (code) {
    case 'CREDENTIAL_VERSION_CONFLICT': return 'workbench.credentialConflict'
    case 'CREDENTIAL_IN_USE': return 'workbench.credentialBound'
    case 'CREDENTIAL_NOT_FOUND': return 'workbench.credentialGone'
    case 'CREDENTIAL_KEY_UNAVAILABLE': return 'workbench.credentialKeyMissing'
    case 'CREDENTIAL_TYPE_UNAVAILABLE': return 'workbench.credentialTypeMissing'
    case 'CREDENTIAL_INVALID': return 'workbench.credentialInvalid'
    default: return 'workbench.credentialFailed'
  }
}

const typeKey = (type: { id: string; version: number }) => `${type.id}@${type.version}`

export const CredentialConfigurationPanel = defineSetupComponent<Props>('CredentialConfigurationPanel',
  ['client', 'credential', 'types', 'encryptionConfigured', 'onClose', 'onChanged'], props => {
    // Capture the version on open; background refresh must never silently rebase a secret write.
    const original = props.credential
    const name = ref(original?.name ?? '')
    const selectedKey = ref(original ? `${original.typeId}@${original.typeVersion}` : props.types[0] ? typeKey(props.types[0]) : '')
    const values = ref<Record<string, string>>({})
    const pending = ref(false)
    const error = ref<string>()
    const invalidField = ref('')
    const confirmDelete = ref(false)
    const lifecycle = new AbortController()
    onBeforeUnmount(() => { lifecycle.abort(); values.value = {} })
    const selected = computed(() => props.types.find(type => typeKey(type) === selectedKey.value))
    const canSave = computed(() => !!props.client && props.encryptionConfigured && !!selected.value?.secretSchemaSupported
      && !!name.value.trim() && !pending.value
      && selected.value.secretFields.every(field => !field.required || !!values.value[field.name]?.length))
    const save = async () => {
      if (!canSave.value || !props.client || !selected.value) return
      const secret: Record<string, NumenValue> = Object.create(null) as Record<string, NumenValue>
      for (const field of selected.value.secretFields) {
        const raw = values.value[field.name]
        if (raw === undefined || raw === '') continue
        try {
          const value: unknown = field.type === 'string' ? raw : JSON.parse(raw)
          if (!isNumenValue(value) || (field.type !== 'json' && typeof value !== field.type)) throw new Error()
          secret[field.name] = value
        } catch {
          invalidField.value = field.label
          error.value = `workbench.invalidCredentialField.${field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'json'}`
          return
        }
      }
      pending.value = true
      error.value = undefined
      try {
        if (original) {
          await props.client.action<WorkbenchRotateCredentialInput, WorkbenchCredentialMutationResult>(workbenchRotateCredentialActionRef, {
            credentialId: original.id, expectedSecretVersion: original.secretVersion, secret,
          }, lifecycle.signal)
        } else {
          await props.client.action<WorkbenchCreateCredentialInput, WorkbenchCredentialMutationResult>(workbenchCreateCredentialActionRef, {
            name: name.value, typeId: selected.value.id, typeVersion: selected.value.version, secret,
          }, lifecycle.signal)
        }
        if (!lifecycle.signal.aborted) { values.value = {}; props.onChanged() }
      } catch (nextError) {
        if (!lifecycle.signal.aborted) error.value = message(nextError)
      } finally {
        for (const key of Object.keys(secret)) delete secret[key]
        pending.value = false
      }
    }
    const remove = async () => {
      if (!original || !props.client || pending.value || !confirmDelete.value) return
      pending.value = true
      error.value = undefined
      try {
        await props.client.action<WorkbenchDeleteCredentialInput, WorkbenchDeleteCredentialResult>(workbenchDeleteCredentialActionRef, {
          credentialId: original.id, expectedSecretVersion: original.secretVersion,
        }, lifecycle.signal)
        if (!lifecycle.signal.aborted) { values.value = {}; props.onChanged() }
      } catch (nextError) {
        if (!lifecycle.signal.aborted) { error.value = message(nextError); confirmDelete.value = false }
      } finally { pending.value = false }
    }
    return () => <aside aria-label={t('workbench.credentialConfiguration')} class="connection-config-panel credential-config-panel">
      <header><div><h2>{original ? t('workbench.manageCredential') : t('workbench.newCredential')}</h2><p>{original ? t('workbench.value0VersionValue1', { value0: original.name, value1: original.secretVersion }) : t('workbench.storeAnEncryptedSecretForConnections')}</p></div>
        <button aria-label={t('workbench.closeCredentialConfiguration')} class="icon-button" onClick={props.onClose} type="button"><X size={16} /></button>
      </header>
      <form autocomplete="off" onSubmit={event => { event.preventDefault(); void save() }}>
        <label class="connection-config-field"><span>{t('workbench.name')}</span><input aria-label={t('workbench.credentialName')} autocomplete="off" disabled={!!original || pending.value} maxlength="120" value={name.value} onInput={event => { name.value = (event.target as HTMLInputElement).value }} type="text" /></label>
        <label class="connection-config-field"><span>{t('workbench.credentialType')}</span><select aria-label={t('workbench.credentialType')} disabled={!!original || pending.value} value={selectedKey.value} onChange={event => { selectedKey.value = (event.target as HTMLSelectElement).value; values.value = {}; error.value = undefined }}>
          {!selected.value ? <option value={selectedKey.value}>{original ? t('workbench.value0Value1Unavailable', { value0: original.typeId, value1: original.typeVersion }) : t('workbench.noTypesAvailable')}</option> : null}
          {props.types.map(type => <option key={typeKey(type)} value={typeKey(type)}>{type.title} · v{type.version}</option>)}
        </select></label>
        <p class="connection-config-notice">{original ? t('workbench.enterACompleteReplacementSecretCurrentValuesCannotBeReadBack') : t('workbench.secretFieldsAreSubmittedOnlyWhenYouCreateThisCredential')}</p>
        {!props.encryptionConfigured ? <p class="connection-config-notice">{t('workbench.configureRuntimeCredentialEncryptionBeforeCreatingOrRotatingSecrets')}</p> : null}
        {!selected.value ? <p class="connection-config-notice">{t('workbench.restoreTheCredentialTypePluginToEditSecrets')}</p>
          : !selected.value.secretSchemaSupported ? <p class="connection-config-notice">{t('workbench.thisTypeRequiresAPluginProvidedEditor')}</p>
          : selected.value.secretFields.map(field => <label class="connection-config-field" key={`${selectedKey.value}:${field.name}`}>
            <span>{field.label}{field.required ? <em>{t('workbench.required')}</em> : null}</span>
            <input aria-label={field.label} autocomplete="new-password" spellcheck={false} type="password" disabled={pending.value || !props.encryptionConfigured}
              value={values.value[field.name] ?? ''} onInput={event => { values.value = { ...values.value, [field.name]: (event.target as HTMLInputElement).value } }} />
            {field.type !== 'string' ? <small>{field.type === 'boolean' ? t('workbench.enterTrueOrFalse') : field.type === 'number' ? t('workbench.enterANumber') : t('workbench.enterAJsonValue')}</small> : null}
          </label>)}
        {error.value ? <p class="connection-config-error" role="alert">{t(error.value, { field: invalidField.value })}</p> : null}
        <footer>
          {original ? confirmDelete.value ? <span class="connection-delete-confirm"><span>{t('workbench.deleteThisCredentialPermanently')}</span><button disabled={pending.value} onClick={() => { confirmDelete.value = false }} type="button">{t('workbench.cancel')}</button><button class="danger-button" disabled={pending.value} onClick={() => { void remove() }} type="button">{t('workbench.deleteCredential')}</button></span>
            : <button class="danger-text-button" disabled={pending.value || original.connectionCount > 0} onClick={() => { confirmDelete.value = true }} type="button">{t('workbench.delete')}</button> : <span />}
          {!confirmDelete.value ? <button class="primary-button" disabled={!canSave.value} type="submit">{pending.value ? t('workbench.saving') : original ? t('workbench.rotateSecret') : t('workbench.createCredential')}</button> : null}
        </footer>
        {original?.connectionCount ? <p class="connection-config-notice">{t('workbench.usedBy')}{original.connectionCount}{t('workbench.connection2')}{original.connectionCount === 1 ? '' : 's'}{t('workbench.removeThoseBindingsBeforeDeletion')}</p> : null}
      </form>
    </aside>
  })
