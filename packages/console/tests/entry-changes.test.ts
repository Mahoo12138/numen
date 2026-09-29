import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import consolePlugin, { consoleEntriesChanged, type ConsoleEntryInvalidation, type ConsoleRequestContext } from '../src/index.js'

function request(root: Context): ConsoleRequestContext {
  return { requestId: 'entry-invalidation', principal: { authenticated: true, subject: { type: 'user', id: 'owner' } }, signal: new AbortController().signal, logger: root.logger('test') }
}

describe('Console-owned Entry invalidation', () => {
  it('emits initial truth and changes without Workbench, maintains stable sources, and removes listeners on unsubscribe', async () => {
    const root = new Context()
    try {
      await root.plugin(consolePlugin)
      const notices: ConsoleEntryInvalidation[] = []
      const off = await root.console.subscribe(consoleEntriesChanged, {}, request(root), event => { notices.push(event as ConsoleEntryInvalidation) })
      expect(notices).toEqual([{ epoch: expect.any(String), revision: 0, entries: [] }])
      const removeFirst = root.consoleEntries.addEntry(root, { id: 'fixture:first', prod: '/fixture/first.js' })
      const firstSource = root.consoleEntries.resolveSource('fixture:first', 'prod')!
      const removeSecond = root.consoleEntries.addEntry(root, { id: 'fixture:second', prod: '/fixture/second.js' })
      await vi.waitFor(() => expect(notices.at(-1)?.entries).toHaveLength(2))
      expect(root.consoleEntries.resolveSource('fixture:first', 'prod')?.revision).toBe(firstSource.revision)
      removeFirst()
      root.consoleEntries.addEntry(root, { id: 'fixture:first', prod: '/fixture/first-new.js' })
      const nextSource = root.consoleEntries.resolveSource('fixture:first', 'prod')!
      expect(nextSource.incarnation).toBeGreaterThan(firstSource.incarnation)
      await vi.waitFor(() => expect(notices.at(-1)?.entries.find(entry => entry.id === 'fixture:first')?.incarnation).toBe(nextSource.incarnation))
      expect(notices.every(event => event.epoch === notices[0]!.epoch)).toBe(true)
      expect(JSON.stringify(notices)).not.toContain('/fixture/')
      await off()
      const count = notices.length
      removeSecond()
      await Promise.resolve()
      expect(notices).toHaveLength(count)
    } finally { await root.fiber.dispose() }
  })

  it('preserves incarnation only across continuous atomic replacement, and bounds slow subscriber emissions', async () => {
    const root = new Context()
    try {
      await root.plugin(consolePlugin)
      await root.consoleEntries.replaceGeneration(root, { scopeId: 'fixture', generation: 1, entries: [{ id: 'fixture:main', prod: '/one.js' }] })
      const initial = root.consoleEntries.resolveSource('fixture:main', 'prod')!
      const dispose = await root.consoleEntries.replaceGeneration(root, { scopeId: 'fixture', generation: 2, entries: [{ id: 'fixture:main', prod: '/two.js' }] })
      const replaced = root.consoleEntries.resolveSource('fixture:main', 'prod')!
      expect(replaced.incarnation).toBe(initial.incarnation)
      expect(replaced.revision).toBeGreaterThan(initial.revision)
      let release!: () => void
      let active = 0
      let maximum = 0
      const notices: ConsoleEntryInvalidation[] = []
      const off = await root.console.subscribe(consoleEntriesChanged, {}, request(root), async event => {
        active++
        maximum = Math.max(maximum, active)
        notices.push(event as ConsoleEntryInvalidation)
        if (notices.length === 1) await new Promise<void>(resolve => { release = resolve })
        active--
      })
      await dispose()
      await root.consoleEntries.replaceGeneration(root, { scopeId: 'fixture', generation: 3, entries: [{ id: 'fixture:main', prod: '/three.js' }] })
      for (let index = 0; index < 20; index++) root.consoleEntries.addEntry(root, { id: `fixture:extra-${index}`, prod: '/extra.js' })
      expect(notices).toHaveLength(1)
      release()
      await vi.waitFor(() => expect(notices).toHaveLength(2))
      expect(maximum).toBe(1)
      expect(notices[1]!.entries.find(entry => entry.id === 'fixture:main')!.incarnation).toBeGreaterThan(initial.incarnation)
      expect(notices[1]!.entries).toHaveLength(21)
      await off()
    } finally { await root.fiber.dispose() }
  })
})
