import { AutomationSnapshotInspectionLimitError, DraftConflictError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleQueryDefinition, type ConsoleRequestContext } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema } from './automation-schemas.js'
import { workbenchAutomationRestoreContentQueryRef, type WorkbenchAutomationRestoreContent, type WorkbenchAutomationRestoreContentQueryInput } from './contracts.js'

export const workbenchAutomationRestoreContentQuery: ConsoleQueryDefinition<WorkbenchAutomationRestoreContentQueryInput, WorkbenchAutomationRestoreContent> = {
  ...workbenchAutomationRestoreContentQueryRef, kind: 'query', title: 'Prepare immutable Automation content for Draft restoration',
  description: 'Explicit authoring preparation: exact snapshot content and saved Draft baseline, without writing, compiling, publishing or activating.',
  input: z.object({ automationId: automationIdSchema, snapshotId: z.string().pattern(/^(?:rev|snap)_[a-f0-9]{32}$/).required(), expectedDraftVersion: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required() }),
  output: z.any<WorkbenchAutomationRestoreContent>(),
}

const unavailable = (): never => { throw new ConsoleProcedureError(409, 'AUTOMATION_RESTORE_UNAVAILABLE', 'The snapshot content could not be prepared for Draft restoration.') }
const limit = (): never => { throw new ConsoleProcedureError(413, 'AUTOMATION_RESTORE_LIMIT', 'The snapshot content exceeds the Draft restoration limits.') }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
  return value as Record<string, unknown>
}

/** Validate authoring shape without projecting, normalizing or interpreting unknown extension fields. */
function validateRestorationContent(content: Pick<WorkbenchAutomationRestoreContent, 'source' | 'presentation'>): void {
  const validateJson = (value: unknown, maximumDepth: number): void => {
    let count = 0
    const active = new Set<object>()
    const visit = (item: unknown, depth: number): void => {
      if (++count > 100_000 || depth > maximumDepth) return limit()
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
      if (!item || typeof item !== 'object' || active.has(item)) return unavailable()
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return unavailable()
      active.add(item)
      for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child, depth + 1)
      active.delete(item)
    }
    visit(value, 0)
  }
  validateJson(content.source, 256)
  validateJson(content.presentation, 64)
  record(content.presentation)
  const ids = new Set<string>()
  const identity = (value: unknown): void => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) || value.startsWith('__') || ids.has(value)) return unavailable()
    if (value.length > 160) return limit()
    ids.add(value)
  }
  const reference = (value: unknown): void => {
    const ref = record(value)
    if (typeof ref.id !== 'string' || !ref.id || !Number.isSafeInteger(ref.version) || (ref.version as number) < 1) return unavailable()
  }
  const bindings = (node: Record<string, unknown>): void => {
    if (node.connection !== undefined && (typeof node.connection !== 'string' || !node.connection)) return unavailable()
    if (node.connections !== undefined) for (const connection of Object.values(record(node.connections))) if (typeof connection !== 'string' || !connection) return unavailable()
  }
  const expressionMap = (value: unknown, depth = 0, allowOpaque = false): void => {
    for (const child of Object.values(record(value))) expression(child, depth, allowOpaque)
  }
  const expression = (value: unknown, depth = 0, allowOpaque = false): void => {
    if (depth > 64) return limit()
    // Unknown extension semantics stay opaque, but recognized core expressions still reach visual editors.
    if (allowOpaque && (!value || typeof value !== 'object' || Array.isArray(value))) return
    const expr = record(value)
    if (allowOpaque && !['literal', 'ref', 'array', 'call', 'object', 'template'].includes(expr.type as string)) return
    switch (expr.type) {
      case 'literal': if (!Object.hasOwn(expr, 'value')) return unavailable(); break
      case 'ref': if (typeof expr.path !== 'string') return unavailable(); break
      case 'array': case 'call': {
        const children = expr.type === 'array' ? expr.items : expr.arguments
        if (!Array.isArray(children) || expr.type === 'call' && typeof expr.function !== 'string') return unavailable()
        children.forEach(child => expression(child, depth + 1, allowOpaque)); break
      }
      case 'object': expressionMap(expr.entries, depth + 1, allowOpaque); break
      case 'template':
        if (!Array.isArray(expr.parts)) return unavailable()
        for (const part of expr.parts) if (typeof part !== 'string' && typeof record(part).ref !== 'string') return unavailable()
        break
      default: return unavailable()
    }
  }
  const invocationPolicy = (value: unknown): void => {
    const policy = record(value)
    if (policy.timeoutMs !== undefined && typeof policy.timeoutMs !== 'number') return unavailable()
    if (policy.retry !== undefined) {
      const retry = record(policy.retry)
      if (typeof retry.maxAttempts !== 'number' || retry.backoffMs !== undefined && typeof retry.backoffMs !== 'number') return unavailable()
    }
  }
  let nodes = 0
  const walk = (value: unknown, depth = 0, blockOnly = false, graphMember = false): void => {
    if (++nodes > 250 || depth > 64) return limit()
    const node = record(value)
    identity(node.id)
    if (blockOnly && node.type !== 'block') return unavailable()
    switch (node.type) {
      case 'graph': {
        if (node.version !== 1 || !Array.isArray(node.nodes) || !Array.isArray(node.edges)) return unavailable()
        if (node.edges.length > 2_000) return limit()
        const members = new Set<string>()
        for (const value of node.nodes) {
          const member = record(value)
          if (!['capability', 'condition', 'merge'].includes(member.type as string)) return unavailable()
          walk(value, depth + 1, false, true)
          members.add(member.id as string)
        }
        const edgeIds = new Set<string>()
        for (const value of node.edges) {
          const edge = record(value), from = record(edge.from), to = record(edge.to)
          if (typeof edge.id !== 'string' || !edge.id || edge.id.length > 160 || edgeIds.has(edge.id)
            || typeof from.nodeId !== 'string' || typeof to.nodeId !== 'string'
            || typeof from.port !== 'string' || !from.port || typeof to.port !== 'string' || !to.port
            || from.nodeId !== node.id && !members.has(from.nodeId) || !members.has(to.nodeId)) return unavailable()
          edgeIds.add(edge.id)
        }
        if (node.output !== undefined) expression(node.output)
        break
      }
      case 'condition': if (!graphMember) return unavailable(); expression(node.condition); break
      case 'merge':
        if (!graphMember || !['all', 'selected'].includes(node.mode as string) || !Array.isArray(node.inputs)
          || node.inputs.some(input => typeof input !== 'string' || !input) || new Set(node.inputs).size !== node.inputs.length) return unavailable()
        break
      case 'block':
        if (!Array.isArray(node.steps)) return unavailable()
        node.steps.forEach(child => walk(child, depth + 1))
        if (node.output !== undefined) expressionMap(node.output)
        break
      case 'if': expression(node.condition); walk(node.then, depth + 1, true); if (node.else !== undefined) walk(node.else, depth + 1, true); break
      case 'parallel': case 'race':
        if (!Array.isArray(node.branches)) return unavailable()
        node.branches.forEach(child => walk(child, depth + 1, true)); break
      case 'foreach':
        expression(node.items); walk(node.body, depth + 1, true)
        if (node.concurrency !== undefined && typeof node.concurrency !== 'number') return unavailable()
        break
      case 'wait': if (node.until !== undefined) expression(node.until); if (node.durationMs !== undefined) expression(node.durationMs); break
      case 'capability':
        reference(node.capability); expressionMap(node.input); bindings(node)
        if (node.policy !== undefined) invocationPolicy(node.policy)
        break
      case 'extension': reference(node.control); expressionMap(node.input, 0, true); break
      default: return unavailable()
    }
  }
  const source = record(content.source)
  if (!Array.isArray(source.triggers)) return unavailable()
  if (source.triggers.length > 100) return limit()
  walk(source.flow)
  for (const value of source.triggers) {
    const trigger = record(value)
    identity(trigger.id); reference(trigger.capability); record(trigger.config); bindings(trigger)
  }
  if (source.inputs !== undefined) {
    const inputs = record(source.inputs)
    if (Object.keys(inputs).length > 100) return limit()
    for (const value of Object.values(inputs)) {
      const declaration = record(value)
      if (!['string', 'number', 'boolean', 'object', 'array'].includes(declaration.type as string)
        || declaration.required !== undefined && typeof declaration.required !== 'boolean'
        || declaration.title !== undefined && typeof declaration.title !== 'string'
        || declaration.description !== undefined && typeof declaration.description !== 'string') return unavailable()
    }
  }
  if (source.policy !== undefined) {
    const policy = record(source.policy)
    if (policy.maxActive !== undefined && typeof policy.maxActive !== 'number'
      || policy.overflow !== undefined && !['queue', 'drop', 'replace'].includes(policy.overflow as string)) return unavailable()
    if (policy.groupBy !== undefined) expression(policy.groupBy)
  }
}

export function workbenchAutomationRestorationProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationRestoreContentQueryRef, {
    query({ input, request }: { input: WorkbenchAutomationRestoreContentQueryInput; request: ConsoleRequestContext }): WorkbenchAutomationRestoreContent {
      if (!request.principal.authenticated) throw new ConsoleProcedureError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
      request.signal.throwIfAborted()
      try {
        // Deferred read transaction keeps the archive state, Draft baseline and snapshot membership consistent.
        return ctx.database.db.transaction(() => {
          const automation = ctx.automations.get(input.automationId)
          if (!automation) throw new ConsoleProcedureError(404, 'AUTOMATION_RESTORE_NOT_FOUND', 'The snapshot was not found in this Automation.')
          if (automation.archivedAt) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before editing its Draft.')
          const baseline = ctx.automations.getDraftIdentity(automation.id)
          if (!baseline) throw new ConsoleProcedureError(404, 'AUTOMATION_RESTORE_NOT_FOUND', 'The snapshot was not found in this Automation.')
          if (baseline.version !== input.expectedDraftVersion) throw new DraftConflictError(input.expectedDraftVersion, baseline.version)
          const snapshot = ctx.automations.getExecutionSnapshotContentForInspection(input.snapshotId, automation.id)
          if (!snapshot) throw new ConsoleProcedureError(404, 'AUTOMATION_RESTORE_NOT_FOUND', 'The snapshot was not found in this Automation.')
          validateRestorationContent(snapshot)
          const result: WorkbenchAutomationRestoreContent = {
            automationId: automation.id, expectedDraftVersion: baseline.version,
            identity: { id: snapshot.id, automationId: snapshot.automationId, purpose: snapshot.purpose, protocolVersion: snapshot.protocolVersion,
              irVersion: snapshot.irVersion, contentHash: snapshot.contentHash, createdAt: snapshot.createdAt,
              ...(snapshot.purpose === 'published' ? { number: snapshot.number } : {}),
              ...(snapshot.sourceDraftVersion === undefined ? {} : { sourceDraftVersion: snapshot.sourceDraftVersion }),
            },
            source: snapshot.source, presentation: snapshot.presentation,
          }
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8 * 1024 * 1024 + 8192) return limit()
          return result
        }).deferred()
      } catch (error) {
        if (error instanceof ConsoleProcedureError) throw error
        if (error instanceof DraftConflictError) throw new ConsoleProcedureError(409, 'DRAFT_VERSION_CONFLICT', 'The Automation Draft changed', { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion })
        if (error instanceof AutomationSnapshotInspectionLimitError) return limit()
        return unavailable()
      }
    },
  })
}

workbenchAutomationRestorationProviderPlugin.inject = ['workbench', 'console', 'automations', 'database']
export default workbenchAutomationRestorationProviderPlugin
