import type { AutomationSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { reconcileAutomationPresentation } from '../src/automation-presentation.js'

const source: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [{
  type: 'foreach', id: 'scope', items: { type: 'literal', value: [] }, body: { type: 'block', id: 'body', steps: [{
    type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [{ type: 'wait', id: 'leaf', durationMs: { type: 'literal', value: 1 } }] },
    else: { type: 'block', id: 'else', steps: [] },
  }] },
}] } }
const presentation = { collapsedNodes: ['root', 'scope', 'body', 'condition', 'then', 'else'], future: { opaque: ['unchanged', false] } }

describe('scoped Presentation reveal', () => {
  it('reveals only strict descendants of the focus scope while retaining its persisted collapse and outer ancestors', () => {
    const before = structuredClone(source)
    const result = reconcileAutomationPresentation(presentation, source, { revealNodeId: 'leaf', revealWithinNodeId: 'scope' })
    expect(result.collapsedNodes).toEqual(['root', 'scope', 'else'])
    expect(result.future).toBe(presentation.future)
    expect(presentation.collapsedNodes).toEqual(['root', 'scope', 'body', 'condition', 'then', 'else'])
    expect(source).toEqual(before)
    expect(reconcileAutomationPresentation(result, source, { revealNodeId: 'leaf', revealWithinNodeId: 'scope' })).toBe(result)
  })

  it.each(['scope', 'leaf', 'else', 'missing', ''] as const)('does not reveal globally for a same-node, unrelated or missing scope %s', focus => {
    const target = focus === 'scope' ? 'scope' : 'leaf'
    const opaque = { ...presentation, collapsedNodes: [...presentation.collapsedNodes, 'legacy-stale-id'] }
    expect(reconcileAutomationPresentation(opaque, source, { revealNodeId: target, revealWithinNodeId: focus })).toBe(opaque)
  })

  it('retains the legacy global reveal when no scope is supplied', () => {
    expect(reconcileAutomationPresentation(presentation, source, { revealNodeId: 'leaf' }).collapsedNodes).toEqual(['else'])
  })

  it('reveals nothing above a direct receiver and does not expand the selected container itself', () => {
    expect(reconcileAutomationPresentation(presentation, source, { revealNodeId: 'body', revealWithinNodeId: 'scope' })).toBe(presentation)
    const selectedContainer = reconcileAutomationPresentation(presentation, source, { revealNodeId: 'then', revealWithinNodeId: 'body' })
    expect(selectedContainer.collapsedNodes).toEqual(['root', 'scope', 'body', 'then', 'else'])
  })
})
