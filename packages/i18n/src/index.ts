import { LocaleTree, fallback } from '@koishijs/i18n-utils'
import { Service, type Context } from 'cordis'

export { LocaleTree, fallback } from '@koishijs/i18n-utils'

export interface LocaleMessages { [key: string]: string | LocaleMessages }
export type MessageParams = Readonly<Record<string, unknown>> | readonly unknown[]
export interface I18nConfig { locales?: string[] }
interface Definition { locale: string; messages: ReadonlyMap<string, string> }

declare module 'cordis' {
  interface Context { i18n: I18nService }
}

/** Validate before passing locale identifiers to Koishi's object-backed tree. */
export function canonicalLocale(locale: string): string {
  const result = Intl.getCanonicalLocales(locale)[0]
  if (!result) throw new TypeError('A non-empty BCP 47 locale is required.')
  return result
}

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
function validatePath(path: string): void {
  if (!path || path.split('.').some(part => !part || unsafeKeys.has(part))) {
    throw new TypeError(`Invalid i18n message path: ${path}`)
  }
}

function flatten(messages: LocaleMessages, prefix = ''): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  const ancestors = new Set<object>()
  const visit = (value: LocaleMessages, path: string, depth: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 32 || ancestors.has(value)) {
      throw new TypeError('Locale messages must be an acyclic tree of strings (maximum depth 32).')
    }
    ancestors.add(value)
    for (const [key, child] of Object.entries(value)) {
      const fullPath = path ? `${path}.${key}` : key
      validatePath(fullPath)
      if (typeof child === 'string') {
        if (result.has(fullPath)) throw new TypeError(`Duplicate i18n message path: ${fullPath}`)
        result.set(fullPath, child)
      } else visit(child, fullPath, depth + 1)
    }
    ancestors.delete(value)
  }
  if (prefix) validatePath(prefix)
  visit(messages, prefix, 0)
  return result
}

function definition(locale: string, path: string | LocaleMessages, messages?: LocaleMessages): Definition {
  return { locale: canonicalLocale(locale), messages: flatten(typeof path === 'string' ? messages! : path, typeof path === 'string' ? path : '') }
}

function ownParam(params: MessageParams, path: string): unknown {
  let value: unknown = params
  for (const part of path.split('.')) {
    if (unsafeKeys.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Plain text only: no evaluation, HTML parsing, or mutation of caller parameters. */
export function interpolate(message: string, params: MessageParams = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (original, path: string) => {
    const value = ownParam(params, path)
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value) : original
  })
}

/** Registrations remain invisible until the owning Entry generation is activated. */
export class I18nStage {
  readonly definitions = new Map<symbol, Definition>()

  constructor(private readonly service: I18nService) {}

  define(owner: Context, locale: string, path: string | LocaleMessages, messages?: LocaleMessages): () => void {
    const value = definition(locale, path, messages)
    const token = Symbol()
    return owner.effect(() => {
      this.definitions.set(token, value)
      this.service.stageChanged(this)
      return () => {
        this.definitions.delete(token)
        this.service.stageChanged(this)
      }
    }, 'i18n.stage.define')
  }

  locales(): string[] { return this.service.locales() }
  fallback(locales: readonly string[]): string[] { return this.service.fallback(locales) }
  getSnapshot(): number { return this.service.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.service.subscribe(listener) }

  text(locales: readonly string[], path: string | readonly string[], params?: MessageParams): string {
    return this.service.text(locales, path, params)
  }
}

/** Shared Node/browser service. The caller supplies locales; server requests never share a mutable language. */
export class I18nService extends Service {
  private readonly defaults: string[]
  private readonly definitions = new Map<symbol, Definition>()
  private readonly listeners = new Set<() => void>()
  private active: { revision: number; stage: I18nStage } | undefined
  private revision = 0

  constructor(ctx: Context, config: I18nConfig = {}) {
    super(ctx, 'i18n')
    this.defaults = [...new Set((config.locales?.length ? config.locales : ['en-US']).map(canonicalLocale))]
    ctx.effect(() => () => this.listeners.clear())
  }

  define(owner: Context, locale: string, path: string | LocaleMessages, messages?: LocaleMessages): () => void {
    const value = definition(locale, path, messages)
    const token = Symbol()
    return owner.effect(() => {
      this.definitions.set(token, value)
      this.changed()
      return () => {
        this.definitions.delete(token)
        this.changed()
      }
    }, 'i18n.define')
  }

  locales(): string[] {
    return [...new Set([...this.defaults, ...this.layers().map(item => item.locale)])]
  }

  fallback(locales: readonly string[]): string[] {
    const preferences = locales.flatMap(locale => {
      try { return [canonicalLocale(locale)] } catch { return [] }
    })
    return fallback(LocaleTree.from(this.locales()), preferences).filter(Boolean)
  }

  text(locales: readonly string[], paths: string | readonly string[], params: MessageParams = {}): string {
    const chain = this.fallback(locales)
    for (const path of typeof paths === 'string' ? [paths] : paths) {
      const value = this.resolve(chain, path, params, new Set())
      if (value !== undefined) return value
    }
    return typeof paths === 'string' ? paths : paths[0] ?? ''
  }

  private resolve(chain: readonly string[], path: string, params: MessageParams, seen: Set<string>): string | undefined {
    if (seen.has(path) || seen.size > 32) return undefined
    const layers = this.layers().reverse()
    for (const locale of chain) {
      const message = layers.find(item => item.locale === locale && item.messages.has(path))?.messages.get(path)
      if (message === undefined) continue
      const visited = new Set(seen).add(path)
      // Koishi's {@path} references, rendered as text, with bounded cycle protection.
      return message.replace(/\{(?:@([^{}]+)|([\w.-]+))\}/g, (original, reference: string | undefined) => (
        reference ? this.resolve(chain, reference, params, visited) ?? original : interpolate(original, params)
      ))
    }
  }

  createStage(): I18nStage { return new I18nStage(this) }

  validateSnapshot(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || (this.active && revision <= this.active.revision)) {
      throw new TypeError('Invalid or stale i18n snapshot revision.')
    }
  }

  activateSnapshot(revision: number, stage: I18nStage): void {
    this.validateSnapshot(revision)
    this.active = { revision, stage }
    this.changed()
  }

  deactivateSnapshot(revision: number): void {
    if (this.active?.revision !== revision) return
    this.active = undefined
    this.changed()
  }

  stageChanged(stage: I18nStage): void { if (this.active?.stage === stage) this.changed() }
  getSnapshot(): number { return this.revision }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private layers(): Definition[] {
    // Direct host overrides take precedence over Entry-owned defaults.
    return [...this.active?.stage.definitions.values() ?? [], ...this.definitions.values()]
  }

  private changed(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}

export default I18nService
