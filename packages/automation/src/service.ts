import {
  isSupportedAutomationVersion,
  type Automation,
  type AutomationDraft,
  type AutomationRevision,
  type AutomationExecutionSnapshot,
  type AutomationSnapshotFields,
  type DraftTestAutomationSnapshot,
  type AutomationSource,
  type GraphSource,
  type NumenValue,
  type ControlResolver,
  type LocalTestPreview,
  type LocalTestRequest,
  type OutputSample,
  type OutputSampleSummary,
} from '@numenjs/core'
import '@numenjs/database'
import { Service, type Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import { compileAutomation, type ConnectionResolver } from './compiler.js'
import { buildLocalTest, LocalTestError } from './local-test.js'
import { assertSampleValue, dataHash, importSample, OutputSampleError, persistSample, readSample, sampleContract, stableSchema } from './output-samples.js'

export class AutomationNotFoundError extends Error {
  override name = 'AutomationNotFoundError'
}

export class AutomationRevisionNotFoundError extends AutomationNotFoundError {
  override name = 'AutomationRevisionNotFoundError'
}

export class AutomationSnapshotInspectionLimitError extends Error {
  override name = 'AutomationSnapshotInspectionLimitError'
}

export class AutomationDraftInspectionLimitError extends Error {
  override name = 'AutomationDraftInspectionLimitError'
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

export interface AutomationComparisonState {
  automationId: string
  automationName: string
  draftVersion: number
  revisions: { id: string; number: number; createdAt: string }[]
  revisionsTruncated: boolean
}

/** Authoring content, independent of compiled plans and frozen contracts. */
export type AutomationSnapshotContent = Pick<AutomationSnapshotFields, 'id' | 'automationId' | 'protocolVersion' | 'irVersion' | 'contentHash' | 'createdAt' | 'source' | 'presentation'> & (
  | { purpose: 'published'; number: number; sourceDraftVersion?: number }
  | { purpose: 'draft-test'; sourceDraftVersion: number }
)

/** Compiled saved Draft data; insertion still checks its exact source version. */
export type PreparedDraftTestSnapshot = Omit<DraftTestAutomationSnapshot, 'id' | 'createdAt'>

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
  number: number | null
  purpose: string
  source_draft_version: number | null
  base_revision_id: string | null
  protocol_version: number
  source_json: string
  presentation_json: string
  ir_version: number
  compiled_plan_json: string
  dependency_manifest_json: string
  contract_snapshot_json: string
  content_hash: string
  created_at: string
  local_test_json: string | null
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

function mapExecutionSnapshot(row: RevisionRow): AutomationExecutionSnapshot {
  const fields: AutomationSnapshotFields = {
    id: row.id,
    automationId: row.automation_id,
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
  const provenance = {
    ...(row.base_revision_id ? { baseRevisionId: row.base_revision_id } : {}),
  }
  if (row.purpose === 'published' && typeof row.number === 'number' && Number.isSafeInteger(row.number) && row.number > 0
    && (row.source_draft_version === null || (Number.isSafeInteger(row.source_draft_version) && row.source_draft_version > 0))) {
    return {
      ...fields, ...provenance, purpose: 'published', number: row.number,
      ...(row.source_draft_version === null ? {} : { sourceDraftVersion: row.source_draft_version }),
    }
  }
  if (row.purpose === 'draft-test' && row.number === null
    && typeof row.source_draft_version === 'number' && Number.isSafeInteger(row.source_draft_version) && row.source_draft_version > 0) {
    return { ...fields, ...provenance, purpose: 'draft-test', sourceDraftVersion: row.source_draft_version,
      ...(row.local_test_json ? { localTest: parseJson(row.local_test_json) } : {}) }
  }
  throw new Error(`invalid automation execution snapshot: ${row.id}`)
}

function mapRevision(row: RevisionRow): AutomationRevision {
  const snapshot = mapExecutionSnapshot(row)
  if (snapshot.purpose !== 'published') throw new Error(`snapshot is not a published Revision: ${row.id}`)
  return snapshot
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

function canonicalGraph(graph: GraphSource): GraphSource {
  const compareId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return {
    ...graph,
    nodes: graph.nodes.map(node => node.type === 'foreach' ? { ...node, body: canonicalGraph(node.body) } : node).sort(compareId),
    edges: [...graph.edges].sort(compareId),
  }
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
        AND automation_revisions.purpose = 'published'
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

  /** The baseline can be checked without parsing or exposing the current Draft document. */
  getDraftIdentity(automationId: string): { version: number; updatedAt: string; baseRevisionId?: string } | undefined {
    const row = this.ctx.database.db.prepare('SELECT version, updated_at, base_revision_id FROM automation_drafts WHERE automation_id = ?')
      .get(automationId) as Pick<DraftRow, 'version' | 'updated_at' | 'base_revision_id'> | undefined
    if (!row) return
    if (!Number.isSafeInteger(row.version) || row.version < 1) throw new Error('draft identity is unavailable')
    return { version: row.version, updatedAt: row.updated_at, ...(row.base_revision_id ? { baseRevisionId: row.base_revision_id } : {}) }
  }

  /** A single read fixes the Draft version and bounds UTF-8 bytes before JSON decoding. */
  getDraftForInspection(automationId: string, expectedVersion: number, maximumBytes = 8 * 1024 * 1024): AutomationDraft | undefined {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('invalid draft inspection version')
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('invalid draft inspection byte limit')
    const row = this.ctx.database.db.prepare(`
      SELECT automation_id, base_revision_id, version, updated_at,
        length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) AS json_bytes,
        CASE WHEN version = ? AND length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) <= ?
          THEN source_json END AS source_json,
        CASE WHEN version = ? AND length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) <= ?
          THEN presentation_json END AS presentation_json
      FROM automation_drafts WHERE automation_id = ?
    `).get(expectedVersion, maximumBytes, expectedVersion, maximumBytes, automationId) as (Omit<DraftRow, 'source_json' | 'presentation_json'> & { source_json: string | null; presentation_json: string | null; json_bytes: number }) | undefined
    if (!row) return
    if (row.version !== expectedVersion) throw new DraftConflictError(expectedVersion, row.version)
    if (row.json_bytes > maximumBytes) throw new AutomationDraftInspectionLimitError('draft inspection exceeds its stored data limit')
    if (row.source_json === null || row.presentation_json === null) throw new Error('draft inspection data is unavailable')
    return mapDraft({ ...row, source_json: row.source_json, presentation_json: row.presentation_json })
  }

  /** Comparison selection and staleness metadata never parse mutable or historical document JSON. */
  getComparisonState(automationId: string): AutomationComparisonState | undefined {
    const row = this.ctx.database.db.prepare(`
      SELECT automations.id, automations.name, automation_drafts.version
      FROM automations JOIN automation_drafts ON automation_drafts.automation_id = automations.id
      WHERE automations.id = ?
    `).get(automationId) as { id: string; name: string; version: number } | undefined
    if (!row) return
    const revisions = this.ctx.database.db.prepare(`
      SELECT id, number, created_at FROM automation_revisions
      WHERE automation_id = ? AND purpose = 'published'
      ORDER BY number DESC LIMIT 101
    `).all(automationId) as Array<Pick<RevisionRow, 'id' | 'number' | 'created_at'>>
    if (!Number.isSafeInteger(row.version) || row.version < 1
      || revisions.some(revision => revision.number === null || !Number.isSafeInteger(revision.number) || revision.number < 1)) {
      throw new Error('comparison identity metadata is unavailable')
    }
    return {
      automationId: row.id, automationName: row.name, draftVersion: row.version,
      revisions: revisions.slice(0, 100).map(revision => ({ id: revision.id, number: revision.number!, createdAt: revision.created_at })),
      revisionsTruncated: revisions.length > 100,
    }
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

    const snapshot = this.compileDraftSnapshot(draft)
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
        FROM automation_revisions WHERE automation_id = ? AND purpose = 'published'
      `).get(automationId) as { number: number }
      this.ctx.database.db.prepare(`
        INSERT INTO automation_revisions (
          id, automation_id, number, protocol_version, source_json, presentation_json,
          ir_version, compiled_plan_json, dependency_manifest_json,
          contract_snapshot_json, content_hash, created_at, purpose, source_draft_version, base_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
      `).run(
        revisionId,
        automationId,
        number,
        snapshot.protocolVersion,
        JSON.stringify(draft.source),
        JSON.stringify(draft.presentation),
        snapshot.irVersion,
        JSON.stringify(snapshot.compiledPlan),
        JSON.stringify(snapshot.dependencyManifest),
        JSON.stringify(snapshot.contractSnapshot),
        snapshot.contentHash,
        now,
        draft.version,
        draft.baseRevisionId ?? null,
      )
      this.ctx.database.db.prepare(`
        UPDATE automation_drafts SET base_revision_id = ? WHERE automation_id = ?
      `).run(revisionId, automationId)
      return this.getRevision(revisionId)!
    })
    this.ctx.emit('numen/automation-change', automationId)
    return revision
  }

  private compileDraftSnapshot(draft: AutomationDraft): Omit<AutomationSnapshotFields, 'id' | 'createdAt'> {
    const compiled = compileAutomation(
      draft.source,
      this.ctx.capabilities,
      this.ctx.get('connections') as ConnectionResolver | undefined,
      this.ctx.get('controls') as ControlResolver | undefined,
    )
    const semanticSnapshot = {
      protocolVersion: compiled.plan.irVersion,
      source: draft.source,
      irVersion: compiled.plan.irVersion,
      compiledPlan: compiled.plan,
      dependencyManifest: compiled.dependencyManifest,
      contractSnapshot: compiled.contractSnapshot,
    }
    return {
      automationId: draft.automationId,
      ...semanticSnapshot,
      presentation: draft.presentation,
      contentHash: createHash('sha256').update(canonicalize({
        ...semanticSnapshot,
        // A graph's authored array order is not an execution dependency. Keep
        // the original Source in the snapshot, but normalize graph identity
        // collections for the semantic fingerprint (v1 trees are unchanged).
        source: draft.source.flow.type === 'graph' ? {
          ...draft.source,
          flow: canonicalGraph(draft.source.flow),
        } : draft.source,
        // Schema UIDs vary across Registry instances; a reviewed Graph preview
        // remains valid when the same contracts are registered after restart.
        ...(draft.source.flow.type === 'graph' ? { contractSnapshot: {
          ...compiled.contractSnapshot,
          capabilities: compiled.contractSnapshot.capabilities.map(contract => ({ ...contract,
            inputSchema: stableSchema(contract.inputSchema), outputSchema: stableSchema(contract.outputSchema) })),
          ...(compiled.contractSnapshot.controls ? { controls: compiled.contractSnapshot.controls.map(contract => ({ ...contract,
            inputSchema: stableSchema(contract.inputSchema) })) } : {}),
        } } : {}),
      })).digest('hex'),
    }
  }

  prepareDraftTestSnapshot(automationId: string, expectedDraftVersion: number): PreparedDraftTestSnapshot {
    if (!Number.isSafeInteger(expectedDraftVersion) || expectedDraftVersion < 1) {
      throw new TypeError('expected draft version must be a positive integer')
    }
    const draft = this.requireDraftTestVersion(automationId, expectedDraftVersion)
    return {
      ...this.compileDraftSnapshot(draft),
      purpose: 'draft-test',
      sourceDraftVersion: draft.version,
      ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}),
    }
  }

  createOutputSample(input: { automationId: string; expectedDraftVersion: number; nodeId: string; value: NumenValue }): OutputSample {
    return this.ctx.database.transaction(() => {
      const prepared = this.prepareDraftTestSnapshot(input.automationId, input.expectedDraftVersion)
      return persistSample(this.ctx, input.automationId, input.nodeId, sampleContract(prepared, input.nodeId), input.value,
        { kind: 'manual', draftVersion: input.expectedDraftVersion })
    })
  }

  importOutputSample(input: { automationId: string; executionId: string }): OutputSample {
    return this.ctx.database.transaction(() => {
      const automation = this.get(input.automationId)
      if (!automation) throw new AutomationNotFoundError('Automation not found.')
      this.requireNotArchived(automation)
      return importSample(this.ctx, input)
    })
  }

  listOutputSamples(automationId: string, nodeId?: string, page?: { offset: number; limit: number }): OutputSampleSummary[] {
    const offset = page?.offset ?? 0, limit = page?.limit ?? 1000
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('invalid sample metadata page')
    // Page identities before touching sample JSON so later values are not decoded for this read.
    const rows = this.ctx.database.db.prepare(`WITH sample_page AS MATERIALIZED (
      SELECT id FROM automation_output_samples WHERE automation_id = ? AND (? IS NULL OR node_id = ?)
      ORDER BY created_at, id LIMIT ? OFFSET ?
    ) SELECT json_remove(sample.sample_json, '$.value', '$.contract') AS sample_json
      FROM sample_page JOIN automation_output_samples AS sample ON sample.id = sample_page.id ORDER BY sample.created_at, sample.id`)
      .all(automationId, nodeId ?? null, nodeId ?? null, limit, offset) as Array<{ sample_json: string }>
    return rows.map(row => parseJson<OutputSampleSummary>(row.sample_json))
  }

  getOutputSample(automationId: string, sampleId: string): OutputSample | undefined {
    return readSample(this.ctx, automationId, sampleId)
  }

  deleteOutputSample(automationId: string, sampleId: string): boolean {
    return this.ctx.database.db.prepare('DELETE FROM automation_output_samples WHERE id = ? AND automation_id = ?').run(sampleId, automationId).changes > 0
  }

  private buildLocalTest(request: LocalTestRequest) {
    if (!Array.isArray(request.sampleIds) || request.sampleIds.length > 1024 || new Set(request.sampleIds).size !== request.sampleIds.length
      || request.sampleIds.some(id => typeof id !== 'string' || id.length > 200)) {
      throw new LocalTestError('LOCAL_TEST_SAMPLES', 'Choose at most 1024 unique sample ids.')
    }
    assertSampleValue(request.input, true)
    assertSampleValue(request.trigger, true)
    const prepared = this.prepareDraftTestSnapshot(request.automationId, request.expectedDraftVersion)
    // Check persisted byte lengths before decoding selected samples or duplicating
    // them into the plan, immutable scope, and preview response.
    const sampleBytes = request.sampleIds.length ? (this.ctx.database.db.prepare(`SELECT COALESCE(SUM(length(CAST(sample_json AS BLOB))), 0) AS bytes
      FROM automation_output_samples WHERE automation_id = ? AND id IN (${request.sampleIds.map(() => '?').join(',')})`)
      .get(request.automationId, ...request.sampleIds) as { bytes: number }).bytes : 0
    if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') + 3 * sampleBytes + 3 * Buffer.byteLength(JSON.stringify(request), 'utf8') > 8 * 1024 * 1024) {
      throw new LocalTestError('LOCAL_TEST_LIMIT', 'Local test snapshot and selected samples exceed the eight MiB aggregate limit.')
    }
    const samples = request.sampleIds.map(id => {
      const sample = readSample(this.ctx, request.automationId, id)
      if (!sample) throw new OutputSampleError('SAMPLE_NOT_FOUND', 'A selected sample was deleted or is unavailable.')
      return sample
    })
    return { prepared, ...buildLocalTest(prepared, request, samples) }
  }

  previewLocalTest(request: LocalTestRequest): LocalTestPreview {
    return this.buildLocalTest(structuredClone(request)).preview
  }

  prepareLocalTestSnapshot(request: LocalTestRequest, previewHash?: string): PreparedDraftTestSnapshot {
    const { prepared, preview, plan } = this.buildLocalTest(structuredClone(request))
    if (previewHash !== undefined && preview.previewHash !== previewHash) throw new LocalTestError('LOCAL_TEST_PREVIEW_STALE', 'Local test preview is stale; review the current calls and substitutions.')
    const localTest = preview.scope
    return { ...prepared, compiledPlan: plan, localTest,
      contentHash: dataHash({ sourceContentHash: prepared.contentHash, plan, localTest }) }
  }

  /** May be nested in the Scheduler's synchronous acceptance transaction. */
  createDraftTestSnapshot(prepared: PreparedDraftTestSnapshot): DraftTestAutomationSnapshot {
    return this.ctx.database.transaction(() => {
      this.requireDraftTestVersion(prepared.automationId, prepared.sourceDraftVersion)
      if (prepared.localTest) {
        const current = this.prepareLocalTestSnapshot(prepared.localTest.request)
        if (current.contentHash !== prepared.contentHash || dataHash(current) !== dataHash(prepared)) {
          throw new LocalTestError('LOCAL_TEST_PREVIEW_STALE', 'Local test data or contracts changed before acceptance.')
        }
      }
      const snapshotId = `snap_${randomUUID().replaceAll('-', '')}`
      this.ctx.database.db.prepare(`
        INSERT INTO automation_revisions (
          id, automation_id, number, protocol_version, source_json, presentation_json,
          ir_version, compiled_plan_json, dependency_manifest_json,
          contract_snapshot_json, content_hash, created_at, purpose, source_draft_version, base_revision_id, local_test_json
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft-test', ?, ?, ?)
      `).run(
        snapshotId, prepared.automationId, prepared.protocolVersion,
        JSON.stringify(prepared.source), JSON.stringify(prepared.presentation), prepared.irVersion,
        JSON.stringify(prepared.compiledPlan), JSON.stringify(prepared.dependencyManifest),
        JSON.stringify(prepared.contractSnapshot), prepared.contentHash, new Date().toISOString(),
        prepared.sourceDraftVersion, prepared.baseRevisionId ?? null, prepared.localTest ? JSON.stringify(prepared.localTest) : null,
      )
      const snapshot = this.getExecutionSnapshot(snapshotId)!
      if (snapshot.purpose !== 'draft-test') throw new Error('expected Draft test snapshot')
      return snapshot
    })
  }

  private requireDraftTestVersion(automationId: string, expectedVersion: number): AutomationDraft {
    const automation = this.get(automationId)
    if (!automation) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    this.requireNotArchived(automation)
    const draft = this.getDraft(automationId)
    if (!draft) throw new AutomationNotFoundError(`automation not found: ${automationId}`)
    if (draft.version !== expectedVersion) throw new DraftConflictError(expectedVersion, draft.version)
    return draft
  }

  getExecutionSnapshot(snapshotId: string): AutomationExecutionSnapshot | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM automation_revisions WHERE id = ?')
      .get(snapshotId) as RevisionRow | undefined
    return row ? mapExecutionSnapshot(row) : undefined
  }

  /** Check membership and stored UTF-8 bytes before parsing immutable inspection data. */
  getExecutionSnapshotForInspection(snapshotId: string, automationId: string, maximumBytes = 8 * 1024 * 1024): AutomationExecutionSnapshot | undefined {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('invalid snapshot inspection byte limit')
    const row = this.ctx.database.db.prepare(`
      SELECT length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB))
        + length(CAST(compiled_plan_json AS BLOB)) + length(CAST(dependency_manifest_json AS BLOB))
        + length(CAST(contract_snapshot_json AS BLOB)) + COALESCE(length(CAST(local_test_json AS BLOB)), 0) AS json_bytes
      FROM automation_revisions WHERE id = ? AND automation_id = ?
    `).get(snapshotId, automationId) as { json_bytes: number } | undefined
    if (!row) return
    if (row.json_bytes > maximumBytes) throw new AutomationSnapshotInspectionLimitError('snapshot inspection exceeds its stored data limit')
    return this.getExecutionSnapshot(snapshotId)
  }

  /** Fixed Source and presentation only; unsupported protocols and excessive bytes never reach JSON decoding. */
  getExecutionSnapshotContentForInspection(snapshotId: string, automationId: string, maximumBytes = 8 * 1024 * 1024): AutomationSnapshotContent | undefined {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('invalid snapshot content byte limit')
    const row = this.ctx.database.db.prepare(`
      SELECT id, automation_id, number, purpose, source_draft_version, protocol_version, ir_version, content_hash, created_at,
        length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) AS json_bytes,
        CASE WHEN ((protocol_version = 1 AND ir_version = 1) OR (protocol_version = 2 AND ir_version = 2)) AND length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) <= ?
          THEN source_json END AS source_json,
        CASE WHEN ((protocol_version = 1 AND ir_version = 1) OR (protocol_version = 2 AND ir_version = 2)) AND length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB)) <= ?
          THEN presentation_json END AS presentation_json
      FROM automation_revisions WHERE id = ? AND automation_id = ?
    `).get(maximumBytes, maximumBytes, snapshotId, automationId) as (Pick<RevisionRow, 'id' | 'automation_id' | 'number' | 'purpose' | 'source_draft_version' | 'protocol_version' | 'ir_version' | 'content_hash' | 'created_at'> & { source_json: string | null; presentation_json: string | null; json_bytes: number }) | undefined
    if (!row) return
    if (!isSupportedAutomationVersion(row.protocol_version, row.ir_version)) throw new Error('snapshot content protocol is unavailable')
    if (row.json_bytes > maximumBytes) throw new AutomationSnapshotInspectionLimitError('snapshot content exceeds its stored data limit')
    if (row.source_json === null || row.presentation_json === null) throw new Error('snapshot content is unavailable')
    const fields = {
      id: row.id, automationId: row.automation_id, protocolVersion: row.protocol_version,
      irVersion: row.ir_version, contentHash: row.content_hash, createdAt: row.created_at,
      source: parseJson<AutomationSource>(row.source_json), presentation: parseJson<Record<string, NumenValue>>(row.presentation_json),
    }
    if (row.purpose === 'published' && row.number !== null && Number.isSafeInteger(row.number) && row.number > 0
      && (row.source_draft_version === null || (Number.isSafeInteger(row.source_draft_version) && row.source_draft_version > 0))) {
      return { ...fields, purpose: 'published', number: row.number, ...(row.source_draft_version === null ? {} : { sourceDraftVersion: row.source_draft_version }) }
    }
    if (row.purpose === 'draft-test' && row.number === null && row.source_draft_version !== null && Number.isSafeInteger(row.source_draft_version) && row.source_draft_version > 0) {
      return { ...fields, purpose: 'draft-test', sourceDraftVersion: row.source_draft_version }
    }
    throw new Error('snapshot content identity is unavailable')
  }

  /** Bounded list metadata without reading Source, IR, contracts or presentation JSON. */
  getExecutionSnapshotIdentity(snapshotId: string):
    | { id: string; purpose: 'published'; number: number }
    | { id: string; purpose: 'draft-test'; sourceDraftVersion: number }
    | undefined {
    const row = this.ctx.database.db.prepare('SELECT id, purpose, number, source_draft_version FROM automation_revisions WHERE id = ?')
      .get(snapshotId) as Pick<RevisionRow, 'id' | 'purpose' | 'number' | 'source_draft_version'> | undefined
    if (!row) return
    if (row.purpose === 'published' && row.number !== null) return { id: row.id, purpose: 'published', number: row.number }
    if (row.purpose === 'draft-test' && row.source_draft_version !== null) return { id: row.id, purpose: 'draft-test', sourceDraftVersion: row.source_draft_version }
    throw new Error(`invalid automation execution snapshot identity: ${row.id}`)
  }

  getRevision(revisionId: string): AutomationRevision | undefined {
    const row = this.ctx.database.db
      .prepare("SELECT * FROM automation_revisions WHERE id = ? AND purpose = 'published'")
      .get(revisionId) as RevisionRow | undefined
    return row ? mapRevision(row) : undefined
  }

  listRevisions(automationId: string): AutomationRevision[] {
    return (this.ctx.database.db.prepare(`
      SELECT * FROM automation_revisions WHERE automation_id = ? AND purpose = 'published' ORDER BY number DESC
    `).all(automationId) as RevisionRow[]).map(mapRevision)
  }

  activateRevision(automationId: string, revisionId: string, expectedActivationGeneration?: number): Automation {
    const result = this.ctx.database.transaction(() => {
      const current = this.requireActivationGeneration(automationId, expectedActivationGeneration)
      this.requireNotArchived(current)
      const revision = this.ctx.database.db.prepare(`
        SELECT 1 FROM automation_revisions WHERE id = ? AND automation_id = ? AND purpose = 'published'
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

      const removedOwnerPredicate = `
        (owner_type = 'execution' AND owner_id IN (
          SELECT executions.id FROM executions JOIN runs ON runs.id = executions.run_id WHERE runs.automation_id = ?
        )) OR (owner_type = 'run' AND owner_id IN (SELECT id FROM runs WHERE automation_id = ?))
          OR (owner_type = 'snapshot' AND owner_id IN (SELECT id FROM automation_revisions WHERE automation_id = ?))
      `
      const releasedResources = this.ctx.database.db.prepare(`
        SELECT DISTINCT resource_id FROM resource_owners WHERE ${removedOwnerPredicate}
      `).pluck().all(automationId, automationId, automationId) as string[]
      this.ctx.database.db.prepare(`DELETE FROM resource_owners WHERE ${removedOwnerPredicate}`)
        .run(automationId, automationId, automationId)
      const now = new Date().toISOString()
      const scheduleGc = this.ctx.database.db.prepare(`
        UPDATE resources SET gc_after = ?, updated_at = ?
        WHERE id = ? AND state = 'COMMITTED'
          AND NOT EXISTS (SELECT 1 FROM resource_owners WHERE resource_owners.resource_id = resources.id)
      `)
      for (const resourceId of releasedResources) scheduleGc.run(now, now, resourceId)
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
