import type { Context } from 'cordis'
import z from 'schemastery'
import { consoleAssetPlugin, type ConsoleAssetConfig } from './assets.js'
import { SingleUserConsoleAuthService, type SingleUserConsoleAuthConfig } from './auth.js'
import { ConsoleEntryRegistry } from './entries.js'
import { consoleEntryChangesPlugin } from './entry-changes.js'
import { consoleHttpPlugin, type ConsoleHttpConfig } from './http.js'
import { ConsoleService } from './service.js'
import { consoleSessionPlugin, type ConsoleSessionConfig } from './session.js'
import { consoleWebSocketPlugin, type ConsoleWebSocketConfig } from './websocket.js'

export interface ConsoleConfig {
  auth?: SingleUserConsoleAuthConfig
  session?: ConsoleSessionConfig
  assets?: ConsoleAssetConfig
  http?: ConsoleHttpConfig
  websocket?: ConsoleWebSocketConfig
}

/** Owns Console infrastructure; domain services and Workbench remain independent. */
export function consolePlugin(ctx: Context, config: ConsoleConfig = {}): void {
  ctx.plugin(ConsoleService)
  ctx.plugin(ConsoleEntryRegistry)
  ctx.plugin(consoleEntryChangesPlugin)
  ctx.plugin(SingleUserConsoleAuthService, config.auth ?? {})
  ctx.plugin(consoleSessionPlugin, config.session ?? {})
  ctx.plugin(consoleAssetPlugin, config.assets ?? {})
  ctx.plugin(consoleHttpPlugin, config.http ?? {})
  ctx.plugin(consoleWebSocketPlugin, config.websocket ?? {})
}

consolePlugin.Config = z.object({
  auth: SingleUserConsoleAuthService.Config,
  session: z.object({
    path: z.string(),
    secureCookie: z.boolean(),
  }),
  assets: z.object({
    mode: z.union(['dev', 'prod']),
    manifestPath: z.string(),
    assetPath: z.string(),
  }),
  http: z.object({ path: z.string() }),
  websocket: z.object({
    path: z.string(),
    maxMessageBytes: z.number().min(1).step(1),
    maxBufferedBytes: z.number().min(1).step(1),
  }),
})

/** Version 1 compatibility only: these retain their original leaf semantics. */
export const legacyConsoleBuiltins = {
  console: ConsoleService,
  consoleEntries: ConsoleEntryRegistry,
  consoleAuth: SingleUserConsoleAuthService,
  consoleSession: consoleSessionPlugin,
  consoleAssets: consoleAssetPlugin,
  consoleHttp: consoleHttpPlugin,
  consoleWs: consoleWebSocketPlugin,
} as const

export default consolePlugin
