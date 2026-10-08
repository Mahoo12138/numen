import type { AutomationSource } from '@numenjs/core'
import {
  applyAutomationSourceCommand,
  automationRelativeInsertTarget,
  findAutomationControl,
  type AutomationInsertTarget,
  type AutomationSourceCommandError,
} from './automation-source-editing.js'

export type AutomationDropPlacement = 'before' | 'after' | 'inside'

export type AutomationDropValidation =
  | { allowed: true; noOp: boolean }
  | { allowed: false; error: AutomationSourceCommandError }

export type AutomationDropResolution =
  | { allowed: true; target: AutomationInsertTarget; noOp: boolean }
  | { allowed: false; error: AutomationSourceCommandError }

/**
 * Check against the current document immediately before dispatching MOVE_TO.
 * The existing pure command owns structural rules; its candidate Source is
 * deliberately discarded so hovering never edits the document or its history.
 */
export function validateAutomationDrop(
  source: AutomationSource,
  nodeId: string,
  target: AutomationInsertTarget,
): AutomationDropValidation {
  const result = applyAutomationSourceCommand(source, { type: 'MOVE_TO', nodeId, target })
  return result.error ? { allowed: false, error: result.error } : { allowed: true, noOp: result.source === source }
}

/** Resolve a visible landing position to one explicit, validated command target. */
export function resolveAutomationDropTarget(
  source: AutomationSource,
  nodeId: string,
  targetNodeId: string,
  placement: AutomationDropPlacement,
): AutomationDropResolution {
  let target: AutomationInsertTarget | undefined
  if (placement === 'inside') {
    const container = findAutomationControl(source, targetNodeId)
    if (container?.type === 'block') target = { kind: 'block', blockId: container.id }
  } else if (placement === 'before' || placement === 'after') {
    target = automationRelativeInsertTarget(source, targetNodeId, placement)
  }
  if (!target) return {
    allowed: false,
    error: {
      code: 'TARGET_INVALID',
      message: placement === 'inside'
        ? 'Choose an existing block as the inside drop target.'
        : 'The drop position no longer exists or is a required structural slot.',
    },
  }
  const validation = validateAutomationDrop(source, nodeId, target)
  return validation.allowed ? { ...validation, target } : validation
}
