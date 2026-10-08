import type { HostConfigSnapshot, HostRegistrationDiagnosis, HostRegistrationOwner, HostRegistrationRef } from '@numenjs/config'
import type { RuntimeRegistration } from '@numenjs/core'
import type { Fiber } from 'cordis'

export function owningEntry(fiber: Fiber): string | undefined {
  let current: Fiber | undefined = fiber
  while (current?.runtime) {
    if (current.entry) return current.entry.id
    current = current.parent.fiber
  }
}

interface Observation {
  ref: HostRegistrationRef
  token: symbol
  active: boolean
  observedAt: string
  generation: number
  entryId?: string
  source?: string
}
const key = (ref: HostRegistrationRef, role: string) => JSON.stringify([ref.kind, ref.id, ref.version, role])

/** Bounded process-local evidence. Never retain a disposed Context/Fiber or infer an owner from names. */
export class RegistrationOwnership {
  private readonly observations = new Map<string, Observation>()
  private evicted = false
  private invalid = false
  private generation = 0

  observe(registration: RuntimeRegistration, active: boolean, source: (id: string) => string | undefined): void {
    if (typeof registration.id !== 'string' || registration.id.length < 1 || registration.id.length > 256 || !Number.isSafeInteger(registration.version) || registration.version < 1 || !['capability', 'connection-adapter', 'connection-type'].includes(registration.kind) || !['definition', 'provider'].includes(registration.role)) { this.invalid = true; this.generation++; return }
    const id = key(registration, registration.role)
    const previous = this.observations.get(id)
    if (!active) {
      if (previous?.token === registration.token && previous.active) { previous.active = false; previous.generation = ++this.generation }
      return
    }
    const entryId = owningEntry(registration.owner.fiber)
    const name = entryId ? source(entryId) : undefined
    this.observations.delete(id)
    this.observations.set(id, { ref: { kind: registration.kind, id: registration.id, version: registration.version }, token: registration.token, active, generation: ++this.generation, observedAt: new Date().toISOString(),
      ...(entryId ? { entryId } : {}), ...(name ? { source: name } : {}),
    })
    // Eviction means unknown, never attribution to an unrelated or older instance.
    if (this.observations.size > 4096) { this.observations.delete(this.observations.keys().next().value!); this.evicted = true }
  }

  /** Internal freshness evidence: include both roles of every scoped reference. */
  freshness(entryIds: ReadonlySet<string>): unknown {
    const scoped = new Set([...this.observations.values()].filter(item => item.entryId && entryIds.has(item.entryId)).map(item => JSON.stringify(item.ref)))
    return {
      observations: [...this.observations.entries()].filter(([, item]) => scoped.has(JSON.stringify(item.ref)))
        .map(([key, item]) => ({ key, generation: item.generation, active: item.active, entryId: item.entryId, source: item.source }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      // Once bounded history was lost, any new observation might belong to the
      // omitted scope. Require a fresh preview after such a change.
      incompleteGeneration: this.evicted || this.invalid ? this.generation : undefined,
    }
  }

  /** Reverse lookup uses observed owner identities, never registration names. */
  inspect(entryIds: ReadonlySet<string>, snapshot: HostConfigSnapshot, limit = 256): {
    diagnoses: HostRegistrationDiagnosis[]; scanned: number; limit: number; truncated: boolean; evicted: boolean; invalid?: boolean
  } {
    const refs = new Map<string, HostRegistrationRef>()
    let truncated = false
    for (const observation of this.observations.values()) {
      if (!observation.entryId || !entryIds.has(observation.entryId)) continue
      const id = JSON.stringify([observation.ref.kind, observation.ref.id, observation.ref.version])
      if (refs.has(id)) continue
      if (refs.size >= limit) { truncated = true; continue }
      refs.set(id, observation.ref)
    }
    return { diagnoses: this.diagnose([...refs.values()], snapshot), scanned: refs.size, limit, truncated, evicted: this.evicted, ...(this.invalid ? { invalid: true } : {}) }
  }

  diagnose(refs: HostRegistrationRef[], snapshot: HostConfigSnapshot): HostRegistrationDiagnosis[] {
    const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]))
    const brief = (entry: HostConfigSnapshot['entries'][number]) => ({ id: entry.id, actualState: entry.actualState,
      selfEnabled: entry.selfEnabled, effectiveEnabled: entry.effectiveEnabled, ...(entry.label ? { label: entry.label } : {}),
    })
    return refs.map(ref => ({ ...ref, owners: (ref.kind === 'connection-type' ? ['definition'] as const : ['definition', 'provider'] as const).map((role): HostRegistrationOwner => {
      const observation = this.observations.get(key(ref, role))
      const entry = observation?.entryId ? entries.get(observation.entryId) : undefined
      const reason = snapshot.restartRequired ? 'configuration-changed'
        : !observation ? 'not-observed' : !observation.entryId ? 'unmanaged'
          : !entry ? 'entry-removed' : observation.source !== entry.name ? 'entry-replaced' : undefined
      if (reason || !entry || !observation) return { role, evidence: 'unknown', reason: reason ?? 'not-observed', ancestors: [] }
      const ancestors: HostRegistrationOwner['ancestors'] = []
      let parent = entry.parentId
      while (parent && ancestors.length < entries.size) {
        const ancestor = entries.get(parent)
        if (!ancestor) break
        ancestors.unshift(brief(ancestor)); parent = ancestor.parentId
      }
      return { role, evidence: observation.active ? 'current' : 'previous', observedAt: observation.observedAt, entry: brief(entry), ancestors }
    }) }))
  }
}
