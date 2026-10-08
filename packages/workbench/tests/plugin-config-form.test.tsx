import { createRenderer, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConfigSchemaNode } from '@numenjs/config'
import { PluginConfigurationForm } from '../src/PluginConfigurationForm.js'
import { renderToMarkup } from './render.js'

interface Element { type: string; props: Record<string, any>; children: Element[]; parent?: Element | null; text?: string }
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
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)]
const matching = (node: Element, predicate: (node: Element) => boolean) => all(node).find(predicate)
const field = (root: Element, path: string) => matching(root, node => node.props['data-config-path'] === path)!
const input = (root: Element, path: string) => matching(field(root, path), node => node.type === 'input' || node.type === 'textarea')!
const text = (node: Element): string => (node.text ?? '') + node.children.map(text).join('')
const button = (root: Element, label: string) => matching(root, node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label))!
const schema: HostConfigSchemaNode = { type: 'object', required: false, fields: [
  { name: 'title', label: 'Title', type: 'string', required: false },
  { name: 'attempts', label: 'Attempts', type: 'number', required: false, min: 0, step: 1 },
  { name: 'connection', label: 'Connection', type: 'object', required: false, fields: [{ name: 'endpoint', label: 'Endpoint', type: 'string', required: false }] },
  { name: 'tags', label: 'Tags', type: 'array', required: false, item: { type: 'string', required: false } },
  { name: 'optionalDefault', label: 'Optional default', type: 'string', required: false, hasDefault: true },
  { name: 'advanced', label: 'Advanced', type: 'json', required: false, fallbackReason: 'unsupported' },
] }
function mount(value: Record<string, unknown>, definition = schema) {
  const config = ref(value), session = ref('first'), disabled = ref(false)
  const change = vi.fn((next: Record<string, unknown>) => { config.value = next })
  const draftState = ref({ dirty: false, invalid: false })
  const draft = vi.fn((state: { dirty: boolean; invalid: boolean }) => { draftState.value = state })
  const root = element('root')
  const app = renderer.createApp({ render: () => {
    // PluginsPage reads this state for navigation and Preview guards; reporting unchanged values must settle.
    draftState.value
    return h(PluginConfigurationForm, { schema: definition, value: config.value, disabled: disabled.value, sessionKey: session.value, onChange: value => change(value), onDraftStateChange: state => draft(state) })
  } })
  app.mount(root)
  return { root, app, config, change, draft, session, disabled }
}
beforeEach(() => {
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('plugin configuration form draft projection', () => {
  it('never edits untouched fields on blur, including absent defaults and empty strings', async () => {
    const state = mount({ title: '', attempts: 2, advanced: { future: true } })
    try {
      for (const name of ['title', 'attempts', 'optionalDefault', 'advanced', 'connection.endpoint']) input(state.root, name).props.onBlur()
      await nextTick(); await nextTick()
      expect(state.change).not.toHaveBeenCalled()
      expect(state.config.value).toEqual({ title: '', attempts: 2, advanced: { future: true } })
      expect(input(state.root, 'optionalDefault').props.value).toBe('')
    } finally { state.app.unmount() }
  })

  it('preserves unknown fields, explicit empty strings and other field drafts across valid commits', async () => {
    const original = { title: 'old', attempts: 2, connection: { endpoint: 'old endpoint', unknown: false }, extension: [1, 2], advanced: { untouched: true } }
    const state = mount(original)
    try {
      input(state.root, 'title').props.onInput({ target: { value: '' } })
      input(state.root, 'title').props.onBlur()
      await nextTick(); await nextTick()
      expect(input(state.root, 'title').props['aria-required']).toBe(false)
      expect(input(state.root, 'title').props.placeholder).toBe('Optional')
      expect(state.config.value.title).toBe('')
      expect(Object.hasOwn(state.config.value, 'title')).toBe(true)
      input(state.root, 'attempts').props.onInput({ target: { value: '1e' } })
      input(state.root, 'attempts').props.onBlur()
      await nextTick()
      input(state.root, 'connection.endpoint').props.onInput({ target: { value: 'new endpoint' } })
      input(state.root, 'connection.endpoint').props.onBlur()
      await nextTick(); await nextTick()
      expect(input(state.root, 'attempts').props.value).toBe('1e')
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: true, invalid: true })
      expect(state.config.value).toEqual({ ...original, title: '', connection: { endpoint: 'new endpoint', unknown: false } })
    } finally { state.app.unmount() }
  })

  it('blocks structural array removal while an invalid field exists, then saves correction before removal', async () => {
    const state = mount({ attempts: 2, tags: ['first', 'second'], retained: true })
    try {
      input(state.root, 'attempts').props.onInput({ target: { value: '-' } })
      input(state.root, 'attempts').props.onBlur()
      await nextTick()
      button(state.root, 'Remove tags.0').props.onClick()
      await nextTick(); await nextTick()
      expect(state.change).not.toHaveBeenCalled()
      expect(input(state.root, 'attempts').props.value).toBe('-')
      expect(state.config.value.tags).toEqual(['first', 'second'])
      input(state.root, 'attempts').props.onInput({ target: { value: '3' } })
      input(state.root, 'attempts').props.onBlur()
      await nextTick(); await nextTick()
      button(state.root, 'Remove tags.0').props.onClick()
      await nextTick(); await nextTick()
      expect(state.config.value).toEqual({ attempts: 3, tags: ['second'], retained: true })
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: false, invalid: false })
    } finally { state.app.unmount() }
  })

  it('adds minimal explicit array items and creates only the edited optional object path', async () => {
    const state = mount({ title: 'kept' })
    try {
      button(state.root, 'Add item to tags').props.onClick()
      await nextTick(); await nextTick()
      expect(state.config.value).toEqual({ title: 'kept', tags: [''] })
      input(state.root, 'connection.endpoint').props.onInput({ target: { value: 'https://example.test' } })
      input(state.root, 'connection.endpoint').props.onBlur()
      await nextTick(); await nextTick()
      expect(state.config.value).toEqual({ title: 'kept', tags: [''], connection: { endpoint: 'https://example.test' } })
      expect(Object.hasOwn(state.config.value, 'optionalDefault')).toBe(false)
    } finally { state.app.unmount() }
  })

  it('commits a focused array edit before removing another item, preserving unknown item fields', async () => {
    const definition: HostConfigSchemaNode = { type: 'object', required: false, fields: [{ name: 'items', label: 'Items', type: 'array', required: false, item: { type: 'object', required: false, fields: [{ name: 'text', label: 'Text', type: 'string', required: true }] } }] }
    const state = mount({ items: [{ text: 'first', unknown: true }, { text: 'second', unknown: false }], untouched: true }, definition)
    class FocusedInput { blur() { input(state.root, 'items.0.text').props.onBlur() } }
    vi.stubGlobal('HTMLElement', FocusedInput)
    vi.stubGlobal('document', { activeElement: new FocusedInput(), addEventListener() {}, removeEventListener() {} })
    try {
      input(state.root, 'items.0.text').props.onInput({ target: { value: 'focused edit' } })
      expect(state.config.value.items).toEqual([{ text: 'first', unknown: true }, { text: 'second', unknown: false }])
      button(state.root, 'Remove items.1').props.onClick()
      await nextTick(); await nextTick(); await nextTick()
      expect(state.config.value).toEqual({ items: [{ text: 'focused edit', unknown: true }], untouched: true })
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: false, invalid: false })
    } finally { state.app.unmount() }
  })

  it('bounds rendering of nested arrays and disables adding invisible items while preserving all values', async () => {
    const nested: HostConfigSchemaNode = { type: 'array', required: false, item: { type: 'array', required: false, item: { type: 'string', required: false } } }
    const values = Array.from({ length: 50 }, (_, outer) => Array.from({ length: 50 }, (_, inner) => `${outer}/${inner}`))
    const state = mount({ grid: values }, { type: 'object', required: false, fields: [{ ...nested, name: 'grid', label: 'Grid' }] })
    try {
      expect(all(state.root).filter(node => node.type === 'input').length).toBeLessThan(500)
      expect(all(state.root).filter(node => node.props.class === 'plugin-config-limit').length).toBeLessThan(20)
      expect(button(state.root, 'Add item to grid').props.disabled).toBe(true)
      expect(button(state.root, 'Add item to grid.0').props.disabled).toBe(true)
      expect(state.config.value.grid).toEqual(values)
      expect(state.change).not.toHaveBeenCalled()
    } finally { state.app.unmount() }
  })

  it('keeps tail field buffers when repairing a compound JSON shape would exceed the rendering budget', async () => {
    const definition: HostConfigSchemaNode = { type: 'object', required: false, fields: [
      { name: 'repair', label: 'Repair', type: 'object', required: false, fields: Array.from({ length: 64 }, (_, index) => ({ name: `child${index}`, label: `Child ${index}`, type: 'string' as const, required: false })) },
      { name: 'grid', label: 'Grid', type: 'array', required: false, item: { type: 'array', required: false, item: { type: 'string', required: false } } },
      { name: 'tail', label: 'Tail', type: 'number', required: false },
    ] }
    const grid = Array.from({ length: 9 }, () => Array.from({ length: 50 }, () => 'kept'))
    const state = mount({ repair: false, grid, tail: 2 }, definition)
    try {
      input(state.root, 'tail').props.onInput({ target: { value: '-' } })
      input(state.root, 'tail').props.onBlur()
      await nextTick()
      input(state.root, 'repair').props.onInput({ target: { value: '{}' } })
      input(state.root, 'repair').props.onBlur()
      await nextTick(); await nextTick()
      expect(state.change).not.toHaveBeenCalled()
      expect(input(state.root, 'tail').props.value).toBe('-')
      expect(input(state.root, 'repair').props.value).toBe('{}')
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: true, invalid: true })
      input(state.root, 'tail').props.onInput({ target: { value: '9' } })
      input(state.root, 'tail').props.onBlur()
      await nextTick(); await nextTick()
      input(state.root, 'repair').props.onBlur()
      await nextTick(); await nextTick()
      expect(state.config.value).toEqual({ repair: {}, grid, tail: 9 })
      expect(field(state.root, 'tail')).toBeUndefined()
      expect(input(state.root, 'repair.child0').props.value).toBe('')
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: false, invalid: false })
    } finally { state.app.unmount() }
  })

  it('shows wrong-shaped stored values as JSON and does not normalize or discard them on blur', async () => {
    const state = mount({ title: null, attempts: 'not a number', connection: false, tags: { preserved: true } })
    try {
      for (const name of ['title', 'attempts', 'connection', 'tags']) {
        expect(input(state.root, name).type).toBe('textarea')
        input(state.root, name).props.onBlur()
      }
      await nextTick(); await nextTick()
      expect(state.change).not.toHaveBeenCalled()
      expect(state.config.value).toEqual({ title: null, attempts: 'not a number', connection: false, tags: { preserved: true } })
      input(state.root, 'connection').props.onInput({ target: { value: '{"endpoint":"new","unknown":"kept"}' } })
      input(state.root, 'connection').props.onBlur()
      await nextTick(); await nextTick()
      expect(input(state.root, 'connection.endpoint').props.value).toBe('new')
      expect(state.config.value.connection).toEqual({ endpoint: 'new', unknown: 'kept' })
    } finally { state.app.unmount() }
  })

  it('keeps invalid buffers until an explicit session change, then clears protection without committing', async () => {
    const state = mount({ attempts: 2, advanced: { original: true } })
    try {
      input(state.root, 'advanced').props.onInput({ target: { value: '{' } })
      input(state.root, 'advanced').props.onBlur()
      await nextTick()
      state.disabled.value = true
      await nextTick()
      expect(input(state.root, 'advanced').props.value).toBe('{')
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: true, invalid: true })
      expect(state.change).not.toHaveBeenCalled()
      state.session.value = 'explicitly reloaded'
      state.config.value = { attempts: 5, advanced: { remote: true } }
      await nextTick(); await nextTick()
      expect(state.draft).toHaveBeenLastCalledWith({ dirty: false, invalid: false })
      expect(input(state.root, 'advanced').props.value).toBe('{\n  "remote": true\n}')
      expect(state.change).not.toHaveBeenCalled()
    } finally { state.app.unmount() }
    expect(state.draft).toHaveBeenLastCalledWith({ dirty: false, invalid: false })
  })

  it('limits rendered array items without truncating the saved document when changing a visible item', async () => {
    const tags = Array.from({ length: 120 }, (_, index) => `item ${index}`)
    const state = mount({ tags, unknown: { keep: true } })
    try {
      expect(field(state.root, 'tags.49')).toBeDefined()
      expect(field(state.root, 'tags.50')).toBeUndefined()
      input(state.root, 'tags.0').props.onInput({ target: { value: 'edited' } })
      input(state.root, 'tags.0').props.onBlur()
      await nextTick(); await nextTick()
      expect(state.config.value.tags).toEqual(['edited', ...tags.slice(1)])
      expect(state.config.value.unknown).toEqual({ keep: true })
    } finally { state.app.unmount() }
  })

  it('updates cached field metadata when required flags change without losing current values', async () => {
    const definition: HostConfigSchemaNode = { type: 'object', required: false, fields: [{ name: 'value', label: 'Value', type: 'string', required: false }] }
    const state = mount({ value: '' }, definition)
    try {
      expect(input(state.root, 'value').props['aria-required']).toBe(false)
      definition.fields![0]!.required = true
      state.disabled.value = true
      await nextTick()
      expect(input(state.root, 'value').props['aria-required']).toBe(true)
      expect(input(state.root, 'value').props.value).toBe('')
      expect(state.change).not.toHaveBeenCalled()
    } finally { state.app.unmount() }
  })

  it('renders schema labels as plain text and associates exact field paths with controls', async () => {
    const markup = await renderToMarkup(h(PluginConfigurationForm, { schema: { type: 'object', required: false, fields: [{ name: 'field', label: '<script>unsafe()</script>', description: '<img src=x onerror=bad()>', type: 'string', required: false }] }, value: {}, disabled: false, sessionKey: 'safe', onChange() {}, onDraftStateChange() {} }))
    expect(markup).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
    expect(markup).toContain('&lt;img src=x onerror=bad()&gt;')
    expect(markup).toContain('<span class="visually-hidden">field</span>')
    expect(markup).not.toContain('<script>')
  })
})
