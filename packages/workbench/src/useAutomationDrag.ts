import type { AutomationSource } from '@numenjs/core'
import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from 'vue'
import { resolveAutomationDropTarget, validateAutomationDrop, type AutomationDropPlacement } from './automation-drag.js'
import { automationStepEditOptions, type AutomationInsertTarget, type AutomationSourceCommand } from './automation-source-editing.js'

interface DropIntent {
  nodeId: string
  placement: AutomationDropPlacement
  target?: AutomationInsertTarget
  allowed: boolean
}

/** Native drag owns transient intent only. One fenced MOVE_TO owns the document edit. */
export function useAutomationDrag(options: {
  host: Ref<HTMLElement | undefined>
  source(): AutomationSource
  canEdit(): boolean
  commit(command: AutomationSourceCommand, source: AutomationSource): boolean
}) {
  const session = shallowRef<{ nodeId: string; source: AutomationSource }>()
  const intent = shallowRef<DropIntent>()
  let frame: number | undefined
  let pointer: { x: number; y: number } | undefined
  let lastTime: number | undefined

  const cancel = () => {
    session.value = undefined
    intent.value = undefined
    pointer = undefined
    lastTime = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const current = () => {
    const drag = session.value
    if (!drag || !options.canEdit() || options.source() !== drag.source) { cancel(); return undefined }
    return drag
  }
  watch(() => [options.source(), options.canEdit()] as const, () => {
    if (session.value) current()
  }, { flush: 'sync' })

  const scroll = (time: number) => {
    if (!current()) return
    const canvas = options.host.value?.closest<HTMLElement>('.automation-canvas')
    const elapsed = Math.min(lastTime === undefined ? 16 : time - lastTime, 32)
    lastTime = time
    if (canvas && pointer) {
      const rect = canvas.getBoundingClientRect()
      if (pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom) {
        const edge = Math.min(56, rect.height / 4)
        const speed = pointer.y < rect.top + edge ? -(rect.top + edge - pointer.y) / edge
          : pointer.y > rect.bottom - edge ? (pointer.y - rect.bottom + edge) / edge : 0
        canvas.scrollTop += speed * elapsed * .65
      }
    }
    frame = requestAnimationFrame(scroll)
  }
  const track = (event: DragEvent) => {
    if (!session.value) return
    pointer = { x: event.clientX, y: event.clientY }
    const zone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drop-node-id]') : null
    if (!zone || !options.host.value?.contains(zone)) intent.value = undefined
  }
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
  const leaveWindow = (event: DragEvent) => { if (!event.relatedTarget) { pointer = undefined; intent.value = undefined } }
  onMounted(() => {
    document.addEventListener('dragover', track, true)
    document.addEventListener('dragleave', leaveWindow)
    document.addEventListener('keydown', escape, true)
    document.addEventListener('dragend', cancel)
    document.addEventListener('drop', cancel)
    window.addEventListener('blur', cancel)
  })
  onBeforeUnmount(() => {
    cancel()
    document.removeEventListener('dragover', track, true)
    document.removeEventListener('dragleave', leaveWindow)
    document.removeEventListener('keydown', escape, true)
    document.removeEventListener('dragend', cancel)
    document.removeEventListener('drop', cancel)
    window.removeEventListener('blur', cancel)
  })

  return {
    session, intent, cancel,
    start(event: DragEvent, nodeId: string) {
      cancel()
      const source = options.source()
      if (!options.canEdit() || !event.dataTransfer || !automationStepEditOptions(source, nodeId).canMoveTo) {
        event.preventDefault()
        return
      }
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-numen-node', nodeId)
      const header = (event.currentTarget as HTMLElement).closest<HTMLElement>('.structured-node-header')
      if (header) event.dataTransfer.setDragImage(header, 18, 18)
      session.value = { nodeId, source }
      frame = requestAnimationFrame(scroll)
    },
    over(event: DragEvent, nodeId: string, placement: AutomationDropPlacement) {
      const drag = current()
      if (!drag) return
      event.stopPropagation()
      const result = resolveAutomationDropTarget(drag.source, drag.nodeId, nodeId, placement)
      intent.value = { nodeId, placement, allowed: result.allowed, ...(result.allowed ? { target: result.target } : {}) }
      if (event.dataTransfer) event.dataTransfer.dropEffect = result.allowed ? 'move' : 'none'
      if (result.allowed) event.preventDefault()
    },
    drop(event: DragEvent, nodeId: string, placement: AutomationDropPlacement) {
      const drag = current()
      const destination = intent.value
      // A drop cannot create a new target or silently substitute a surviving container.
      if (!drag || !destination?.allowed || !destination.target || destination.nodeId !== nodeId || destination.placement !== placement) {
        cancel()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const result = validateAutomationDrop(options.source(), drag.nodeId, destination.target)
      cancel()
      if (result.allowed && !result.noOp) options.commit({ type: 'MOVE_TO', nodeId: drag.nodeId, target: destination.target }, drag.source)
    },
  }
}
