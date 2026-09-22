import { diagnosticText, t, plural } from './i18n.js'
import type { CompileDiagnostic, SourceRef } from '@numen/core'
import { AlertTriangle, Save } from '@lucide/vue'
import { ref, watch } from 'vue'
import type { AutomationDraftSavePhase } from './useAutomationDraftDocument.js'
import { defineSetupComponent } from './vue-component.js'

const panelTabs = ['Problems', 'Preview', 'Logs'] as const

interface AutomationPanelProps {
  problems: CompileDiagnostic[]
  preview?: boolean
  onProblemSelect(source: SourceRef): void
}

export const AutomationPanel = defineSetupComponent<AutomationPanelProps>('AutomationPanel', ['problems', 'preview', 'onProblemSelect'], props => {
  const open = ref(false)
  const activeTab = ref('Problems')

  watch(() => props.problems.length, (length) => {
    if (length) {
      activeTab.value = 'Problems'
      open.value = true
    }
  })

  return () => {
    const problemCount = props.preview ? 1 : props.problems.length
    return <section class="bottom-panel" data-open={open.value} aria-label={t('workbench.bottomPanel')}>
      <div class="panel-tablist" role="tablist">
        {panelTabs.map(tab => (
          <button
            aria-selected={activeTab.value === tab}
            data-active={activeTab.value === tab}
            key={tab}
            onClick={() => { activeTab.value = tab; open.value = true }}
            role="tab"
            type="button"
          >{t(`workbench.tabs.${tab}`)}{tab === 'Problems' ? <span class="problem-count">{problemCount}</span> : null}</button>
        ))}
        <button
          aria-label={open.value ? t('workbench.collapseBottomPanel') : t('workbench.expandBottomPanel')}
          class="panel-toggle"
          onClick={() => { open.value = !open.value }}
          type="button"
        >⌃</button>
      </div>
      {open.value ? (
        <div class="panel-content automation-panel-content">
          {activeTab.value === 'Problems' ? (
            props.problems.length ? props.problems.map((problem, index) => (
              <button
                class="automation-problem"
                key={`${problem.code}:${problem.source?.nodeId ?? ''}:${problem.source?.fieldPath ?? ''}:${index}`}
                onClick={() => problem.source && props.onProblemSelect(problem.source)}
                type="button"
              >
                <AlertTriangle aria-hidden="true" size={14} />
                <span><strong>{problem.code}</strong><small>{diagnosticText(problem)}</small></span>
                <code>{[problem.source?.nodeId, problem.source?.fieldPath].filter(Boolean).join(' · ') || t('workbench.automation')}</code>
              </button>
            )) : <p>{t('workbench.noPublishProblemsForTheCurrentLocalDraft')}</p>
          ) : <p>{t('workbench.panelOutput', { panel: t(`workbench.tabs.${activeTab.value}`) })}</p>}
        </div>
      ) : null}
    </section>
  }
})

export function AutomationStatusBar({ phase, message, problemCount, preview = false }: {
  phase: AutomationDraftSavePhase
  message: string
  problemCount: number
  preview?: boolean
}) {
  const needsAttention = phase === 'CONFLICT' || phase === 'ERROR'
  return (
    <footer class="status-bar" data-save-phase={phase}>
      <span class={problemCount || needsAttention ? 'problem-status' : 'ready-status'}>
        <span class="status-check">{problemCount || needsAttention ? '!' : '✓'}</span>
        {problemCount
          ? plural('workbench.publishProblems', problemCount)
          : needsAttention ? t('workbench.draftNeedsAttention') : t('workbench.ready')}
      </span>
      <span><Save size={14} />{preview ? t('workbench.saved') : t(`workbench.save.${phase}`)}</span>
    </footer>
  )
}
