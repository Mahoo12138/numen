import { workbenchConnectionUsageProviderPlugin } from './connection-usage-provider.js'
import { workbenchManagementProviderPlugin } from './management-provider.js'
import { workbenchSystemProviderPlugin } from './system-provider.js'
import { workbenchPluginOwnershipProviderPlugin } from './plugin-ownership-provider.js'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchAutomationActivationProviderPlugin,
  workbenchAutomationAuthoringProviderPlugin,
  workbenchAutomationCatalogProviderPlugin,
  workbenchAutomationsProviderPlugin,
  workbenchConnectionsProviderPlugin,
  workbenchCredentialsProviderPlugin,
  workbenchHomeProviderPlugin,
  workbenchInvalidationProviderPlugin,
  workbenchLogsProviderPlugin,
  workbenchRunsProviderPlugin,
  workbenchRuntimePlugin,
  type WorkbenchRuntimeConfig,
} from './runtime.js'

export type WorkbenchConfig = WorkbenchRuntimeConfig

/** Consumers declare their own dependencies so unavailable features wait independently. */
export function workbenchPlugin(ctx: Context, config: WorkbenchConfig = {}): void {
  ctx.plugin(workbenchRuntimePlugin, config)
  ctx.plugin(workbenchManagementProviderPlugin)
  ctx.plugin(workbenchPluginOwnershipProviderPlugin)
  ctx.plugin(workbenchSystemProviderPlugin)
  ctx.plugin(workbenchConnectionUsageProviderPlugin)
  ctx.plugin(workbenchAutomationAuthoringProviderPlugin)
  ctx.plugin(workbenchAutomationActivationProviderPlugin)
  ctx.plugin(workbenchAutomationCatalogProviderPlugin)
  ctx.plugin(workbenchAutomationsProviderPlugin)
  ctx.plugin(workbenchConnectionsProviderPlugin)
  ctx.plugin(workbenchCredentialsProviderPlugin)
  ctx.plugin(workbenchHomeProviderPlugin)
  ctx.plugin(workbenchLogsProviderPlugin)
  ctx.plugin(workbenchInvalidationProviderPlugin)
  ctx.plugin(workbenchRunsProviderPlugin)
}

workbenchPlugin.Config = z.object({
  root: z.string(),
  assetPath: z.string(),
  entrySource: z.string(),
})

/** Version 1 compatibility only: these retain their original leaf semantics. */
export const legacyWorkbenchBuiltins = {
  workbench: workbenchRuntimePlugin,
  workbenchAutomationAuthoring: workbenchAutomationAuthoringProviderPlugin,
  workbenchAutomationActivation: workbenchAutomationActivationProviderPlugin,
  workbenchAutomationCatalog: workbenchAutomationCatalogProviderPlugin,
  workbenchAutomations: workbenchAutomationsProviderPlugin,
  workbenchConnections: workbenchConnectionsProviderPlugin,
  workbenchCredentials: workbenchCredentialsProviderPlugin,
  workbenchHome: workbenchHomeProviderPlugin,
  workbenchLogs: workbenchLogsProviderPlugin,
  workbenchInvalidation: workbenchInvalidationProviderPlugin,
  workbenchRuns: workbenchRunsProviderPlugin,
} as const

export default workbenchPlugin
