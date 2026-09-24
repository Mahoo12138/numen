import { ResizeHandle } from '@numenjs/components'
import { t } from './i18n.js'
import { useWorkbenchLayout } from './workbench-layout.js'
import { defineSetupComponent } from './vue-component.js'

export const PanelResizeHandle = defineSetupComponent('PanelResizeHandle', [], () => {
  const layout = useWorkbenchLayout()
  return () => layout ? <ResizeHandle class="panel-resize-handle" ariaLabel={t('workbench.resize.panel')}
    title={t('workbench.resize.hint')} axis="y" direction={-1}
    value={layout.panelOpen.value ? layout.sizes.value.panel : layout.sizes.value.mobile ? 42 : 46}
    min={layout.panelOpen.value ? layout.sizes.value.panelMin : layout.sizes.value.mobile ? 42 : 46} max={layout.sizes.value.panelMax}
    onChange={layout.setPanel} onCommit={layout.save} onCancel={layout.cancel}
    onReset={() => { layout.panelOpen.value = true; layout.reset('panel') }} /> : null
})
