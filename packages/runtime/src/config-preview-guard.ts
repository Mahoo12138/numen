import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HostConfigError, type HostConfigImpact, type HostConfigMutationRequest } from '@numenjs/config'
import type { Context } from 'cordis'
import type { RuntimeImpactEvidence } from './config-impact-evidence.js'

/** Canonical object order, without weakening exact array/config value semantics. */
export function canonicalPreviewValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item)
}

/** Process-local authentication makes restart invalidate every previously issued proof. */
export class ConfigPreviewGuard {
  private readonly secret = randomBytes(32)
  private readonly identities = new WeakMap<object, number>()
  private nextIdentity = 0

  identity(value: object | null | undefined): number | null {
    if (!value) return null
    let identity = this.identities.get(value)
    if (!identity) { identity = ++this.nextIdentity; this.identities.set(value, identity) }
    return identity
  }

  token(input: HostConfigMutationRequest, observation: unknown): string {
    return createHmac('sha256', this.secret).update(canonicalPreviewValue({ fingerprint: input.fingerprint, operation: input.operation, observation })).digest('hex')
  }

  verify(input: HostConfigMutationRequest & { previewToken?: unknown }, observation: unknown): void {
    if (typeof input.previewToken !== 'string' || !input.previewToken) throw new HostConfigError('PREVIEW_REQUIRED', 'Preview this exact operation before applying it.')
    const expected = this.token(input, observation)
    if (!/^[a-f0-9]{64}$/.test(input.previewToken) || !timingSafeEqual(Buffer.from(input.previewToken, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new HostConfigError('PREVIEW_STALE', 'The operation or its runtime observations changed. Review a new preview before applying your retained edits.')
    }
  }
}

/** Additional internal read-model identity; no payload or digest is exposed in the DTO. */
export function persistedPreviewEvidence(ctx: Context, impact: HostConfigImpact, evidence: RuntimeImpactEvidence): unknown {
  const scoped = (kind: string) => new Set(impact.nodes.filter(node => node.kind === kind).map(node => node.id))
  const connectionIds = scoped('connection'), revisionIds = scoped('revision'), runIds = scoped('run')
  const runs = evidence.runs.filter(run => runIds.has(run.id))
  // A coverage change matters; global scanned counts merely describe unrelated
  // objects and must not invalidate an otherwise identical scoped preview.
  const coverage = impact.coverage.map(({ scanned: _scanned, ...item }) => item)
  let fallback = impact.truncated || impact.coverage.some(item => item.status === 'partial' || item.status === 'unavailable')
  let database: Context['database']['db'] | undefined
  try { database = ctx.get('database')?.db } catch { /* An installed service may still be initializing. */ }
  if (!database) return { coverage, database: 'unavailable', runs }
  try {
    return database.transaction(() => {
      // Config values are private and bounded. HMAC binds their exact bytes,
      // including unsupported out-of-band edits that forgot generation updates.
      const connectionStatement = database.prepare(`SELECT id, adapter_id, adapter_version, type_id, type_version, enabled, generation, updated_at,
        CASE WHEN length(CAST(config_json AS BLOB)) <= @byte_limit THEN config_json END AS config_json,
        CASE WHEN length(CAST(credential_id AS BLOB)) <= 256 THEN credential_id END AS credential_id,
        length(CAST(config_json AS BLOB)) AS config_bytes, length(CAST(credential_id AS BLOB)) AS credential_bytes
        FROM connections WHERE id = @id`)
      let remainingBytes = 4_194_304
      const connections = [...connectionIds].sort().map(id => {
        const byteLimit = Math.min(Math.max(remainingBytes, 0), 262144)
        const row = connectionStatement.get({ id, byte_limit: byteLimit }) as { config_bytes: number; credential_bytes: number; config_json: string | null } | undefined
        if (!row) return null
        if (row.config_bytes <= byteLimit) remainingBytes -= row.config_bytes
        if (row.config_bytes > byteLimit || row.credential_bytes > 256) { fallback = true; row.config_json = null }
        return row
      })
      const revisionStatement = database.prepare(`SELECT r.id, r.automation_id, r.content_hash, r.purpose, r.protocol_version, r.ir_version,
        a.active_revision_id, a.activation_generation, a.enabled, a.archived_at
        FROM automation_revisions r JOIN automations a ON a.id = r.automation_id WHERE r.id = ?`)
      const revisions = [...revisionIds].sort().map(id => revisionStatement.get(id) ?? null)
      const executionStatement = database.prepare(`SELECT e.id, e.generation, e.wake_at, e.updated_at,
        (SELECT a.id FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT 1) AS attempt_id,
        (SELECT a.number FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT 1) AS attempt_number
        FROM executions e WHERE e.id = ?`)
      const executions = runs.flatMap(run => run.executions.map(execution => executionStatement.get(execution.id) ?? null))
      // Incomplete/omitted relationships cannot prove that a database change was
      // unrelated. Conservatively invalidate on same-connection writes or commits
      // from other connections; these counters are intentionally internal only.
      const incompleteChanges = fallback ? {
        own: database.prepare('SELECT total_changes() AS changes').get(),
        external: database.pragma('data_version', { simple: true }),
      } : undefined
      return { coverage, connections, revisions, executions, runs, incompleteChanges }
    })()
  } catch {
    // Never turn a failed freshness read into a reusable empty proof.
    return { coverage, database: 'read-failed', nonce: randomBytes(16).toString('hex') }
  }
}
