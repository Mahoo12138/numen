import { getCurrentInstance, inject, provide, type InjectionKey } from 'vue'

export const defaultComponentMessages = {
  'false': "False",
  'notSet': "Not set",
  'optional': "Optional",
  'optionalJsonValue': "Optional JSON value",
  'optionalNumber': "Optional number",
  'required': "Required",
  'requiredJsonValue': "Required JSON value",
  'requiredNumber': "Required number",
  'seconds': "seconds",
  'select': "Select…",
  'true': "True",
  'validation.json': "Enter valid JSON.",
  'waitDurationInSeconds': "Wait duration in seconds",
  'waitUntilDateAndTime': "Wait until date and time",
} as const
export type ComponentMessageKey = keyof typeof defaultComponentMessages
export type ComponentTranslator = (key: ComponentMessageKey) => string
const translatorKey = Symbol.for('numen.components.translator') as InjectionKey<ComponentTranslator>

/** Call in setup. The translator may read reactive locale state; each Vue tree is isolated. */
export function provideComponentI18n(translate: ComponentTranslator): void {
  provide(translatorKey, translate)
}

export function componentText(key: ComponentMessageKey): string {
  const translate = getCurrentInstance() ? inject(translatorKey, undefined) : undefined
  return translate?.(key) ?? defaultComponentMessages[key]
}
