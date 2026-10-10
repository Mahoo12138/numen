import { Button, Input } from '@numenjs/components'
import { ref } from 'vue'
import { defineSetupComponent } from './vue-component.js'
import { t } from './i18n.js'

interface Props { onLocate(id?: string): void }
export const SourceNodeLocator = defineSetupComponent<Props>('SourceNodeLocator', ['onLocate'], props => {
  const value = ref('')
  return () => <form class="source-node-locator" onSubmit={event => { event.preventDefault(); props.onLocate(value.value.trim() || undefined) }}>
    <label>{t('workbench.graph.locateFixed')}<Input aria-label={t('workbench.graph.nodeId')} maxlength={160} value={value.value}
      onInput={event => { value.value = (event.target as HTMLInputElement).value }} /></label>
    <Button type="submit">{t('workbench.graph.locate')}</Button>
    <Button type="button" onClick={() => { value.value = ''; props.onLocate() }}>{t('workbench.graph.overview')}</Button>
  </form>
})
