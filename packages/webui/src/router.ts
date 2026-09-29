import { Service, type Context } from 'cordis'
import type {
  FrontendExtensionRef,
  FrontendPage,
} from './extensions.js'
import './extensions.js'

export interface BrowserRouterEnvironment {
  location: Pick<Location, 'href'>
  history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

export interface BrowserRouterConfig {
  environment?: BrowserRouterEnvironment
  basePath?: string
}

export interface BrowserRouteTarget {
  parameters?: Record<string, string | number>
  query?: Record<string, string | number | boolean | null | undefined>
}

export interface BrowserNavigateOptions extends BrowserRouteTarget {
  replace?: boolean
}

export interface BrowserNavigationAttempt {
  pathname: string
  search: string
  reason: 'navigate' | 'popstate'
}

export type BrowserNavigationGuard = (attempt: BrowserNavigationAttempt) => boolean

interface HistoryPosition { key: string; index: number }

function historyPosition(state: unknown): HistoryPosition | undefined {
  const value = (state as { numenPosition?: unknown } | null)?.numenPosition
  if (!value || typeof value !== 'object') return
  const position = value as HistoryPosition
  if (typeof position.key === 'string' && Number.isSafeInteger(position.index)) return position
}

export interface BrowserRouteState {
  status: 'READY' | 'NOT_FOUND'
  pathname: string
  search: string
  parameters: Record<string, string>
  page?: FrontendPage
}

declare module 'cordis' {
  interface Context {
    webuiRouter: BrowserRouterService
  }

  interface Events {
    'numen/webui-route-change'(state: BrowserRouteState): void
  }
}

function defaultEnvironment(): BrowserRouterEnvironment {
  return {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener.bind(globalThis),
    removeEventListener: globalThis.removeEventListener.bind(globalThis),
  }
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === '/') return ''
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#') || basePath.includes('//')) {
    throw new TypeError(`invalid browser router base path: ${basePath}`)
  }
  return normalizePathname(basePath)
}

function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname
}

function splitPath(path: string): string[] {
  if (path === '/') return []
  return normalizePathname(path).slice(1).split('/')
}

function matchPage(page: FrontendPage, pathname: string): Record<string, string> | undefined {
  const templateSegments = splitPath(page.path)
  const pathSegments = splitPath(pathname)
  if (templateSegments.length !== pathSegments.length) return
  const parameters: Record<string, string> = {}
  for (let index = 0; index < templateSegments.length; index++) {
    const template = templateSegments[index]!
    const value = pathSegments[index]!
    if (template.startsWith(':')) {
      try {
        parameters[template.slice(1)] = decodeURIComponent(value)
      } catch {
        return
      }
      continue
    }
    if (template !== value) return
  }
  return parameters
}

function routePriority(left: FrontendPage, right: FrontendPage): number {
  const leftParameters = splitPath(left.path).filter(segment => segment.startsWith(':')).length
  const rightParameters = splitPath(right.path).filter(segment => segment.startsWith(':')).length
  return leftParameters - rightParameters || left.path.localeCompare(right.path) || left.id.localeCompare(right.id)
}

function buildPath(page: FrontendPage, target: BrowserRouteTarget): string {
  const parameters = target.parameters ?? {}
  const used = new Set<string>()
  const pathname = page.path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment
    const name = segment.slice(1)
    const value = parameters[name]
    if (value === undefined) throw new Error(`frontend route parameter is required: ${name}`)
    used.add(name)
    return encodeURIComponent(String(value))
  }).join('/')
  for (const name of Object.keys(parameters)) {
    if (!used.has(name)) throw new Error(`frontend route parameter is not declared: ${name}`)
  }
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(target.query ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== undefined && value !== null) search.set(name, String(value))
  }
  const query = search.toString()
  return query ? `${pathname}?${query}` : pathname
}

export class BrowserRouterService extends Service {
  static inject = ['webuiExtensions']

  private readonly environment: BrowserRouterEnvironment
  private readonly basePath: string
  private readonly listeners = new Set<() => void>()
  private readonly guards = new Set<BrowserNavigationGuard>()
  private position!: HistoryPosition
  private acceptedHref = ''
  private acceptedHistory: unknown
  private restoringHistory = false
  private state!: BrowserRouteState

  constructor(ctx: Context, config: BrowserRouterConfig = {}) {
    super(ctx, 'webuiRouter')
    this.environment = config.environment ?? defaultEnvironment()
    this.basePath = normalizeBasePath(config.basePath ?? '')
  }

  *[Service.init]() {
    this.position = historyPosition(this.environment.history.state) ?? { key: globalThis.crypto.randomUUID(), index: 0 }
    this.environment.history.replaceState({ ...this.currentHistory(), numenPosition: this.position }, '', this.environment.location.href)
    this.acceptLocation()
    const onPopState = () => {
      const nextPosition = historyPosition(this.environment.history.state)
      if (this.restoringHistory) {
        if (nextPosition?.key === this.position.key && nextPosition.index === this.position.index) this.restoringHistory = false
        return
      }
      if (!this.allowNavigation(this.environment.location.href, 'popstate')) {
        if (nextPosition?.key === this.position.key && nextPosition.index !== this.position.index) {
          this.restoringHistory = true
          this.environment.history.go(this.position.index - nextPosition.index)
        } else {
          // Entries outside this router do not carry a trustworthy direction.
          // Keep the current document and URL rather than guessing a traversal.
          this.environment.history.replaceState(this.acceptedHistory, '', this.acceptedHref)
        }
        return
      }
      if (nextPosition?.key === this.position.key) this.position = nextPosition
      else {
        this.position = { key: globalThis.crypto.randomUUID(), index: 0 }
        this.environment.history.replaceState({ ...this.currentHistory(), numenPosition: this.position }, '', this.environment.location.href)
      }
      this.acceptLocation()
      this.reconcile()
    }
    this.environment.addEventListener('popstate', onPopState)
    const disposePageListener = this.ctx.on('numen/webui-extension-change', (kind) => {
      if (kind === 'page') this.reconcile(true)
    })
    this.reconcile(true)
    yield () => {
      disposePageListener()
      this.environment.removeEventListener('popstate', onPopState)
      this.listeners.clear()
      this.guards.clear()
    }
  }

  getState(): BrowserRouteState {
    return {
      ...this.state,
      parameters: { ...this.state.parameters },
      ...(this.state.page ? { page: this.state.page } : {}),
    }
  }

  getSnapshot(): BrowserRouteState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  beforeLeave(guard: BrowserNavigationGuard): () => void {
    this.guards.add(guard)
    return () => this.guards.delete(guard)
  }

  private currentHistory(): Record<string, unknown> {
    const state = this.environment.history.state
    return state && typeof state === 'object' ? state as Record<string, unknown> : {}
  }

  private acceptLocation(): void {
    this.acceptedHref = this.environment.location.href
    this.acceptedHistory = this.environment.history.state
  }

  private allowNavigation(href: string, reason: BrowserNavigationAttempt['reason']): boolean {
    const target = new URL(href, this.environment.location.href)
    const current = new URL(this.acceptedHref)
    if (target.pathname === current.pathname && target.search === current.search) return true
    const attempt = { pathname: stripBasePath(normalizePathname(target.pathname), this.basePath), search: target.search, reason }
    return [...this.guards].every(guard => guard(attempt))
  }

  href(ref: FrontendExtensionRef, target: BrowserRouteTarget = {}): string {
    const page = this.ctx.webuiExtensions.getPage(ref)
    if (!page) throw new Error(`frontend route not found: ${ref.id}@${ref.version}`)
    return `${this.basePath}${buildPath(page, target)}` || '/'
  }

  navigate(ref: FrontendExtensionRef, options: BrowserNavigateOptions = {}): BrowserRouteState {
    const href = this.href(ref, options)
    if (this.restoringHistory || !this.allowNavigation(href, 'navigate')) return this.getState()
    if (!options.replace) this.position = { ...this.position, index: this.position.index + 1 }
    const historyState = {
      ...(this.environment.history.state && typeof this.environment.history.state === 'object'
        ? this.environment.history.state as Record<string, unknown>
        : {}),
      numenRoute: { id: ref.id, version: ref.version },
      numenPosition: this.position,
    }
    if (options.replace) this.environment.history.replaceState(historyState, '', href)
    else this.environment.history.pushState(historyState, '', href)
    this.acceptLocation()
    this.reconcile()
    return this.getState()
  }

  reconcile(force = false): BrowserRouteState {
    const url = new URL(this.environment.location.href)
    const pathname = stripBasePath(normalizePathname(url.pathname), this.basePath)
    let page: FrontendPage | undefined
    let parameters: Record<string, string> = {}
    for (const candidate of this.ctx.webuiExtensions.listPages().sort(routePriority)) {
      const match = matchPage(candidate, pathname)
      if (!match) continue
      page = candidate
      parameters = match
      break
    }
    const next: BrowserRouteState = {
      status: page ? 'READY' : 'NOT_FOUND',
      pathname,
      search: url.search,
      parameters,
      ...(page ? { page } : {}),
    }
    const changed = !this.state
      || this.state.pathname !== next.pathname
      || this.state.search !== next.search
      || this.state.page !== next.page
      || JSON.stringify(this.state.parameters) !== JSON.stringify(next.parameters)
    if (changed) this.state = next
    if (changed || force) {
      this.ctx.emit('numen/webui-route-change', this.getState())
      for (const listener of [...this.listeners]) listener()
    }
    return this.getState()
  }
}

export default BrowserRouterService
