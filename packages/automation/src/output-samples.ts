import type { AutomationExecutionSnapshot, ContractSnapshotCapability, OutputSample, NumenValue } from '@numenjs/core'
import type { Context } from 'cordis'
import { createHash, randomUUID } from 'node:crypto'
import Schema from 'schemastery'

export class OutputSampleError extends Error {
  override name = 'OutputSampleError'
  constructor(public readonly code: string, message: string) { super(message) }
}

export function canonicalData(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalData).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalData((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export const dataHash = (value: unknown): string => createHash('sha256').update(canonicalData(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Schema serialization uses process-local UIDs; hashes bind the contract, never those UIDs. */
export function stableSchema(schema: unknown): unknown {
  if (!object(schema)) return schema
  const refs = object(schema.refs) ? schema.refs : {}
  const active = new Map<number, string>()
  const visit = (value: unknown, path: string): unknown => {
    const uid = typeof value === 'number' ? value : object(value) && typeof value.uid === 'number' ? value.uid : undefined
    if (uid !== undefined && Object.hasOwn(refs, uid)) {
      if (active.has(uid)) return { $ref: active.get(uid) }
      active.set(uid, path)
      const result = visit(refs[uid], path)
      active.delete(uid)
      return result
    }
    if (!object(value)) return value
    return Object.fromEntries(Object.keys(value).filter(key => key !== 'uid' && key !== 'refs').sort().map(key => {
      const child = value[key]
      if (key === 'dict' && object(child)) return [key, Object.fromEntries(Object.keys(child).sort().map(name => [name, visit(child[name], `${path}.${name}`)]))]
      if (key === 'list' && Array.isArray(child)) return [key, child.map((item, index) => visit(item, `${path}.${index}`))]
      return [key, key === 'inner' || key === 'sKey' ? visit(child, `${path}.${key}`) : child]
    }))
  }
  return visit(schema, '$')
}

export function sampleContractHash(contract: ContractSnapshotCapability): string {
  return dataHash({ id: contract.id, version: contract.version, kind: contract.kind,
    inputSchema: stableSchema(contract.inputSchema), outputSchema: stableSchema(contract.outputSchema),
    semantics: contract.semantics, connections: contract.connections ?? [] })
}

export function assertSampleValue(value: unknown, requestData = false): asserts value is NumenValue {
  let count = 0
  const active = new Set<object>()
  const visit = (current: unknown, depth: number): void => {
    if (++count > 50_000 || depth > 32) throw new OutputSampleError('SAMPLE_LIMIT', 'Sample exceeds its depth or value limit.')
    if (current === null || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return
    if (typeof current === 'string') {
      if (!requestData && /\[(?:redacted|hidden(?::[^\]]*)?|inspection limit reached|truncated)\]/i.test(current)) {
        throw new OutputSampleError('SAMPLE_INCOMPLETE', 'Redacted or truncated inspection values cannot be samples.')
      }
      return
    }
    if (!current || typeof current !== 'object' || active.has(current)
      || !Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new OutputSampleError('SAMPLE_INVALID', 'Sample must contain complete JSON values.')
    }
    if (!requestData && Object.hasOwn(current, '$resource')) throw new OutputSampleError('SAMPLE_RESOURCE_UNSUPPORTED', 'ResourceRef samples are not supported.')
    active.add(current)
    for (const child of Object.values(current)) visit(child, depth + 1)
    active.delete(current)
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) throw new OutputSampleError('SAMPLE_LIMIT', 'Sample exceeds one MiB.')
}

export function validateFrozenValue(value: NumenValue, schema: unknown): void {
  try {
    const result = new Schema(schema as Partial<Schema>)(structuredClone(value))
    if (canonicalData(result) !== canonicalData(value)) throw new Error('validation changed value')
  } catch {
    throw new OutputSampleError('SAMPLE_SCHEMA_MISMATCH', 'The complete value does not match the frozen capability contract.')
  }
}

/** Import authorization follows immutable public-leaf classification; no projection is accepted. */
function assertImportPublic(value: NumenValue, encoded: unknown): void {
  const privateNames = /^(?:password|passwd|pwd|secret|secrets|token|accesstoken|refreshtoken|apikey|privatekey|clientsecret|authorization|proxyauthorization|cookie|cookies|setcookie|credential|credentials|credentialmaterial|ciphertext|connection|connections|__proto__|prototype|constructor)$/i
  const walk = (data: NumenValue, schema: unknown, name = ''): void => {
    const deny = () => { throw new OutputSampleError('SAMPLE_IMPORT_PRIVATE', 'Execution output is not completely classified for reuse.') }
    if (!object(schema) || privateNames.test(name.replace(/[-_\s]/g, ''))) return deny()
    const meta = object(schema.meta) ? schema.meta : {}
    const extra = object(meta.extra) && object(meta.extra.numen) ? meta.extra.numen : {}
    if (['secret', 'password', 'credential', 'credentials', 'resource'].includes(String(meta.role)) || meta.sensitive === true || extra.execution === 'sensitive') return deny()
    if (Array.isArray(data)) {
      if (schema.type !== 'array' || schema.inner === undefined) return deny()
      for (const item of data) walk(item, schema.inner)
    } else if (object(data)) {
      if (schema.type !== 'object' || !object(schema.dict)) return deny()
      for (const [key, child] of Object.entries(data)) walk(child as NumenValue, schema.dict[key], key)
    } else if (extra.execution !== 'public') deny()
  }
  walk(value, stableSchema(encoded))
}

export function sampleContract(snapshot: Pick<AutomationExecutionSnapshot, 'compiledPlan' | 'contractSnapshot' | 'source'>, nodeId: string): ContractSnapshotCapability {
  if (snapshot.source.flow.type !== 'graph' || snapshot.source.flow.version !== 1 || !snapshot.source.flow.nodes.some(node => node.id === nodeId && node.type === 'capability')) {
    throw new OutputSampleError('SAMPLE_NODE_UNSUPPORTED', 'Samples support ordinary Capability members in the root Graph.')
  }
  const instruction = snapshot.compiledPlan.instructions[nodeId]
  if (instruction?.op !== 'invoke') throw new OutputSampleError('SAMPLE_NODE_UNSUPPORTED', 'Sample source must be a real Capability invocation.')
  const contract = snapshot.contractSnapshot.capabilities.find(item => item.id === instruction.capability.id && item.version === instruction.capability.version)
  if (!contract) throw new OutputSampleError('SAMPLE_CONTRACT_MISSING', 'Frozen output contract is unavailable.')
  return contract
}

export function persistSample(ctx: Context, automationId: string, nodeId: string, contract: ContractSnapshotCapability, value: unknown, provenance: OutputSample['provenance']): OutputSample {
  assertSampleValue(value)
  validateFrozenValue(value, contract.outputSchema)
  const { count } = ctx.database.db.prepare('SELECT COUNT(*) AS count FROM automation_output_samples WHERE automation_id = ?').get(automationId) as { count: number }
  if (count >= 1000) throw new OutputSampleError('SAMPLE_LIMIT', 'An Automation supports at most 1000 saved output samples.')
  const sample: OutputSample = { id: `sample_${randomUUID().replaceAll('-', '')}`, automationId, nodeId,
    capability: { id: contract.id, version: contract.version }, contract, contractHash: sampleContractHash(contract),
    value: structuredClone(value), valueHash: dataHash(value), integrity: 'complete', provenance, createdAt: new Date().toISOString() }
  ctx.database.db.prepare('INSERT INTO automation_output_samples (id, automation_id, node_id, sample_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sample.id, automationId, nodeId, JSON.stringify(sample), sample.createdAt)
  return sample
}

export function readSample(ctx: Context, automationId: string, sampleId: string): OutputSample | undefined {
  const row = ctx.database.db.prepare('SELECT sample_json FROM automation_output_samples WHERE id = ? AND automation_id = ?').get(sampleId, automationId) as { sample_json: string } | undefined
  return row ? JSON.parse(row.sample_json) as OutputSample : undefined
}

export function importSample(ctx: Context, request: { automationId: string; executionId: string }): OutputSample {
  if (Object.keys(request).some(key => key !== 'automationId' && key !== 'executionId')) throw new OutputSampleError('SAMPLE_IMPORT_PROJECTION', 'Import accepts only an Execution identity, never projected data.')
  const row = ctx.database.db.prepare(`SELECT execution.id, execution.instruction_id, execution.status,
      length(CAST(execution.output_json AS BLOB)) AS output_bytes,
      CASE WHEN length(CAST(execution.output_json AS BLOB)) <= 1048576 THEN execution.output_json END AS output_json,
      run.id AS run_id, run.revision_id, snapshot.protocol_version, snapshot.ir_version,
      length(CAST(snapshot.source_json AS BLOB)) + length(CAST(snapshot.presentation_json AS BLOB))
        + length(CAST(snapshot.compiled_plan_json AS BLOB)) + length(CAST(snapshot.dependency_manifest_json AS BLOB))
        + length(CAST(snapshot.contract_snapshot_json AS BLOB)) + COALESCE(length(CAST(snapshot.local_test_json AS BLOB)), 0) AS snapshot_bytes
    FROM executions AS execution JOIN runs AS run ON run.id = execution.run_id
    JOIN automation_revisions AS snapshot ON snapshot.id = run.revision_id
    WHERE execution.id = ? AND run.automation_id = ?`).get(request.executionId, request.automationId) as {
      id: string; instruction_id: string; status: string; output_bytes: number | null; output_json: string | null; run_id: string; revision_id: string
      protocol_version: number; ir_version: number; snapshot_bytes: number
    } | undefined
  if (!row || row.status !== 'COMPLETED' || row.output_bytes === null) throw new OutputSampleError('SAMPLE_IMPORT_INCOMPLETE', 'A complete persisted successful Execution is required.')
  if (row.output_json === null) throw new OutputSampleError('SAMPLE_LIMIT', 'Execution output exceeds the sample limit.')
  // Historical imports must not decode a future format or an unbounded snapshot.
  if (row.protocol_version !== 2 || row.ir_version !== 2) {
    throw new OutputSampleError('SAMPLE_PROTOCOL_UNSUPPORTED', 'The source execution protocol is unsupported for Graph output samples.')
  }
  if (row.snapshot_bytes > 8 * 1024 * 1024) throw new OutputSampleError('SAMPLE_LIMIT', 'Source snapshot exceeds the eight MiB import limit.')
  const snapshot = ctx.automations.getExecutionSnapshot(row.revision_id)
  if (!snapshot) throw new OutputSampleError('SAMPLE_CONTRACT_MISSING', 'Source snapshot is unavailable.')
  if (snapshot.protocolVersion !== 2 || snapshot.irVersion !== 2 || snapshot.compiledPlan.irVersion !== 2) {
    throw new OutputSampleError('SAMPLE_PROTOCOL_UNSUPPORTED', 'The source execution protocol is unsupported for Graph output samples.')
  }
  const contract = sampleContract(snapshot, row.instruction_id)
  const value: unknown = JSON.parse(row.output_json)
  assertSampleValue(value)
  assertImportPublic(value, contract.outputSchema)
  return persistSample(ctx, request.automationId, row.instruction_id, contract, value, {
    kind: 'execution', snapshotId: snapshot.id, snapshotContentHash: snapshot.contentHash, runId: row.run_id, executionId: row.id,
  })
}
