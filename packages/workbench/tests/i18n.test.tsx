import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { I18nService } from '@numenjs/i18n'
import { BrowserLocaleService } from '@numenjs/webui/i18n'
import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { enUS } from '../src/locales/en-US.js'
import { zhCN } from '../src/locales/zh-CN.js'
import { provideWorkbenchI18n, registerWorkbenchLocales, t, localizeCatalogItem } from '../src/i18n.js'
import { renderToMarkup } from './render.js'

describe('Workbench localization', () => {
  it('keeps catalog keys and interpolation parameters aligned, and resolves literal UI lookups', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort())
    const placeholders = (value: string) => [...new Set(value.match(/\{[\w.-]+\}/g) ?? [])].sort()
    for (const [key, value] of Object.entries(enUS)) {
      expect(placeholders(zhCN[key as keyof typeof enUS]), key).toEqual(placeholders(value))
    }
    const directory = fileURLToPath(new URL('../src/', import.meta.url))
    for (const file of readdirSync(directory).filter(file => file.endsWith('.tsx'))) {
      const text = readFileSync(`${directory}/${file}`, 'utf8')
      for (const match of text.matchAll(/\bt\(['"]([^'"]+)['"]/g)) expect(enUS, `${file}: ${match[1]}`).toHaveProperty(match[1]!)
    }
  })

  it('isolates simultaneous Vue trees and escapes user parameters as text', async () => {
    const create = async (locale: string) => {
      const ctx = new Context()
      await ctx.plugin(I18nService)
      await ctx.plugin(BrowserLocaleService, { locale, storage: null })
      registerWorkbenchLocales(ctx)
      ctx.i18n.define(ctx, locale, { test: { message: '{value}' } })
      const Child = () => <p>{t('workbench.saveChanges')}: {t('test.message', { value: '<script>alert(1)</script>' })}</p>
      const App = defineComponent({ setup() {
        provideWorkbenchI18n(() => ctx.webuiLocale)
        return () => <Child />
      } })
      return { ctx, App }
    }
    const english = await create('en-US'), chinese = await create('zh-CN')
    try {
      const [en, zh] = await Promise.all([renderToMarkup(<english.App />), renderToMarkup(<chinese.App />)])
      expect(en).toContain('Save')
      expect(zh).toContain('保存')
      expect(en).toContain('&lt;script&gt;')
      expect(zh).not.toContain('<script>')
      chinese.ctx.webuiLocale.setLocale('en-US')
      expect(english.ctx.webuiLocale.locale).toBe('en-US')
    } finally {
      await english.ctx.fiber.dispose(); await chinese.ctx.fiber.dispose()
    }
  })

  it('translates catalog labels while retaining contract identity and user-visible literal values', () => {
    const item = { kind: 'capability' as const, capability: { id: 'demo:echo', version: 1 }, title: 'Echo',
      description: 'Echo description', capabilityKind: 'action' as const, providerAvailable: true, connectionSlots: [], connectionRequirements: [], inputSchemaSupported: true,
      inputFields: [{ name: 'message', label: 'Message', type: 'string' as const, required: true, defaultValue: 'User text' }] }
    const localized = localizeCatalogItem(item, key => (zhCN as Record<string, string>)[key] ?? key)
    expect(localized.title).toBe('回显')
    expect('inputFields' in localized && localized.inputFields[0]).toMatchObject({ name: 'message', label: '消息', defaultValue: 'User text' })
    expect(item.inputFields[0]!.label).toBe('Message')
    expect('capability' in localized && localized.capability).toEqual(item.capability)
  })
})
