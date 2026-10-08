import type { AutomationSource, CapabilityRef, ControlSource } from '@numenjs/core'
import type { AutomationStep } from './model.js'

export interface AutomationNodeSearchResult {
  step: AutomationStep
  /** Stable Source identity; step.id retains the Canvas projection identity. */
  id: string
  label: string
  capability?: string
}

const normalize = (text: string): string => text.normalize('NFC').toLowerCase()
const capabilityText = (ref: CapabilityRef): string | undefined => typeof ref.id === 'string' && Number.isSafeInteger(ref.version) && ref.version > 0 ? `${ref.id}@${ref.version}` : undefined

/** Search only display labels, Source IDs and explicit capability references. */
export function searchAutomationNodes(source: AutomationSource, steps: readonly AutomationStep[], query: string): AutomationNodeSearchResult[] {
  const identities = new Map<string, { capability?: string }>()
  const ambiguous = new Set<string>()
  const add = (id: string, capability?: string) => {
    if (identities.has(id)) { ambiguous.add(id); return }
    identities.set(id, capability === undefined ? {} : { capability })
  }
  for (const trigger of source.triggers) add(trigger.id, capabilityText(trigger.capability))
  const pending: ControlSource[] = [source.flow]
  const visited = new Set<ControlSource>()
  while (pending.length) {
    const node = pending.pop()!
    if (visited.has(node)) { ambiguous.add(node.id); continue }
    visited.add(node)
    add(node.id, node.type === 'capability' ? capabilityText(node.capability) : undefined)
    switch (node.type) {
      case 'block': for (const child of node.steps) pending.push(child); break
      case 'if': pending.push(node.then); if (node.else) pending.push(node.else); break
      case 'parallel': case 'race': for (const branch of node.branches) pending.push(branch); break
      case 'foreach': pending.push(node.body); break
      // Extension inputs and unknown future fields are opaque; never inspect them.
    }
  }
  const words = normalize(query.trim()).split(/\s+/u).filter(Boolean)
  const results: AutomationNodeSearchResult[] = []
  const listed = new Set<string>()
  for (const step of steps) {
    const id = step.sourceId
    if (!id || ambiguous.has(id) || listed.has(id)) continue
    const node = identities.get(id)
    if (!node) continue
    const fields = [step.label, id, ...(node.capability ? [node.capability] : [])].map(normalize)
    if (!words.every(word => fields.some(field => field.includes(word)))) continue
    listed.add(id)
    results.push({ step, id, label: step.label, ...node })
  }
  return results
}
