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
  onChange(value: number): void
  onCommit?(value: number): void
  onCancel?(): void
  onReset?(): void
}

/** Controlled splitter: pointer capture, cancellation, keyboard access and iframe-safe dragging. */
export const ResizeHandle = defineSetupComponent<ResizeHandleProps>('NumenResizeHandle', [
  'ariaLabel', 'axis', 'value', 'min', 'max', 'direction', 'disabled', 'step', 'onChange', 'onCommit', 'onCancel', 'onReset',
], (props, { attrs }) => {
  const dragging = ref(false)
  let session: { element: HTMLElement; pointer: number; origin: number; initial: number; current: number } | undefined
  const clamp = (value: number) => Math.round(Math.min(Math.max(props.min, props.max), Math.max(props.min, value)))
  const coordinate = (event: PointerEvent) => props.axis === 'x' ? event.clientX : event.clientY
  const finish = (cancel = false) => {
    const current = session
    if (!current) return
    session = undefined
    dragging.value = false
    window.removeEventListener('blur', cancelDrag)
    window.removeEventListener('keydown', escapeDrag, true)
    if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer)
    if (cancel) { props.onChange(current.initial); props.onCancel?.() }
    else props.onCommit?.(clamp(current.current))
  }
  const cancelDrag = () => finish(true)
  const escapeDrag = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) }
  }
  watch(() => props.disabled, disabled => { if (disabled) cancelDrag() })
  onScopeDispose(cancelDrag)
  const move = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointer) return
    session.current = clamp(session.initial + (coordinate(event) - session.origin) * (props.direction ?? 1))
    props.onChange(session.current)
  }
  return () => <>
    <div {...attrs} class={['n-resize-handle', attrs.class]} role="separator" tabindex={props.disabled ? -1 : 0}
      aria-label={props.ariaLabel} aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={props.min} aria-valuemax={Math.max(props.min, props.max)} aria-valuenow={props.value}
      aria-valuetext={`${Math.round(props.value)} px`} aria-disabled={props.disabled || undefined}
      data-axis={props.axis} data-dragging={dragging.value}
      onPointerdown={(event: PointerEvent) => {
        if (props.disabled || session || event.button !== 0 || !event.isPrimary) return
        const element = event.currentTarget as HTMLElement
        event.preventDefault()
        element.focus({ preventScroll: true })
        element.setPointerCapture(event.pointerId)
        session = { element, pointer: event.pointerId, origin: coordinate(event), initial: props.value, current: props.value }
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
        const value = clamp(next)
        props.onChange(value)
        props.onCommit?.(value)
      }} />
    {dragging.value ? <Teleport to="body"><div class="n-resize-shield" data-axis={props.axis} aria-hidden="true" /></Teleport> : null}
  </>
})
