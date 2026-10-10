import { createRenderer, h, nextTick, ref, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationSource } from '@numenjs/core'
import { GraphConversionPanel } from '../src/GraphConversionPanel.js'
import { GraphLocalTestPanel } from '../src/GraphLocalTestPanel.js'
import { createAutomationInputSession, provideAutomationInputSession } from '../src/automation-input-session.js'
import type { AutomationDraftDocument } from '../src/useAutomationDraftDocument.js'
import type { WorkbenchConsoleClient } from '../src/types.js'

vi.mock('../src/GraphAutomationCanvas.js', async () => {
  const { h } = await import('vue')
  return { GraphAutomationCanvas: (props: any) => h('div', { 'data-preview-source': props.source, 'data-preview-presentation': props.presentation }) }
})

type Element = { type: string; props: Record<string, any>; children: Element[]; parent?: Element | null; text?: string }
const element = (type: string): Element => ({ type, props: {}, children: [] })
const renderer = createRenderer<Element, Element>({
  createElement: element, createText: text => ({ ...element('#text'), text }), createComment: text => ({ ...element('#comment'), text }),
  setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text },
  parentNode: node => node.parent ?? null, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp(node, key, _old, value) { node.props[key] = value },
  insert(node, parent, anchor) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, node) },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
})
const matching = (node: Element, predicate: (item: Element) => boolean): Element | undefined => predicate(node) ? node : node.children.map(child => matching(child, predicate)).find(Boolean)
const textContent = (node: Element): string => (node.text ?? '') + node.children.map(textContent).join('')
const button = (root: Element, label: string) => matching(root, node => node.type === 'button' && textContent(node) === label)!
const flush = async () => { for (let i = 0; i < 5; i++) await nextTick() }
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals() })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const source = (id = 'before'): AutomationSource => ({ triggers: [], flow: { type: 'capability', id, capability: { id: 'demo:echo', version: 1 }, input: { value: { type: 'literal', value: id } } } })
const document = (id = 'one', value = 'before'): AutomationDraftDocument => ({ automationId: id, version: 1, updatedAt: '', source: source(value), presentation: { marker: value } })

function mountConversion(action: WorkbenchConsoleClient['action']) {
  const current = shallowRef(document()), session = createAutomationInputSession(() => false), beforeConvert = vi.fn(() => true), root = element('root')
  const app = renderer.createApp({ setup() { provideAutomationInputSession(session); return () => h(GraphConversionPanel, {
    key: current.value.automationId, client: { action } as WorkbenchConsoleClient, document: current.value, name: current.value.automationId,
    canConvert: true, beforeConvert, onOpenCopy: vi.fn(),
  }) } })
  app.mount(root); cleanups.push(() => app.unmount())
  return { current, session, beforeConvert, root }
}

async function mountLocal(action: WorkbenchConsoleClient['action']) {
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, querySelector: () => ({ scrollIntoView() {} }) })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const session = createAutomationInputSession(() => false), root = element('root'), shown = ref(true)
  const query = vi.fn(async (ref: { id: string }, input: any) => ref.id === 'numen:output-samples' ? { items: [] }
    : { request: input, previewHash: 'hash', nodeIds: ['target'], calls: [], substitutions: [], externalWrites: [] })
  const app = renderer.createApp({ setup() { provideAutomationInputSession(session); return () => shown.value ? h(GraphLocalTestPanel, {
    client: { action, query } as unknown as WorkbenchConsoleClient, automationId: 'one', nodeId: 'target', source: source('target'), draftVersion: 1,
    canEdit: true, prepareDraft: async () => 1, onRun: vi.fn(),
  }) : null } })
  app.mount(root); cleanups.push(() => app.unmount())
  button(root, 'Local test and samples').props.onClick(); await flush()
  button(root, 'Preview local test').props.onClick(); await flush()
  return { session, shown, root }
}

describe('Graph request ownership', () => {
  it('keeps an unknown conversion request and its displayed source and layout fixed while retrying', async () => {
    const first = deferred<unknown>(), action = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ automationId: 'copy' })
    const state = mountConversion(action)
    button(state.root, 'Preview as Graph').props.onClick(); await flush()
    button(state.root, 'Create Graph copy').props.onClick(); await flush()
    const captured = structuredClone(action.mock.calls[0]![1])
    first.reject(new Error('response lost')); await flush()
    state.current.value = document('one', 'after'); await flush()
    const canvas = matching(state.root, node => !!node.props['data-preview-source'])!
    expect(canvas.props['data-preview-source']).toEqual(captured.source)
    expect(canvas.props['data-preview-presentation']).toEqual(captured.presentation)
    const retry = button(state.root, 'Retry saving copy') ?? button(state.root, 'Create Graph copy')
    retry.props.onClick(); await flush()
    expect(action.mock.calls[1]![1]).toEqual(captured)
    expect(state.beforeConvert).toHaveBeenCalledTimes(1)
  })

  it('protects a conversion before its result and does not leak its request to another Automation', async () => {
    const pending = deferred<unknown>(), action = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ automationId: 'copy-two' })
    const state = mountConversion(action)
    button(state.root, 'Preview as Graph').props.onClick(); await flush()
    button(state.root, 'Create Graph copy').props.onClick(); await flush()
    expect(state.session.hasUncommitted).toBe(true)
    // This models an explicitly approved leave, using the same Automation key as Workspace.
    state.current.value = document('two', 'next'); await flush()
    pending.reject(new Error('old request aborted')); await flush()
    expect(state.session.hasUncommitted).toBe(false)
    button(state.root, 'Preview as Graph').props.onClick(); await flush()
    button(state.root, 'Create Graph copy').props.onClick(); await flush()
    expect(action.mock.calls[1]![1]).toMatchObject({ automationId: 'two' })
    expect(action.mock.calls[1]![1].requestId).not.toBe(action.mock.calls[0]![1].requestId)
  })

  it('protects a local start immediately even with untouched default input and trigger', async () => {
    const pending = deferred<unknown>(), state = await mountLocal(vi.fn().mockReturnValue(pending.promise))
    button(state.root, 'Run reviewed local test').props.onClick(); await flush()
    expect(state.session.hasUncommitted).toBe(true)
    pending.reject(new Error('response lost')); await flush()
    expect(state.session.hasUncommitted).toBe(true)
  })

  it('does not re-register a disposed local-test field when a late request settles', async () => {
    const pending = deferred<unknown>(), state = await mountLocal(vi.fn().mockReturnValue(pending.promise))
    button(state.root, 'Run reviewed local test').props.onClick(); await flush()
    state.shown.value = false; await flush()
    expect(state.session.hasUncommitted).toBe(false)
    pending.reject(new Error('late abort')); await flush()
    expect(state.session.hasUncommitted).toBe(false)
  })
})
