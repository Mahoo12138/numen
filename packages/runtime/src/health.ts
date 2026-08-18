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
      },
    }
    response.status = document.status === 'ready' ? 200 : 503
    response.json(document)
  })
}

healthPlugin.inject = ['server', 'database', 'capabilities']
