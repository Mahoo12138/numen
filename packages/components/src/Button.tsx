import { defineComponent, type PropType } from 'vue'

export const Button = defineComponent({
  name: 'NumenButton',
  props: {
    variant: { type: String as PropType<'primary' | 'secondary' | 'danger' | 'ghost'>, default: 'secondary' },
    type: { type: String as PropType<'button' | 'submit' | 'reset'>, default: 'button' },
    disabled: Boolean,
    busy: Boolean,
    onClick: Function as PropType<(event: MouseEvent) => void>,
  },
  setup(props, { slots }) {
    return () => <button class="n-button" data-variant={props.variant} type={props.type}
      onClick={event => { if (!props.disabled && !props.busy) props.onClick?.(event) }} disabled={props.disabled || props.busy} aria-busy={props.busy}>{slots.default?.()}</button>
  },
})
