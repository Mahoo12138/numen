import type { InputHTMLAttributes, TextareaHTMLAttributes, Ref } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface InputProps extends InputHTMLAttributes {
  /** Native element access for focus and selection without reaching into the component instance. */
  inputRef?: Ref<HTMLInputElement | undefined>
}
export interface TextareaProps extends TextareaHTMLAttributes {
  inputRef?: Ref<HTMLTextAreaElement | undefined>
}

/** Native input semantics and events with shared tokens; callers own validation and drafts. */
export const Input = defineSetupComponent<InputProps>('NumenInput', ['inputRef'], (props, { attrs }) =>
  () => <input {...attrs} class={['n-input', attrs.class]} ref={props.inputRef} />)

export const Textarea = defineSetupComponent<TextareaProps>('NumenTextarea', ['inputRef'], (props, { attrs }) =>
  () => <textarea {...attrs} class={['n-input', attrs.class]} ref={props.inputRef} />)
