import type { HostPluginEntry } from '@numenjs/config'
import { t } from './i18n.js'

export function PluginDetails({ entry }: { entry: HostPluginEntry }) {
  return <section class="plugin-instance-facts" aria-label={t('workbench.pluginConfig.details')}>
    <h2>{entry.label || entry.id}</h2>
    <dl>
      <div><dt>{t('workbench.pluginConfig.instanceId')}</dt><dd><code>{entry.id}</code></dd></div>
      <div><dt>{t('workbench.management.source')}</dt><dd>{entry.group ? t('workbench.management.group') : entry.name}</dd></div>
      {!entry.group ? <div><dt>{t('workbench.pluginConfig.package')}</dt><dd>{entry.packageName} · {entry.packageVersion ?? t('workbench.management.versionUnknown')} · {t(entry.installed === true ? 'workbench.management.installed' : entry.installed === false ? 'workbench.management.notInstalled' : 'workbench.management.installUnknown')}</dd></div> : null}
      <div><dt>{t('workbench.pluginConfig.state')}</dt><dd>{t(`workbench.management.state.${entry.actualState}`)}</dd></div>
      <div><dt>{t('workbench.pluginConfig.intent')}</dt><dd>{t(entry.selfEnabled ? 'workbench.management.desiredOn' : 'workbench.management.desiredOff')} · {t(entry.effectiveEnabled ? 'workbench.management.effectiveOn' : entry.selfEnabled && entry.parentId ? 'workbench.management.parentDisabled' : 'workbench.management.effectiveOff')}</dd></div>
      <div><dt>{t('workbench.management.parent')}</dt><dd>{entry.parentId ?? t('workbench.management.root')}</dd></div>
    </dl>
    {entry.protected ? <p class="plugin-protected">{t('workbench.management.protected')}</p> : null}
    {entry.configReadOnlyReason ? <p class="plugin-config-readonly">{entry.configReadOnlyReason}</p> : null}
    {entry.internal.length ? <details class="plugin-internal"><summary>{t('workbench.management.internal', { count: entry.internal.length })}</summary>
      <ul>{entry.internal.map(child => <li key={child.diagnosticId}><strong>{child.name}</strong><span>{t(`workbench.management.state.${child.state}`)}</span><small>{child.dependencies.join(', ')}</small></li>)}</ul>
    </details> : null}
  </section>
}
