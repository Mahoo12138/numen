import Server from '@cordisjs/plugin-server'
import consolePlugin from '@numenjs/console'
import { LoggingService, logsQueryRef } from '@numenjs/logging'
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import workbenchPlugin, { legacyWorkbenchBuiltins } from '../src/plugin.js'
import { coreWorkbenchEntryId } from '../src/runtime.js'
import { workbenchAutomationsIndexQueryRef } from '../src/contracts.js'

describe('Workbench product plugin', () => {
  it('waits for Console without installing it and restores a missing feature dependency locally', async () => {
    const root = new Context()
    try {
      await root.plugin(Server, { host: '127.0.0.1', port: 0 })
      const workbench = await root.plugin(workbenchPlugin, { entrySource: '/fixture/core-entry.js' })
      expect(root.console).toBeUndefined()
      expect(root.workbench).toBeUndefined()
      for (const child of Object.values(legacyWorkbenchBuiltins)) {
        const fibers = root.registry.get(child)?.fibers
        expect(fibers).toHaveLength(1)
        expect([...fibers!][0]!.parent.fiber).toBe(workbench)
      }
      const console = await root.plugin(consolePlugin, { auth: { token: 'workbench-plugin-token' } })
      await vi.waitFor(() => expect(root.workbench).toBeDefined())
      expect(root.consoleEntries.list()).toEqual([{ id: coreWorkbenchEntryId, prod: '/fixture/core-entry.js' }])
      expect(root.console.get(logsQueryRef)).toMatchObject({ providerAvailable: false })
      expect(root.console.get(workbenchAutomationsIndexQueryRef)).toMatchObject({ providerAvailable: false })
      const entryRevision = root.consoleEntries.getRevision()

      const logging = await root.plugin(LoggingService, { console: false })
      await vi.waitFor(() => expect(root.console.get(logsQueryRef)).toMatchObject({ providerAvailable: true }))
      expect(root.consoleEntries.getRevision()).toBe(entryRevision)
      expect(root.console.get(workbenchAutomationsIndexQueryRef)).toMatchObject({ providerAvailable: false })
      await logging.dispose()
      await vi.waitFor(() => expect(root.console.get(logsQueryRef)).toMatchObject({ providerAvailable: false }))
      expect(root.consoleEntries.getRevision()).toBe(entryRevision)
      await root.plugin(LoggingService, { console: false })
      await vi.waitFor(() => expect(root.console.get(logsQueryRef)).toMatchObject({ providerAvailable: true }))
      expect(root.consoleEntries.list()).toHaveLength(1)

      const consoleChildren = [...root.registry.values()].flatMap(runtime => [...runtime.fibers])
        .filter(fiber => fiber.parent.fiber === console)
      await workbench.dispose()
      expect(root.workbench).toBeUndefined()
      for (const child of consoleChildren) expect([...root.registry.get(child.runtime!.callback)!.fibers]).toContain(child)
      expect(root.consoleEntries.list()).toEqual([])
      expect(root.console.get(logsQueryRef)).toBeUndefined()
      expect(root.console.get(workbenchAutomationsIndexQueryRef)).toBeUndefined()
      for (const child of Object.values(legacyWorkbenchBuiltins)) expect(root.registry.has(child)).toBe(false)
      const response = await fetch(`${root.server.baseUrl}/api/console/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer workbench-plugin-token' },
      })
      expect(response.status).toBe(200)
      await console.dispose()
    } finally {
      await root.fiber.dispose()
    }
  })
})
