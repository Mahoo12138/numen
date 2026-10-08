import type { AutomationSource } from '@numenjs/core'
import { createRenderer, h, ref, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAutomationSourceCommand, type AutomationSourceCommand } from '../src/automation-source-editing.js'
import { useAutomationDrag } from '../src/useAutomationDrag.js'

type RenderNode = { children: RenderNode[]; parent?: RenderNode | null }
const renderNode = (): RenderNode => ({ children: [] })
const renderer = createRenderer<RenderNode, RenderNode>({
  createElement: renderNode, createText: renderNode, createComment: renderNode,
  setText() {}, setElementText() {}, patchProp() {},
  parentNode: node => node.parent ?? null,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
})

// Only browser boundaries used by the composable are modeled here. Actual native
// event delivery and DOM drag behavior are covered by browser acceptance tests.
class SurfaceElement {
  scrollTop = 100
  constructor(readonly role: 'canvas' | 'host' | 'header' | 'handle' | 'zone' | 'outside', readonly parent?: SurfaceElement) {}
  closest(selector: string): SurfaceElement | null {
    const role = selector === '.automation-canvas' ? 'canvas' : selector === '.structured-node-header' ? 'header' : selector === '[data-drop-node-id]' ? 'zone' : undefined
    return this.role === role ? this : this.parent?.closest(selector) ?? null
  }
  contains(element: SurfaceElement): boolean { return element === this || !!element.parent && this.contains(element.parent) }
  getBoundingClientRect() { return { left: 0, right: 300, top: 0, bottom: 200, height: 200 } }
}
function listeners() {
  const active = new Map<string, Array<{ listener: EventListener; capture: boolean }>>()
  const addEventListener = vi.fn((type: string, listener: EventListener, capture = false) => {
    const entries = active.get(type) ?? []
    entries.push({ listener, capture }); active.set(type, entries)
  })
  const removeEventListener = vi.fn((type: string, listener: EventListener, capture = false) => {
    active.set(type, (active.get(type) ?? []).filter(entry => entry.listener !== listener || entry.capture !== capture))
  })
  return { active, addEventListener, removeEventListener,
    dispatch(type: string, event: object = {}) { for (const entry of [...active.get(type) ?? []]) entry.listener(event as Event) },
    count() { return [...active.values()].reduce((total, entries) => total + entries.length, 0) },
  }
}
const apps: Array<{ unmount(): void }> = []
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.unstubAllGlobals() })
function fixture() {
  const source = shallowRef<AutomationSource>({ triggers: [], flow: { type: 'block', id: 'root', steps: ['a', 'b', 'c'].map(id => ({ type: 'wait', id, durationMs: { type: 'literal', value: 1 } })) } })
  const editable = ref(true)
  const canvas = new SurfaceElement('canvas'), host = new SurfaceElement('host', canvas)
  const header = new SurfaceElement('header', host), handle = new SurfaceElement('handle', header), zone = new SurfaceElement('zone', host)
  const document = listeners(), window = listeners(), frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  const cancelFrame = vi.fn((id: number) => { frames.delete(id) })
  vi.stubGlobal('Element', SurfaceElement)
  vi.stubGlobal('document', document); vi.stubGlobal('window', window)
  vi.stubGlobal('requestAnimationFrame', requestFrame); vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const commit = vi.fn((_command: AutomationSourceCommand, _source: AutomationSource) => true)
  let drag!: ReturnType<typeof useAutomationDrag>
  const app = renderer.createApp({ setup() {
    drag = useAutomationDrag({ host: shallowRef(host as unknown as HTMLElement), source: () => source.value, canEdit: () => editable.value, commit })
    return () => h('div')
  } })
  app.mount(renderNode()); apps.push(app)
  function event(overrides: Partial<DragEvent> = {}) {
    const value = { clientX: 100, clientY: 100, target: zone, currentTarget: handle, relatedTarget: null,
      dataTransfer: { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn(), setDragImage: vi.fn(), getData: vi.fn(() => 'external-node') },
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
    }
    return value as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> }
  }
  function tick(time: number) {
    const [id, callback] = frames.entries().next().value ?? []
    expect(callback).toBeDefined()
    frames.delete(id!); callback!(time)
  }
  return { drag, source, editable, commit, event, app, document, window, frames, requestFrame, cancelFrame, canvas, host, header, handle, zone, tick }
}

function expectCancelled(state: ReturnType<typeof fixture>) {
  expect(state.drag.session.value).toBeUndefined()
  expect(state.drag.intent.value).toBeUndefined()
  expect(state.frames.size).toBe(0)
}

describe('Automation drag session and lifecycle', () => {
  it('starts only a local movable Source node and retains its exact identity', () => {
    const state = fixture(), input = state.event()
    state.drag.start(input, 'a')
    expect(state.drag.session.value).toEqual({ nodeId: 'a', source: state.source.value })
    expect(state.drag.session.value?.source).toBe(state.source.value)
    expect(input.dataTransfer?.effectAllowed).toBe('move')
    expect(input.dataTransfer?.setData).toHaveBeenCalledWith('application/x-numen-node', 'a')
    expect(input.dataTransfer?.setDragImage).toHaveBeenCalledWith(state.header, 18, 18)
    expect(state.frames.size).toBe(1)
    expect(input.stopPropagation).toHaveBeenCalledOnce()
    expect(state.commit).not.toHaveBeenCalled()
    for (const nodeId of ['root', 'missing']) {
      const invalid = state.event(); state.drag.start(invalid, nodeId)
      expect(invalid.preventDefault).toHaveBeenCalledOnce()
      expectCancelled(state)
    }
    state.drag.start(state.event({ dataTransfer: null }), 'a'); expectCancelled(state)
    state.editable.value = false
    state.drag.start(state.event(), 'a'); expectCancelled(state)
  })

  it('does not accept external drop payloads without a local drag session', () => {
    const state = fixture(), external = state.event()
    state.drag.over(external, 'b', 'after')
    state.drag.drop(external, 'b', 'after')
    expect(external.preventDefault).not.toHaveBeenCalled()
    expect(external.dataTransfer?.getData).not.toHaveBeenCalled()
    expect(state.commit).not.toHaveBeenCalled()
    expectCancelled(state)
  })

  it.each(['no-hover', 'different-node', 'different-placement', 'invalid-hover'] as const)('requires the same previously accepted landing position: %s', change => {
    const state = fixture()
    state.drag.start(state.event(), 'a')
    if (change !== 'no-hover') state.drag.over(state.event(), change === 'invalid-hover' ? 'missing' : 'b', 'after')
    const drop = state.event()
    state.drag.drop(drop, change === 'different-node' ? 'c' : 'b', change === 'different-placement' ? 'before' : 'after')
    expect(state.commit).not.toHaveBeenCalled()
    expect(drop.preventDefault).not.toHaveBeenCalled()
    expectCancelled(state)
  })

  it('produces one MOVE_TO with the original Source fence only at a valid drop, even after repeated hover and duplicate delivery', () => {
    const state = fixture(), original = state.source.value
    state.drag.start(state.event(), 'a')
    for (let count = 0; count < 4; count++) state.drag.over(state.event(), 'b', 'after')
    expect(state.commit).not.toHaveBeenCalled()
    expect(state.source.value).toBe(original)
    const drop = state.event()
    state.drag.drop(drop, 'b', 'after')
    state.drag.drop(state.event(), 'b', 'after')
    expect(state.commit).toHaveBeenCalledExactlyOnceWith({ type: 'MOVE_TO', nodeId: 'a', target: { kind: 'block', blockId: 'root', beforeNodeId: 'c' } }, original)
    expect(state.commit.mock.calls[0]![1]).toBe(original)
    expect(drop.preventDefault).toHaveBeenCalledOnce()
    expect(drop.stopPropagation).toHaveBeenCalledOnce()
    expectCancelled(state)
  })

  it('ends a no-op drop without a command or history entry', () => {
    const state = fixture()
    state.drag.start(state.event(), 'a')
    state.drag.over(state.event(), 'b', 'before')
    expect(state.drag.intent.value?.allowed).toBe(true)
    state.drag.drop(state.event(), 'b', 'before')
    expect(state.commit).not.toHaveBeenCalled()
    expectCancelled(state)
  })

  it.each(['source-clone', 'source-node-removed', 'hover-target-removed', 'conflict-readonly'] as const)('cancels synchronously on %s and cannot resume the old session', cause => {
    const state = fixture()
    state.drag.start(state.event(), 'a')
    // Last-node after resolves to an append target; the Source identity fence
    // must still catch disappearance of the original visible target.
    state.drag.over(state.event(), 'c', 'after')
    if (cause === 'conflict-readonly') state.editable.value = false
    else if (cause === 'source-clone') state.source.value = structuredClone(state.source.value)
    else state.source.value = applyAutomationSourceCommand(state.source.value, { type: 'DELETE_STEP', nodeId: cause === 'source-node-removed' ? 'a' : 'c' }).source
    expectCancelled(state)
    state.editable.value = true
    state.drag.drop(state.event(), 'c', 'after')
    expect(state.commit).not.toHaveBeenCalled()
  })

  it.each(['explicit', 'escape', 'dragend', 'document-drop', 'window-blur'] as const)('cancels via %s without committing or leaving an animation frame', reason => {
    const state = fixture()
    state.drag.start(state.event(), 'a'); state.drag.over(state.event(), 'b', 'after')
    if (reason === 'explicit') state.drag.cancel()
    else if (reason === 'escape') state.document.dispatch('keydown', { key: 'Escape' })
    else if (reason === 'dragend') state.document.dispatch('dragend')
    else if (reason === 'document-drop') state.document.dispatch('drop')
    else state.window.dispatch('blur')
    expectCancelled(state)
    state.drag.drop(state.event(), 'b', 'after')
    expect(state.commit).not.toHaveBeenCalled()
  })

  it('clears the hovered intent outside the local drop surfaces and on leaving the window', () => {
    const state = fixture()
    state.drag.start(state.event(), 'a'); state.drag.over(state.event(), 'b', 'after')
    const foreignZone = new SurfaceElement('zone', new SurfaceElement('outside'))
    state.document.dispatch('dragover', state.event({ target: foreignZone as unknown as EventTarget }))
    expect(state.drag.intent.value).toBeUndefined()
    state.drag.drop(state.event(), 'b', 'after'); expect(state.commit).not.toHaveBeenCalled()
    state.drag.start(state.event(), 'a'); state.drag.over(state.event(), 'b', 'after')
    state.document.dispatch('dragleave', { relatedTarget: null })
    expect(state.drag.intent.value).toBeUndefined()
    state.drag.drop(state.event(), 'b', 'after'); expect(state.commit).not.toHaveBeenCalled()
  })

  it('auto-scrolls only while the pointer is inside the canvas edge and bounds long-frame movement', () => {
    const state = fixture()
    state.drag.start(state.event(), 'a')
    state.document.dispatch('dragover', state.event({ clientX: 100, clientY: 199 }))
    state.tick(1000)
    expect(state.canvas.scrollTop).toBeGreaterThan(100)
    const prior = state.canvas.scrollTop
    state.tick(100_000)
    expect(state.canvas.scrollTop - prior).toBeLessThanOrEqual(32 * .65)
    state.document.dispatch('dragover', state.event({ clientX: 301, clientY: 199 }))
    const outside = state.canvas.scrollTop; state.tick(100_016)
    expect(state.canvas.scrollTop).toBe(outside)
    state.document.dispatch('dragover', state.event({ clientX: 100, clientY: 1 }))
    state.tick(100_032); expect(state.canvas.scrollTop).toBeLessThan(outside)
    state.document.dispatch('dragleave', { relatedTarget: null })
    const left = state.canvas.scrollTop; state.tick(100_048)
    expect(state.canvas.scrollTop).toBe(left)
    expect(state.commit).not.toHaveBeenCalled()
    state.drag.cancel(); expectCancelled(state)
  })

  it('unmounts active sessions by removing every listener and cancelling scheduled and already-delivered frames', () => {
    const state = fixture()
    expect(state.document.count()).toBe(5); expect(state.window.count()).toBe(1)
    state.drag.start(state.event(), 'a'); state.drag.over(state.event(), 'b', 'after')
    const delivered = [...state.frames.values()][0]!
    state.app.unmount(); apps.splice(apps.indexOf(state.app), 1)
    expectCancelled(state)
    expect(state.document.count()).toBe(0); expect(state.window.count()).toBe(0)
    for (const [event, listener, capture] of state.document.addEventListener.mock.calls) {
      expect(state.document.removeEventListener).toHaveBeenCalledWith(event, listener, ...(capture === undefined ? [] : [capture]))
    }
    expect(state.window.removeEventListener).toHaveBeenCalledWith('blur', state.window.addEventListener.mock.calls[0]![1])
    // A callback that was already delivered to the event queue must not restart
    // scrolling after cancellation, even if the source changes afterwards.
    delivered(2000)
    state.source.value = structuredClone(state.source.value)
    expect(state.frames.size).toBe(0)
    expect(state.commit).not.toHaveBeenCalled()
  })
})
