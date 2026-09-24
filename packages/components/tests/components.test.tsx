import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { Button, SelectMenu, StringLiteralEditor, provideComponentI18n, isSchemaValue, type SchemaLiteralRendererProps } from '../src/index.js'

const props: SchemaLiteralRendererProps = {
  canEdit: true, controlId: 'field', inputId: 'message', invalid: false,
  field: { name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true },
  onCommit() {},
}

describe('standalone components', () => {
  it('renders without DOM globals or host services, and does not fabricate a selection', async () => {
    const render = (value: string, options: Array<{ value: string; label: string }>) => renderToString(createSSRApp({
      render: () => h(SelectMenu, { value, options, ariaLabel: 'Mode', onChange() {} }),
    }))
    expect(await render('deleted', [{ value: 'first', label: 'First' }])).toContain('deleted')
    const empty = await render('', [])
    expect(empty).toContain('disabled')
    expect(empty).toContain('aria-expanded="false"')
  })

  it('isolates translators between concurrent Vue trees and escapes user text', async () => {
    const localized = (label: string) => defineComponent({ setup() {
      provideComponentI18n(() => label)
      return () => <StringLiteralEditor {...props} value={'<script>alert(1)</script>'} />
    } })
    const [english, chinese, fallback] = await Promise.all([
      renderToString(createSSRApp(localized('Required'))),
      renderToString(createSSRApp(localized('必填'))),
      renderToString(createSSRApp({ render: () => <StringLiteralEditor {...props} /> })),
    ])
    expect(english).toContain('placeholder="Required"')
    expect(chinese).toContain('placeholder="必填"')
    expect(fallback).toContain('placeholder="Required"')
    expect(chinese).toContain('&lt;script&gt;')
    expect(chinese).not.toContain('<script>')
  })

  it('busy buttons cannot submit and default to a non-submit button', async () => {
    const html = await renderToString(createSSRApp({ render: () => <Button busy>Save</Button> }))
    expect(html).toContain('type="button"')
    expect(html).toContain('disabled')
    expect(html).toContain('aria-busy="true"')
  })

  it('rejects non-JSON values and cycles, accepts shared subtrees without treating them as cycles', () => {
    const shared = { a: 1 }
    expect(isSchemaValue({ first: shared, second: shared })).toBe(true)
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const value of [cycle, new Date(), Infinity, NaN, undefined, { a: undefined }, { a: 1n }, JSON.parse('1e400')]) {
      expect(isSchemaValue(value)).toBe(false)
    }
    expect(isSchemaValue({ nested: [null, true, 'text', { $resource: 'id' }] })).toBe(true)
  })
})
