import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutomationCapacityFixture } from '../../../benchmarks/workbench/fixtures.js'
import { StructuredAutomationFlow } from '../src/StructuredAutomationFlow.js'
import { projectAutomationSteps } from '../src/automation-projection.js'
import { automationStepEditOptions } from '../src/automation-source-editing.js'
import { renderToMarkup } from './render.js'

afterEach(() => vi.restoreAllMocks())

describe('flow drag-handle rendering', () => {
  it.each([100, 300] as const)('renders all eligible handles in a %s-node flow without cloning Source for copy validation', async size => {
    const { source } = createAutomationCapacityFixture(size)
    const steps = projectAutomationSteps(source)
    // The unchanged command menu is the independent eligibility contract.
    const expected = steps.filter(step => automationStepEditOptions(source, step.sourceId).canMoveTo).map(step => step.sourceId).sort()
    const before = JSON.stringify(source)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const markup = await renderToMarkup(<StructuredAutomationFlow source={source} steps={steps}
      activeStepId={steps[0]!.id} canEdit onStepChange={() => {}} />)
    const handles = [...markup.matchAll(/data-drag-node-id="([^"]+)"/g)].map(match => match[1]).sort()
    expect(handles).toEqual(expected)
    expect(markup).toContain('data-node-id="bench-edit"')
    expect(clone).not.toHaveBeenCalled()
    expect(JSON.stringify(source)).toBe(before)
  })

  it('keeps a read-only flow browsable without exposing drag handles or performing copy validation', async () => {
    const { source } = createAutomationCapacityFixture(100)
    const steps = projectAutomationSteps(source)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const markup = await renderToMarkup(<StructuredAutomationFlow source={source} steps={steps}
      activeStepId={steps[0]!.id} canEdit={false} onStepChange={() => {}} />)
    expect(markup).toContain('data-node-id="bench-edit"')
    expect(markup).not.toContain('data-drag-node-id=')
    expect(clone).not.toHaveBeenCalled()
  })
})
