import { createRenderer, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonLiteralEditor, NumberLiteralEditor } from '@numenjs/components'
import type { InvocationPolicy, ValueExpr } from '@numenjs/core'
import { AutomationLiteralField } from '../src/AutomationLiteralField.js'
import { ValueExpressionField } from '../src/ValueExpressionEditor.js'
import { ExecutionPolicyFields } from '../src/ExecutionPolicyFields.js'
import { createAutomationInputSession, provideAutomationInputSession } from '../src/automation-input-session.js'

type Element = { type: string; props: Record<string, any>; children: Element[]; parent?: Element | null; text?: string }
const element = (type: string): Element => ({ type, props: {}, children: [] })
const renderer = createRenderer<Element, Element>({
  createElement: element, createText: text => ({ ...element('#text'), text }), createComment: text => ({ ...element('#comment'), text }),
  setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text },
  parentNode: node => node.parent ?? null, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp(node, key, _previous, value) { node.props[key] = value },
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
})
const find = (node: Element, type: string): Element | undefined => node.type === type ? node : node.children.map(child => find(child, type)).find(Boolean)
const matching = (node: Element, predicate: (node: Element) => boolean): Element | undefined => predicate(node) ? node : node.children.map(child => matching(child, predicate)).find(Boolean)
const textContent = (node: Element): string => (node.text ?? '') + node.children.map(textContent).join('')

afterEach(() => vi.unstubAllGlobals())

describe('explicit local field discard', () => {
  it('keeps an invalid retry delay and policy when removing retry is cancelled, then removes only retry on confirmation', async () => {
    const confirm = vi.fn(() => false)
    const session = createAutomationInputSession(confirm)
    const policy = ref<InvocationPolicy | undefined>({ timeoutMs: 5000, retry: { maxAttempts: 3, backoffMs: 250 } })
    const changed = vi.fn((_nodeId: string, next?: InvocationPolicy) => { policy.value = next })
    const root = element('root')
    const app = renderer.createApp({ setup() {
      provideAutomationInputSession(session)
      return () => h(ExecutionPolicyFields, { nodeId: 'echo', canEdit: true, semantics: { retrySafe: true }, policy: policy.value, problems: [], onChange: changed })
    } })
    app.mount(root)
    const delay = () => matching(root, node => node.props.id === 'echo-policy-retry-backoffMs')!
    const remove = () => matching(root, node => node.type === 'button' && textContent(node) === 'Remove retry policy')!
    try {
      delay().props.onInput({ target: { value: '-' } }); delay().props.onBlur()
      await nextTick()
      remove().props.onClick()
      await nextTick()
      expect(delay().props.value).toBe('-')
      expect(session.hasInvalid).toBe(true)
      expect(changed).not.toHaveBeenCalled()
      expect(policy.value).toEqual({ timeoutMs: 5000, retry: { maxAttempts: 3, backoffMs: 250 } })
      confirm.mockReturnValue(true)
      remove().props.onClick()
      await nextTick(); await nextTick()
      expect(policy.value).toEqual({ timeoutMs: 5000 })
      expect(delay()).toBeUndefined()
      expect(session.hasUncommitted).toBe(false)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally { app.unmount() }
  })

  it.each(['json', 'number', 'reference', 'template'] as const)('resets a mounted %s editor only after confirmation, without committing temporary text', async mode => {
    // Rendering state is exercised without a browser; SelectMenu only registers these idle listeners.
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    const confirm = vi.fn(() => false)
    const session = createAutomationInputSession(confirm)
    const commit = vi.fn()
    const expression = ref<ValueExpr>(mode === 'reference' ? { type: 'ref', path: 'input.message' } : { type: 'template', parts: ['Saved ', { ref: 'input.message' }] })
    const root = element('root')
    const app = renderer.createApp({ setup() {
      provideAutomationInputSession(session)
      return () => mode === 'json' || mode === 'number'
        ? h(AutomationLiteralField, { renderer: mode === 'json' ? JsonLiteralEditor : NumberLiteralEditor,
          fieldPath: 'input.value', canEdit: true, controlId: 'node', inputId: 'field', invalid: false,
          field: { name: 'value', label: 'Value', type: mode, schemaType: mode === 'json' ? 'object' : 'number', required: true },
          value: mode === 'json' ? { saved: true } : 1000, onCommit: commit })
        : h(ValueExpressionField, { nodeId: 'node', canEdit: true,
          field: { name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true },
          expression: expression.value, onChange: commit })
    } })
    app.mount(root)
    const input = () => find(root, mode === 'json' || mode === 'template' ? 'textarea' : 'input')!
    const initial = input().props.value
    const invalid = mode === 'json' ? '{"bad":' : mode === 'number' ? '-' : mode === 'reference' ? 'bad [' : '{{ bad ['
    try {
      input().props.onInput({ target: { value: invalid } })
      input().props.onBlur({ target: { value: invalid } })
      await nextTick()
      expect(session.hasInvalid).toBe(true)
      expect(input().props.value).toBe(invalid)
      expect(session.confirmDiscard()).toBe(false)
      await nextTick()
      expect(input().props.value).toBe(invalid)
      expect(session.hasUncommitted).toBe(true)
      confirm.mockReturnValue(true)
      expect(session.confirmDiscard()).toBe(true)
      await nextTick(); await nextTick()
      expect(input().props.value).toBe(initial)
      expect(input().props['aria-invalid']).toBe(false)
      expect(session.hasUncommitted).toBe(false)
      expect(session.hasInvalid).toBe(false)
      expect(commit).not.toHaveBeenCalled()
      // The still-mounted editor can start another independent draft after reset.
      input().props.onInput({ target: { value: invalid } })
      expect(session.hasUncommitted).toBe(true)
      app.unmount()
      await nextTick()
      expect(session.hasUncommitted).toBe(false)
    } finally { app.unmount() }
  })
})
