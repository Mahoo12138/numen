import { createRenderer, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreSchemaLiteralRenderers, JsonLiteralEditor, NumberLiteralEditor } from '@numenjs/components'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
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

const schemaUI: SchemaUIResolver = {
  getSnapshot: () => 1, subscribe: () => () => {},
  resolveRenderer<Renderer>(request, mode): Renderer | undefined {
    return mode === 'editor' ? coreSchemaLiteralRenderers.find(renderer => renderer.type === request.type)?.editor as Renderer | undefined : undefined
  },
}

function mountCollection(initial: ValueExpr) {
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const confirm = vi.fn(() => false), session = createAutomationInputSession(confirm)
  const expression = ref(initial), canEdit = ref(true)
  const change = vi.fn((next: ValueExpr) => { expression.value = next })
  const root = element('root')
  const app = renderer.createApp({ setup() {
    provideAutomationInputSession(session)
    return () => h(ValueExpressionField, { nodeId: 'node', canEdit: canEdit.value, schemaUI,
      field: { name: 'payload', label: 'Payload', type: 'json', schemaType: 'any', required: true },
      expression: expression.value, onChange: change })
  } })
  app.mount(root)
  return { app, root, confirm, session, expression, canEdit, change,
    byLabel: (label: string) => matching(root, node => node.props['aria-label'] === label)!,
    input: (name: string) => matching(root, node => node.props.id === `node-input-${name}`)!,
  }
}

describe('collection member draft protection', () => {
  it('keeps Call callbacks off the DOM and commits a nested argument as one valid expression edit', async () => {
    const state = mountCollection({ type: 'object', entries: { x: { type: 'call', function: 'core:add', arguments: [{ type: 'literal', value: 1 }, { type: 'literal', value: 2 }] } } })
    try {
      const call = matching(state.root, node => node.props.class === 'structured-call-editor')!
      expect(call.props.onChange).toBeUndefined()
      const input = state.input('payload/object/x-argument-0')
      input.props.onInput({ target: { value: '5' } }); input.props.onBlur()
      await nextTick(); await nextTick()
      expect(state.expression.value).toEqual({ type: 'object', entries: { x: { type: 'call', function: 'core:add', arguments: [{ type: 'literal', value: 5 }, { type: 'literal', value: 2 }] } } })
      expect(state.change).toHaveBeenCalledTimes(1)
    } finally { state.app.unmount() }
  })

  it('renders legal JSON surrogate keys and does not blur a name while the input method is composing', () => {
    const state = mountCollection({ type: 'object', entries: JSON.parse('{"\\ud800":{"type":"literal","value":1}}') })
    try {
      const blur = vi.fn()
      state.byLabel('Payload field name 1').props.onKeydown({ key: 'Enter', isComposing: true, target: { blur } })
      expect(blur).not.toHaveBeenCalled()
      expect(state.input('payload/object/%ud800').props.value).toBe('1')
      expect(state.change).not.toHaveBeenCalled()
    } finally { state.app.unmount() }
  })
  it('keeps duplicate names local, protects sibling values on rename, then commits exactly once', async () => {
    const initial: ValueExpr = { type: 'object', entries: { first: { type: 'literal', value: 1 }, second: { type: 'literal', value: 'saved' } } }
    const state = mountCollection(initial)
    try {
      const name = () => state.byLabel('Payload field name 1')
      name().props.onInput({ target: { value: 'second' } }); name().props.onBlur()
      await nextTick()
      expect(state.session.hasInvalid).toBe(true)
      expect(name().props.value).toBe('second')
      expect(state.change).not.toHaveBeenCalled()
      const input = state.input('payload/object/second')
      input.props.onInput({ target: { value: '{' } }); input.props.onBlur()
      await nextTick()
      name().props.onInput({ target: { value: 'renamed' } }); name().props.onBlur()
      await nextTick()
      expect(state.confirm).toHaveBeenCalledTimes(1)
      expect(state.expression.value).toEqual(initial)
      expect(state.session.hasUncommitted).toBe(true)
      state.confirm.mockReturnValue(true)
      name().props.onBlur()
      await nextTick(); await nextTick()
      expect(state.expression.value).toEqual({ type: 'object', entries: { renamed: { type: 'literal', value: 1 }, second: { type: 'literal', value: 'saved' } } })
      expect(state.change).toHaveBeenCalledTimes(1)
      expect(state.session.hasUncommitted).toBe(false)
      expect(state.input('payload/object/second').props.value).toBe('"saved"')
    } finally { state.app.unmount() }
  })

  it('does not move an invalid array draft into another item and resets it only after confirmation', async () => {
    const state = mountCollection({ type: 'array', items: [{ type: 'literal', value: 1 }, { type: 'ref', path: 'input.value' }] })
    try {
      const input = () => state.input('payload/array/1')
      input().props.onInput({ target: { value: 'invalid [' } }); input().props.onBlur({ target: { value: 'invalid [' } })
      await nextTick()
      state.byLabel('Move item 2 up').props.onClick()
      await nextTick()
      expect(input().props.value).toBe('invalid [')
      expect(state.change).not.toHaveBeenCalled()
      state.confirm.mockReturnValue(true)
      state.byLabel('Move item 2 up').props.onClick()
      await nextTick(); await nextTick()
      expect(state.expression.value).toEqual({ type: 'array', items: [{ type: 'ref', path: 'input.value' }, { type: 'literal', value: 1 }] })
      expect(state.input('payload/array/0').props.value).toBe('input.value')
      expect(state.session.hasUncommitted).toBe(false)
      expect(state.change).toHaveBeenCalledTimes(1)
    } finally { state.app.unmount() }
  })

  it('keeps structural controls disabled and does not leak domain change callbacks onto collection DOM', async () => {
    const state = mountCollection({ type: 'object', entries: { a: { type: 'literal', value: 1 } } })
    try {
      const collection = matching(state.root, node => node.props['data-collection-type'] === 'object')!
      expect(collection.props.onChange).toBeUndefined()
      state.canEdit.value = false
      await nextTick()
      expect(state.byLabel('Remove field a').props.disabled).toBe(true)
      expect(state.byLabel('Payload field name 1').props.disabled).toBe(true)
      state.byLabel('Remove field a').props.onClick()
      expect(state.change).not.toHaveBeenCalled()
    } finally { state.app.unmount() }
  })
})

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
