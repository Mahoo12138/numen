import Loader, { Group } from '@cordisjs/plugin-loader'
import { LoggingService } from '@numenjs/logging'
import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numenjs/automation'
import consolePlugin, { legacyConsoleBuiltins } from '@numenjs/console'
import { createRuntimeEntries, loadConfig, readManagedConfig, type LoadedConfig, type RuntimeEntry } from '@numenjs/config'
import { ConnectionService } from '@numenjs/connections'
import { CredentialService } from '@numenjs/credentials'
import { ResourceService } from '@numenjs/resources'
import { CapabilityRegistry, ControlRegistry, coreControlsPlugin } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { httpSocksPlugin, OutboundHttpService } from '@numenjs/http'
import demoIntegrationPlugin from '@numenjs/integration-demo'
import httpIntegrationPlugin from '@numenjs/integration-http'
import scheduleIntegrationPlugin from '@numenjs/integration-schedule'
import { SchedulerService } from '@numenjs/scheduler'
import { TriggerService } from '@numenjs/triggers'
import workbenchPlugin, { legacyWorkbenchBuiltins } from '@numenjs/workbench/plugin'
import { Context } from 'cordis'
import { I18nService } from '@numenjs/i18n'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { healthPlugin, readinessPlugin } from './health.js'
import { HostConfigurationService, toCordisEntry } from './config-management.js'

export interface StartRuntimeOptions {
  configPath?: string
  safeMode?: boolean
}

export interface NumenApplication {
  context: Context
  config: LoadedConfig
  entries: RuntimeEntry[]
  safeMode: boolean
  serverUrl: string | undefined
  workbenchUrl: string | undefined
  stop(): Promise<void>
}

const hostBuiltins = {
  i18n: I18nService,
  database: DatabaseService,
  capabilities: CapabilityRegistry,
  controls: ControlRegistry,
  coreControls: coreControlsPlugin,
  credentials: CredentialService,
  resources: ResourceService,
  connections: ConnectionService,
  http: OutboundHttpService,
  httpSocks: httpSocksPlugin,
  demo: demoIntegrationPlugin,
  httpIntegration: httpIntegrationPlugin,
  schedule: scheduleIntegrationPlugin,
  automations: AutomationService,
  scheduler: SchedulerService,
  triggers: TriggerService,
  server: Server,
  health: healthPlugin,
  readiness: readinessPlugin,
} as const

const productBuiltins = { ...hostBuiltins, console: consolePlugin, workbench: workbenchPlugin, group: Group }
const legacyBuiltins = { ...hostBuiltins, ...legacyConsoleBuiltins, ...legacyWorkbenchBuiltins }

// Keep the historical public builtin names for v1 resolution. v2 groups are
// reserved syntax handled by Config, not an additional v1 builtin.
export const runtimeBuiltinNames: ReadonlySet<string> = new Set([
  ...Object.keys(legacyBuiltins),
])

export async function startRuntime(options: StartRuntimeOptions = {}): Promise<NumenApplication> {
  const config = await loadConfig(options.configPath)
  const safeMode = options.safeMode ?? false
  let entries = createRuntimeEntries(config.config, runtimeBuiltinNames, safeMode)
  const context = new Context()
  context.baseUrl = pathToFileURL(config.baseDir + sep).href

  try {
    const secrets: string[] = []
    const seen = new Set<object>()
    const collect = (value: unknown, sensitive = false, depth = 0): void => {
      if (depth > 16 || secrets.length >= 256) return
      if (typeof value === 'string') { if (sensitive && value.length >= 4) secrets.push(value); return }
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      for (const [key, child] of Object.entries(value)) collect(child, sensitive || /secret|token|password|credential|api.?key|authorization|cookie/i.test(key), depth + 1)
      seen.delete(value)
    }
    collect(config.config.plugins)
    collect(Object.fromEntries(Object.entries(process.env).filter(([key]) => /NUMEN_.*(?:KEY|TOKEN|SECRET)/i.test(key))), true)
    await context.plugin(LoggingService, {
      ...config.config.logger,
      directory: resolve(config.baseDir, config.config.dataDir, 'logs'),
      environment: process.env,
      secrets,
      pluginPath(fiber) {
        const path: string[] = []
        let current = fiber
        while (current.runtime) {
          path.unshift(current.entry?.id ?? current.name)
          current = current.parent.fiber
        }
        return path.join('/') || 'root'
      },
    })
    context.logger('runtime').info('Runtime starting%s', safeMode ? ' in safe mode' : '')
    await context.plugin(Loader, { baseUrl: context.baseUrl })
    Object.assign(context.loader.builtins, config.config.version === 1 ? legacyBuiltins : productBuiltins)
    const managementDocument = await readManagedConfig(config.filename, runtimeBuiltinNames, safeMode)
    if (JSON.stringify(managementDocument.config) !== JSON.stringify(config.config)) throw new Error('Configuration changed during startup; restart with the current file.')
    await context.plugin(HostConfigurationService, { filename: config.filename, builtins: runtimeBuiltinNames, safeMode, fingerprint: managementDocument.fingerprint, onSaved(document) { config.config = document.config; entries = document.entries } })
    await context.loader.root.update(entries.map(toCordisEntry))
    await context.loader.await()
    context.logger('runtime').info('Runtime ready')
  } catch (error) {
    context.logger('runtime').error('Runtime startup failed: %s', error)
    await context.fiber.dispose()
    throw error
  }

  let stopTask: Promise<void> | undefined
  return {
    context,
    config,
    get entries() { return entries },
    safeMode,
    serverUrl: context.server?.baseUrl,
    workbenchUrl: context.workbench?.getLaunchUrl(),
    stop() {
      if (!stopTask) {
        context.logger('runtime').info('Runtime stopping')
        stopTask = context.fiber.dispose().then(() => undefined)
      }
      return stopTask
    },
  }
}
