import type { ConsoleFrontendEntry } from '@numen/console'
import type { Context } from 'cordis'
import { workbenchServerPlugin, type WorkbenchServerConfig } from './server.js'

export const coreWorkbenchEntryId = 'numen:workbench-core'

export interface WorkbenchRuntimeConfig extends WorkbenchServerConfig {
  entrySource?: string
}

export function workbenchRuntimePlugin(ctx: Context, config: WorkbenchRuntimeConfig = {}): void {
  workbenchServerPlugin(ctx, config)
  const entry: ConsoleFrontendEntry = {
    id: coreWorkbenchEntryId,
    prod: config.entrySource ?? new URL('./app/core-entry.js', import.meta.url).href,
  }
  ctx.consoleEntries.addEntry(ctx, entry)
}

workbenchRuntimePlugin.inject = ['server', 'consoleEntries']

export default workbenchRuntimePlugin
