import type { ButtonHTMLAttributes } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface ButtonProps extends Omit<ButtonHTMLAttributes, 'disabled' | 'onClick'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'default' | 'icon'
  disabled?: boolean | undefined
  busy?: boolean
  onClick?: (event: MouseEvent) => void
}

export const Button = defineSetupComponent<ButtonProps>('NumenButton', [
  'variant', 'size', 'type', 'disabled', 'busy', 'onClick',
], (props, { slots, attrs }) => () => <button {...attrs} class={['n-button', attrs.class]}
  data-variant={props.variant ?? 'secondary'} data-size={props.size ?? 'default'} type={props.type ?? 'button'}
  onClick={event => { if (!props.disabled && !props.busy) props.onClick?.(event) }}
  disabled={props.disabled || props.busy} aria-busy={!!props.busy}>{slots.default?.()}</button>)
