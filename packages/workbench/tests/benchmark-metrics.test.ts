import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { Page } from '@playwright/test'
import { DisposableList } from 'cordis'
import { describe, expect, it } from 'vitest'
import { createProbe, hostSnapshot, summarize } from '../../../benchmarks/workbench/metrics.js'

async function harness() {
  const page = new EventEmitter() as EventEmitter & { context(): unknown; locator(): unknown }
  page.context = () => ({ newCDPSession: async () => ({
    send: async (method: string) => method === 'Runtime.getHeapUsage' ? { usedSize: 10, backingStorageSize: 2 }
      : method === 'Memory.getDOMCounters' ? { documents: 1, nodes: 20, jsEventListeners: 4 } : {},
  }) })
  page.locator = () => ({ count: async () => 15 })
  const probe = await createProbe(page as unknown as Page)
  const socket = (path = '/api/console/subscribe') => {
    const transport = new EventEmitter() as EventEmitter & { url(): string }
    transport.url = () => `ws://127.0.0.1:8080${path}`
    page.emit('websocket', transport)
    return {
      sent: (message: unknown) => transport.emit('framesent', { payload: JSON.stringify(message) }),
      received: (message: unknown) => transport.emit('framereceived', { payload: JSON.stringify(message) }),
      malformed: () => transport.emit('framereceived', { payload: 'not-json' }),
      close: () => transport.emit('close'),
    }
  }
  return { probe, socket, snapshot: () => probe.snapshot('test') }
}

describe('Workbench benchmark measurement boundaries', () => {
  it('uses nearest-rank percentiles and preserves the original sample sequence', () => {
    const samples = [20, 1, ...Array.from({ length: 18 }, (_, index) => index + 2)]
    const original = [...samples]
    expect(summarize(samples)).toEqual({ count: 20, p50Ms: 10, p95Ms: 19, maxMs: 20, samplesMs: original })
    expect(samples).toEqual(original)
    expect(summarize([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null, samplesMs: [] })
    expect(summarize([7])).toMatchObject({ count: 1, p50Ms: 7, p95Ms: 7, maxMs: 7 })
  })

  it('separates pending, acknowledged and stopping subscriptions across socket epochs', async () => {
    const { probe, socket, snapshot } = await harness()
    const first = socket(), other = socket('/another-socket')
    first.sent({ type: 'subscribe', id: 'browser-1', procedure: 'workbench:changed@1' })
    expect(await snapshot()).toMatchObject({ liveSocketTransports: 1, openSockets: 1, socketCountKind: 'live-transport', activeSubscriptions: 0, pendingSubscriptions: 1 })
    first.received({ type: 'ready', id: 'browser-1', requestId: 'server-1' })
    first.sent({ type: 'unsubscribe', id: 'browser-1' })
    expect(await snapshot()).toMatchObject({ activeSubscriptions: 1, pendingSubscriptions: 0, closingSubscriptions: 1, subscriptions: ['workbench:changed@1'] })
    const second = socket()
    second.sent({ type: 'subscribe', id: 'browser-1', procedure: 'workbench:changed@1' })
    second.received({ type: 'ready', id: 'browser-1', requestId: 'server-2' })
    expect(await snapshot()).toMatchObject({ liveSocketTransports: 2, activeSubscriptions: 2 })
    first.received({ type: 'unsubscribed', id: 'browser-1' })
    expect(await snapshot()).toMatchObject({ activeSubscriptions: 1, closingSubscriptions: 0 })
    first.close(); first.close(); other.close()
    expect(await snapshot()).toMatchObject({ liveSocketTransports: 1, activeSubscriptions: 1 })
    second.received({ type: 'complete', id: 'browser-1', reason: 'provider_unavailable' })
    second.close()
    expect(await snapshot()).toMatchObject({ liveSocketTransports: 0, activeSubscriptions: 0, pendingSubscriptions: 0 })
    probe.assertHealthy()
  })

  it('does not turn an error after ready into a false subscription release', async () => {
    const { probe, socket, snapshot } = await harness(), connection = socket()
    connection.sent({ type: 'subscribe', id: 'active', procedure: 'workbench:changed@1' })
    connection.received({ type: 'ready', id: 'active' })
    connection.sent({ type: 'subscribe', id: 'active', procedure: 'another:changed@1' })
    connection.received({ type: 'error', id: 'active', error: { code: 'SUBSCRIPTION_EXISTS', message: 'duplicate' } })
    expect(await snapshot()).toMatchObject({ activeSubscriptions: 1, pendingSubscriptions: 0, subscriptions: ['workbench:changed@1'] })
    expect(() => probe.assertHealthy()).toThrow('SUBSCRIPTION_EXISTS')
    connection.sent({ type: 'subscribe', id: 'pending', procedure: 'missing:changed@1' })
    connection.received({ type: 'error', id: 'pending', error: { code: 'PROCEDURE_NOT_FOUND' } })
    expect(await snapshot()).toMatchObject({ activeSubscriptions: 1, pendingSubscriptions: 0 })
  })

  it('accepts only the expected missing-unsubscribe response and reports malformed or uncorrelated protocol frames', async () => {
    const healthy = await harness(), connection = healthy.socket()
    connection.sent({ type: 'subscribe', id: 'known', procedure: 'workbench:changed@1' })
    connection.received({ type: 'ready', id: 'known' })
    connection.sent({ type: 'unsubscribe', id: 'known' })
    connection.received({ type: 'complete', id: 'known', reason: 'provider_unavailable' })
    connection.received({ type: 'error', id: 'known', error: { code: 'SUBSCRIPTION_NOT_FOUND' } })
    expect(await healthy.snapshot()).toMatchObject({ activeSubscriptions: 0, pendingSubscriptions: 0, closingSubscriptions: 0 })
    healthy.probe.assertHealthy()
    const invalid = await harness(), unknown = invalid.socket()
    unknown.received({ type: 'ready', id: 'never-sent' })
    unknown.malformed()
    unknown.received({ type: 'error', error: { code: 'MESSAGE_INVALID' } })
    expect(() => invalid.probe.assertHealthy()).toThrow('Malformed Console subscription frame')
  })

  it('reads existing host registries without confusing unavailable counters with zero', () => {
    const active = { activeSubscriptions: new Set([{}, {}]) }, idle = { activeSubscriptions: new Set() }
    const open = { readyState: 1, OPEN: 1 }, closing = { readyState: 2, OPEN: 1 }
    const entries = new Map([['numen:changed@1', active], ['numen:query@1', idle]])
    const clients = new Set([open, closing])
    const routes = new DisposableList<{ path: string; clients: typeof clients }>()
    for (const route of [
      { path: '/api/console/subscribe', clients },
      { path: '/api/console/subscribe', clients: new Set([open]) },
      { path: '/another-socket', clients: new Set([open]) },
    ]) routes.push(route)
    const context = { console: { entries }, server: { wsRoutes: routes } }
    expect(hostSnapshot(context)).toEqual({
      consoleSubscriptions: { supported: true, activeSubscriptions: 2, byProcedure: { 'numen:changed@1': 2 } },
      consoleSockets: { supported: true, liveSocketTransports: 2, openSockets: 1 },
    })
    expect(active.activeSubscriptions.size).toBe(2)
    expect(clients.size).toBe(2)
    for (const unavailable of [undefined, {}, { console: { entries: [] }, server: { wsRoutes: [] } },
      { console: { entries: new Map([['changed', {}]]) }, server: { wsRoutes: [{ path: '/api/console/subscribe' }] } },
      { get console() { throw Error('unavailable') }, get server() { throw Error('unavailable') } },
    ]) {
      expect(hostSnapshot(unavailable)).toEqual({
        consoleSubscriptions: { supported: false, reason: expect.any(String) },
        consoleSockets: { supported: false, reason: expect.any(String) },
      })
    }
    expect(hostSnapshot({ console: { entries: new Map() }, server: { wsRoutes: [{ path: '/api/console/subscribe', clients: new Set() }] } })).toEqual({
      consoleSubscriptions: { supported: true, activeSubscriptions: 0, byProcedure: {} },
      consoleSockets: { supported: true, liveSocketTransports: 0, openSockets: 0 },
    })
  })

  it('executes the actual Playwright-transformed probe in a fresh realm and detects property-only updates after capture', () => {
    const require = createRequire(import.meta.url)
    const playwrightRequire = createRequire(require.resolve('@playwright/test'))
    const playwrightRoot = dirname(playwrightRequire.resolve('playwright/package.json'))
    const { babelTransform } = require(join(playwrightRoot, 'lib/transform/babelBundle.js')) as {
      babelTransform(source: string, filename: string, isModule: boolean, plugins: unknown[]): { code: string }
    }
    const filename = fileURLToPath(new URL('../../../benchmarks/workbench/metrics.ts', import.meta.url))
    const source = readFileSync(filename, 'utf8') + '\nexport const injectedProbeSource = browserProbe.toString()\n'
    const exports: Record<string, unknown> = {}
    runInNewContext(babelTransform(source, filename, false, []).code, { exports, module: { exports }, require, process })
    const frames: Array<() => void> = [], listeners = new Map<string, (event: unknown) => void>()
    let now = 0
    class TestElement { value = 'before'; closest() { return this } }
    const input = new TestElement()
    const scope = {
      window: {} as { __numenBench?: { arm(ready: unknown, event?: string, target?: string): void; timing?: { start: number; end?: number } } },
      document: { querySelector: () => input, addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback), removeEventListener: (type: string) => listeners.delete(type) },
      Element: TestElement,
      MutationObserver: class { observe() {} disconnect() {} },
      PerformanceObserver: class { static supportedEntryTypes: string[] = [] },
      performance: { now: () => now },
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    }
    runInNewContext(`(${exports.injectedProbeSource})({selector:'input',property:'value',value:'never'})`, scope)
    const probe = scope.window.__numenBench!
    probe.arm({ selector: 'input', property: 'value', value: 'after' }, 'focusout', 'input')
    now = 10
    listeners.get('focusout')!({ target: input, type: 'focusout' })
    expect(probe.timing).toEqual({ start: 10, event: 'focusout' })
    // The framework handler runs after document capture and changes only .value.
    input.value = 'after'
    for (let index = 0; index < 3; index++) { now += 16; frames.shift()!() }
    expect(probe.timing?.end).toBe(58)
    expect(listeners.size).toBe(0)
    // A queued paint from an abandoned arm cannot complete the next measurement.
    probe.arm({ selector: 'input', property: 'value', value: 'after' }, 'focusout', 'input')
    listeners.get('focusout')!({ target: input, type: 'focusout' })
    probe.arm({ selector: 'input', property: 'value', value: 'future' }, 'focusout', 'input')
    while (frames.length) frames.shift()!()
    expect(probe.timing).toBeUndefined()
    expect([...listeners.keys()].sort()).toEqual(['focusin', 'focusout'])
    // A focus-only deep link may not produce any DOM mutation.
    input.value = 'before'
    probe.arm({ selector: 'input', property: 'value', value: 'after' })
    input.value = 'after'
    listeners.get('focusin')!({ target: input })
    while (frames.length) { now += 16; frames.shift()!() }
    expect(probe.timing?.end).toBe(now)
    expect(listeners.size).toBe(0)
    // A transient DIRTY-equivalent state can advance during the two paint frames.
    input.value = 'before'
    probe.arm({ selector: 'input', property: 'value', value: 'after', latch: true }, 'blur', 'input')
    listeners.get('blur')!({ target: input, type: 'blur' })
    input.value = 'after'
    frames.shift()!()
    input.value = 'saved'
    while (frames.length) { now += 16; frames.shift()!() }
    expect(probe.timing?.end).toBe(now)
    expect(listeners.size).toBe(0)
  })
})
