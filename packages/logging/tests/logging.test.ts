import { Context } from 'cordis'
import { mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoggingService, namespaceLevel, resolveLoggingConfig, validateLoggingConfig, withLogContext } from '../src/index.js'

const roots: Context[] = [], directories: string[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function root(config: ConstructorParameters<typeof LoggingService>[1] = {}) {
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(LoggingService, { console: false, ...config })
  return ctx
}
async function directory() { const path = await mkdtemp(join(tmpdir(), 'numen-logs-')); directories.push(path); return path }

describe('host logging', () => {
  it('validates inherited namespace levels, explicit overrides, and environment precedence without mutating config', () => {
    const config = { levels: { base: 1, http: { base: 2, client: 0 }, 'special:exact': 3 } }
    const resolved = resolveLoggingConfig(config, { NUMEN_LOG_LEVEL: '0', NUMEN_DEBUG: 'http:client, scheduler' })
    expect(namespaceLevel(resolved.levels, 'http:other')).toBe(2)
    expect(namespaceLevel(resolved.levels, 'http:client')).toBe(3)
    expect(namespaceLevel(resolved.levels, 'http:client:transport')).toBe(3)
    expect(namespaceLevel(resolved.levels, 'unconfigured')).toBe(0)
    expect(config.levels.base).toBe(1)
    expect(() => resolveLoggingConfig({}, { NUMEN_LOG_LEVEL: 'NaN' })).toThrow()
    for (const config of [{ levels: { base: -1 } }, { capacity: 0 }, { levels: JSON.parse('{"__proto__":3}') }, { persist: 'yes' }]) expect(() => validateLoggingConfig(config)).toThrow()
    const cyclic: any = {}; cyclic.child = cyclic
    expect(() => validateLoggingConfig({ levels: cyclic })).toThrow()
  })

  it('uses a single sanitized projection for terminal, disk and history without inspecting getters or mutating arguments', async () => {
    const path = await directory(), output: string[] = []
    const ctx = await root({ directory: path, console: true, secrets: ['bare-private-token'], writeConsole: line => output.push(line) })
    const getter = vi.fn(() => { throw new Error('do not read') })
    const value: any = { password: 'secret-password', headers: { authorization: 'Bearer header-private-token' }, body: 'personal message', nested: { value: 'bare-private-token' } }
    value.circular = value
    Object.defineProperty(value, 'danger', { enumerable: true, get: getter })
    ctx.logger('plugin').info('object %o', value)
    ctx.logger('plugin').error(new Error('https://example.test/#numen-bootstrap=bootstrap-secret'))
    ctx.logger('plugin').info('token=%s', 'formatted-secret')
    ctx.logger('plugin').info('\u001b[31mplain text\u001b[0m')
    const history = JSON.stringify(ctx.logs.query()), terminal = output.join('\n'), disk = await readFile(join(path, 'runtime.jsonl'), 'utf8')
    for (const text of [history, terminal, disk]) for (const secret of ['secret-password', 'header-private-token', 'personal message', 'bare-private-token', 'bootstrap-secret', 'formatted-secret']) expect(text).not.toContain(secret)
    expect(getter).not.toHaveBeenCalled()
    expect(value.password).toBe('secret-password')
    expect(ctx.logger.buffer).toEqual([])
    expect(history).toContain('[REDACTED]')
    expect(output.at(-1)).toContain('plain text')
    expect(output.at(-1)).not.toContain('\u001b')
  })

  it('isolates concurrent asynchronous scopes and Runtime instances, restores nested context, and records plugin identity', async () => {
    const first = await root(), second = await root()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const one = withLogContext({ runId: 'run_one', traceId: 'trace_one' }, async () => {
      await barrier
      withLogContext({ attemptId: 'attempt_one' }, () => first.logger('integration').info('nested'))
      first.logger('integration').info('outer')
    })
    const two = withLogContext({ runId: 'run_two' }, async () => { first.logger('integration').info('two'); release(); await Promise.resolve() })
    await Promise.all([one, two])
    const plugin = (ctx: Context) => { ctx.logger('provider').warn('owned') }
    const fiber = await first.plugin(plugin)
    second.logger('integration').info('separate')
    const oneRecords = first.logs.query({ runId: 'run_one' }).records
    expect(oneRecords).toHaveLength(2)
    expect(oneRecords.find(item => item.message === 'nested')).toMatchObject({ runId: 'run_one', attemptId: 'attempt_one', traceId: 'trace_one' })
    expect(oneRecords.find(item => item.message === 'outer')).not.toHaveProperty('attemptId')
    expect(first.logs.query().records.find(item => item.message === 'owned')).toMatchObject({ fiberId: fiber.uid, pluginPath: 'plugin' })
    expect(second.logs.query().records).toHaveLength(1)
    expect(second.logs.query().records[0]).not.toHaveProperty('runId')
  })

  it('bounds floods, stable older-page cursors, rotation and restart history, including a torn last write', async () => {
    const path = await directory()
    const ctx = await root({ directory: path, capacity: 30, maxFileBytes: 65536, maxFiles: 2 })
    for (let i = 0; i < 140; i++) ctx.logger('flood').info('record-%d %s', i, 'x'.repeat(3500))
    const first = ctx.logs.query({ limit: 10 })
    expect(first.retained).toBe(30)
    expect(first.evicted).toBe(110)
    expect(ctx.logs.query({ before: { stream: first.stream, sequence: 1 } })).toMatchObject({ expired: true, records: [] })
    for (let i = 0; i < 3; i++) ctx.logger('flood').info('new-%d', i)
    const older = ctx.logs.query({ before: first.next!, limit: 10 })
    expect(older.records.some(item => first.records.some(previous => previous.id === item.id))).toBe(false)
    expect(new Set([...first.records, ...older.records].map(item => item.id)).size).toBe(20)
    const filenames = await readdir(path)
    expect(filenames).toHaveLength(2)
    for (const filename of filenames) expect(Buffer.byteLength(await readFile(join(path, filename)))).toBeLessThanOrEqual(65536)
    await ctx.fiber.dispose()
    await appendFile(join(path, 'runtime.jsonl'), '{"incomplete":')
    const restarted = await root({ directory: path, capacity: 30, maxFileBytes: 65536, maxFiles: 2 })
    expect(restarted.logs.query({ before: first.next! })).toMatchObject({ reset: true, malformed: 1, persistence: 'ready' })
    expect(restarted.logs.query().records.some(record => record.id === first.records[0]!.id)).toBe(true)
    restarted.logger('recovery').info('after restart')
    await restarted.fiber.dispose()
    const again = await root({ directory: path, capacity: 30, maxFileBytes: 65536, maxFiles: 2 })
    expect(again.logs.query({ namespace: 'recovery' }).records[0]?.message).toBe('after restart')
  })

  it('isolates disk, terminal and malformed object failures, and releases subscriptions and exporters', async () => {
    const path = await directory()
    await writeFile(join(path, 'not-a-directory'), 'occupied')
    const ctx = await root({ directory: join(path, 'not-a-directory'), console: true, writeConsole() { throw new Error('closed pipe') } })
    const logs = ctx.logs, before = ctx.logger.exporters.size
    expect(() => ctx.logger('runtime').warn('still running')).not.toThrow()
    expect(logs.query()).toMatchObject({ persistence: 'failed' })
    expect(logs.query().records).toHaveLength(1)
    const broken = new Proxy({}, { ownKeys() { throw new Error('bad proxy') } })
    expect(() => ctx.logger('runtime').info(broken)).not.toThrow()
    expect(logs.query().malformed).toBe(1)
    const listener = vi.fn(), unsubscribe = logs.subscribe(listener)
    ctx.logger('runtime').info('one')
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    unsubscribe()
    ctx.logger('runtime').info('two')
    await ctx.fiber.dispose()
    expect(ctx.logger.exporters.size).toBeLessThan(before)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rejects malformed logger metadata and recursive exporters without poisoning subsequent records', async () => {
    let recurse = false
    const ctx = await root({ console: true, writeConsole() { if (recurse) ctx.logger('recursive').info('nested export') } })
    const exporter = [...ctx.logger.exporters.values()].at(-1)!
    expect(() => exporter.export({ name: null, type: 'info', level: 2, ts: Date.now(), args: ['invalid'], sn: 0 } as any)).not.toThrow()
    recurse = true
    ctx.logger('runtime').info('outer export')
    recurse = false
    ctx.logger('runtime').info('after recursion')
    expect(ctx.logs.query()).toMatchObject({ malformed: 2 })
    expect(ctx.logs.query().records.map(record => record.message)).toEqual(['after recursion', 'outer export'])
  })
})
