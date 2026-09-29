import { ConsoleProcedureError, type ConsoleQueryDefinition, type ConsoleRequestContext } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { workbenchExecutionDataQueryRef, type WorkbenchExecutionData, type WorkbenchExecutionDataInput } from './contracts.js'
import { inspectExecutionValue } from './execution-inspection.js'
import { sourceNodeIdForExecution } from './run-detail-projection.js'

export const workbenchExecutionDataQuery: ConsoleQueryDefinition<WorkbenchExecutionDataInput, WorkbenchExecutionData> = {
  ...workbenchExecutionDataQueryRef,
  kind: 'query',
  title: 'Inspect Execution data',
  description: 'Explicit, bounded inspection of fields classified by the immutable Revision contract.',
  input: z.object({ runId: z.string().min(1).max(200).required(), executionId: z.string().min(1).max(200).required(), attemptId: z.string().min(1).max(200) }),
  output: z.any<WorkbenchExecutionData>(),
}

export function provideExecutionData(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchExecutionDataQueryRef, {
    query({ input, request }: { input: WorkbenchExecutionDataInput; request: ConsoleRequestContext }): WorkbenchExecutionData {
      if (!request.principal.authenticated) throw new ConsoleProcedureError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
      request.signal.throwIfAborted()
      try {
        const run = ctx.scheduler.getRunIdentity(input.runId)
        const stored = run && ctx.scheduler.inspectExecution(run.id, input.executionId)
        if (!run || !stored) throw new ConsoleProcedureError(404, 'EXECUTION_NOT_FOUND', 'The Execution was not found in this Run.')
        const attempt = input.attemptId ? ctx.scheduler.getAttempt(run.id, input.executionId, input.attemptId) : undefined
        if (input.attemptId && !attempt) throw new ConsoleProcedureError(404, 'ATTEMPT_NOT_FOUND', 'The Attempt was not found in this Execution.')
        const revision = ctx.automations.getRevision(run.revisionId)
        const instruction = revision?.compiledPlan.instructions[stored.execution.instructionId]
        const contract = instruction?.op === 'invoke' ? revision?.contractSnapshot.capabilities.find(item =>
          item.id === instruction.capability.id && item.version === instruction.capability.version) : undefined
        const sourceNodeId = sourceNodeIdForExecution(revision, stored.execution.instructionId)
        const result: WorkbenchExecutionData = {
          runId: run.id,
          executionId: stored.execution.id,
          ...(sourceNodeId ? { sourceNodeId } : {}),
          provenance: 'execution-current',
          ...(attempt ? { attempt: { id: attempt.id, number: attempt.number } } : {}),
          input: inspectExecutionValue(stored.execution.resolvedInput, contract?.inputSchema, stored.inputOmitted),
          output: inspectExecutionValue(stored.execution.output, contract?.outputSchema, stored.outputOmitted),
        }
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 24_576) {
          throw new ConsoleProcedureError(413, 'EXECUTION_DATA_LIMIT', 'The inspection response exceeds its size limit.')
        }
        return result
      } catch (error) {
        if (error instanceof ConsoleProcedureError) throw error
        // JSON/parser errors can contain stored payload fragments. They must not reach generic transport logging.
        throw new ConsoleProcedureError(409, 'EXECUTION_DATA_UNAVAILABLE', 'Execution data could not be inspected.')
      }
    },
  })
}
