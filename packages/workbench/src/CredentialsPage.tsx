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
    <header class="core-page-header"><KeyRound size={22} /><div><h1>Credentials</h1><p>Manage encrypted secrets used by Connections.</p></div></header>
    <div class="credential-navigation"><button class="secondary-button" disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections)} type="button">Back to Connections</button></div>
    {state.status === 'DISABLED' ? <section class="core-page-section core-page-empty"><p>Open Workbench from a running Numen Runtime to manage Credentials.</p></section>
      : state.status === 'LOADING' ? <section class="core-page-section core-page-empty" aria-busy="true"><p>Loading Credential metadata…</p></section>
      : state.status === 'ERROR' ? <section class="core-page-section core-page-empty"><p role="alert">Credentials unavailable. {state.message}</p><button class="secondary-button" onClick={reload} type="button">Try again</button></section>
      : <>
        {!state.data.encryptionConfigured ? <p class="credential-notice">Credential encryption is not configured. Existing metadata is available; configure the runtime master key to create or rotate secrets.</p> : null}
        <div class="connections-workspace" data-configuring={!!configuration.value}>
          <section class="core-page-section connections-section">
            <div class="runs-section-heading connection-section-heading"><div><h2>Stored Credentials</h2><span>{state.data.items.length} configured · metadata only</span></div>
              <button class="secondary-button" disabled={!state.data.encryptionConfigured || !state.data.types.length} onClick={() => { configuration.value = 'create' }} type="button"><Plus size={14} />New Credential</button></div>
            {state.data.items.length ? <div class="runs-table-wrap credentials-table-wrap"><table class="runs-table credentials-table">
              <thead><tr><th>Credential</th><th>Type</th><th>Version</th><th>Connections</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody>{state.data.items.map(credential => <tr key={credential.id}>
                <td><strong>{credential.name}</strong><small>{credential.typeAvailable ? 'Configured' : 'Type unavailable'}</small></td>
                <td><strong>{credential.typeTitle}</strong><small>{credential.typeId}@{credential.typeVersion}</small></td>
                <td>v{credential.secretVersion}</td><td>{credential.connectionCount}</td>
                <td><button class="secondary-button" aria-label={`Manage ${credential.name}`} onClick={() => { configuration.value = credential }} type="button">Manage</button></td>
              </tr>)}</tbody>
            </table></div> : <div class="connection-empty"><p>No Credentials stored yet.</p>{!state.data.types.length ? <p>Enable a plugin that defines a Credential type to get started.</p> : null}</div>}
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
