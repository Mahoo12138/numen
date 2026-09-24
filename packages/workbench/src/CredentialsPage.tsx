import { Button } from '@numenjs/components'
import { diagnosticText, t } from './i18n.js'
import { KeyRound, Plus } from '@lucide/vue'
import { shallowRef } from 'vue'
import { CredentialConfigurationPanel } from './CredentialConfigurationPanel.js'
import { workbenchCredentialsIndexQueryRef, type WorkbenchCredential, type WorkbenchCredentialsIndex } from './contracts.js'
import { coreWorkbenchRoutes } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

const emptyInput = {}
export const CredentialsPage = defineSetupComponent<WorkbenchPageProps>('CredentialsPage', ['consoleClient', 'navigation'], props => {
  const [state, reload, refresh] = useConsoleQuery<Record<string, never>, WorkbenchCredentialsIndex>(
    () => props.consoleClient, workbenchCredentialsIndexQueryRef, emptyInput, 'credentials',
  )
  const configuration = shallowRef<'create' | WorkbenchCredential>()
  return () => <main class="main-workbench core-page">
    <header class="core-page-header"><KeyRound size={22} /><div><h1>{t('workbench.credentials')}</h1><p>{t('workbench.manageEncryptedSecretsUsedByConnections')}</p></div></header>
    <div class="credential-navigation"><Button variant="secondary" class="secondary-button" disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections)} type="button">{t('workbench.backToConnections')}</Button></div>
    {state.status === 'DISABLED' ? <section class="core-page-section core-page-empty"><p>{t('workbench.openWorkbenchFromARunningNumenRuntimeToManageCredentials')}</p></section>
      : state.status === 'LOADING' ? <section class="core-page-section core-page-empty" aria-busy="true"><p>{t('workbench.loadingCredentialMetadata')}</p></section>
      : state.status === 'ERROR' ? <section class="core-page-section core-page-empty"><p role="alert">{t('workbench.credentialsUnavailable')}{diagnosticText(state)}</p><Button variant="secondary" class="secondary-button" onClick={reload} type="button">{t('workbench.tryAgain')}</Button></section>
      : <>
        {!state.data.encryptionConfigured ? <p class="credential-notice">{t('workbench.credentialEncryptionIsNotConfiguredExistingMetadataIsAvailableConfigureTheRuntimeMasterKeyTo')}</p> : null}
        <div class="connections-workspace" data-configuring={!!configuration.value}>
          <section class="core-page-section connections-section">
            <div class="runs-section-heading connection-section-heading"><div><h2>{t('workbench.storedCredentials')}</h2><span>{state.data.items.length}{t('workbench.configuredMetadataOnly')}</span></div>
              <Button variant="secondary" class="secondary-button" disabled={!state.data.encryptionConfigured || !state.data.types.length} onClick={() => { configuration.value = 'create' }} type="button"><Plus size={14} />{t('workbench.newCredential')}</Button></div>
            {state.data.items.length ? <div class="runs-table-wrap credentials-table-wrap"><table class="runs-table credentials-table">
              <thead><tr><th>{t('workbench.credential')}</th><th>{t('workbench.type')}</th><th>{t('workbench.version')}</th><th>{t('workbench.connections')}</th><th><span class="visually-hidden">{t('workbench.actions')}</span></th></tr></thead>
              <tbody>{state.data.items.map(credential => <tr key={credential.id}>
                <td><strong>{credential.name}</strong><small>{credential.typeAvailable ? t('workbench.configured') : t('workbench.typeUnavailable')}</small></td>
                <td><strong>{credential.typeTitle}</strong><small>{credential.typeId}@{credential.typeVersion}</small></td>
                <td>v{credential.secretVersion}</td><td>{credential.connectionCount}</td>
                <td><Button variant="secondary" class="secondary-button" aria-label={t('workbench.manageValue0', { value0: credential.name })} onClick={() => { configuration.value = credential }} type="button">{t('workbench.manage')}</Button></td>
              </tr>)}</tbody>
            </table></div> : <div class="connection-empty"><p>{t('workbench.noCredentialsStoredYet')}</p>{!state.data.types.length ? <p>{t('workbench.enableAPluginThatDefinesACredentialTypeToGetStarted')}</p> : null}</div>}
          </section>
          {configuration.value ? <CredentialConfigurationPanel key={configuration.value === 'create' ? 'create' : configuration.value.id}
            {...(props.consoleClient ? { client: props.consoleClient } : {})}
            {...(configuration.value !== 'create' ? { credential: configuration.value } : {})}
            types={state.data.types} encryptionConfigured={state.data.encryptionConfigured}
            onClose={() => { configuration.value = undefined }} onChanged={() => { configuration.value = undefined; refresh() }}
          /> : null}
        </div>
      </>}
  </main>
})
