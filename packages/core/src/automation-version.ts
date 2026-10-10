/** Source and IR evolve together for the graph protocol; do not guess how future pairs execute. */
export function isSupportedAutomationVersion(protocolVersion: number, irVersion: number): boolean {
  return (protocolVersion === 1 && irVersion === 1) || (protocolVersion === 2 && irVersion === 2)
}
