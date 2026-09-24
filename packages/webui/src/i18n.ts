import { canonicalLocale, fallback, LocaleTree, type MessageParams } from '@numenjs/i18n'
import { Service, type Context } from 'cordis'

export interface BrowserLocaleConfig {
  locale?: string
  supportedLocales?: string[]
  languages?: readonly string[]
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

export const localeStorageKey = 'numen.locale'

declare module 'cordis' { interface Context { webuiLocale: BrowserLocaleService } }

/** Locale preference belongs to this browser, not to server-side durable domain data. */
export class BrowserLocaleService extends Service {
  static inject = ['i18n']
  readonly supportedLocales: readonly string[]
  private readonly languages: readonly string[]
  private readonly storage: BrowserLocaleConfig['storage']
  private preference: string | undefined
  private revision = 0
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, config: BrowserLocaleConfig = {}) {
    super(ctx, 'webuiLocale')
    this.supportedLocales = [...new Set((config.supportedLocales ?? ['en-US', 'zh-CN']).map(canonicalLocale))]
    if (!this.supportedLocales.length) throw new TypeError('At least one browser locale is required.')
    this.languages = config.languages ?? globalThis.navigator?.languages ?? []
    let storage = config.storage
    if (storage === undefined) {
      try { storage = globalThis.localStorage } catch { storage = null }
    }
    this.storage = storage
    let saved: string | null | undefined
    try { saved = storage?.getItem(localeStorageKey) } catch { /* Private browsers may deny storage. */ }
    const candidate = config.locale ?? saved
    if (candidate) {
      try {
        const locale = canonicalLocale(candidate)
        if (this.supportedLocales.includes(locale)) this.preference = locale
      } catch { /* Invalid stored preferences fall back to browser language. */ }
    }
  }

  *[Service.init]() {
    yield this.ctx.i18n.subscribe(() => this.changed())
    yield () => this.listeners.clear()
  }

  get locale(): string {
    if (this.preference) return this.preference
    const languages = this.languages.flatMap(locale => {
      try { return [canonicalLocale(locale)] } catch { return [] }
    })
    return fallback(LocaleTree.from([...this.supportedLocales]), languages)
      .find(locale => this.supportedLocales.includes(locale)) ?? this.supportedLocales[0]!
  }

  get preferredLocale(): string | undefined { return this.preference }

  setLocale(locale: string | undefined): void {
    const next = locale === undefined ? undefined : canonicalLocale(locale)
    if (next !== undefined && !this.supportedLocales.includes(next)) throw new TypeError('Unsupported browser locale.')
    if (next === this.preference) return
    this.preference = next
    try {
      if (next) this.storage?.setItem(localeStorageKey, next)
      else this.storage?.removeItem(localeStorageKey)
    } catch { /* In-memory switching still works when persistence is unavailable. */ }
    this.changed()
  }

  text(path: string | readonly string[], params?: MessageParams): string {
    return this.ctx.i18n.text([this.locale], path, params)
  }

  getSnapshot(): number { return this.revision }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}
