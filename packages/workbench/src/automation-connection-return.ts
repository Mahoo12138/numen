import type { AutomationSource, CapabilityRef } from '@numenjs/core'
import type { WorkbenchAutomationConnectionOption, WorkbenchAutomationConnectionSlot, WorkbenchAutomationInsertCatalog, WorkbenchConnectionAdapter } from './contracts.js'
import { findAutomationNode } from './graph-source-editing.js'

export interface AutomationConnectionReturn {
  automationId: string
  nodeId: string
  slotName: string
  capability: CapabilityRef
  originalBinding: string | undefined
}
const sameCapability = (a: CapabilityRef, b: CapabilityRef) => a.id === b.id && a.version === b.version
export function compatibleConnectionType(slot: WorkbenchAutomationConnectionSlot, connection: { typeId: string; typeVersion: number }): boolean {
  return !slot.accepts.length || slot.accepts.includes(connection.typeId) || slot.accepts.includes(`${connection.typeId}@${connection.typeVersion}`)
}
function target(source: AutomationSource, catalog: WorkbenchAutomationInsertCatalog, nodeId: string, slotName: string) {
  const found = findAutomationNode(source, nodeId), node = found?.type === 'capability' ? found : source.triggers.find(item => item.id === nodeId)
  if (!node) return
  const definition = catalog.items.find(item => (item.kind === 'capability' || item.kind === 'trigger') && sameCapability(item.capability, node.capability))
  if (!definition || !('connectionRequirements' in definition)) return
  const slot = definition.connectionRequirements.find(item => item.name === slotName)
  if (!slot) return
  const binding = node.connections?.[slotName] ?? (definition.connectionRequirements[0]?.name === slotName ? node.connection : undefined)
  return { node, slot, binding }
}
export function captureConnectionReturn(automationId: string, source: AutomationSource, catalog: WorkbenchAutomationInsertCatalog, nodeId: string, slotName: string): AutomationConnectionReturn | undefined {
  const current = target(source, catalog, nodeId, slotName)
  if (!current) return
  return { automationId, nodeId, slotName, capability: { ...current.node.capability }, originalBinding: current.binding }
}
export function connectionReturnError(ticket: AutomationConnectionReturn, automationId: string, source: AutomationSource, catalog: WorkbenchAutomationInsertCatalog, connection: WorkbenchAutomationConnectionOption | undefined): 'targetChanged' | 'incompatible' | undefined {
  const current = target(source, catalog, ticket.nodeId, ticket.slotName)
  if (ticket.automationId !== automationId || !current || !sameCapability(current.node.capability, ticket.capability) || current.binding !== ticket.originalBinding) return 'targetChanged'
  if (!connection || !compatibleConnectionType(current.slot, connection)) return 'incompatible'
}
export function connectionReturnAdapters(ticket: AutomationConnectionReturn, source: AutomationSource, catalog: WorkbenchAutomationInsertCatalog, adapters: WorkbenchConnectionAdapter[]): WorkbenchConnectionAdapter[] {
  const current = target(source, catalog, ticket.nodeId, ticket.slotName)
  return current ? adapters.filter(adapter => compatibleConnectionType(current.slot, adapter)) : []
}
