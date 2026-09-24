import { defineComponent, type PropType } from 'vue'
import { Button } from './Button.js'

export const StatePanel = defineComponent({
  name: 'NumenStatePanel',
  props: {
    title: { type: String, required: true },
    message: { type: String, required: true },
    busy: Boolean,
    tone: { type: String as PropType<'default' | 'error'>, default: 'default' },
    action: String,
    onAction: Function as PropType<() => void>,
  },
  setup(props) {
    return () => <section class="n-state-panel" aria-busy={props.busy} data-tone={props.tone}
      role={props.tone === 'error' ? 'alert' : 'status'}>
      <strong>{props.title}</strong><p>{props.message}</p>
      {props.action ? <Button disabled={props.busy} onClick={() => props.onAction?.()}>{props.action}</Button> : null}
    </section>
  },
})
