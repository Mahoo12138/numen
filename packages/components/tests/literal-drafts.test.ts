import { createRenderer, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { JsonLiteralEditor, NumberLiteralEditor, DurationLiteralEditor } from '../src/SchemaRenderers.js'
import { parseSchemaLiteral } from '../src/schema-literal.js'
import type { SchemaField, SchemaValue } from '../src/schema.js'
import type { SchemaDraftState, SchemaLiteralRenderer } from '../src/SchemaRenderers.js'

type Element = { type: string; props: Record<string, any>; children: Element[]; parent?: Element | null; text?: string }
const element = (type: string): Element => ({ type, props: {}, children: [] })
const renderer = createRenderer<Element, Element>({
  createElement: type => element(type), createText: text => ({ ...element('#text'), text }), createComment: text => ({ ...element('#comment'), text }),
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

function mount(Editor: SchemaLiteralRenderer, field: SchemaField, initial: SchemaValue | undefined) {
  const value = ref(initial)
  const state = ref<SchemaDraftState>({ dirty: false, invalid: false })
  const invalid = ref(false)
  const commit = vi.fn((next?: SchemaValue) => { value.value = next })
  const root = element('root')
  const app = renderer.createApp({ render: () => h(Editor, { canEdit: true, controlId: 'node', inputId: 'field', invalid: false, field,
    ...(value.value !== undefined ? { value: value.value } : {}), onCommit: commit,
    onDraftStateChange: (next: SchemaDraftState) => { state.value = next },
    onValidationChange: (next: boolean) => { invalid.value = next },
  }) })
  app.mount(root)
  const input = () => find(root, field.type === 'json' ? 'textarea' : 'input')!
  return { app, value, state, invalid, commit, input, async edit(text: string) {
    input().props.onInput({ target: { value: text } })
    await nextTick()
  }, async blur() { input().props.onBlur(); await nextTick(); await nextTick() } }
}

describe('literal draft validation and preservation', () => {
  it('keeps malformed JSON across blur and source refresh, then commits a corrected field once', async () => {
    const view = mount(JsonLiteralEditor, { name: 'headers', label: 'Headers', type: 'json', schemaType: 'object', required: true }, { original: true })
    try {
      await view.edit('{"token":')
      expect(view.state.value).toEqual({ dirty: true, invalid: true })
      expect(view.invalid.value).toBe(true)
      await view.blur()
      expect(view.commit).not.toHaveBeenCalled()
      expect(view.input().props.value).toBe('{"token":')
      expect(view.input().props['aria-invalid']).toBe(true)
      view.value.value = { refreshed: true }
      await nextTick()
      expect(view.input().props.value).toBe('{"token":')
      await view.edit('[]')
      await view.blur()
      expect(view.commit).not.toHaveBeenCalled()
      await view.edit('{"accepted":true}')
      expect(view.state.value).toEqual({ dirty: true, invalid: false })
      expect(view.invalid.value).toBe(false)
      await view.blur()
      expect(view.value.value).toEqual({ accepted: true })
      expect(view.commit).toHaveBeenCalledTimes(1)
      expect(view.state.value).toEqual({ dirty: false, invalid: false })
    } finally { view.app.unmount() }
  })

  it('preserves invalid numeric text and rejects range and increment errors without writing a value', async () => {
    const view = mount(NumberLiteralEditor, { name: 'attempts', label: 'Attempts', type: 'number', schemaType: 'number', required: true, min: 1, max: 10, step: 1 }, 2)
    try {
      for (const text of ['-', 'Infinity', '0', '11', '2.5', '']) {
        await view.edit(text); await view.blur()
        expect(view.input().props.value).toBe(text)
        expect(view.value.value).toBe(2)
        expect(view.state.value).toEqual({ dirty: true, invalid: true })
      }
      expect(view.commit).not.toHaveBeenCalled()
      await view.edit('3'); await view.blur()
      expect(view.value.value).toBe(3)
      expect(view.state.value).toEqual({ dirty: false, invalid: false })
    } finally { view.app.unmount() }
  })

  it('does not silently round sub-millisecond durations and releases field state on unmount', async () => {
    const view = mount(DurationLiteralEditor, { name: 'duration', label: 'Duration', type: 'number', schemaType: 'number', required: true, role: 'numen/duration-ms', min: 0, step: 1 }, 1000)
    await view.edit('0.0001'); await view.blur()
    expect(view.value.value).toBe(1000)
    expect(view.input().props.value).toBe('0.0001')
    await view.edit('0.001'); await view.blur()
    expect(view.value.value).toBe(1)
    await view.edit('invalid')
    view.app.unmount()
    expect(view.state.value).toEqual({ dirty: false, invalid: false })
  })

  it('rejects nonfinite JSON and wrong root shapes while allowing optional removal and valid boundary values', () => {
    const json: SchemaField = { name: 'items', label: 'Items', type: 'json', schemaType: 'array', required: true }
    expect(parseSchemaLiteral('[1e400]', json)).toEqual({ error: 'validation.json' })
    expect(parseSchemaLiteral('{}', json)).toEqual({ error: 'validation.jsonType' })
    expect(parseSchemaLiteral('null', json)).toEqual({ error: 'validation.jsonType' })
    expect(parseSchemaLiteral('[]', json)).toEqual({ value: [] })
    expect(parseSchemaLiteral('', { ...json, required: false })).toEqual({ value: undefined })
    const date: SchemaField = { name: 'date', label: 'Date', type: 'string', schemaType: 'string', required: true, role: 'numen/iso-date-time' }
    expect(parseSchemaLiteral('2026-02-30T10:00', date)).toEqual({ error: 'validation.dateTime' })
    expect(parseSchemaLiteral('', { ...date, required: false })).toEqual({ value: undefined })
  })
})
