import { createRenderer, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { AutomationEditor } from '../src/AutomationEditor.js'
import { provideWorkbenchCommands } from '../src/commands.js'

type Node = { type: string; props: Record<string, any>; children: Node[]; parent?: Node | null }
const node = (type: string): Node => ({ type, props: {}, children: [] })
const renderer = createRenderer<Node, Node>({
  createElement: node, createText: () => node('#text'), createComment: () => node('#comment'),
  setText() {}, setElementText() {}, parentNode: element => element.parent ?? null,
  nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  patchProp(element, key, _old, value) { element.props[key] = value },
  insert(element, parent) { element.parent = parent; parent.children.push(element) },
  remove(element) { if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1) },
})
const find = (root: Node, label: string): Node | undefined => root.props['aria-label'] === label ? root : root.children.map(child => find(child, label)).find(Boolean)

describe('toolbar command dispatch', () => {
  it('invokes a registered command exactly once without merging it with the fallback listener', async () => {
    const command = vi.fn(), fallback = vi.fn()
    const root = node('root')
    const app = renderer.createApp({ setup() {
      const commands = provideWorkbenchCommands()
      commands.register(() => [{ id: 'automation.undo', label: 'Undo', execute: command }])
      return () => h(AutomationEditor, { activeTab: 'Editor', activeStepId: 'notification', onOpenInspector() {}, onStepChange() {}, onTabChange() {}, onUndo: fallback,
        authoring: { canEdit: true, canPublish: false, canUndo: true, canRedo: false, publishPending: false } })
    } })
    app.mount(root)
    try {
      const undo = find(root, 'Undo')!
      expect(undo.props.disabled).toBeFalsy()
      undo.props.onClick({})
      await nextTick()
      expect(command).toHaveBeenCalledTimes(1)
      expect(fallback).not.toHaveBeenCalled()
    } finally { app.unmount() }
  })
})
