import { defineComponent } from 'vue'

export const FormSection = defineComponent({
  name: 'NumenFormSection',
  props: {
    title: { type: String, required: true },
    open: { type: Boolean, default: true },
  },
  setup(props, { slots }) {
    return () => <details class="n-form-section" open={props.open}>
      <summary>{props.title}</summary><div>{slots.default?.()}</div>
    </details>
  },
})
