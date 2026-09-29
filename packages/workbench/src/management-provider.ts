import { HostConfigError, type HostConfigService, type HostConfigMutationRequest, type HostConfigMutationResult, type HostConfigPreview, type HostConfigSnapshot } from '@numenjs/config'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { workbenchPluginApplyRef, workbenchPluginPreviewRef, workbenchPluginsQueryRef } from './management-contracts.js'

declare module 'cordis' { interface Context { hostConfig: HostConfigService } }

const id = z.string().min(1).max(200).required()
const request = z.object({
  fingerprint: z.string().min(1).max(100).required(),
  operation: z.union([
    z.object({ kind: z.const('setEnabled').required(), id, enabled: z.boolean().required() }),
    z.object({ kind: z.const('setLabel').required(), id, label: z.string().max(160).required() }),
    z.object({ kind: z.const('setCollapsed').required(), id, collapsed: z.boolean().required() }),
    z.object({ kind: z.const('createGroup').required(), id, label: z.string().max(160), parentId: z.string().max(200) }),
    z.object({ kind: z.const('move').required(), id, parentId: z.string().max(200) }),
    z.object({ kind: z.const('removeGroup').required(), id }),
    z.object({ kind: z.const('setConfig').required(), id, config: z.dict(z.any()).required() }),
  ]).required(),
})
export const workbenchPluginsQuery: ConsoleQueryDefinition<Record<string, unknown>, HostConfigSnapshot> = {
  ...workbenchPluginsQueryRef, kind: 'query', title: 'Configured plugin instances', input: z.object({}), output: z.any<HostConfigSnapshot>().required(),
}
export const workbenchPluginPreview: ConsoleQueryDefinition<HostConfigMutationRequest, HostConfigPreview> = {
  ...workbenchPluginPreviewRef, kind: 'query', title: 'Preview plugin configuration change', input: request, output: z.any<HostConfigPreview>().required(),
}
export const workbenchPluginApply: ConsoleActionDefinition<HostConfigMutationRequest, HostConfigMutationResult> = {
  ...workbenchPluginApplyRef, kind: 'action', title: 'Save and apply plugin configuration', input: request, output: z.any<HostConfigMutationResult>().required(),
}
async function invoke<T>(call: () => Promise<T>): Promise<T> {
  try { return await call() }
  catch (error) {
    if (error instanceof HostConfigError) throw new ConsoleProcedureError(error.code.includes('CONFLICT') ? 409 : 400, error.code, error.message)
    throw new ConsoleProcedureError(500, 'HOST_CONFIG_UNAVAILABLE', 'The Host configuration operation could not be completed. Read the current state before retrying.')
  }
}
export function workbenchManagementProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchPluginsQueryRef, { query: () => invoke(() => ctx.hostConfig.read()) })
  ctx.console.provideQuery<HostConfigMutationRequest, HostConfigPreview>(ctx, workbenchPluginPreviewRef, { query: ({ input }) => invoke(() => ctx.hostConfig.preview(input)) })
  ctx.console.provideAction<HostConfigMutationRequest, HostConfigMutationResult>(ctx, workbenchPluginApplyRef, { action: ({ input }) => invoke(() => ctx.hostConfig.apply(input)) })
}
workbenchManagementProviderPlugin.inject = ['workbench', 'console', 'hostConfig']
