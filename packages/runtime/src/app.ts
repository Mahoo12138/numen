import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'
import LoggerConsole from '@cordisjs/plugin-logger-console'
import Server from '@cordisjs/plugin-server'
import { AutomationService } from '@numen/automation'
import {
  ConsoleService,
  ConsoleEntryRegistry,
  SingleUserConsoleAuthService,
  consoleAssetPlugin,
  consoleHttpPlugin,
  consoleSessionPlugin,
  consoleWebSocketPlugin,
} from '@numen/console'
import { createRuntimeEntries, loadConfig, type LoadedConfig, type RuntimeEntry } from '@numen/config'
import { ConnectionService } from '@numen/connections'
import { CredentialService } from '@numen/credentials'
import { ResourceService } from '@numen/resources'
import { CapabilityRegistry } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { SchedulerService } from '@numen/scheduler'
import { TriggerService } from '@numen/triggers'
import {
  workbenchAutomationsProviderPlugin,
  workbenchConnectionsProviderPlugin,
  workbenchHomeProviderPlugin,
  workbenchInvalidationProviderPlugin,
  workbenchRunsProviderPlugin,
  workbenchRuntimePlugin,
} from '@numen/workbench/runtime'
import { Context } from 'cordis'
import { sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { healthPlugin, readinessPlugin } from './health.js'

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

const builtins = {
  database: DatabaseService,
  capabilities: CapabilityRegistry,
  credentials: CredentialService,
  resources: ResourceService,
  connections: ConnectionService,
  automations: AutomationService,
  scheduler: SchedulerService,
  triggers: TriggerService,
  console: ConsoleService,
  consoleEntries: ConsoleEntryRegistry,
  consoleAuth: SingleUserConsoleAuthService,
  server: Server,
  workbench: workbenchRuntimePlugin,
  workbenchAutomations: workbenchAutomationsProviderPlugin,
  workbenchConnections: workbenchConnectionsProviderPlugin,
  workbenchHome: workbenchHomeProviderPlugin,
  workbenchInvalidation: workbenchInvalidationProviderPlugin,
  workbenchRuns: workbenchRunsProviderPlugin,
  consoleSession: consoleSessionPlugin,
  consoleAssets: consoleAssetPlugin,
  consoleHttp: consoleHttpPlugin,
  consoleWs: consoleWebSocketPlugin,
  health: healthPlugin,
  readiness: readinessPlugin,
} as const

export const runtimeBuiltinNames: ReadonlySet<string> = new Set(Object.keys(builtins))

function toCordisEntry(entry: RuntimeEntry): EntryOptions {
  return {
    id: entry.id,
    name: entry.name,
    config: entry.config,
    disabled: entry.disabled,
  }
}

export async function startRuntime(options: StartRuntimeOptions = {}): Promise<NumenApplication> {
  const config = await loadConfig(options.configPath)
  const safeMode = options.safeMode ?? false
  const entries = createRuntimeEntries(config.config, runtimeBuiltinNames, safeMode)
  const context = new Context()
  context.baseUrl = pathToFileURL(config.baseDir + sep).href

  try {
    await context.plugin(LoggerConsole)
    await context.plugin(Loader, { baseUrl: context.baseUrl })
    Object.assign(context.loader.builtins, builtins)
    await context.loader.root.update(entries.map(toCordisEntry))
    await context.loader.await()
  } catch (error) {
    await context.fiber.dispose()
    throw error
  }

  let stopTask: Promise<void> | undefined
  return {
    context,
    config,
    entries,
    safeMode,
    serverUrl: context.server?.baseUrl,
    workbenchUrl: context.workbench?.getLaunchUrl(),
    stop() {
      return stopTask ??= Promise.resolve(context.fiber.dispose()).then(() => undefined)
    },
  }
}
