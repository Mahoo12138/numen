import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { I18nService, interpolate } from '../src/index.js'

describe('shared i18n service', () => {
  it('uses Koishi locale fallback and path-first lookup with safe interpolation', async () => {
    const root = new Context()
    await root.plugin(I18nService, { locales: ['en-US', 'zh-CN', 'zh-TW'] })
    root.i18n.define(root, 'en-us', 'example', { hello: 'Hello {user.name}', onlyEnglish: 'English',
      second: 'Second', shared: 'Shared', reference: '{@example.shared} {0}', empty: '' })
    root.i18n.define(root, 'zh-cn', { example: { hello: '你好 {user.name}', second: '第二条' } })
    expect(root.i18n.text(['zh-CN'], 'example.hello', { user: { name: '<b>Ada</b>' } })).toBe('你好 <b>Ada</b>')
    expect(root.i18n.text(['zh-TW'], 'example.hello', { user: { name: 'Ada' } })).toBe('你好 Ada')
    expect(root.i18n.text(['zh-CN'], ['example.onlyEnglish', 'example.second'])).toBe('English')
    expect(root.i18n.text(['fr-FR'], 'example.hello')).toBe('Hello {user.name}')
    expect(root.i18n.text(['en-US'], 'example.reference', ['text'])).toBe('Shared text')
    root.i18n.define(root, 'en-US', { inner: '{0}', outer: '{@inner}' })
    expect(root.i18n.text(['en-US'], 'outer', ['{1}', 'must not expand'])).toBe('{1}')
    expect(root.i18n.text(['zh-CN'], 'example.empty')).toBe('')
    expect(root.i18n.text(['en-US'], 'missing')).toBe('missing')
    expect(interpolate('{constructor} {value} {nested.secret}', { value: false })).toBe('{constructor} false {nested.secret}')
    await root.fiber.dispose()
  })

  it('restores prior layers on override removal and does not mutate registered dictionaries', async () => {
    const root = new Context()
    await root.plugin(I18nService)
    const original = { example: { title: 'Original' } }
    root.i18n.define(root, 'en-US', original)
    original.example.title = 'Mutated'
    const override = (ctx: Context) => { ctx.i18n.define(ctx, 'en-US', { example: { title: 'Override' } }) }
    override.inject = ['i18n']
    const fiber = await root.plugin(override)
    expect(root.i18n.text([], 'example.title')).toBe('Override')
    await fiber.dispose()
    expect(root.i18n.text([], 'example.title')).toBe('Original')
    await root.fiber.dispose()
  })

  it('stages entire generations, fences stale activation and retires only owned entries', async () => {
    const root = new Context()
    await root.plugin(I18nService)
    const first = root.i18n.createStage()
    const disposeFirst = first.define(root, 'en-US', { plugin: { title: 'First' } })
    expect(root.i18n.text([], 'plugin.title')).toBe('plugin.title')
    root.i18n.activateSnapshot(1, first)
    const second = root.i18n.createStage()
    const disposeSecond = second.define(root, 'en-US', { plugin: { title: 'Second' } })
    expect(root.i18n.text([], 'plugin.title')).toBe('First')
    root.i18n.activateSnapshot(2, second)
    disposeFirst()
    expect(root.i18n.text([], 'plugin.title')).toBe('Second')
    expect(() => root.i18n.activateSnapshot(1, first)).toThrow('stale')
    disposeSecond()
    expect(root.i18n.text([], 'plugin.title')).toBe('plugin.title')
    await root.fiber.dispose()
  })

  it('rejects unsafe catalogs and bounds reference cycles without evaluating expressions', async () => {
    const root = new Context()
    await root.plugin(I18nService)
    expect(() => root.i18n.define(root, '__proto__', { key: 'value' })).toThrow()
    expect(() => root.i18n.define(root, 'en-US', JSON.parse('{"__proto__":{"polluted":"yes"}}'))).toThrow()
    expect(() => root.i18n.define(root, 'en-US', { 'x.y': 'a', x: { y: 'b' } })).toThrow('Duplicate')
    const cyclic: Record<string, any> = {}; cyclic.self = cyclic
    expect(() => root.i18n.define(root, 'en-US', cyclic)).toThrow('acyclic')
    root.i18n.define(root, 'en-US', { a: '{@b}', b: '{@a}', code: '{process.exit()}' })
    expect(root.i18n.text([], 'a')).toBe('{@a}')
    expect(root.i18n.text([], 'code')).toBe('{process.exit()}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    await root.fiber.dispose()
  })
})
