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
  token: symbol
  active: boolean
  observedAt: string
  entryId?: string
  source?: string
}
const key = (ref: HostRegistrationRef, role: string) => JSON.stringify([ref.kind, ref.id, ref.version, role])

/** Bounded process-local evidence. Never retain a disposed Context/Fiber or infer an owner from names. */
export class RegistrationOwnership {
  private readonly observations = new Map<string, Observation>()

  observe(registration: RuntimeRegistration, active: boolean, source: (id: string) => string | undefined): void {
    const id = key(registration, registration.role)
    const previous = this.observations.get(id)
    if (!active) {
      if (previous?.token === registration.token) previous.active = false
      return
    }
    const entryId = owningEntry(registration.owner.fiber)
    const name = entryId ? source(entryId) : undefined
    this.observations.delete(id)
    this.observations.set(id, { token: registration.token, active, observedAt: new Date().toISOString(),
      ...(entryId ? { entryId } : {}), ...(name ? { source: name } : {}),
    })
    // Eviction means unknown, never attribution to an unrelated or older instance.
    if (this.observations.size > 4096) this.observations.delete(this.observations.keys().next().value!)
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
