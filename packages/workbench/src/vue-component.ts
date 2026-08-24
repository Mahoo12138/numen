import {
  defineComponent,
  type DefineComponent,
  type SetupContext,
  type VNodeChild,
} from 'vue'

/**
 * Defines a Vue setup component whose public interface is a plain props object.
 *
 * Workbench Pages and Chrome are registered dynamically. Each adapter declares
 * only its prop names here; TypeScript remains the single source for value types,
 * while Vue receives the names it needs to keep every prop reactive at runtime.
 */
export function defineSetupComponent<Props extends object>(
  name: string,
  propNames: ReadonlyArray<Extract<keyof Props, string>>,
  setup: (props: Readonly<Props>, context: SetupContext) => () => VNodeChild,
): DefineComponent<Props> {
  return defineComponent({
    name,
    inheritAttrs: false,
    props: [...propNames],
    setup(props, context) {
      return setup(props as Readonly<Props>, context)
    },
  }) as unknown as DefineComponent<Props>
}
