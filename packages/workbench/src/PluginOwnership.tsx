import { Button } from '@numenjs/components'
import { computed, ref } from 'vue'
import { diagnosticText, t } from './i18n.js'
import { workbenchPluginOwnershipRef, type WorkbenchOwnershipInput, type WorkbenchOwnershipResult } from './management-contracts.js'
import { coreWorkbenchRoutes } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export const PluginOwnership = defineSetupComponent<WorkbenchPageProps & { target: WorkbenchOwnershipInput }>('PluginOwnership', ['consoleClient', 'navigation', 'target'], props => {
  const open = ref(false)
  // Stable value identity avoids restarting the request on every parent render.
  const encoded = computed(() => JSON.stringify(props.target))
  const input = computed<WorkbenchOwnershipInput>(() => JSON.parse(encoded.value))
  const [query, reload] = useConsoleQuery<WorkbenchOwnershipInput, WorkbenchOwnershipResult>(() => open.value ? props.consoleClient : undefined,
    workbenchPluginOwnershipRef, input, ['plugins', 'connections', 'runs'])
  const locate = (entryId: string) => {
    const navigation = props.navigation
    if (navigation) navigation.navigate(coreWorkbenchRoutes.plugins, { query: { entryId, from: props.target.kind === 'connection'
      ? `/connections?${new URLSearchParams({ connectionId: props.target.connectionId })}` : navigation.route.pathname + navigation.route.search } })
  }
  return () => <details class="plugin-ownership" onToggle={event => { open.value = (event.target as HTMLDetailsElement).open }}>
    <summary>{t('workbench.ownership.inspect')}</summary>
    {open.value ? <div class="plugin-ownership-content">
      <p>{t('workbench.ownership.scope')}</p>
      {query.status === 'LOADING' ? <p role="status">{t('workbench.management.loading')}</p> : null}
      {query.status === 'DISABLED' ? <p>{t('workbench.management.unavailable')}</p> : null}
      {query.status === 'ERROR' ? <p role="alert">{diagnosticText(query)} <Button onClick={reload} type="button">{t('workbench.tryAgain')}</Button></p> : null}
      {query.status === 'READY' ? query.data.missingConnectionIds.map(id => <p role="status" key={id}>{t('workbench.ownership.connectionMissing', { id })}</p>) : null}
      {query.status === 'READY' ? query.data.registrations.length ? query.data.registrations.map(registration => <section key={`${registration.kind}:${registration.id}@${registration.version}`}>
        <strong>{t(`workbench.ownership.kind.${registration.kind}`)} · {registration.id}@{registration.version}</strong>
        {registration.owners.map(owner => <div class="plugin-owner" key={owner.role}>
          <span>{t(`workbench.ownership.role.${owner.role}`)} · {t(`workbench.ownership.evidence.${owner.evidence}`)}</span>
          {owner.entry ? <>
            <Button type="button" onClick={() => locate(owner.entry!.id)}>{t('workbench.ownership.open', { name: owner.entry.label || owner.entry.id })}</Button>
            <small>{t(`workbench.management.state.${owner.entry.actualState}`)}</small>
            {owner.ancestors.filter(ancestor => !ancestor.selfEnabled).map(ancestor => <div class="plugin-owner-cause" key={ancestor.id}>
              <span>{t('workbench.ownership.disabledGroup')}</span><Button type="button" onClick={() => locate(ancestor.id)}>{ancestor.label || ancestor.id}</Button>
            </div>)}
          </> : <small>{t(`workbench.ownership.reason.${owner.reason ?? 'not-observed'}`)}</small>}
        </div>)}
      </section>) : <p>{t('workbench.ownership.noRegistrations')}</p> : null}
    </div> : null}
  </details>
})
