import { PanelResizeHandle } from './PanelResizeHandle.js'
import { useWorkbenchLayout } from './workbench-layout.js'
import { LogsView, type LogsViewProps } from './LogsView.js'
import { diagnosticText, t, plural } from './i18n.js'
import type { CompileDiagnostic, SourceRef } from '@numenjs/core'
import { AlertTriangle, Save } from '@lucide/vue'
import { ref, watch } from 'vue'
import type { AutomationDraftSavePhase } from './useAutomationDraftDocument.js'
import { defineSetupComponent } from './vue-component.js'
import { useCommandRegistration } from './commands.js'

const panelTabs = ['Problems', 'Logs'] as const

interface AutomationPanelProps extends Pick<LogsViewProps, 'consoleClient' | 'automationId'> {
  problems: CompileDiagnostic[]
  preview?: boolean
  onProblemSelect(source: SourceRef): void
}

export const AutomationPanel = defineSetupComponent<AutomationPanelProps>('AutomationPanel', ['problems', 'preview', 'onProblemSelect', 'consoleClient', 'automationId'], props => {
  const open = useWorkbenchLayout()?.panelOpen ?? ref(false)
  const activeTab = ref('Problems')
  const commands = useCommandRegistration(() => panelTabs.map(tab => ({
    id: `automation.panel.${tab}`, label: t('workbench.commands.showPanel', { panel: t(`workbench.tabs.${tab}`) }),
    execute: () => { activeTab.value = tab; open.value = true },
  })))

  watch(() => props.problems.length, (length) => {
    if (length) {
      activeTab.value = 'Problems'
      open.value = true
    }
  })

  return () => {
    const problemCount = props.problems.length
    return <section class="bottom-panel" data-open={open.value} aria-label={t('workbench.bottomPanel')}>
      <PanelResizeHandle />
      <div class="panel-tablist" role="tablist">
        {panelTabs.map(tab => (
          <button
            aria-selected={activeTab.value === tab}
            data-active={activeTab.value === tab}
            key={tab}
            onClick={() => { if (commands) commands.execute(`automation.panel.${tab}`); else { activeTab.value = tab; open.value = true } }}
            role="tab"
            type="button"
          >{t(`workbench.tabs.${tab}`)}{tab === 'Problems' ? <span class="problem-count">{problemCount}</span> : null}</button>
        ))}
        <button
          aria-label={open.value ? t('workbench.collapseBottomPanel') : t('workbench.expandBottomPanel')}
          class="panel-toggle"
          onClick={() => { if (commands?.find('workbench.panel')) commands.execute('workbench.panel'); else open.value = !open.value }}
          type="button"
        >⌃</button>
      </div>
      {open.value ? (
        <div class={['panel-content automation-panel-content', activeTab.value === 'Logs' && 'logs-panel-content']}>
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
          ) : <LogsView compact {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})} {...(props.automationId ? { automationId: props.automationId } : {})} />}
        </div>
      ) : null}
    </section>
  }
})

export function AutomationStatusBar({ phase, message, problemCount, preview = false, pendingInput = false }: {
  phase: AutomationDraftSavePhase
  message: string
  problemCount: number
  preview?: boolean
  pendingInput?: boolean
}) {
  const needsAttention = phase === 'CONFLICT' || phase === 'ERROR'
  return (
    <footer class="status-bar" data-save-phase={phase} data-input-pending={pendingInput}>
      <span class={problemCount || needsAttention ? 'problem-status' : 'ready-status'}>
        <span class="status-check">{problemCount || needsAttention ? '!' : '✓'}</span>
        {problemCount
          ? plural('workbench.publishProblems', problemCount)
          : needsAttention ? t('workbench.draftNeedsAttention') : pendingInput ? t('workbench.document.editingInput') : preview ? t('workbench.commands.preview') : phase === 'UNAVAILABLE' ? t('workbench.commands.noDocument') : t('workbench.commands.noProblems')}
      </span>
      {!preview && phase !== 'UNAVAILABLE' ? <span title={pendingInput ? t('workbench.document.unappliedInput') : undefined}><Save size={14} />{pendingInput ? t('workbench.document.unappliedInputShort') : t(`workbench.save.${phase}`)}</span> : null}
    </footer>
  )
}
