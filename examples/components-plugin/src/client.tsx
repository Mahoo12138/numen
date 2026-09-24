import type { Context } from 'cordis'
import type {} from '@numenjs/webui'
import { defineComponent, ref, shallowRef } from 'vue'
import { Button, FormSection, SelectMenu, StringLiteralEditor, JsonLiteralEditor, type SchemaValue } from '@numenjs/components'
import '@numenjs/components/style.css'

export const ComponentsPage = defineComponent({
  name: 'ComponentsExamplePage',
  setup() {
    const mode = ref('fast')
    const message = shallowRef<SchemaValue>('')
    const data = shallowRef<SchemaValue>({ enabled: true })
    const invalid = ref(false)
    const commits = ref(0)
    return () => <main class="main-workbench secondary-view">
      <h1>Shared components</h1>
      <FormSection title="Plugin settings">
        <SelectMenu ariaLabel="Execution mode" value={mode.value}
          options={[{ value: 'fast', label: 'Fast' }, { value: 'careful', label: 'Careful' }]}
          onChange={value => { mode.value = value }} />
        <label for="example-message">Message</label>
        <StringLiteralEditor canEdit controlId="example" inputId="example-message" invalid={false}
          field={{ name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true }}
          value={message.value} onCommit={value => { message.value = value ?? '' }} />
        <label for="example-data">JSON data</label>
        <JsonLiteralEditor canEdit controlId="example" inputId="example-data" invalid={invalid.value}
          field={{ name: 'data', label: 'JSON data', type: 'json', schemaType: 'object', required: true }}
          value={data.value} onValidationChange={value => { invalid.value = value }}
          onCommit={value => { data.value = value ?? null }} />
        <Button variant="primary" disabled={invalid.value} onClick={() => { commits.value++ }}>Apply settings</Button>
        <output aria-label="Current settings">{JSON.stringify({ mode: mode.value, message: message.value, data: data.value, commits: commits.value })}</output>
      </FormSection>
    </main>
  },
})

export default function componentsFrontend(ctx: Context): void {
  ctx.webuiExtensions.page(ctx, {
    id: 'example:components', version: 1, path: '/plugins/components', title: 'Shared components', component: ComponentsPage,
  })
}
componentsFrontend.inject = ['webuiExtensions']
