import { expect, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, arch, release } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const integer = (name: string, fallback: number) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`Invalid ${name}`)
  return value
}
export const settings = {
  samples: integer('NUMEN_BENCH_SAMPLES', 20),
  coldTrials: integer('NUMEN_BENCH_COLD_TRIALS', 3),
  lifecycleRounds: integer('NUMEN_BENCH_LIFECYCLE_ROUNDS', 10),
}
export interface Ready {
  selector: string
  attribute?: string
  property?: 'value'
  value?: string
  text?: string
  /** Latch a transient state such as DIRTY before the autosave timer advances it. */
  latch?: boolean
}
export interface MeasureOptions { event: 'pointerdown' | 'blur' | 'focusout' | 'input' | 'keydown'; target: string; ready: Ready }
export function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null
  return { count: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null, samplesMs: samples }
}

// Installed before navigation, with no app globals or private Vue state access.
function browserProbe(initialReady: Ready) {
  const state = {
    longTasks: [] as Array<{ startTime: number; duration: number }>,
    supported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    timing: undefined as { start: number; end?: number; event?: string } | undefined,
    cleanup: undefined as (() => void) | undefined,
    arm(ready: Ready, event?: string, target?: string) {
      state.cleanup?.()
      state.timing = undefined
      let disposed = false
      let scheduled = false
      const matches = () => {
        const element = document.querySelector(ready.selector)
        return !!element && (!ready.attribute || element.getAttribute(ready.attribute) === ready.value)
          && (!ready.property || (element as HTMLInputElement).value === ready.value)
          && (!ready.text || element.textContent?.includes(ready.text))
      }
      const check = () => {
        if (disposed || !state.timing || state.timing.end !== undefined || scheduled || !matches()) return
        scheduled = true
        requestAnimationFrame(() => requestAnimationFrame(() => {
          scheduled = false
          if (disposed) return
          if (state.timing && (ready.latch || matches())) {
            state.timing.end = performance.now()
            state.cleanup?.()
          } else check()
        }))
      }
      const begin = (input: Event) => {
        if (target && !(input.target instanceof Element && input.target.closest(target))) return
        if (!state.timing) state.timing = { start: performance.now(), event: input.type }
        check()
        // A framework may update only an input property after the capture phase,
        // which does not produce a MutationObserver notification.
        requestAnimationFrame(check)
      }
      const observer = new MutationObserver(check)
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      document.addEventListener('focusin', check, true)
      state.cleanup = () => {
        disposed = true; observer.disconnect(); document.removeEventListener('focusin', check, true)
        if (event) document.removeEventListener(event, begin, true)
      }
      if (event) document.addEventListener(event, begin, true)
      else { state.timing = { start: 0 }; check() }
    },
  }
  if (state.supported) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
  }).observe({ type: 'longtask', buffered: true })
  ;(window as unknown as { __numenBench: typeof state }).__numenBench = state
  state.arm(initialReady)
}
type ProbeWindow = Window & { __numenBench: BrowserProbeState }
// The browser callback uses the same data shape without importing runtime code.
interface BrowserProbeState {
  arm(ready: Ready, event?: string, target?: string): void
  timing?: { start: number; end?: number }
  longTasks: Array<{ startTime: number; duration: number }>
  supported: boolean
}

export async function createProbe(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  let navigationScript: string | undefined
  const series: Record<string, number[]> = {}
  const measuredIntervals: Array<{ label: string; start: number; end: number }> = []
  const requestCounts: Record<string, number> = {}
  const requestDurations: Record<string, number[]> = {}
  const errors: string[] = []
  let peakSubscriptions = 0
  const sockets = new Map<object, Map<string, string>>()
  const acknowledgements = new Map<object, Set<string>>()
  const closing = new Map<object, Set<string>>()
  const protocolErrors: Array<{ id?: string; code: string }> = []
  const parseFrame = (payload: string | Buffer): Record<string, unknown> | undefined => {
    try {
      const message: unknown = JSON.parse(String(payload))
      if (message && typeof message === 'object' && !Array.isArray(message)) return message as Record<string, unknown>
    } catch { /* A malformed frame makes the measurement invalid, not an empty state. */ }
    errors.push('Malformed Console subscription frame')
  }
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    if (!request.url().endsWith('/api/console/call') || request.method() !== 'POST') return
    const procedure = request.postDataJSON()?.procedure
    if (typeof procedure === 'string') requestCounts[procedure] = (requestCounts[procedure] ?? 0) + 1
  })
  page.on('requestfinished', request => {
    if (!request.url().endsWith('/api/console/call') || request.method() !== 'POST') return
    const procedure = request.postDataJSON()?.procedure, timing = request.timing()
    if (typeof procedure === 'string' && timing.responseEnd >= 0) (requestDurations[procedure] ??= []).push(timing.responseEnd)
  })
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/api/console/subscribe')) return
    const pending = new Map<string, string>(), active = new Set<string>()
    const stopping = new Set<string>()
    sockets.set(socket, pending); acknowledgements.set(socket, active); closing.set(socket, stopping)
    socket.on('framesent', frame => {
      const message = parseFrame(frame.payload)
      if (message?.type === 'subscribe' && typeof message.id === 'string' && typeof message.procedure === 'string' && !pending.has(message.id)) pending.set(message.id, message.procedure)
      if (message?.type === 'unsubscribe' && typeof message.id === 'string') stopping.add(message.id)
    })
    socket.on('framereceived', frame => {
      const message = parseFrame(frame.payload)
      if (!message) return
      const id = typeof message.id === 'string' ? message.id : undefined
      if (message.type === 'ready' && id) {
        if (!pending.has(id)) errors.push('Console subscription ready without an observed subscribe')
        active.add(id)
      }
      if ((message.type === 'unsubscribed' || message.type === 'complete') && id) {
        active.delete(id); pending.delete(id)
        if (message.type === 'unsubscribed') stopping.delete(id)
      }
      if (message.type === 'error') {
        const detail = message.error as { code?: unknown } | undefined
        const code = typeof detail?.code === 'string' ? detail.code : 'UNKNOWN_PROTOCOL_ERROR'
        protocolErrors.push({ ...(id ? { id } : {}), code })
        // An unsubscribe can race with a provider's complete frame. Other errors
        // are unexpected here; errors after ready do not terminate a subscription.
        const alreadyStopped = code === 'SUBSCRIPTION_NOT_FOUND' && !!id && stopping.has(id)
        if (!alreadyStopped) errors.push(`Unexpected Console subscription error: ${code}`)
        if (id && (!active.has(id) || alreadyStopped)) {
          active.delete(id); pending.delete(id); stopping.delete(id)
        }
      }
      peakSubscriptions = Math.max(peakSubscriptions, [...acknowledgements.values()].reduce((sum, ids) => sum + ids.size, 0))
    })
    socket.on('close', () => { sockets.delete(socket); acknowledgements.delete(socket); closing.delete(socket) })
  })
  const finish = async () => {
    await page.waitForFunction(() => (window as unknown as ProbeWindow).__numenBench?.timing?.end !== undefined, undefined, { timeout: 15_000 })
    return page.evaluate(() => {
      const timing = (window as unknown as ProbeWindow).__numenBench.timing!
      return timing.end! - timing.start
    })
  }
  return {
    async navigate(url: string, ready: Ready) {
      if (navigationScript) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: navigationScript })
      const installed = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${browserProbe.toString()})(${JSON.stringify(ready)})` })
      navigationScript = installed.identifier
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const elapsed = await finish()
      await expect(page).toHaveTitle('Numen Workbench')
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)
      return elapsed
    },
    async measure(label: string, options: MeasureOptions, action: () => Promise<void>) {
      await page.evaluate(options => (window as unknown as ProbeWindow).__numenBench.arm(options.ready, options.event, options.target), options)
      await action()
      const elapsed = await finish()
      ;(series[label] ??= []).push(elapsed)
      measuredIntervals.push({ label, ...await page.evaluate(() => {
        const timing = (window as unknown as ProbeWindow).__numenBench.timing!
        return { start: timing.start, end: timing.end! }
      }) })
      return elapsed
    },
    async snapshot(label: string) {
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const dom = await cdp.send('Memory.getDOMCounters')
      const documentElements = await page.locator('*').count()
      const subscriptions = [...acknowledgements].flatMap(([socket, ids]) => [...ids].map(id => sockets.get(socket)?.get(id) ?? 'unknown')).sort()
      const pendingSubscriptions = [...sockets].reduce((sum, [socket, ids]) => sum + [...ids.keys()].filter(id => !acknowledgements.get(socket)?.has(id)).length, 0)
      const closingSubscriptions = [...closing.values()].reduce((sum, ids) => sum + ids.size, 0)
      // Playwright's websocket event includes connection setup. openSockets is a
      // compatibility alias for live transports, not an OPEN-readyState count.
      return { label, heapUsedBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize, ...dom, documentElements,
        liveSocketTransports: sockets.size, openSockets: sockets.size, socketCountKind: 'live-transport' as const,
        activeSubscriptions: subscriptions.length, pendingSubscriptions, closingSubscriptions, subscriptions }
    },
    async summary() {
      const browser = await page.evaluate(() => {
        const state = (window as unknown as ProbeWindow).__numenBench
        return { longTaskSupported: state.supported, longTasks: state.longTasks }
      })
      return { latency: Object.fromEntries(Object.entries(series).map(([label, values]) => [label, summarize(values)])), requestCounts,
        requestDurations: Object.fromEntries(Object.entries(requestDurations).map(([label, values]) => [label, summarize(values)])),
        peakSubscriptions, protocolErrors, measuredIntervals, ...browser }
    },
    assertHealthy() { expect(errors).toEqual([]) },
  }
}

type HostObservation<Value> = ({ supported: true } & Value) | { supported: false; reason: string }
export interface HostSnapshot {
  consoleSubscriptions: HostObservation<{ activeSubscriptions: number; byProcedure: Record<string, number> }>
  consoleSockets: HostObservation<{ liveSocketTransports: number; openSockets: number }>
}

/** Read existing Runtime state only; this does not install a diagnostic endpoint. */
export function hostSnapshot(ctx: unknown): HostSnapshot {
  const context = ctx as {
    console?: { entries?: unknown }
    server?: { wsRoutes?: unknown }
  } | null | undefined
  const consoleSubscriptions = (): HostSnapshot['consoleSubscriptions'] => {
    try {
      // Console currently exposes no public count. Keep this benchmark-only
      // introspection explicit, and fail closed if its private shape changes.
      const entries = context?.console?.entries
      if (!(entries instanceof Map)) return { supported: false, reason: 'Console registry entries are unavailable' }
      const counts: Array<[string, number]> = []
      for (const [key, entry] of entries) {
        if (typeof key !== 'string' || !(entry?.activeSubscriptions instanceof Set)) {
          return { supported: false, reason: 'Console active subscription registry shape is unsupported' }
        }
        if (entry.activeSubscriptions.size) counts.push([key, entry.activeSubscriptions.size])
      }
      counts.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      return { supported: true, activeSubscriptions: counts.reduce((sum, [, count]) => sum + count, 0), byProcedure: Object.fromEntries(counts) }
    } catch { return { supported: false, reason: 'Console registry could not be read' } }
  }
  const consoleSockets = (): HostSnapshot['consoleSockets'] => {
    try {
      const routes = context?.server?.wsRoutes
      if (!routes || typeof (routes as Iterable<unknown>)[Symbol.iterator] !== 'function') return { supported: false, reason: 'Server WebSocket routes are unavailable' }
      const matched = [...routes as Iterable<{ path?: unknown; clients?: unknown }>].filter(route => route?.path === '/api/console/subscribe')
      if (!matched.length) return { supported: false, reason: 'Console WebSocket route is unavailable' }
      const sockets = new Set<{ readyState: number; OPEN: number }>()
      for (const route of matched) {
        if (!(route.clients instanceof Set)) return { supported: false, reason: 'Server WebSocket clients shape is unsupported' }
        for (const socket of route.clients) {
          if (typeof socket?.readyState !== 'number' || typeof socket?.OPEN !== 'number') return { supported: false, reason: 'Server WebSocket readyState is unavailable' }
          sockets.add(socket)
        }
      }
      return { supported: true, liveSocketTransports: sockets.size, openSockets: [...sockets].filter(socket => socket.readyState === socket.OPEN).length }
    } catch { return { supported: false, reason: 'Server WebSocket routes could not be read' } }
  }
  return { consoleSubscriptions: consoleSubscriptions(), consoleSockets: consoleSockets() }
}

async function buildIdentity() {
  const root = join(process.cwd(), 'packages/workbench/dist/app'), hash = createHash('sha256')
  async function visit(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else { hash.update(path.slice(root.length)); hash.update(await readFile(path)) }
    }
  }
  await visit(root)
  let sourceHead = process.env.NUMEN_BENCH_SOURCE_HEAD ?? 'unknown'
  let dirtyPaths: string[] = []
  try {
    sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirtyPaths = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean)
  } catch { /* Archive verification passes its explicit source base. */ }
  return { sourceHead, dirtyPaths, workbenchAssetSha256: hash.digest('hex') }
}
export async function writeResult(testInfo: TestInfo, id: string, result: object) {
  const report = { schemaVersion: 1, id, outcome: 'passed', measuredAt: new Date().toISOString(), settings,
    environment: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version,
      viewport: { width: 1440, height: 960 }, ...await buildIdentity() },
    ...result }
  const path = testInfo.outputPath('metrics.json')
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  await testInfo.attach(id, { path, contentType: 'application/json' })
}
