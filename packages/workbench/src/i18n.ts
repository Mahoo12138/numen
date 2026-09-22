import { interpolate, type MessageParams } from '@numen/i18n'
import type { BrowserLocaleService } from '@numen/webui/i18n'
import type { Context } from 'cordis'
import type { FrontendPage } from '@numen/webui/extensions'
import type { WorkbenchAutomationInsertItem } from './contracts.js'
import { computed, getCurrentInstance, inject, provide, shallowRef, watchEffect, type ComputedRef, type InjectionKey } from 'vue'
import { enUS } from './locales/en-US.js'
import { zhCN } from './locales/zh-CN.js'

export interface WorkbenchI18n {
  locale: ComputedRef<string>
  preferredLocale: ComputedRef<string | undefined>
  t(key: string, params?: MessageParams): string
  setLocale(locale: string | undefined): void
}

const key = Symbol.for('numen.workbench.i18n') as InjectionKey<WorkbenchI18n>
const preview: WorkbenchI18n = {
  locale: computed(() => 'en-US'),
  preferredLocale: computed(() => undefined),
  t: (path, params) => interpolate((enUS as Record<string, string>)[path] ?? path, params),
  setLocale() {},
}

export function registerWorkbenchLocales(ctx: Context): void {
  ctx.i18n.define(ctx, 'en-US', enUS)
  ctx.i18n.define(ctx, 'zh-CN', zhCN)
}

/** A Vue subtree owns its subscription; separate Workbench apps never share language state. */
export function provideWorkbenchI18n(getService: () => BrowserLocaleService | undefined): WorkbenchI18n {
  const revision = shallowRef(0)
  watchEffect(onCleanup => {
    const service = getService()
    revision.value = service?.getSnapshot() ?? 0
    if (service) onCleanup(service.subscribe(() => { revision.value = service.getSnapshot() }))
  })
  const value: WorkbenchI18n = {
    locale: computed(() => { revision.value; return getService()?.locale ?? 'en-US' }),
    preferredLocale: computed(() => { revision.value; return getService()?.preferredLocale }),
    t(path, params) {
      revision.value
      return getService()?.text(path, params) ?? preview.t(path, params)
    },
    setLocale(locale) { getService()?.setLocale(locale) },
  }
  provide(key, value)
  return value
}

export function useWorkbenchI18n(): WorkbenchI18n {
  return getCurrentInstance() ? inject(key, preview) : preview
}

/** Render-time helper for both Vue functional components and ordinary JSX projections. */
export function t(path: string, params?: MessageParams): string {
  return useWorkbenchI18n().t(path, params)
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(useWorkbenchI18n().locale.value, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date)
}

export function pageTitle(page: Pick<FrontendPage, 'title' | 'titleKey'>): string {
  return page.titleKey ? t(page.titleKey) : page.title
}

export function statusLabel(status: string): string {
  const key = `workbench.status.${status.toUpperCase()}`
  const result = t(key)
  return result === key ? status.charAt(0) + status.slice(1).toLowerCase() : result
}

export function plural(key: string, count: number): string {
  const category = new Intl.PluralRules(useWorkbenchI18n().locale.value).select(count)
  return t(`${key}.${category}`, { count })
}

/** Localize only contract metadata; Source names, bindings, enum values, and defaults stay untouched. */
export function localizeCatalogItem(item: WorkbenchAutomationInsertItem, translate = t): WorkbenchAutomationInsertItem {
  const prefix = item.kind === 'control' ? `workbench.controls.${item.control}`
    : item.kind === 'extension' ? `workbench.controls.${item.control.id}@${item.control.version}`
      : `workbench.capabilities.${item.capability.id}@${item.capability.version}`
  const value = (path: string, original: string) => {
    const translated = translate(`${prefix}.${path}`)
    return translated === `${prefix}.${path}` ? original : translated
  }
  return { ...item, title: value('title', item.title),
    ...(item.description ? { description: value('description', item.description) } : {}),
    ...('inputFields' in item ? { inputFields: item.inputFields.map(field => ({ ...field,
      label: value(`fields.${field.name}`, field.label),
      ...(field.description ? { description: value(`fieldDescriptions.${field.name}`, field.description) } : {}),
    })) } : {}),
  }
}

export function diagnosticText(diagnostic: { code?: string; message: string }): string {
  if (!diagnostic.code || useWorkbenchI18n().locale.value === 'en-US') return diagnostic.message
  const key = `workbench.errors.${diagnostic.code}`
  const translated = t(key, { message: diagnostic.message })
  return translated === key ? diagnostic.message : translated
}

export function metadataText(key: string, fallback: string): string {
  const translated = t(key)
  return translated === key ? fallback : translated
}
