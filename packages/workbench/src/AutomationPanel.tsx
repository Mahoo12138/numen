import type { CompileDiagnostic } from '@numen/core'
import { AlertTriangle, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AutomationDraftSavePhase } from './useAutomationDraftDocument.js'

const panelTabs = ['Problems', 'Preview', 'Logs'] as const

export function AutomationPanel({ problems, preview = false, onProblemSelect }: {
  problems: CompileDiagnostic[]
  preview?: boolean
  onProblemSelect(nodeId: string): void
}) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('Problems')
  const problemCount = preview ? 1 : problems.length

  useEffect(() => {
    if (problems.length) {
      setActiveTab('Problems')
      setOpen(true)
    }
  }, [problems.length])

  return (
    <section className="bottom-panel" data-open={open} aria-label="Bottom panel">
      <div className="panel-tablist" role="tablist">
        {panelTabs.map(tab => (
          <button
            aria-selected={activeTab === tab}
            data-active={activeTab === tab}
            key={tab}
            onClick={() => { setActiveTab(tab); setOpen(true) }}
            role="tab"
            type="button"
          >{tab}{tab === 'Problems' ? <span className="problem-count">{problemCount}</span> : null}</button>
        ))}
        <button
          aria-label={open ? 'Collapse bottom panel' : 'Expand bottom panel'}
          className="panel-toggle"
          onClick={() => setOpen(value => !value)}
          type="button"
        >⌃</button>
      </div>
      {open ? (
        <div className="panel-content automation-panel-content">
          {activeTab === 'Problems' ? (
            problems.length ? problems.map((problem, index) => (
              <button
                className="automation-problem"
                key={`${problem.code}:${problem.source?.nodeId ?? ''}:${problem.source?.fieldPath ?? ''}:${index}`}
                onClick={() => problem.source?.nodeId && onProblemSelect(problem.source.nodeId)}
                type="button"
              >
                <AlertTriangle aria-hidden="true" size={14} />
                <span><strong>{problem.code}</strong><small>{problem.message}</small></span>
                <code>{[problem.source?.nodeId, problem.source?.fieldPath].filter(Boolean).join(' · ') || 'Automation'}</code>
              </button>
            )) : <p>No publish problems for the current local Draft.</p>
          ) : <p>{activeTab} output will appear here.</p>}
        </div>
      ) : null}
    </section>
  )
}

export function AutomationStatusBar({ phase, message, problemCount, preview = false }: {
  phase: AutomationDraftSavePhase
  message: string
  problemCount: number
  preview?: boolean
}) {
  const needsAttention = phase === 'CONFLICT' || phase === 'ERROR'
  return (
    <footer className="status-bar" data-save-phase={phase}>
      <span className={problemCount || needsAttention ? 'problem-status' : 'ready-status'}>
        <span className="status-check">{problemCount || needsAttention ? '!' : '✓'}</span>
        {problemCount
          ? `${problemCount} publish problem${problemCount === 1 ? '' : 's'}`
          : needsAttention ? 'Draft needs attention' : 'Ready'}
      </span>
      <span><Save size={14} />{preview ? 'Saved' : message}</span>
    </footer>
  )
}
