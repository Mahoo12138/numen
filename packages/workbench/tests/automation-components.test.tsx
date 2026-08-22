import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AutomationEditor } from '../src/AutomationEditor.js'
import { AutomationPanel, AutomationStatusBar } from '../src/AutomationPanel.js'
import { Inspector } from '../src/Inspector.js'
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

  it('renders authoring actions and separates published from active state', () => {
    const inactiveDetail: WorkbenchAutomationDetail = {
      ...detail,
      automation: {
        id: detail.automation.id,
        name: detail.automation.name,
        enabled: detail.automation.enabled,
        activationGeneration: detail.automation.activationGeneration,
        createdAt: detail.automation.createdAt,
        updatedAt: detail.automation.updatedAt,
      },
      revisions: detail.revisions.map(revision => ({ ...revision, active: false })),
    }
    const steps = projectAutomationSteps(inactiveDetail.draft.source)
    const markup = renderToStaticMarkup(<AutomationEditor
      activeTab="Editor"
      activeStepId={steps[0]!.id}
      automationId={inactiveDetail.automation.id}
      authoring={{
        canEdit: true,
        canPublish: true,
        canUndo: true,
        canRedo: false,
        publishPending: false,
      }}
      detailState={{ status: 'READY', data: inactiveDetail }}
      onAddWaitStep={vi.fn()}
      onOpenInspector={vi.fn()}
      onPublish={vi.fn()}
      onStepChange={vi.fn()}
      onTabChange={vi.fn()}
      steps={steps}
    />)

    expect(markup).toContain('Published r1')
    expect(markup).toContain('Not active')
    expect(markup).toContain('>Publish<')
    expect(markup).toContain('Add step')
  })

  it('renders conflict recovery and publish diagnostics in Page-owned regions', () => {
    const editorMarkup = renderToStaticMarkup(<AutomationEditor
      activeTab="Editor"
      activeStepId=""
      automationId={detail.automation.id}
      authoring={{
        canEdit: false,
        canPublish: false,
        canUndo: false,
        canRedo: false,
        publishPending: false,
        conflict: { expectedVersion: 3, actualVersion: 4 },
      }}
      detailState={{ status: 'READY', data: detail }}
      onOpenInspector={vi.fn()}
      onReloadDraft={vi.fn()}
      onStepChange={vi.fn()}
      onTabChange={vi.fn()}
      steps={[]}
    />)
    const panelMarkup = renderToStaticMarkup(<AutomationPanel
      onProblemSelect={vi.fn()}
      problems={[{
        severity: 'error',
        code: 'WAIT_SOURCE_INVALID',
        message: 'Wait duration must be positive.',
        source: { nodeId: 'wait-1', fieldPath: 'durationMs' },
      }]}
    />)
    const statusMarkup = renderToStaticMarkup(<AutomationStatusBar
      message="Draft conflict"
      phase="CONFLICT"
      problemCount={1}
    />)

    expect(editorMarkup).toContain('Draft changed elsewhere.')
    expect(editorMarkup).toContain('Reload server Draft')
    expect(panelMarkup).toContain('problem-count')
    expect(statusMarkup).toContain('1 publish problem')
    expect(statusMarkup).toContain('Draft conflict')
  })

  it('projects editable Wait fields and source diagnostics into the Inspector', () => {
    const steps = projectAutomationSteps(detail.draft.source, [{
      severity: 'error',
      code: 'WAIT_SOURCE_INVALID',
      message: 'Wait duration is invalid.',
      source: { nodeId: 'pause' },
    }])
    const inspectorMarkup = renderToStaticMarkup(<Inspector
      activeStepId={steps[0]!.id}
      canEdit
      fieldFocus={{ nodeId: 'pause', fieldPath: 'durationMs', request: 1 }}
      onClose={vi.fn()}
      onWaitDurationChange={vi.fn()}
      open
      problems={[{
        severity: 'error',
        code: 'WAIT_SOURCE_INVALID',
        message: 'Wait duration is invalid.',
        source: { nodeId: 'pause' },
      }]}
      source={detail.draft.source}
      steps={steps}
    />)

    expect(steps[0]).toMatchObject({ problemCount: 1 })
    expect(inspectorMarkup).toContain('aria-label="Wait duration in seconds"')
    expect(inspectorMarkup).toContain('value="5"')
    expect(inspectorMarkup).toContain('aria-invalid="true"')
    expect(inspectorMarkup).toContain('Wait duration is invalid.')
  })
})
