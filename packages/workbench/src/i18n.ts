import { provideComponentI18n } from '@numenjs/components'
import { interpolate, type MessageParams } from '@numenjs/i18n'
import type { BrowserLocaleService } from '@numenjs/webui/i18n'
import type { Context } from 'cordis'
import type { FrontendPage } from '@numenjs/webui/extensions'
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
  const messages = new Map<string, string>()
  const cacheLimit = 256
  let subscribedService: BrowserLocaleService | undefined
  let cacheRevision = 0
  watchEffect(onCleanup => {
    const service = getService()
    messages.clear()
    subscribedService = service
    if (service) {
      // Subscribe before reading the snapshot so no generation change is lost.
      const unsubscribe = service.subscribe(() => {
        if (subscribedService !== service) return
        messages.clear()
        cacheRevision = service.getSnapshot()
        revision.value = cacheRevision
      })
      onCleanup(() => {
        unsubscribe()
        messages.clear()
        subscribedService = undefined
      })
    }
    cacheRevision = service?.getSnapshot() ?? 0
    revision.value = cacheRevision
  }, { flush: 'sync' })
  const value: WorkbenchI18n = {
    locale: computed(() => { revision.value; return getService()?.locale ?? 'en-US' }),
    preferredLocale: computed(() => { revision.value; return getService()?.preferredLocale }),
    t(path, params) {
      revision.value
      const service = getService()
      if (!service) return preview.t(path, params)
      // Parameter interpolation stays inside the service: resolving references
      // can form literal placeholders that must not be interpreted a second time.
      if (params !== undefined || service !== subscribedService) return service.text(path, params)
      const cached = messages.get(path)
      if (cached !== undefined) {
        // An earlier service listener may render before our invalidation callback.
        // Fence the hit without mutating Vue dependencies during that render.
        const currentRevision = service.getSnapshot()
        if (currentRevision === cacheRevision) return cached
        messages.clear()
        cacheRevision = currentRevision
      }
      const text = service.text(path, params)
      if (messages.size >= cacheLimit) messages.delete(messages.keys().next().value!)
      messages.set(path, text)
      return text
    },
    setLocale(locale) { getService()?.setLocale(locale) },
  }
  provideComponentI18n(key => value.t(`workbench.${key}`))
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
