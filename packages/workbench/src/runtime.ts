import type { ConsoleFrontendEntry } from '@numen/console'
import { Service, type Context } from 'cordis'
import { workbenchHomeOverviewQuery } from './home-provider.js'
import { workbenchRunsIndexQuery } from './runs-provider.js'
import { workbenchServerPlugin, type WorkbenchServerConfig } from './server.js'

export { workbenchHomeOverviewQuery, workbenchHomeProviderPlugin } from './home-provider.js'
export { workbenchRunsIndexQuery, workbenchRunsProviderPlugin } from './runs-provider.js'

export const coreWorkbenchEntryId = 'numen:workbench-core'

export interface WorkbenchRuntimeConfig extends WorkbenchServerConfig {
  entrySource?: string
}

declare module 'cordis' {
  interface Context {
    workbench: WorkbenchRuntimeService
  }
}

export class WorkbenchRuntimeService extends Service {
  static inject = ['server', 'console', 'consoleEntries', 'consoleAuth']

  constructor(ctx: Context, config: WorkbenchRuntimeConfig = {}) {
    super(ctx, 'workbench')
    workbenchServerPlugin(ctx, config)
    ctx.console.define(ctx, workbenchHomeOverviewQuery)
    ctx.console.define(ctx, workbenchRunsIndexQuery)
    const entry: ConsoleFrontendEntry = {
      id: coreWorkbenchEntryId,
      prod: config.entrySource ?? new URL('./app/core-entry.js', import.meta.url).href,
    }
    ctx.consoleEntries.addEntry(ctx, entry)
  }

  getLaunchUrl(pathname = '/'): string {
    const base = new URL(this.ctx.server.baseUrl)
    const url = new URL(pathname, base)
    if (url.origin !== base.origin) throw new TypeError('Workbench launch path must be same-origin')
    url.search = ''
    url.hash = new URLSearchParams({
      'numen-bootstrap': this.ctx.consoleAuth.getBootstrapToken(),
    }).toString()
    return url.href
  }
}

export const workbenchRuntimePlugin = WorkbenchRuntimeService

export default workbenchRuntimePlugin
