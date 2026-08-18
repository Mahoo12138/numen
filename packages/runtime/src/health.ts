import type { Context } from 'cordis'

export interface HealthDocument {
  status: 'ok'
  name: 'numen'
  version: string
  uptimeSeconds: number
}

export interface ReadinessDocument {
  status: 'ready' | 'not_ready'
  checks: {
    database: {
      ready: boolean
      migrationVersion?: number
    }
    capabilities: {
      ready: boolean
      definitions: number
      providers: number
    }
    automations: {
      ready: boolean
      count: number
    }
    scheduler: {
      ready: boolean
      queuedRuns: number
      runnableExecutions: number
      waitingExecutions: number
      blockedExecutions: number
    }
    triggers: {
      ready: boolean
      desiredSubscriptions: number
      activeSubscriptions: number
      unavailableSubscriptions: number
    }
  }
}

export function healthPlugin(ctx: Context): void {
  ctx.server.get('/api/health', async (_request, response) => {
    response.json({
      status: 'ok',
      name: 'numen',
      version: '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
    } satisfies HealthDocument)
  })

}

healthPlugin.inject = ['server']

export function readinessPlugin(ctx: Context): void {
  ctx.server.get('/api/ready', async (_request, response) => {
    let databaseReady = false
    let migrationVersion: number | undefined
    try {
      const health = ctx.database?.health()
      databaseReady = health?.ready ?? false
      migrationVersion = health?.migrationVersion
    } catch {
      databaseReady = false
    }

    let statuses: ReturnType<Context['capabilities']['list']> = []
    try {
      statuses = ctx.capabilities?.list() ?? []
    } catch {
      statuses = []
    }
    const capabilitiesReady = !!ctx.capabilities
    const document: ReadinessDocument = {
      status: databaseReady && capabilitiesReady ? 'ready' : 'not_ready',
      checks: {
        database: {
          ready: databaseReady,
          ...(migrationVersion === undefined ? {} : { migrationVersion }),
        },
        capabilities: {
          ready: capabilitiesReady,
          definitions: statuses.length,
          providers: statuses.filter(status => status.providerAvailable).length,
        },
        automations: {
          ready: true,
          count: ctx.automations.count(),
        },
        scheduler: ctx.scheduler.health(),
        triggers: ctx.triggers.health(),
      },
    }
    response.status = document.status === 'ready' ? 200 : 503
    response.json(document)
  })
}

readinessPlugin.inject = ['server', 'database', 'capabilities', 'automations', 'scheduler', 'triggers']
