import { Context } from 'cordis'
import { I18nService } from '@numenjs/i18n'
import { BrowserLocaleService } from '@numenjs/webui/i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, shallowRef } from 'vue'
import { provideWorkbenchI18n, registerWorkbenchLocales, t, type WorkbenchI18n } from '../src/i18n.js'
import { renderToMarkup } from './render.js'

type Element = { children: Element[]; parent?: Element | null; text?: string }
const element = (): Element => ({ children: [] })
const renderer = createRenderer<Element, Element>({
  createElement: element, createText: text => ({ children: [], text }), createComment: element,
  setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text },
  parentNode: node => node.parent ?? null, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp() {},
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
})
const contexts: Context[] = [], unmounts: Array<() => void> = []
async function context(locale = 'en-US') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(I18nService)
  await ctx.plugin(BrowserLocaleService, { locale, storage: null })
  registerWorkbenchLocales(ctx)
  return ctx
}
function mount(getService: () => BrowserLocaleService | undefined) {
  let i18n!: WorkbenchI18n
  const app = renderer.createApp({ setup() {
    i18n = provideWorkbenchI18n(getService)
    return () => h('p')
  } })
  app.mount(element())
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  unmounts.push(unmount)
  return { i18n, unmount }
}
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) unmount()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('Workbench per-tree translation cache', () => {
  it('resolves a repeated real render-time UI label only once per service generation', async () => {
    const ctx = await context(), text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    const service = ctx.webuiLocale // WorkbenchShell receives this service as a stable Vue prop.
    const Child = () => <span>{t('workbench.structure.else')}</span>
    const App = defineComponent({ setup() {
      provideWorkbenchI18n(() => service)
      return () => <main><Child /><Child /><Child /></main>
    } })
    const markup = await renderToMarkup(<App />)
    expect(markup.match(/Else/g)).toHaveLength(3)
    expect(text).toHaveBeenCalledTimes(1)
    expect(text).toHaveBeenCalledWith('workbench.structure.else', undefined)
  })

  it('keeps parameterized real UI calls uncached, including mutation of the same params object', async () => {
    const ctx = await context(), text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    const service = ctx.webuiLocale
    const params = { value0: 'First' }
    const Child = () => <span>{t('workbench.actionsForValue0', params)}</span>
    const App = defineComponent({ setup() {
      provideWorkbenchI18n(() => service)
      return () => <main><Child /><Child /></main>
    } })
    expect(await renderToMarkup(<App />)).toContain('First')
    params.value0 = 'Second'
    expect(await renderToMarkup(<App />)).toContain('Second')
    expect(text).toHaveBeenCalledTimes(4)
    expect(text.mock.calls.every(([, received]) => received === params)).toBe(true)
  })

  it('invalidates synchronously on locale changes and Entry stage activation, definition and disposal', async () => {
    const ctx = await context(), service = ctx.webuiLocale, { i18n } = mount(() => service)
    expect(i18n.t('workbench.structure.else')).toBe('Else')
    ctx.webuiLocale.setLocale('zh-CN')
    expect(i18n.locale.value).toBe('zh-CN')
    expect(i18n.t('workbench.structure.else')).not.toBe('Else')
    ctx.webuiLocale.setLocale('en-US')
    expect(i18n.t('workbench.structure.else')).toBe('Else')
    const stage = ctx.i18n.createStage()
    const disposeFirst = stage.define(ctx, 'en-US', { cache: { staged: 'First' } })
    expect(i18n.t('cache.staged')).toBe('cache.staged')
    ctx.i18n.activateSnapshot(1, stage)
    expect(i18n.t('cache.staged')).toBe('First')
    const disposeLater = stage.define(ctx, 'en-US', { cache: { staged: 'Later' } })
    expect(i18n.t('cache.staged')).toBe('Later')
    const disposeHost = ctx.i18n.define(ctx, 'en-US', { cache: { staged: 'Host' } })
    expect(i18n.t('cache.staged')).toBe('Host')
    disposeHost()
    expect(i18n.t('cache.staged')).toBe('Later')
    disposeLater()
    expect(i18n.t('cache.staged')).toBe('First')
    ctx.i18n.deactivateSnapshot(1)
    expect(i18n.t('cache.staged')).toBe('cache.staged')
    ctx.i18n.activateSnapshot(2, stage)
    expect(i18n.t('cache.staged')).toBe('First')
    disposeFirst()
    expect(i18n.t('cache.staged')).toBe('cache.staged')
  })

  it('isolates trees and replaces the subscription immediately even when service revisions are equal', async () => {
    const first = await context('en-US'), second = await context('zh-CN')
    const firstService = first.webuiLocale, secondService = second.webuiLocale
    expect(firstService.getSnapshot()).toBe(secondService.getSnapshot())
    const current = shallowRef<BrowserLocaleService | undefined>(firstService)
    const one = mount(() => current.value), two = mount(() => secondService)
    const listeners = (service: BrowserLocaleService) => (service as unknown as { listeners: Set<() => void> }).listeners.size
    expect(one.i18n.t('workbench.structure.else')).toBe('Else')
    const chinese = two.i18n.t('workbench.structure.else')
    expect(chinese).not.toBe('Else')
    expect(listeners(firstService)).toBe(1)
    expect(listeners(secondService)).toBe(1)
    current.value = secondService
    // No nextTick: replacement and its new dictionary notification must be observed immediately.
    expect(listeners(firstService)).toBe(0)
    expect(listeners(secondService)).toBe(2)
    expect(one.i18n.t('workbench.structure.else')).toBe(chinese)
    secondService.setLocale('en-US')
    expect(one.i18n.t('workbench.structure.else')).toBe('Else')
    expect(two.i18n.t('workbench.structure.else')).toBe('Else')
    current.value = undefined
    expect(listeners(secondService)).toBe(1)
    expect(one.i18n.t('workbench.structure.else')).toBe('Else')
    two.unmount()
    expect(listeners(secondService)).toBe(0)
  })

  it('subscribes before reading the generation snapshot', async () => {
    const ctx = await context(), order: string[] = []
    const subscribe = BrowserLocaleService.prototype.subscribe, getSnapshot = BrowserLocaleService.prototype.getSnapshot
    vi.spyOn(BrowserLocaleService.prototype, 'subscribe').mockImplementation(function (this: BrowserLocaleService, listener) {
      order.push('subscribe')
      return subscribe.call(this, listener)
    })
    vi.spyOn(BrowserLocaleService.prototype, 'getSnapshot').mockImplementation(function (this: BrowserLocaleService) {
      order.push('snapshot')
      return getSnapshot.call(this)
    })
    mount(() => ctx.webuiLocale)
    expect(order.slice(0, 2)).toEqual(['subscribe', 'snapshot'])
  })

  it('fences cached reads made by an earlier listener before the provider invalidation callback runs', async () => {
    const ctx = await context(), service = ctx.webuiLocale
    ctx.i18n.define(ctx, 'en-US', { cache: { observed: 'Before' } })
    let i18n!: WorkbenchI18n
    const observed: Array<[string, string]> = []
    const stop = service.subscribe(() => observed.push([i18n.t('workbench.structure.else'), i18n.t('cache.observed')]))
    try {
      i18n = mount(() => service).i18n
      expect(i18n.t('workbench.structure.else')).toBe('Else')
      expect(i18n.t('cache.observed')).toBe('Before')
      service.setLocale('zh-CN')
      expect(observed.at(-1)?.[0]).not.toBe('Else')
      expect(i18n.t('cache.observed')).toBe('Before')
      ctx.i18n.define(ctx, 'en-US', { cache: { observed: 'After' } })
      expect(observed.at(-1)?.[1]).toBe('After')
    } finally { stop() }
  })

  it('bypasses caching for a service identity that changed outside reactive subscription tracking', async () => {
    const first = await context(), second = await context()
    first.i18n.define(first, 'en-US', { cache: { value: 'First' } })
    second.i18n.define(second, 'en-US', { cache: { value: 'Second' } })
    let current = first.webuiLocale
    const { i18n } = mount(() => current)
    expect(i18n.t('cache.value')).toBe('First')
    current = second.webuiLocale
    expect(i18n.t('cache.value')).toBe('Second')
    second.i18n.define(second, 'en-US', { cache: { value: 'Updated second' } })
    expect(i18n.t('cache.value')).toBe('Updated second')
  })

  it('preserves missing keys, empty messages, references, cycles and reference-created literal placeholders', async () => {
    const ctx = await context()
    ctx.i18n.define(ctx, 'en-US', { cache: {
      empty: '', left: '{', right: 'name}', joined: '{@cache.left}{@cache.right}',
      inner: '{user.name}', outer: 'Hello {@cache.inner}', cycleA: '{@cache.cycleB}', cycleB: '{@cache.cycleA}',
      argument: '{0}', reference: '{@cache.argument}',
    } })
    const service = ctx.webuiLocale, { i18n } = mount(() => service)
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(i18n.t('cache.missing')).toBe('cache.missing')
      expect(i18n.t('cache.empty')).toBe('')
      expect(i18n.t('cache.cycleA')).toBe('{@cache.cycleA}')
      expect(i18n.t('cache.joined')).toBe('{name}')
      expect(i18n.t('cache.joined', { name: 'must stay literal' })).toBe('{name}')
      expect(i18n.t('cache.missing.{name}', { name: 'must stay literal' })).toBe('cache.missing.{name}')
      expect(i18n.t('cache.reference', ['{1}', 'must not expand'])).toBe('{1}')
    }
    const params = { user: { name: 'First' } }
    expect(i18n.t('cache.outer', params)).toBe('Hello First')
    params.user.name = 'Second'
    expect(i18n.t('cache.outer', params)).toBe('Hello Second')
    expect(i18n.t('cache.outer')).toBe('Hello {user.name}')
    const untouched = { get unused() { throw Error('Unrelated params must not be enumerated') }, user: { name: 'Safe' } }
    expect(i18n.t('cache.outer', untouched)).toBe('Hello Safe')
  })

  it('bounds cached keys at 256, evicts old entries and reuses the newest text', async () => {
    const ctx = await context()
    ctx.i18n.define(ctx, 'en-US', { cache: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`k${index}`, `Label ${index}`])) })
    const service = ctx.webuiLocale, { i18n } = mount(() => service), text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    for (let index = 0; index < 257; index++) expect(i18n.t(`cache.k${index}`)).toBe(`Label ${index}`)
    expect(text).toHaveBeenCalledTimes(257)
    expect(i18n.t('cache.k256')).toBe('Label 256')
    expect(text).toHaveBeenCalledTimes(257)
    expect(i18n.t('cache.k0')).toBe('Label 0')
    expect(text).toHaveBeenCalledTimes(258)
  })

  it('caches empty strings but delegates every explicit params value, including empty arrays and objects', async () => {
    const ctx = await context(), service = ctx.webuiLocale
    ctx.i18n.define(ctx, 'en-US', { cache: { empty: '' } })
    const { i18n } = mount(() => service), text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    expect(i18n.t('cache.empty')).toBe('')
    expect(i18n.t('cache.empty')).toBe('')
    expect(text).toHaveBeenCalledTimes(1)
    for (const params of [{}, []]) {
      expect(i18n.t('cache.empty', params)).toBe('')
      expect(i18n.t('cache.empty', params)).toBe('')
    }
    expect(text).toHaveBeenCalledTimes(5)
  })

  it('owns separate caches for two providers sharing a service and releases only the unmounted subscription', async () => {
    const ctx = await context(), service = ctx.webuiLocale
    const first = mount(() => service), second = mount(() => service)
    const text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    first.i18n.t('workbench.structure.else'); second.i18n.t('workbench.structure.else')
    first.i18n.t('workbench.structure.else'); second.i18n.t('workbench.structure.else')
    expect(text).toHaveBeenCalledTimes(2)
    const listeners = (service as unknown as { listeners: Set<() => void> }).listeners
    expect(listeners.size).toBe(2)
    first.unmount()
    expect(listeners.size).toBe(1)
    service.setLocale('zh-CN')
    const translated = second.i18n.t('workbench.structure.else')
    expect(translated).not.toBe('Else')
    expect(text).toHaveBeenCalledTimes(3)
    // A retained bridge cannot keep serving its pre-unmount cache.
    expect(first.i18n.t('workbench.structure.else')).toBe(translated)
    expect(first.i18n.t('workbench.structure.else')).toBe(translated)
    expect(text).toHaveBeenCalledTimes(5)
    expect(listeners.size).toBe(1)
    second.unmount()
    expect(listeners.size).toBe(0)
  })

  it('keeps inactive or retired Entry definitions from invalidating the active generation', async () => {
    const ctx = await context(), service = ctx.webuiLocale
    const first = ctx.i18n.createStage(), second = ctx.i18n.createStage()
    const disposeFirst = first.define(ctx, 'en-US', { cache: { entry: 'First' } })
    ctx.i18n.activateSnapshot(1, first)
    const { i18n } = mount(() => service), text = vi.spyOn(BrowserLocaleService.prototype, 'text')
    expect(i18n.t('cache.entry')).toBe('First')
    const disposeInactive = second.define(ctx, 'en-US', { cache: { entry: 'Second' } })
    expect(i18n.t('cache.entry')).toBe('First')
    expect(text).toHaveBeenCalledTimes(1)
    ctx.i18n.activateSnapshot(2, second)
    expect(i18n.t('cache.entry')).toBe('Second')
    expect(text).toHaveBeenCalledTimes(2)
    disposeFirst()
    ctx.i18n.deactivateSnapshot(1)
    expect(i18n.t('cache.entry')).toBe('Second')
    expect(text).toHaveBeenCalledTimes(2)
    disposeInactive()
    expect(i18n.t('cache.entry')).toBe('cache.entry')
    expect(text).toHaveBeenCalledTimes(3)
  })
})
