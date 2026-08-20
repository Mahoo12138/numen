import { Service, type Context } from 'cordis'
import type {
  FrontendExtensionRef,
  FrontendPage,
} from './extensions.js'
import './extensions.js'

export interface BrowserRouterEnvironment {
  location: Pick<Location, 'href'>
  history: Pick<History, 'state' | 'pushState' | 'replaceState'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

export interface BrowserRouterConfig {
  environment?: BrowserRouterEnvironment
}

export interface BrowserRouteTarget {
  parameters?: Record<string, string | number>
  query?: Record<string, string | number | boolean | null | undefined>
}

export interface BrowserNavigateOptions extends BrowserRouteTarget {
  replace?: boolean
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
  private state!: BrowserRouteState

  constructor(ctx: Context, config: BrowserRouterConfig = {}) {
    super(ctx, 'webuiRouter')
    this.environment = config.environment ?? defaultEnvironment()
  }

  *[Service.init]() {
    const onPopState = () => this.reconcile()
    this.environment.addEventListener('popstate', onPopState)
    const disposePageListener = this.ctx.on('numen/webui-extension-change', (kind) => {
      if (kind === 'page') this.reconcile(true)
    })
    this.reconcile(true)
    yield () => {
      disposePageListener()
      this.environment.removeEventListener('popstate', onPopState)
    }
  }

  getState(): BrowserRouteState {
    return {
      ...this.state,
      parameters: { ...this.state.parameters },
      ...(this.state.page ? { page: this.state.page } : {}),
    }
  }

  href(ref: FrontendExtensionRef, target: BrowserRouteTarget = {}): string {
    const page = this.ctx.webuiExtensions.getPage(ref)
    if (!page) throw new Error(`frontend route not found: ${ref.id}@${ref.version}`)
    return buildPath(page, target)
  }

  navigate(ref: FrontendExtensionRef, options: BrowserNavigateOptions = {}): BrowserRouteState {
    const href = this.href(ref, options)
    const historyState = {
      ...(this.environment.history.state && typeof this.environment.history.state === 'object'
        ? this.environment.history.state as Record<string, unknown>
        : {}),
      numenRoute: { id: ref.id, version: ref.version },
    }
    if (options.replace) this.environment.history.replaceState(historyState, '', href)
    else this.environment.history.pushState(historyState, '', href)
    this.reconcile()
    return this.getState()
  }

  reconcile(force = false): BrowserRouteState {
    const url = new URL(this.environment.location.href)
    const pathname = normalizePathname(url.pathname)
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
    this.state = next
    if (changed || force) this.ctx.emit('numen/webui-route-change', this.getState())
    return this.getState()
  }
}

export default BrowserRouterService
