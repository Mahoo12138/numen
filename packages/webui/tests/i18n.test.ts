import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { I18nService } from '@numenjs/i18n'
import { BrowserLocaleService, localeStorageKey } from '../src/i18n.js'

describe('browser locale preferences', () => {
  it('negotiates locale, persists explicit choices, and notifies on dictionary changes', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const create = async () => {
      const ctx = new Context()
      await ctx.plugin(I18nService)
      await ctx.plugin(BrowserLocaleService, { languages: ['zh-TW'], storage })
      ctx.i18n.define(ctx, 'en-US', { title: 'Hello' })
      ctx.i18n.define(ctx, 'zh-CN', { title: '你好' })
      return ctx
    }
    const first = await create()
    expect(first.webuiLocale.locale).toBe('zh-CN')
    expect(first.webuiLocale.text('title')).toBe('你好')
    first.webuiLocale.setLocale('en-us')
    expect(values.get(localeStorageKey)).toBe('en-US')
    const second = await create()
    expect(second.webuiLocale.locale).toBe('en-US')
    const listener = vi.fn()
    const dispose = second.webuiLocale.subscribe(listener)
    second.i18n.define(second, 'en-US', { title: 'Updated' })
    expect(listener).toHaveBeenCalledOnce()
    second.webuiLocale.setLocale(undefined)
    expect(second.webuiLocale.locale).toBe('zh-CN')
    expect(values.has(localeStorageKey)).toBe(false)
    dispose()
    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  it('handles blocked storage, invalid stored tags and independent browser contexts', async () => {
    const first = new Context(), second = new Context()
    await first.plugin(I18nService); await second.plugin(I18nService)
    await first.plugin(BrowserLocaleService, { languages: ['bad_locale', 'zh-CN'], storage: {
      getItem: () => '__proto__', setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') },
    } })
    await second.plugin(BrowserLocaleService, { languages: ['en-US'], storage: null })
    first.webuiLocale.setLocale('en-US')
    expect(first.webuiLocale.locale).toBe('en-US')
    first.webuiLocale.setLocale('zh-CN')
    expect(second.webuiLocale.locale).toBe('en-US')
    expect(() => first.webuiLocale.setLocale('fr-FR')).toThrow('Unsupported')
    await first.fiber.dispose(); await second.fiber.dispose()
  })
})
