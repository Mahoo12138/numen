import {
  type Automation,
  type AutomationDraft,
  type AutomationRevision,
  type AutomationSource,
  type NumenValue,
} from '@numen/core'
import '@numen/database'
import { Service, type Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import { compileAutomation } from './compiler.js'

export class AutomationNotFoundError extends Error {
  override name = 'AutomationNotFoundError'
}

export class DraftConflictError extends Error {
  override name = 'DraftConflictError'

  constructor(public readonly expectedVersion: number, public readonly actualVersion: number) {
    super(`draft version conflict: expected ${expectedVersion}, actual ${actualVersion}`)
  }
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

interface AutomationRow {
  id: string
  name: string
  enabled: number
  active_revision_id: string | null
  activation_generation: number
  created_at: string
  updated_at: string
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

    this.ctx.database.transaction(() => {
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
    })
    return { automation: this.get(id)!, draft: this.getDraft(id)! }
  }

  get(id: string): Automation | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined
    return row ? mapAutomation(row) : undefined
  }

  list(): Automation[] {
    return (this.ctx.database.db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all() as AutomationRow[])
      .map(mapAutomation)
  }

  getDraft(automationId: string): AutomationDraft | undefined {
    const row = this.ctx.database.db
      .prepare('SELECT * FROM automation_drafts WHERE automation_id = ?')
      .get(automationId) as DraftRow | undefined
    return row ? mapDraft(row) : undefined
  }

  saveDraft(input: SaveDraftInput): AutomationDraft {
    const now = new Date().toISOString()
    return this.ctx.database.transaction(() => {
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
  }

  count(): number {
    return (this.ctx.database.db.prepare('SELECT COUNT(*) AS count FROM automations').get() as { count: number }).count
  }

  publishDraft(automationId: string, expectedDraftVersion?: number): AutomationRevision {
    const draft = this.getDraft(automationId)
    if (!draft) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    if (expectedDraftVersion !== undefined && draft.version !== expectedDraftVersion) {
      throw new DraftConflictError(expectedDraftVersion, draft.version)
    }

    const compiled = compileAutomation(draft.source, this.ctx.capabilities)
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

    return this.ctx.database.transaction(() => {
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

  activateRevision(automationId: string, revisionId: string): Automation {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const revision = this.ctx.database.db.prepare(`
        SELECT 1 FROM automation_revisions WHERE id = ? AND automation_id = ?
      `).get(revisionId, automationId)
      if (!revision) throw new AutomationNotFoundError(`revision not found for automation: ${revisionId}`)
      this.ctx.database.db.prepare(`
        UPDATE automations
        SET active_revision_id = ?, activation_generation = activation_generation + 1,
            updated_at = ?
        WHERE id = ?
      `).run(revisionId, now, automationId)
    })
    this.ctx.emit('numen/automation-change', automationId)
    return this.get(automationId)!
  }

  setEnabled(automationId: string, enabled: boolean): Automation {
    const now = new Date().toISOString()
    const result = this.ctx.database.db.prepare(`
      UPDATE automations
      SET enabled = ?, activation_generation = activation_generation + 1, updated_at = ?
      WHERE id = ? AND enabled != ?
    `).run(enabled ? 1 : 0, now, automationId, enabled ? 1 : 0)
    if (result.changes === 0 && !this.get(automationId)) {
      throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    }
    if (result.changes) this.ctx.emit('numen/automation-change', automationId)
    return this.get(automationId)!
  }
}

export default AutomationService
