import { AutomationArchivedError, AutomationCompileError, AutomationNotFoundError, DraftConflictError, LocalTestError, OutputSampleError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition, type ConsoleRequestContext } from '@numenjs/console'
import { AutomationInputValidationError, isNumenValue, type LocalTestRequest, type OutputSample } from '@numenjs/core'
import { DraftTestResourceUnavailableError, ManualRunRequestConflictError } from '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema, automationSourceNodeIdSchema } from './automation-schemas.js'
import { createOutputSampleActionRef, deleteOutputSampleActionRef, importOutputSampleActionRef, localTestPreviewQueryRef, outputSamplesQueryRef, startLocalTestActionRef,
  type CreateOutputSampleInput, type DeleteOutputSampleInput, type ImportOutputSampleInput, type OutputSamplesInput, type OutputSamplesPage, type OutputSampleSummary,
  type WorkbenchLocalTestPreview, type StartLocalTestInput, type StartLocalTestResult } from './local-test-contracts.js'

const sampleId = z.string().pattern(/^sample_[a-f0-9]{32}$/).required()
const version = z.number().min(1).step(1).required()
const requestFields = { automationId: automationIdSchema, expectedDraftVersion: version, targetNodeId: automationSourceNodeIdSchema.required(),
  mode: z.union(['to-node', 'only-node']).required(), sampleIds: z.array(sampleId).max(1024).required(), input: z.any().required(), trigger: z.any() }
export const outputSamplesQuery: ConsoleQueryDefinition<OutputSamplesInput, OutputSamplesPage> = {
  ...outputSamplesQueryRef, kind: 'query', title: 'Reusable output sample metadata',
  input: z.object({ automationId: automationIdSchema, offset: z.number().min(0).max(Number.MAX_SAFE_INTEGER).step(1) }), output: z.any(),
}
export const createOutputSampleAction: ConsoleActionDefinition<CreateOutputSampleInput, OutputSampleSummary> = {
  ...createOutputSampleActionRef, kind: 'action', title: 'Save a manual output sample',
  input: z.object({ automationId: automationIdSchema, expectedDraftVersion: version, nodeId: automationSourceNodeIdSchema.required(), value: z.any() }), output: z.any(),
}
export const importOutputSampleAction: ConsoleActionDefinition<ImportOutputSampleInput, OutputSampleSummary> = {
  ...importOutputSampleActionRef, kind: 'action', title: 'Import a complete persisted execution output',
  input: z.object({ automationId: automationIdSchema, executionId: z.string().max(160).required() }), output: z.any(),
}
export const deleteOutputSampleAction: ConsoleActionDefinition<DeleteOutputSampleInput, { deleted: boolean }> = {
  ...deleteOutputSampleActionRef, kind: 'action', title: 'Delete a reusable output sample',
  input: z.object({ automationId: automationIdSchema, sampleId }), output: z.object({ deleted: z.boolean().required() }),
}
export const localTestPreviewQuery: ConsoleQueryDefinition<LocalTestRequest, WorkbenchLocalTestPreview> = {
  ...localTestPreviewQueryRef, kind: 'query', title: 'Preview real local-test calls and substitutions', input: z.object(requestFields), output: z.any(),
}
export const startLocalTestAction: ConsoleActionDefinition<StartLocalTestInput, StartLocalTestResult> = {
  ...startLocalTestActionRef, kind: 'action', title: 'Start the reviewed local test',
  input: z.object({ ...requestFields, previewHash: z.string().pattern(/^[a-f0-9]{64}$/).required(), requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required() }),
  output: z.object({ runId: z.string().required(), snapshotId: z.string().required() }),
}
const summary = ({ value: _value, contract: _contract, ...sample }: OutputSample): OutputSampleSummary => sample
function publicError(error: unknown): never {
  if (error instanceof ConsoleProcedureError) throw error
  if (error instanceof LocalTestError || error instanceof OutputSampleError) throw new ConsoleProcedureError(422, error.code, error.message)
  if (error instanceof DraftConflictError) throw new ConsoleProcedureError(409, 'DRAFT_VERSION_CONFLICT', 'The Draft changed. Save and preview again.')
  if (error instanceof AutomationArchivedError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore the Automation before testing.')
  if (error instanceof AutomationNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation is unavailable.')
  if (error instanceof ManualRunRequestConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REQUEST_CONFLICT', 'The request ID was already used with different content.')
  if (error instanceof DraftTestResourceUnavailableError) throw new ConsoleProcedureError(422, 'RUN_RESOURCE_UNAVAILABLE', 'A referenced resource is unavailable.')
  if (error instanceof AutomationCompileError || error instanceof AutomationInputValidationError || error instanceof TypeError) throw new ConsoleProcedureError(422, 'LOCAL_TEST_DATA_INVALID', 'The Draft, test input or sample does not satisfy its contract.')
  throw new ConsoleProcedureError(409, 'LOCAL_TEST_UNAVAILABLE', 'The local test data could not be processed.')
}
function authorize(request: ConsoleRequestContext): void {
  if (!request.principal.authenticated) throw new ConsoleProcedureError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
  request.signal.throwIfAborted()
}
export function localTestProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, outputSamplesQueryRef, { query({ input, request }: { input: OutputSamplesInput; request: ConsoleRequestContext }) {
    authorize(request)
    try {
      if (!ctx.automations.get(input.automationId)) throw new AutomationNotFoundError('Automation is unavailable')
      const offset = input.offset ?? 0, page = ctx.automations.listOutputSamples(input.automationId, undefined, { offset, limit: 51 })
      return { items: page.slice(0, 50), ...(page.length > 50 ? { nextOffset: offset + 50 } : {}) }
    } catch (error) { return publicError(error) }
  } })
  ctx.console.provideAction(ctx, createOutputSampleActionRef, { action({ input, request }: { input: CreateOutputSampleInput; request: ConsoleRequestContext }) {
    authorize(request)
    try { if (!isNumenValue(input.value)) throw new TypeError('Invalid sample'); return summary(ctx.automations.createOutputSample(input)) } catch (error) { return publicError(error) }
  } })
  ctx.console.provideAction(ctx, importOutputSampleActionRef, { action({ input, request }: { input: ImportOutputSampleInput; request: ConsoleRequestContext }) {
    authorize(request)
    try { return summary(ctx.automations.importOutputSample(input)) } catch (error) { return publicError(error) }
  } })
  ctx.console.provideAction(ctx, deleteOutputSampleActionRef, { action({ input, request }: { input: DeleteOutputSampleInput; request: ConsoleRequestContext }) {
    authorize(request)
    try { return { deleted: ctx.automations.deleteOutputSample(input.automationId, input.sampleId) } } catch (error) { return publicError(error) }
  } })
  ctx.console.provideQuery(ctx, localTestPreviewQueryRef, { query({ input, request }: { input: LocalTestRequest; request: ConsoleRequestContext }): WorkbenchLocalTestPreview {
    authorize(request)
    try {
      const { scope, ...preview } = ctx.automations.previewLocalTest(input)
      return { ...preview, nodeIds: scope.nodeIds }
    } catch (error) { return publicError(error) }
  } })
  ctx.console.provideAction(ctx, startLocalTestActionRef, { async action({ input, request }: { input: StartLocalTestInput; request: ConsoleRequestContext }): Promise<StartLocalTestResult> {
    authorize(request)
    try { const run = await ctx.scheduler.startLocalTest(input); return { runId: run.id, snapshotId: run.revisionId } } catch (error) { return publicError(error) }
  } })
}
localTestProviderPlugin.inject = ['workbench', 'console', 'automations', 'scheduler']
