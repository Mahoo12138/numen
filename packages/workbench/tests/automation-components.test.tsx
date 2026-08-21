import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AutomationEditor } from '../src/AutomationEditor.js'
import { AutomationSidebar } from '../src/AutomationSidebar.js'
import { projectAutomationSteps } from '../src/automation-projection.js'
import type { WorkbenchAutomationDetail, WorkbenchAutomationsIndex } from '../src/contracts.js'

const detail: WorkbenchAutomationDetail = {
  automation: {
    id: 'auto_11111111111111111111111111111111',
    name: 'Live Automation',
    enabled: true,
    activeRevisionId: 'rev_1',
    activationGeneration: 2,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:01:00.000Z',
  },
  draft: {
    source: {
      triggers: [],
      flow: {
        type: 'block',
        id: 'root',
        steps: [{
          type: 'wait',
          id: 'pause',
          durationMs: { type: 'literal', value: 5_000 },
        }],
      },
    },
    presentation: {},
    version: 3,
    updatedAt: '2026-08-21T00:01:00.000Z',
  },
  revisions: [{
    id: 'rev_1',
    number: 1,
    contentHash: 'abc123',
    active: true,
    createdAt: '2026-08-21T00:00:30.000Z',
  }],
}

const index: WorkbenchAutomationsIndex = {
  summary: { total: 1, enabled: 1, published: 1 },
  items: [{
    ...detail.automation,
    draftVersion: detail.draft.version,
    revisionCount: 1,
    latestRevisionNumber: 1,
  }],
}

describe('live Automation workspace projections', () => {
  it('renders the live Sidebar summary without static preview records', () => {
    const markup = renderToStaticMarkup(<AutomationSidebar
      activeId={detail.automation.id}
      onChange={vi.fn()}
      state={{ status: 'READY', data: index }}
    />)

    expect(markup).toContain('Live Automation')
    expect(markup).toContain('Draft v3 · 1 revision')
    expect(markup).not.toContain('Morning Brief')
  })

  it('renders Draft and immutable Revision data from the typed detail projection', () => {
    const steps = projectAutomationSteps(detail.draft.source)
    const editor = (activeTab: string) => renderToStaticMarkup(<AutomationEditor
      activeTab={activeTab}
      activeStepId={steps[0]!.id}
      automationId={detail.automation.id}
      automations={index.items}
      detailState={{ status: 'READY', data: detail }}
      onAutomationChange={vi.fn()}
      onOpenInspector={vi.fn()}
      onStepChange={vi.fn()}
      onTabChange={vi.fn()}
      steps={steps}
    />)

    const editorMarkup = editor('Editor')
    expect(editorMarkup).toContain('Live Automation')
    expect(editorMarkup).toContain('Draft v3')
    expect(editorMarkup).toContain('Published r1')
    expect(editorMarkup).toContain('Pause')
    expect(editorMarkup).toContain('aria-label="Select automation"')
    expect(editor('Revisions')).toContain('abc123')
  })
})
