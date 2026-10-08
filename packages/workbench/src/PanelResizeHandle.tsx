import { ResizeHandle } from '@numenjs/components'
import { t } from './i18n.js'
import { useWorkbenchLayout } from './workbench-layout.js'
import { defineSetupComponent } from './vue-component.js'

export const PanelResizeHandle = defineSetupComponent('PanelResizeHandle', [], () => {
  const layout = useWorkbenchLayout()
  return () => layout ? <ResizeHandle class="panel-resize-handle" ariaLabel={t('workbench.resize.panel')}
    title={t('workbench.resize.hint')} axis="y" direction={-1}
    value={layout.panelOpen.value ? layout.sizes.value.panel : layout.sizes.value.mobile ? 42 : 46}
    min={layout.sizes.value.panelMin} max={layout.sizes.value.panelMax}
    collapsed={!layout.panelOpen.value} collapsedSize={layout.sizes.value.mobile ? 42 : 46}
    onCollapsedChange={collapsed => layout.setCollapsed('panel', collapsed)}
    onChange={layout.setPanel} onCommit={() => { layout.save(); if (!layout.panelOpen.value) document.querySelector<HTMLElement>('.panel-toggle')?.focus({ preventScroll: true }) }} onCancel={layout.cancel}
    onReset={() => { layout.panelOpen.value = true; layout.reset('panel') }} /> : null
})
