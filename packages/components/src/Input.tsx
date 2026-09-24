import type { FunctionalComponent, InputHTMLAttributes, TextareaHTMLAttributes, Ref } from 'vue'

export interface InputProps extends InputHTMLAttributes {
  /** Native element access for focus and selection without reaching into the component instance. */
  inputRef?: Ref<HTMLInputElement | undefined>
}
export interface TextareaProps extends TextareaHTMLAttributes {
  inputRef?: Ref<HTMLTextAreaElement | undefined>
}

/** Native input semantics and events with shared tokens; callers own validation and drafts. */
export const Input: FunctionalComponent<InputProps> = ({ inputRef, ...attrs }) =>
  <input {...attrs} class={['n-input', attrs.class]} ref={inputRef} />
Input.inheritAttrs = false

export const Textarea: FunctionalComponent<TextareaProps> = ({ inputRef, ...attrs }) =>
  <textarea {...attrs} class={['n-input', attrs.class]} ref={inputRef} />
Textarea.inheritAttrs = false
