import { describe, expect, it, vi } from 'vitest'
import { renderToMarkup } from './render.js'
import { AutomationEditor } from '../src/AutomationEditor.js'
import { AutomationPanel, AutomationStatusBar } from '../src/AutomationPanel.js'
import { Inspector } from '../src/Inspector.js'
import { AutomationSidebar } from '../src/AutomationSidebar.js'
import { projectAutomationSteps } from '../src/automation-projection.js'
import { coreSchemaLiteralRenderers } from '../src/SchemaRenderers.js'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import type {
  WorkbenchAutomationDetail,
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationsIndex,
} from '../src/contracts.js'

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

const schemaUI: SchemaUIResolver = {
  getSnapshot: () => 1,
  subscribe: () => () => {},
  resolveRenderer<Renderer>(request, mode): Renderer | undefined {
    if (mode !== 'editor') return
    return coreSchemaLiteralRenderers.find(renderer => renderer.type === request.type)?.editor as Renderer | undefined
  },
}

describe('live Automation workspace projections', () => {
  it('renders the live Sidebar summary without static preview records', async () => {
    const markup = await renderToMarkup(<AutomationSidebar
      activeId={detail.automation.id}
      onChange={vi.fn()}
      state={{ status: 'READY', data: index }}
    />)

    expect(markup).toContain('Live Automation')
    expect(markup).toContain('Draft v3 · 1 revision')
    expect(markup).not.toContain('Morning Brief')
  })

  it('renders an empty Automation state after the live index resolves', async () => {
    const markup = await renderToMarkup(<AutomationEditor
      activeTab="Editor"
      activeStepId=""
      automations={[]}
      detailState={{ status: 'READY', data: null }}
      onOpenInspector={vi.fn()}
      onStepChange={vi.fn()}
      onTabChange={vi.fn()}
      steps={[]}
    />)

    expect(markup).toContain('No automations yet')
    expect(markup).not.toContain('Loading automation')
  })

  it('renders Draft and immutable Revision data from the typed detail projection', async () => {
    const steps = projectAutomationSteps(detail.draft.source)
    const editor = (activeTab: string) => renderToMarkup(<AutomationEditor
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

    const editorMarkup = await editor('Editor')
    expect(editorMarkup).toContain('Live Automation')
    expect(editorMarkup).toContain('Draft v3')
    expect(editorMarkup).toContain('Published r1')
    expect(editorMarkup).toContain('Pause')
    expect(editorMarkup).toContain('aria-label="Select automation"')
    expect(await editor('Revisions')).toContain('abc123')
  })

  it('renders authoring actions and separates published from active state', async () => {
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
    const markup = await renderToMarkup(<AutomationEditor
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
      onInsert={vi.fn()}
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

  it('renders conflict recovery and publish diagnostics in Page-owned regions', async () => {
    const editorMarkup = await renderToMarkup(<AutomationEditor
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
    const panelMarkup = await renderToMarkup(<AutomationPanel
      onProblemSelect={vi.fn()}
      problems={[{
        severity: 'error',
        code: 'WAIT_SOURCE_INVALID',
        message: 'Wait duration must be positive.',
        source: { nodeId: 'wait-1', fieldPath: 'durationMs' },
      }]}
    />)
    const statusMarkup = await renderToMarkup(<AutomationStatusBar
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

  it('projects editable Wait fields and source diagnostics into the Inspector', async () => {
    const steps = projectAutomationSteps(detail.draft.source, [{
      severity: 'error',
      code: 'WAIT_SOURCE_INVALID',
      message: 'Wait duration is invalid.',
      source: { nodeId: 'pause' },
    }])
    const inspectorMarkup = await renderToMarkup(<Inspector
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

  it('renders schema-driven Capability inputs separately from named Connection bindings', async () => {
    const capabilitySource = {
      triggers: [],
      flow: {
        type: 'capability' as const,
        id: 'send-message',
        capability: { id: 'test:send', version: 1 },
        connections: { account: 'conn-ready' },
        input: {
          message: { type: 'literal' as const, value: 'Hello' },
          attempts: { type: 'literal' as const, value: 2 },
          urgent: { type: 'literal' as const, value: true },
          channel: { type: 'literal' as const, value: 'email' },
          payload: { type: 'literal' as const, value: { subject: 'Morning' } },
        },
      },
    }
    const catalog: WorkbenchAutomationInsertCatalog = {
      items: [{
        kind: 'capability',
        capability: { id: 'test:send', version: 1 },
        capabilityKind: 'action',
        title: 'Send message',
        providerAvailable: true,
        connectionSlots: ['account'],
        connectionRequirements: [{ name: 'account', required: true, accepts: ['mail:adapter'] }],
        inputSchemaSupported: true,
        inputFields: [
          { name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true, role: 'numen/expression' },
          { name: 'attempts', label: 'Attempts', type: 'number', schemaType: 'number', required: false, min: 1, max: 5 },
          { name: 'urgent', label: 'Urgent', type: 'boolean', schemaType: 'boolean', required: false },
          {
            name: 'channel',
            label: 'Channel',
            type: 'enum',
            schemaType: 'union',
            required: true,
            options: [{ label: 'email', value: 'email' }, { label: 'chat', value: 'chat' }],
          },
          { name: 'payload', label: 'Payload', type: 'json', schemaType: 'object', required: false },
        ],
      }],
      connections: [{
        id: 'conn-ready',
        name: 'Ready account',
        adapterId: 'mail:adapter',
        adapterVersion: 1,
        enabled: true,
        adapterAvailable: true,
        status: 'READY',
      }],
    }
    const problems = [{
      severity: 'error' as const,
      code: 'INPUT_SCHEMA_INVALID',
      message: 'Message is invalid.',
      source: { nodeId: 'send-message', fieldPath: 'input.message' },
    }]
    const steps = projectAutomationSteps(capabilitySource, problems, new Map([['test:send@1', 'Send message']]))
    const markup = await renderToMarkup(<Inspector
      activeStepId={steps[0]!.id}
      canEdit
      catalog={catalog}
      onCapabilityConnectionChange={vi.fn()}
      onCapabilityInputChange={vi.fn()}
      onClose={vi.fn()}
      open
      problems={problems}
      source={capabilitySource}
      steps={steps}
      schemaUI={schemaUI}
    />)

    expect(markup).toContain('>Connection<')
    expect(markup).toContain('aria-label="account connection"')
    expect(markup).toContain('Ready account')
    expect(markup).toContain('for="send-message-input-message"')
    expect(markup).toContain('aria-label="Message value mode"')
    expect(markup).toContain('value="Hello"')
    expect(markup).toContain('aria-describedby="send-message-input-message-problem"')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('numen/expression')
    expect(markup).toContain('for="send-message-input-payload"')
    expect(markup).toContain('Message is invalid.')
  })
})
