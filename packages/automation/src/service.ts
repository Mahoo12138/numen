import {
  type Automation,
  type AutomationDraft,
  type AutomationRevision,
  type AutomationSource,
  type NumenValue,
  type ControlResolver,
} from '@numenjs/core'
import '@numenjs/database'
import { Service, type Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import { compileAutomation, type ConnectionResolver } from './compiler.js'

export class AutomationNotFoundError extends Error {
  override name = 'AutomationNotFoundError'
}

export class AutomationRevisionNotFoundError extends AutomationNotFoundError {
  override name = 'AutomationRevisionNotFoundError'
}

export class AutomationActivationConflictError extends Error {
  override name = 'AutomationActivationConflictError'

  constructor(public readonly expectedGeneration: number, public readonly actualGeneration: number) {
    super(`automation activation conflict: expected ${expectedGeneration}, actual ${actualGeneration}`)
  }
}

export class DraftConflictError extends Error {
  override name = 'DraftConflictError'

  constructor(public readonly expectedVersion: number, public readonly actualVersion: number) {
    super(`draft version conflict: expected ${expectedVersion}, actual ${actualVersion}`)
  }
}

export class DraftCopyRequestConflictError extends Error {
  override name = 'DraftCopyRequestConflictError'
}

export class AutomationArchivedError extends Error {
  override name = 'AutomationArchivedError'
}

export class AutomationPurgeConflictError extends Error {
  override name = 'AutomationPurgeConflictError'
}

export class AutomationHasActiveRunsError extends Error {
  override name = 'AutomationHasActiveRunsError'
  constructor(public readonly count: number) { super(`automation has ${count} active Run(s)`) }
}

export interface SaveDraftCopyInput {
  automationId: string
  requestId: string
  name: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
}

export interface CreateAutomationInput {
  name: string
  source?: AutomationSource
  presentation?: Record<string, NumenValue>
}

export interface SaveDraftInput {
  automationId: string
  expectedVersion: number
  source: AutomationSource
  presentation?: Record<string, NumenValue>
}

export interface AutomationSummary extends Automation {
  draftVersion: number
  revisionCount: number
  activeRunCount: number
  runCount: number
  latestRevisionNumber?: number
}

interface AutomationRow {
  id: string
  name: string
  enabled: number
  active_revision_id: string | null
  activation_generation: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface AutomationSummaryRow extends AutomationRow {
  draft_version: number
  revision_count: number
  latest_revision_number: number | null
  active_run_count: number
  run_count: number
}

interface DraftRow {
  automation_id: string
  base_revision_id: string | null
  source_json: string
  presentation_json: string
  version: number
  updated_at: string
}

interface RevisionRow {
  id: string
  automation_id: string
  number: number
  protocol_version: number
  source_json: string
  presentation_json: string
  ir_version: number
  compiled_plan_json: string
  dependency_manifest_json: string
  contract_snapshot_json: string
  content_hash: string
  created_at: string
}

declare module 'cordis' {
  interface Context {
    automations: AutomationService
  }

  interface Events {
    'numen/automation-change'(automationId: string): void
    'numen/automation-purge'(automationId: string): void
  }
}

function defaultSource(): AutomationSource {
  return {
    triggers: [],
    flow: { type: 'block', id: 'flow', steps: [] },
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    ...(row.active_revision_id ? { activeRevisionId: row.active_revision_id } : {}),
    activationGeneration: row.activation_generation,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDraft(row: DraftRow): AutomationDraft {
  return {
    automationId: row.automation_id,
    ...(row.base_revision_id ? { baseRevisionId: row.base_revision_id } : {}),
    source: parseJson(row.source_json),
    presentation: parseJson(row.presentation_json),
    version: row.version,
    updatedAt: row.updated_at,
  }
}

function mapRevision(row: RevisionRow): AutomationRevision {
  return {
    id: row.id,
    automationId: row.automation_id,
    number: row.number,
    protocolVersion: row.protocol_version,
    source: parseJson(row.source_json),
    presentation: parseJson(row.presentation_json),
    irVersion: row.ir_version,
    compiledPlan: parseJson(row.compiled_plan_json),
    dependencyManifest: parseJson(row.dependency_manifest_json),
    contractSnapshot: parseJson(row.contract_snapshot_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

export class AutomationService extends Service {
  static inject = ['database', 'capabilities']

  constructor(ctx: Context) {
    super(ctx, 'automations')
  }

  create(input: CreateAutomationInput): { automation: Automation; draft: AutomationDraft } {
    const name = input.name.trim()
    if (!name) throw new TypeError('automation name is required')
    const id = `auto_${randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()
    const source = input.source ?? defaultSource()
    const presentation = input.presentation ?? {}

    this.ctx.database.transaction(() => this.insertAutomation(id, name, source, presentation, now))
    this.ctx.emit('numen/automation-change', id)
    return { automation: this.get(id)!, draft: this.getDraft(id)! }
  }

  private insertAutomation(id: string, name: string, source: AutomationSource, presentation: Record<string, NumenValue>, now: string): void {
    this.ctx.database.db.prepare(`
      INSERT INTO automations (
        id, name, enabled, activation_generation, created_at, updated_at
      ) VALUES (?, ?, 0, 0, ?, ?)
    `).run(id, name, now, now)
    this.ctx.database.db.prepare(`
      INSERT INTO automation_drafts (
        automation_id, source_json, presentation_json, version, updated_at
      ) VALUES (?, ?, ?, 1, ?)
    `).run(id, JSON.stringify(source), JSON.stringify(presentation), now)
  }

  /** Preserve a local Draft as a disabled Automation; retries return the same durable copy. */
  saveDraftCopy(input: SaveDraftCopyInput): { automation: Automation; draft: AutomationDraft } {
    const name = input.name.trim()
    if (!name || name.length > 200) throw new TypeError('copy name must contain 1 to 200 characters')
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) throw new TypeError('invalid copy request id')
    const contentHash = createHash('sha256').update(canonicalize({ ...input, name })).digest('hex')
    let created = false
    const id = this.ctx.database.transaction(() => {
      const previous = this.ctx.database.db.prepare(
        'SELECT content_hash, automation_id FROM automation_draft_copy_requests WHERE request_id = ?',
      ).get(input.requestId) as { content_hash: string; automation_id: string } | undefined
      if (previous) {
        if (previous.content_hash !== contentHash) throw new DraftCopyRequestConflictError('copy request already used with different content')
        return previous.automation_id
      }
      const original = this.get(input.automationId)
      if (!original) throw new AutomationNotFoundError(`automation not found: ${input.automationId}`)
      this.requireNotArchived(original)
      const copyId = `auto_${randomUUID().replaceAll('-', '')}`
      this.insertAutomation(copyId, name, input.source, input.presentation, new Date().toISOString())
      this.ctx.database.db.prepare(
        'INSERT INTO automation_draft_copy_requests (request_id, content_hash, automation_id) VALUES (?, ?, ?)',
      ).run(input.requestId, contentHash, copyId)
      created = true
      return copyId
    })
    if (created) this.ctx.emit('numen/automation-change', id)
    return { automation: this.get(id)!, draft: this.getDraft(id)! }
  }

  get(id: string): Automation | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined
    return row ? mapAutomation(row) : undefined
  }

  list(includeArchived = false): Automation[] {
    return (this.ctx.database.db.prepare(`SELECT * FROM automations ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at DESC`).all() as AutomationRow[])
      .map(mapAutomation)
  }

  listSummaries(includeArchived = false): AutomationSummary[] {
    const rows = this.ctx.database.db.prepare(`
      SELECT automations.*, automation_drafts.version AS draft_version,
        COUNT(automation_revisions.id) AS revision_count,
        MAX(automation_revisions.number) AS latest_revision_number,
        (SELECT COUNT(*) FROM runs WHERE runs.automation_id = automations.id
          AND runs.status IN ('QUEUED', 'RUNNING', 'CANCELLING')) AS active_run_count,
        (SELECT COUNT(*) FROM runs WHERE runs.automation_id = automations.id) AS run_count
      FROM automations
      JOIN automation_drafts ON automation_drafts.automation_id = automations.id
      LEFT JOIN automation_revisions ON automation_revisions.automation_id = automations.id
      WHERE automations.archived_at IS ${includeArchived ? 'NOT ' : ''}NULL
      GROUP BY automations.id
      ORDER BY automations.updated_at DESC, automations.id DESC
    `).all() as AutomationSummaryRow[]
    return rows.map(row => ({
      ...mapAutomation(row),
      draftVersion: row.draft_version,
      revisionCount: row.revision_count,
      ...(row.latest_revision_number === null ? {} : { latestRevisionNumber: row.latest_revision_number }),
      activeRunCount: row.active_run_count,
      runCount: row.run_count,
    }))
  }

  getDraft(automationId: string): AutomationDraft | undefined {
    const row = this.ctx.database.db
      .prepare('SELECT * FROM automation_drafts WHERE automation_id = ?')
      .get(automationId) as DraftRow | undefined
    return row ? mapDraft(row) : undefined
  }

  saveDraft(input: SaveDraftInput): AutomationDraft {
    const now = new Date().toISOString()
    const draft = this.ctx.database.transaction(() => {
      const automation = this.get(input.automationId)
      if (!automation) throw new AutomationNotFoundError(`automation not found: ${input.automationId}`)
      this.requireNotArchived(automation)
      const result = this.ctx.database.db.prepare(`
        UPDATE automation_drafts
        SET source_json = ?, presentation_json = ?, version = version + 1, updated_at = ?
        WHERE automation_id = ? AND version = ?
      `).run(
        JSON.stringify(input.source),
        JSON.stringify(input.presentation ?? {}),
        now,
        input.automationId,
        input.expectedVersion,
      )
      if (result.changes === 0) {
        const current = this.getDraft(input.automationId)
        if (!current) throw new AutomationNotFoundError(`automation not found: ${input.automationId}`)
        throw new DraftConflictError(input.expectedVersion, current.version)
      }
      this.ctx.database.db.prepare('UPDATE automations SET updated_at = ? WHERE id = ?').run(now, input.automationId)
      return this.getDraft(input.automationId)!
    })
    this.ctx.emit('numen/automation-change', input.automationId)
    return draft
  }

  count(): number {
    return (this.ctx.database.db.prepare('SELECT COUNT(*) AS count FROM automations WHERE archived_at IS NULL').get() as { count: number }).count
  }

  publishDraft(automationId: string, expectedDraftVersion?: number): AutomationRevision {
    const draft = this.getDraft(automationId)
    if (!draft) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    if (expectedDraftVersion !== undefined && draft.version !== expectedDraftVersion) {
      throw new DraftConflictError(expectedDraftVersion, draft.version)
    }

    const compiled = compileAutomation(
      draft.source,
      this.ctx.capabilities,
      this.ctx.get('connections') as ConnectionResolver | undefined,
      this.ctx.get('controls') as ControlResolver | undefined,
    )
    const protocolVersion = 1
    const semanticSnapshot = {
      protocolVersion,
      source: draft.source,
      irVersion: compiled.plan.irVersion,
      compiledPlan: compiled.plan,
      dependencyManifest: compiled.dependencyManifest,
      contractSnapshot: compiled.contractSnapshot,
    }
    const contentHash = createHash('sha256').update(canonicalize(semanticSnapshot)).digest('hex')
    const revisionId = `rev_${randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()

    const revision = this.ctx.database.transaction(() => {
      const automation = this.get(automationId)
      if (!automation) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
      this.requireNotArchived(automation)
      const current = this.getDraft(automationId)
      if (!current) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
      if (current.version !== draft.version) throw new DraftConflictError(draft.version, current.version)
      const { number } = this.ctx.database.db.prepare(`
        SELECT COALESCE(MAX(number), 0) + 1 AS number
        FROM automation_revisions WHERE automation_id = ?
      `).get(automationId) as { number: number }
      this.ctx.database.db.prepare(`
        INSERT INTO automation_revisions (
          id, automation_id, number, protocol_version, source_json, presentation_json,
          ir_version, compiled_plan_json, dependency_manifest_json,
          contract_snapshot_json, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        automationId,
        number,
        protocolVersion,
        JSON.stringify(draft.source),
        JSON.stringify(draft.presentation),
        compiled.plan.irVersion,
        JSON.stringify(compiled.plan),
        JSON.stringify(compiled.dependencyManifest),
        JSON.stringify(compiled.contractSnapshot),
        contentHash,
        now,
      )
      this.ctx.database.db.prepare(`
        UPDATE automation_drafts SET base_revision_id = ? WHERE automation_id = ?
      `).run(revisionId, automationId)
      return this.getRevision(revisionId)!
    })
    this.ctx.emit('numen/automation-change', automationId)
    return revision
  }

  getRevision(revisionId: string): AutomationRevision | undefined {
    const row = this.ctx.database.db
      .prepare('SELECT * FROM automation_revisions WHERE id = ?')
      .get(revisionId) as RevisionRow | undefined
    return row ? mapRevision(row) : undefined
  }

  listRevisions(automationId: string): AutomationRevision[] {
    return (this.ctx.database.db.prepare(`
      SELECT * FROM automation_revisions WHERE automation_id = ? ORDER BY number DESC
    `).all(automationId) as RevisionRow[]).map(mapRevision)
  }

  activateRevision(automationId: string, revisionId: string, expectedActivationGeneration?: number): Automation {
    const result = this.ctx.database.transaction(() => {
      const current = this.requireActivationGeneration(automationId, expectedActivationGeneration)
      this.requireNotArchived(current)
      const revision = this.ctx.database.db.prepare(`
        SELECT 1 FROM automation_revisions WHERE id = ? AND automation_id = ?
      `).get(revisionId, automationId)
      if (!revision) throw new AutomationRevisionNotFoundError(`revision not found for automation: ${revisionId}`)
      if (current.activeRevisionId === revisionId) return { automation: current, changed: false }
      this.ctx.database.db.prepare(`
        UPDATE automations
        SET active_revision_id = ?, activation_generation = activation_generation + 1,
            updated_at = ?
        WHERE id = ? AND activation_generation = ?
      `).run(revisionId, new Date().toISOString(), automationId, current.activationGeneration)
      return { automation: this.get(automationId)!, changed: true }
    })
    if (result.changed) this.ctx.emit('numen/automation-change', automationId)
    return result.automation
  }

  setEnabled(automationId: string, enabled: boolean, expectedActivationGeneration?: number): Automation {
    const result = this.ctx.database.transaction(() => {
      const current = this.requireActivationGeneration(automationId, expectedActivationGeneration)
      this.requireNotArchived(current)
      if (current.enabled === enabled) return { automation: current, changed: false }
      this.ctx.database.db.prepare(`
        UPDATE automations
        SET enabled = ?, activation_generation = activation_generation + 1, updated_at = ?
        WHERE id = ? AND activation_generation = ?
      `).run(enabled ? 1 : 0, new Date().toISOString(), automationId, current.activationGeneration)
      return { automation: this.get(automationId)!, changed: true }
    })
    if (result.changed) this.ctx.emit('numen/automation-change', automationId)
    return result.automation
  }

  private requireActivationGeneration(automationId: string, expected?: number): Automation {
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      throw new TypeError('expected activation generation must be a non-negative integer')
    }
    const current = this.get(automationId)
    if (!current) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    if (expected !== undefined && current.activationGeneration !== expected) {
      throw new AutomationActivationConflictError(expected, current.activationGeneration)
    }
    return current
  }

  archive(automationId: string, expectedActivationGeneration?: number): Automation {
    const result = this.ctx.database.transaction(() => {
      const current = this.requireActivationGeneration(automationId, expectedActivationGeneration)
      if (current.archivedAt) return { automation: current, changed: false }
      const now = new Date().toISOString()
      this.ctx.database.db.prepare(`
        UPDATE automations SET archived_at = ?, activation_generation = activation_generation + 1, updated_at = ?
        WHERE id = ? AND activation_generation = ? AND archived_at IS NULL
      `).run(now, now, automationId, current.activationGeneration)
      return { automation: this.get(automationId)!, changed: true }
    })
    if (result.changed) this.ctx.emit('numen/automation-change', automationId)
    return result.automation
  }

  restoreArchive(automationId: string, expectedActivationGeneration?: number): Automation {
    const result = this.ctx.database.transaction(() => {
      const current = this.requireActivationGeneration(automationId, expectedActivationGeneration)
      if (!current.archivedAt) return { automation: current, changed: false }
      this.ctx.database.db.prepare(`
        UPDATE automations SET archived_at = NULL, activation_generation = activation_generation + 1, updated_at = ?
        WHERE id = ? AND activation_generation = ? AND archived_at = ?
      `).run(new Date().toISOString(), automationId, current.activationGeneration, current.archivedAt)
      return { automation: this.get(automationId)!, changed: true }
    })
    if (result.changed) this.ctx.emit('numen/automation-change', automationId)
    return result.automation
  }

  /** Permanently removes one archived Automation and its run history. */
  removeArchived(automationId: string, expectedArchivedAt: string): { automationId: string; runCount: number } {
    const result = this.ctx.database.transaction(() => {
      const current = this.get(automationId)
      if (!current) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
      if (!current.archivedAt || current.archivedAt !== expectedArchivedAt) {
        throw new AutomationPurgeConflictError('archive state changed; reload before permanent removal')
      }
      const active = this.ctx.database.db.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE automation_id = ? AND status IN ('QUEUED', 'RUNNING', 'CANCELLING')
      `).get(automationId) as { count: number }
      if (active.count) throw new AutomationHasActiveRunsError(active.count)
      const { count: runCount } = this.ctx.database.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE automation_id = ?').get(automationId) as { count: number }

      const now = new Date().toISOString()
      this.ctx.database.db.prepare(`
        UPDATE resources SET gc_after = ?, updated_at = ?
        WHERE state = 'COMMITTED' AND id IN (
          SELECT owned.resource_id FROM resource_owners owned
          WHERE owned.owner_type = 'execution'
            AND owned.owner_id IN (SELECT executions.id FROM executions JOIN runs ON runs.id = executions.run_id WHERE runs.automation_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM resource_owners other WHERE other.resource_id = owned.resource_id
                AND NOT (other.owner_type = 'execution' AND other.owner_id IN (
                  SELECT executions.id FROM executions JOIN runs ON runs.id = executions.run_id WHERE runs.automation_id = ?
                ))
            )
        )
      `).run(now, now, automationId, automationId)
      this.ctx.database.db.prepare(`
        DELETE FROM execution_iterations
        WHERE iterate_execution_id IN (SELECT id FROM executions WHERE run_id IN (SELECT id FROM runs WHERE automation_id = ?))
          OR root_execution_id IN (SELECT id FROM executions WHERE run_id IN (SELECT id FROM runs WHERE automation_id = ?))
          OR terminal_execution_id IN (SELECT id FROM executions WHERE run_id IN (SELECT id FROM runs WHERE automation_id = ?))
      `).run(automationId, automationId, automationId)
      this.ctx.database.db.prepare(`
        UPDATE executions SET parent_execution_id = NULL, scope_execution_id = NULL
        WHERE run_id IN (SELECT id FROM runs WHERE automation_id = ?)
      `).run(automationId)
      this.ctx.database.db.prepare(`
        DELETE FROM resource_owners WHERE owner_type = 'execution'
          AND owner_id IN (SELECT executions.id FROM executions JOIN runs ON runs.id = executions.run_id WHERE runs.automation_id = ?)
      `).run(automationId)
      this.ctx.database.db.prepare('DELETE FROM runs WHERE automation_id = ?').run(automationId)
      this.ctx.database.db.prepare('DELETE FROM automations WHERE id = ? AND archived_at = ?').run(automationId, expectedArchivedAt)
      return { automationId, runCount }
    })
    this.ctx.emit('numen/automation-purge', automationId)
    return result
  }

  private requireNotArchived(automation: Automation): void {
    if (automation.archivedAt) throw new AutomationArchivedError(`automation is archived: ${automation.id}`)
  }
}

export default AutomationService
