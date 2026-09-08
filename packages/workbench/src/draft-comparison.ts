import type { AutomationDraftDocument } from './useAutomationDraftDocument.js'
import type { WorkbenchAutomationDraft } from './contracts.js'

export interface DraftDifference {
  path: string
  local: string
  server: string
}

/** Bounded, read-only JSON comparison. Paths are JSON Pointers; array order remains significant. */
export function compareAutomationDrafts(
  local: Pick<AutomationDraftDocument, 'source' | 'presentation'>,
  server: Pick<WorkbenchAutomationDraft, 'source' | 'presentation'>,
): { differences: DraftDifference[]; truncated: boolean } {
  const differences: DraftDifference[] = []
  let truncated = false
  let visited = 0
  const display = (value: unknown) => {
    const text = value === undefined ? '(not present)' : JSON.stringify(value, null, 2)
    return text.length > 2000 ? `${text.slice(0, 2000)}\n… (value shortened)` : text
  }
  const visit = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (Object.is(a, b)) return
    if (++visited > 20_000 || differences.length >= 100) { truncated = true; return }
    if (depth < 64 && a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      for (const key of keys) {
        visit(Object.hasOwn(a, key) ? (a as Record<string, unknown>)[key] : undefined,
          Object.hasOwn(b, key) ? (b as Record<string, unknown>)[key] : undefined,
          `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1)
        if (truncated) break
      }
      return
    }
    differences.push({ path, local: display(a), server: display(b) })
  }
  visit({ source: local.source, presentation: local.presentation }, { source: server.source, presentation: server.presentation }, '', 0)
  return { differences, truncated }
}
