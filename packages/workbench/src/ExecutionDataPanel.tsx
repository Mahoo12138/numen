import { Button } from '@numenjs/components'
import { t } from './i18n.js'
import type { ExecutionDataState } from './useExecutionData.js'

export function ExecutionDataPanel({ state, onClose, onLocate }: {
  state: ExecutionDataState
  onClose(): void
  onLocate(sourceNodeId: string): void
}) {
  if (state.status === 'CLOSED') return null
  return <section class="run-data-panel" aria-label={t('workbench.runData.title')} tabindex={-1}
    onKeydown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><h2>{t('workbench.runData.title')}</h2><Button onClick={onClose} type="button">{t('workbench.runData.close')}</Button></header>
    <p>{t('workbench.runData.boundary')}</p>
    {state.status === 'LOADING' ? <p role="status">{t('workbench.runData.loading')}</p> : null}
    {state.status === 'ERROR' ? <p role="alert">{t('workbench.runData.failed')}</p> : null}
    {state.status === 'READY' ? <>
      <p class="run-data-provenance">{t('workbench.runData.current')}{state.data.attempt ? ` · ${t('workbench.attempt2')}${state.data.attempt.number}` : ''}</p>
      {state.data.sourceNodeId ? <Button onClick={() => onLocate(state.data.sourceNodeId!)} type="button">{t('workbench.runData.locate')}</Button> : null}
      <div class="run-data-values">{(['input', 'output'] as const).map(side => <section key={side}>
        <h3>{t(`workbench.runData.${side}`)}</h3>
        <p>{state.data[side].hidden ? t('workbench.runData.hidden', { count: state.data[side].hidden }) : null}
          {state.data[side].truncated ? ` ${t('workbench.runData.truncated')}` : null}</p>
        <pre>{JSON.stringify(state.data[side].value, null, 2)}</pre>
      </section>)}</div>
    </> : null}
  </section>
}
