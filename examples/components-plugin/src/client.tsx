import type { Context } from 'cordis'
import type {} from '@numenjs/webui'
import { defineComponent, ref, shallowRef } from 'vue'
import { Button, FormSection, SelectMenu, StringLiteralEditor, JsonLiteralEditor, BooleanLiteralEditor, EnumLiteralEditor, type SchemaValue } from '@numenjs/components'
import '@numenjs/components/style.css'

export const ComponentsPage = defineComponent({
  name: 'ComponentsExamplePage',
  setup() {
    const mode = ref('fast')
    const message = shallowRef<SchemaValue>('')
    const data = shallowRef<SchemaValue>({ enabled: true })
    const enabled = shallowRef<SchemaValue>()
    const attempts = shallowRef<SchemaValue | undefined>(1)
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
        <BooleanLiteralEditor canEdit controlId="example" inputId="example-enabled" invalid={false}
          field={{ name: 'enabled', label: 'Enabled', type: 'boolean', schemaType: 'boolean', required: true }}
          {...(enabled.value !== undefined ? { value: enabled.value } : {})} onCommit={value => { enabled.value = value }} />
        <EnumLiteralEditor canEdit controlId="example" inputId="example-attempts" invalid={false}
          field={{ name: 'attempts', label: 'Attempts', type: 'enum', schemaType: 'number', required: true,
            options: [{ label: 'Once', value: 1 }, { label: 'Three times', value: 3 }] }}
          {...(attempts.value !== undefined ? { value: attempts.value } : {})} onCommit={value => { attempts.value = value }} />
        <Button variant="primary" disabled={invalid.value} onClick={() => { commits.value++ }}>Apply settings</Button>
        <output aria-label="Current settings">{JSON.stringify({ mode: mode.value, message: message.value, data: data.value, enabled: enabled.value, attempts: attempts.value, commits: commits.value })}</output>
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
