import { Button } from '@numenjs/components'
import type { GraphSource } from '@numenjs/core'
import { computed, ref, watch, type VNodeChild } from 'vue'
import { GraphAutomationCanvas, type GraphAutomationCanvasProps } from './GraphAutomationCanvas.js'
import { defineSetupComponent } from './vue-component.js'
import { t } from './i18n.js'

interface Props extends GraphAutomationCanvasProps { nodeFocus?: VNodeChild }

/** Visited scopes stay mounted so returning from a loop or focus preserves its viewport. */
export const GraphCanvasWorkspace = defineSetupComponent<Props>('GraphCanvasWorkspace', ['source', 'graph', 'presentation', 'steps', 'activeStepId', 'canEdit', 'catalog', 'toolbar', 'onFocusNode', 'onStepChange', 'onCommand', 'onPositions', 'nodeFocus'], props => {
  const scopeId = ref(props.graph.id), visited = ref([props.graph.id])
  const scopes = computed(() => {
    const result = new Map<string, { graph: GraphSource; path: string[] }>()
    const visit = (graph: GraphSource, path: string[]) => {
      result.set(graph.id, { graph, path: [...path, graph.id] })
      for (const node of graph.nodes) if (node.type === 'foreach') visit(node.body, [...path, graph.id])
    }
    visit(props.graph, [])
    return result
  })
  const show = (id: string) => {
    if (!scopes.value.has(id)) return
    scopeId.value = id
    if (!visited.value.includes(id)) visited.value.push(id)
  }
  watch(() => [props.graph, props.activeStepId] as const, () => {
    const selected = props.activeStepId.slice(7)
    const scope = [...scopes.value.values()].find(({ graph }) => graph.id === selected || graph.nodes.some(node => node.id === selected))
    show(scope?.graph.id ?? props.graph.id)
    visited.value = visited.value.filter(id => scopes.value.has(id))
  }, { immediate: true })
  return () => <div class="graph-workspace" data-focused={!!props.nodeFocus}>
    <div class="graph-scope-workspace" style={props.nodeFocus ? { visibility: 'hidden', pointerEvents: 'none' } : {}}>
      {(scopes.value.get(scopeId.value)?.path.length ?? 0) > 1 ? <nav class="graph-scope-path" aria-label={t('workbench.graph.scopes')}>
        {scopes.value.get(scopeId.value)!.path.map(id => <Button type="button" key={id} aria-current={scopeId.value === id ? 'location' : undefined}
          onClick={() => { if (props.onStepChange(`source:${id}`) !== false) show(id) }}>{id}</Button>)}
        <span>{t('workbench.graph.loopScopeHelp')}</span>
      </nav> : null}
      {visited.value.map(id => {
        const graph = scopes.value.get(id)?.graph
        return graph ? <div class="graph-scope-canvas" key={id} style={{ display: id === scopeId.value ? 'flex' : 'none' }}>
          <GraphAutomationCanvas {...props} graph={graph} onOpenScope={show} />
        </div> : null
      })}
    </div>
    {props.nodeFocus}
  </div>
})
