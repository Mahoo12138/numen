import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import demoIntegrationPlugin, { echoCapability } from '../src/index.js'

describe('Demo Integration', () => {
  it('executes Echo through publish, manual Run, Scheduler, and persisted output inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-demo-'))
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
      await root.plugin(CapabilityRegistry)
      demoIntegrationPlugin(root)
      await root.plugin(AutomationService)
      await root.plugin(ResourceService, { path: join(directory, 'resources') })
      await root.plugin(SchedulerService, { autoDispatch: false })

      const { automation } = root.automations.create({ name: 'Echo demo', source: {
        triggers: [],
        flow: {
          type: 'capability',
          id: 'echo',
          capability: echoCapability,
          input: { message: { type: 'literal', value: 'Numen is alive.' } },
        },
      } })
      const revision = root.automations.publishDraft(automation.id, 1)
      root.automations.activateRevision(automation.id, revision.id)
      const run = root.scheduler.startManual(automation.id)
      await root.scheduler.dispatchUntilIdle()

      expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
      expect(root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'echo')?.output)
        .toEqual({ message: 'Numen is alive.' })
    } finally {
      await root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
