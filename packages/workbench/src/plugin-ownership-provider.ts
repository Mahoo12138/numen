import type { HostRegistrationRef } from '@numenjs/config'
import { ConsoleProcedureError, ConsoleProcedureUnavailableError, type ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { workbenchPluginOwnershipRef, type WorkbenchOwnershipInput, type WorkbenchOwnershipResult } from './management-contracts.js'
import './management-provider.js'

const id = z.string().min(1).max(200).required()
export const workbenchPluginOwnershipQuery: ConsoleQueryDefinition<WorkbenchOwnershipInput, WorkbenchOwnershipResult> = {
  ...workbenchPluginOwnershipRef, kind: 'query', title: 'Observed plugin ownership',
  input: z.union([
    z.object({ kind: z.const('connection').required(), connectionId: id }),
    z.object({ kind: z.const('execution').required(), runId: id, executionId: id }),
    z.object({ kind: z.const('capability').required(), id, version: z.number().step(1).min(1).required() }),
  ]), output: z.any<WorkbenchOwnershipResult>().required(),
}

export function workbenchPluginOwnershipProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchPluginOwnershipRef, { async query({ input }: { input: WorkbenchOwnershipInput }): Promise<WorkbenchOwnershipResult> {
    const refs: HostRegistrationRef[] = []
    const missingConnectionIds: string[] = []
    const addConnection = (id: string, required = true) => {
      const service = ctx.get('connections')
      if (!service) throw new ConsoleProcedureUnavailableError('Connection diagnostics are unavailable.')
      const connection = service.get(id)
      if (!connection) {
        if (required) throw new ConsoleProcedureError(404, 'CONNECTION_NOT_FOUND', 'The Connection no longer exists.')
        missingConnectionIds.push(id)
        return
      }
      refs.push({ kind: 'connection-adapter', ...connection.adapter }, { kind: 'connection-type', ...connection.type })
    }
    if (input.kind === 'connection') addConnection(input.connectionId)
    else if (input.kind === 'capability') refs.push({ kind: 'capability', id: input.id, version: input.version })
    else {
      const scheduler = ctx.get('scheduler'), automations = ctx.get('automations')
      if (!scheduler || !automations) throw new ConsoleProcedureUnavailableError('Run diagnostics are unavailable.')
      const run = scheduler.getRunIdentity(input.runId)
      // Enforce run/execution ownership before reading the immutable compiled instruction.
      const execution = scheduler.inspectExecution(input.runId, input.executionId, 1)?.execution
      if (!run || !execution) throw new ConsoleProcedureError(404, 'EXECUTION_NOT_FOUND', 'The Execution does not belong to this Run.')
      const revision = automations.getRevision(run.revisionId)
      const instruction = revision?.compiledPlan.instructions[execution.instructionId]
      if (!instruction) throw new ConsoleProcedureError(404, 'INSTRUCTION_NOT_FOUND', 'The immutable instruction is unavailable.')
      if (instruction.op === 'invoke') {
        refs.push({ kind: 'capability', ...instruction.capability })
        for (const connectionId of new Set(Object.values(instruction.connections ?? {}))) addConnection(connectionId, false)
      }
    }
    const unique = [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()]
    if (unique.length + missingConnectionIds.length > 64) throw new ConsoleProcedureError(422, 'DIAGNOSTIC_LIMIT', 'This instruction has too many dependencies to inspect at once.')
    try { return { registrations: await ctx.hostConfig.diagnose(unique), missingConnectionIds } }
    catch { throw new ConsoleProcedureUnavailableError('Host ownership diagnostics are unavailable. Try again after checking the Host configuration.') }
  } })
}
workbenchPluginOwnershipProviderPlugin.inject = ['workbench', 'console', 'hostConfig']
