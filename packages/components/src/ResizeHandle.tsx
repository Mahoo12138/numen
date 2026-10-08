import { onScopeDispose, ref, Teleport, watch, type HTMLAttributes } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface ResizeHandleProps extends Omit<HTMLAttributes, 'onChange'> {
  ariaLabel: string
  /** Axis of movement, not the separator's visual orientation. */
  axis: 'x' | 'y'
  value: number
  min: number
  max: number
  /** Use -1 for a panel on the right/bottom of the handle. */
  direction?: 1 | -1
  disabled?: boolean
  step?: number
  collapsed?: boolean
  collapsedSize?: number
  /** Distance below the expanded minimum before pointer dragging collapses the panel. */
  collapseOffset?: number
  onCollapsedChange?(collapsed: boolean): void
  onChange(value: number): void
  onCommit?(value: number): void
  onCancel?(): void
  onReset?(): void
}

/** Controlled splitter: pointer capture, cancellation, keyboard access and iframe-safe dragging. */
export const ResizeHandle = defineSetupComponent<ResizeHandleProps>('NumenResizeHandle', [
  'ariaLabel', 'axis', 'value', 'min', 'max', 'direction', 'disabled', 'step',
  'collapsed', 'collapsedSize', 'collapseOffset', 'onCollapsedChange', 'onChange', 'onCommit', 'onCancel', 'onReset',
], (props, { attrs }) => {
  const dragging = ref(false)
  let session: {
    element: HTMLElement; pointer: number; origin: number; initial: number; initialDisplayedSize: number
    initialCollapsed: boolean; collapsed: boolean; collapsible: boolean; current: number
    expandedMin: number; expandedMax: number; collapseThreshold: number; collapsedSize: number
  } | undefined
  const collapsible = () => Boolean(props.onCollapsedChange)
  const clamp = (value: number, min = props.min, max = props.max) => Math.round(Math.min(Math.max(min, max), Math.max(min, value)))
  const coordinate = (event: PointerEvent) => props.axis === 'x' ? event.clientX : event.clientY
  const finish = (cancel = false) => {
    const current = session
    if (!current) return
    session = undefined
    dragging.value = false
    window.removeEventListener('blur', cancelDrag)
    window.removeEventListener('keydown', escapeDrag, true)
    if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer)
    if (cancel) {
      if (current.collapsible && current.collapsed !== current.initialCollapsed) props.onCollapsedChange?.(current.initialCollapsed)
      if (!current.initialCollapsed) props.onChange(current.initial)
      props.onCancel?.()
    } else props.onCommit?.(current.collapsible && current.collapsed ? current.collapsedSize : clamp(current.current, current.collapsible ? current.expandedMin : props.min, current.collapsible ? current.expandedMax : props.max))
  }
  const cancelDrag = () => finish(true)
  const escapeDrag = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) }
  }
  watch(() => props.disabled, disabled => { if (disabled) cancelDrag() })
  onScopeDispose(cancelDrag)
  const move = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointer) return
    const current = session
    current.current = current.initialDisplayedSize + (coordinate(event) - current.origin) * (props.direction ?? 1)
    if (current.collapsible) {
      const collapsed = current.current <= (current.initialCollapsed ? Math.max(current.collapseThreshold, current.collapsedSize) : current.collapseThreshold)
      if (collapsed !== current.collapsed) {
        current.collapsed = collapsed
        props.onCollapsedChange?.(collapsed)
      }
      if (collapsed) return
    }
    props.onChange(clamp(current.current, current.collapsible ? current.expandedMin : props.min, current.collapsible ? current.expandedMax : props.max))
  }
  return () => <>
    <div {...attrs} class={['n-resize-handle', attrs.class]} role="separator" tabindex={props.disabled ? -1 : 0}
      aria-label={props.ariaLabel} aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={collapsible() ? props.collapsedSize ?? 0 : props.min} aria-valuemax={Math.max(props.min, props.max)} aria-valuenow={props.value}
      aria-valuetext={`${Math.round(props.value)} px`} aria-disabled={props.disabled || undefined}
      data-axis={props.axis} data-dragging={dragging.value} data-collapsed={props.collapsed ?? false}
      onPointerdown={(event: PointerEvent) => {
        if (props.disabled || session || event.button !== 0 || !event.isPrimary) return
        const element = event.currentTarget as HTMLElement
        event.preventDefault()
        element.focus({ preventScroll: true })
        element.setPointerCapture(event.pointerId)
        const canCollapse = collapsible()
        const collapsedSize = props.collapsedSize ?? 0
        const initialCollapsed = canCollapse && Boolean(props.collapsed)
        const initialDisplayedSize = initialCollapsed ? collapsedSize : props.value
        session = {
          element, pointer: event.pointerId, origin: coordinate(event), initial: props.value, initialDisplayedSize,
          initialCollapsed, collapsed: initialCollapsed, collapsible: canCollapse, current: initialDisplayedSize,
          expandedMin: props.min, expandedMax: props.max, collapseThreshold: props.min - (props.collapseOffset ?? 24), collapsedSize,
        }
        dragging.value = true
        window.addEventListener('blur', cancelDrag)
        window.addEventListener('keydown', escapeDrag, true)
      }}
      onPointermove={move}
      onPointerup={(event: PointerEvent) => { if (session?.pointer === event.pointerId) { move(event); finish() } }}
      onPointercancel={(event: PointerEvent) => { if (session?.pointer === event.pointerId) cancelDrag() }}
      onLostpointercapture={(event: PointerEvent) => { if (session?.pointer === event.pointerId) cancelDrag() }}
      onDblclick={() => { if (!props.disabled) props.onReset?.() }}
      onKeydown={(event: KeyboardEvent) => {
        if (props.disabled || session) return
        if (event.key === 'Enter' && props.onReset) { event.preventDefault(); props.onReset(); return }
        let next: number
        const negative = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
        const positive = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown'
        if (event.key === 'Home') next = props.min
        else if (event.key === 'End') next = props.max
        else if (event.key === negative || event.key === positive) {
          next = props.value + (event.key === negative ? -1 : 1) * (props.direction ?? 1) * (props.step ?? 8) * (event.shiftKey ? 5 : 1)
        } else return
        event.preventDefault()
        if (collapsible() && props.collapsed && (event.key === negative || event.key === positive) && next <= (props.collapsedSize ?? 0)) return
        const value = clamp(next)
        if (collapsible() && props.collapsed) props.onCollapsedChange?.(false)
        props.onChange(value)
        props.onCommit?.(value)
      }} />
    {dragging.value ? <Teleport to="body"><div class="n-resize-shield" data-axis={props.axis} aria-hidden="true" /></Teleport> : null}
  </>
})
