import type { AutomationSource, BlockSource, ControlSource, TriggerSource } from '@numenjs/core'
import { Button, SelectMenu } from '@numenjs/components'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Clipboard, Copy, Focus, GripVertical, ListTree, MoreHorizontal, Scissors, Trash2 } from '@lucide/vue'
import { computed, nextTick, ref, watch, type VNodeChild } from 'vue'
import { AutomationQuickPicker } from './AutomationQuickPicker.js'
import { automationMovableNodeIds, automationRelativeInsertTarget, automationStepEditOptions } from './automation-source-editing.js'
import type { AutomationInsertTarget, AutomationSourceCommand } from './automation-source-editing.js'
import type { WorkbenchAutomationInsertCatalog, WorkbenchAutomationInsertItem } from './contracts.js'
import type { AutomationStep } from './model.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'
import { t } from './i18n.js'
import { automationAncestors } from './automation-presentation.js'
import { searchAutomationNodes } from './automation-node-search.js'
import type { AutomationDropPlacement } from './automation-drag.js'
import { useAutomationDrag } from './useAutomationDrag.js'
import { automationCollapsibleIds, automationContainerPath, automationFlowContainers, type AutomationFlowContainer } from './automation-flow-context.js'
import { defineSetupComponent } from './vue-component.js'

export interface AutomationClipboardView {
  mode: 'copy' | 'cut'
  nodeId: string
  label?: string
}

interface StructuredAutomationFlowProps {
  source: AutomationSource
  steps: AutomationStep[]
  activeStepId: string
  inspectorFocusNodeId?: string
  canEdit: boolean
  insertCatalogState?: ConsoleQueryState<WorkbenchAutomationInsertCatalog>
  collapsedNodes?: string[]
  clipboard?: AutomationClipboardView
  onStepChange(id: string, revealWithinNodeId?: string): boolean | void
  onInsert?(item: WorkbenchAutomationInsertItem, target: AutomationInsertTarget): boolean
  onReloadInsertCatalog?(): void
  onSourceCommand?(command: AutomationSourceCommand, expectedSource?: AutomationSource): boolean
  onDeleteStep?(nodeId: string): void
  onMoveStep?(nodeId: string, direction: 'up' | 'down'): void
  onCopyStep?(nodeId: string): void
  onCutStep?(nodeId: string): void
  onPaste?(target: AutomationInsertTarget): boolean
  onToggleCollapse?(nodeId: string, collapsed: boolean): void
  onSetCollapsed?(nodeIds: string[], collapsed: boolean): void
}

export const StructuredAutomationFlow = defineSetupComponent<StructuredAutomationFlowProps>('StructuredAutomationFlow', [
  'source', 'steps', 'activeStepId', 'inspectorFocusNodeId', 'canEdit', 'insertCatalogState', 'collapsedNodes', 'clipboard',
  'onStepChange', 'onInsert', 'onReloadInsertCatalog', 'onSourceCommand', 'onDeleteStep', 'onMoveStep',
  'onCopyStep', 'onCutStep', 'onPaste', 'onToggleCollapse', 'onSetCollapsed',
], props => {
  const host = ref<HTMLElement>()
  const outlineOpen = ref(false)
  const search = ref('')
  const searchResults = computed(() => searchAutomationNodes(props.source, props.steps, search.value))
  const actionNode = ref<string>()
  const moveNode = ref<string>()
  const destination = ref('')
  const removal = ref<{ key: string; label: string; command: AutomationSourceCommand }>()
  const metadata = computed(() => new Map(props.steps.map(step => [step.sourceId, step])))
  // Handles need only sequence membership; full copy validation stays in actions.
  const movableNodeIds = computed(() => automationMovableNodeIds(props.source))
  // Focus is a viewport choice. Persisted folding still belongs to Presentation.
  const focusId = ref<string>()
  const containers = computed(() => new Map(automationFlowContainers(props.source).map(container => [container.node.id, container])))
  const focused = computed(() => focusId.value ? containers.value.get(focusId.value) : undefined)
  const selectedSourceId = computed(() => props.steps.find(step => step.id === props.activeStepId)?.sourceId)
  const selectedPath = computed(() => selectedSourceId.value ? automationContainerPath(props.source, selectedSourceId.value) : [])
  const focusCandidate = computed(() => selectedPath.value.at(-1))
  const focusPath = computed(() => focusId.value ? automationContainerPath(props.source, focusId.value).filter(container => container.node.id !== props.source.flow.id) : [])
  const foldingIds = computed(() => automationCollapsibleIds(props.source, focusId.value))
  const containerLabel = (container: AutomationFlowContainer) => {
    if (container.role === 'root') return t('workbench.structure.flow')
    if (container.role === 'branch') return t('workbench.structure.branch', { count: (container.branchIndex ?? 0) + 1 })
    if (container.role === 'then' || container.role === 'else' || container.role === 'body') return t(`workbench.structure.${container.role}`)
    return metadata.value.get(container.node.id)?.label ?? container.node.id
  }
  watch([() => props.source, selectedSourceId], () => {
    if (focusId.value && (!focused.value || !selectedPath.value.some(container => container.node.id === focusId.value))) focusId.value = undefined
  })
  // Archived and conflicted drafts remain browsable without mutating the document.
  // Once editing resumes, the persisted presentation owns the view again.
  const readonlyCollapsed = ref<string[]>()
  watch(() => props.canEdit && !!props.onToggleCollapse, canPersist => {
    readonlyCollapsed.value = canPersist ? undefined : [...(props.collapsedNodes ?? [])]
  }, { immediate: true })
  const isCollapsed = (id: string) => id !== focusId.value && ((readonlyCollapsed.value ?? props.collapsedNodes)?.includes(id) ?? false)
  const setCollapsed = (collapsed: boolean) => {
    drag.cancel()
    if (readonlyCollapsed.value === undefined) props.onSetCollapsed?.(foldingIds.value, collapsed)
    else {
      const ids = new Set(readonlyCollapsed.value)
      for (const id of foldingIds.value) { if (collapsed) ids.add(id); else ids.delete(id) }
      readonlyCollapsed.value = [...ids]
    }
  }
  const toggleCollapse = (id: string, collapsed: boolean) => {
    if (readonlyCollapsed.value === undefined) {
      props.onToggleCollapse?.(id, collapsed)
      return
    }
    const ids = new Set(readonlyCollapsed.value)
    if (collapsed) ids.add(id)
    else ids.delete(id)
    readonlyCollapsed.value = [...ids]
  }
  const revealReadonly = (nodeId: string | undefined) => {
    if (readonlyCollapsed.value === undefined || !nodeId) return
    const path = automationAncestors(props.source, nodeId)
    const scopeIndex = focusId.value ? path.indexOf(focusId.value) : -1
    const ancestors = new Set(focusId.value ? scopeIndex >= 0 ? path.slice(scopeIndex + 1) : [] : path)
    readonlyCollapsed.value = readonlyCollapsed.value.filter(id => !ancestors.has(id))
  }
  const select = (id: string) => {
    const step = metadata.value.get(id)
    if (step && props.onStepChange(step.id, focusId.value) !== false) revealReadonly(step.sourceId)
  }
  const focusSelection = async (explicit = false) => {
    await nextTick()
    // A background projection can choose a surviving node after remote deletion.
    // Only an explicit locate/edit may interrupt an in-progress outline search.
    if (!explicit && host.value?.querySelector('.structure-outline')?.contains(document.activeElement)) return
    const selected = host.value?.querySelector<HTMLButtonElement>('.automation-step[aria-pressed="true"], .structure-block-title[aria-pressed="true"]')
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const selectedSourceId = props.steps.find(step => step.id === props.activeStepId)?.sourceId
    // A Problems field request owns focus; Canvas still reveals the selected node.
    if (!props.inspectorFocusNodeId || props.inspectorFocusNodeId !== selectedSourceId) selected?.focus({ preventScroll: true })
  }
  watch(() => props.activeStepId, () => {
    revealReadonly(props.steps.find(step => step.id === props.activeStepId)?.sourceId)
    actionNode.value = undefined
    moveNode.value = undefined
    void focusSelection()
  })

  const command = (value: AutomationSourceCommand, expectedSource?: AutomationSource) => {
    const applied = props.onSourceCommand?.(value, expectedSource) ?? false
    if (applied) void focusSelection(true)
    return applied
  }
  const drag = useAutomationDrag({ host, source: () => props.source, canEdit: () => props.canEdit, commit: command })
  const focusContainer = (id?: string) => {
    if (id && !containers.value.has(id)) return
    drag.cancel()
    focusId.value = id === props.source.flow.id ? undefined : id
    actionNode.value = undefined
    moveNode.value = undefined
    removal.value = undefined
    void nextTick(() => {
      host.value?.closest<HTMLElement>('.automation-canvas')?.scrollTo({ top: 0 })
    })
  }
  const dropZone = (nodeId: string, placement: AutomationDropPlacement): VNodeChild => {
    if (!drag.session.value) return null
    const active = drag.intent.value?.nodeId === nodeId && drag.intent.value.placement === placement
    const state = active ? drag.intent.value?.allowed ? 'allowed' : 'rejected' : undefined
    const label = metadata.value.get(nodeId)?.label ?? t('workbench.structure.flow')
    return <div class="structure-drop-zone" data-drop-node-id={nodeId} data-drop-placement={placement} data-drop-state={state}
      onDragover={event => drag.over(event, nodeId, placement)} onDrop={event => drag.drop(event, nodeId, placement)}>
      <span>{t(state === 'rejected' ? 'workbench.structure.dropRejected' : `workbench.structure.drop${placement}`, { label })}</span>
    </div>
  }
  const locate = (step: AutomationStep) => {
    const scope = focusId.value && automationContainerPath(props.source, step.sourceId ?? '').some(container => container.node.id === focusId.value) ? focusId.value : undefined
    if (props.onStepChange(step.id, scope) === false) return
    if (!scope) focusId.value = undefined
    revealReadonly(step.sourceId)
    outlineOpen.value = false
    void focusSelection(true)
  }
  const destinations = () => {
    const options: Array<{ value: string; label: string }> = []
    const visit = (control: ControlSource, path: string[]) => {
      if (control.type === 'block') {
        options.push({ value: control.id, label: path.join(' / ') })
        for (const child of control.steps) visit(child, [...path, metadata.value.get(child.id)?.label ?? child.id])
      } else if (control.type === 'if') {
        visit(control.then, [...path, t('workbench.structure.then')])
        if (control.else) visit(control.else, [...path, t('workbench.structure.else')])
      } else if (control.type === 'foreach') visit(control.body, [...path, t('workbench.structure.body')])
      else if (control.type === 'parallel' || control.type === 'race') {
        control.branches.forEach((branch, index) => visit(branch, [...path, t('workbench.structure.branch', { count: index + 1 })]))
      }
    }
    visit(props.source.flow, [t('workbench.structure.flow')])
    return options
  }
  const confirm = (key: string, label: string, value: AutomationSourceCommand, nonempty: boolean) => {
    if (nonempty) removal.value = { key, label, command: value }
    else command(value)
  }
  const confirmation = (key: string): VNodeChild => removal.value?.key === key ? (
    <div class="structure-confirmation" role="group" aria-label={t('workbench.structure.confirmRemoval')}>
      <p>{t(removal.value.command.type === 'CLEAR_BLOCK' ? 'workbench.structure.clearContents' : 'workbench.structure.removeContents', { label: removal.value.label })}</p>
      <Button disabled={!props.canEdit} onClick={() => {
        if (removal.value && command(removal.value.command)) removal.value = undefined
      }} type="button">{t('workbench.structure.confirmRemoval')}</Button>
      <Button onClick={() => { removal.value = undefined }} type="button">{t('workbench.structure.cancel')}</Button>
    </div>
  ) : null

  const picker = (target: AutomationInsertTarget, label: string, compact = false, root = false) => <AutomationQuickPicker
    disabled={!props.canEdit}
    target={target}
    label={label}
    compact={compact}
    {...(root ? { triggerTarget: { kind: 'triggers' as const } } : {})}
    {...(props.insertCatalogState ? { state: props.insertCatalogState } : {})}
    {...(props.onInsert ? { onInsert: props.onInsert } : {})}
    {...(props.onReloadInsertCatalog ? { onReload: props.onReloadInsertCatalog } : {})}
  />
  const paste = (target: AutomationInsertTarget, label: string) => props.clipboard ? <Button
    aria-label={label}
    class="structure-paste-button"
    disabled={!props.canEdit}
    onClick={() => props.onPaste?.(target)}
    type="button"
  ><Clipboard size={14} />{label}</Button> : null

  const actions = (nodeId: string, step: AutomationStep): VNodeChild => {
    const options = automationStepEditOptions(props.source, nodeId)
    const before = automationRelativeInsertTarget(props.source, nodeId, 'before')
    const after = automationRelativeInsertTarget(props.source, nodeId, 'after')
    const trigger = props.source.triggers.some(item => item.id === nodeId)
    return <div class="step-edit-actions structure-actions" onKeydown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        const header = (event.currentTarget as HTMLElement).previousElementSibling
        actionNode.value = undefined
        header?.querySelector<HTMLButtonElement>('.structure-menu-button')?.focus()
      }
    }} role="group" aria-label={t('workbench.actionsForValue0', { value0: step.label })}>
      {!trigger && before ? picker(before, t('workbench.structure.insertBefore', { label: step.label })) : null}
      {!trigger && after ? picker(after, t('workbench.structure.insertAfter', { label: step.label })) : null}
      <Button disabled={!props.canEdit || !options.canCopy} title={!options.canCopy ? t('workbench.structure.errors.COPY_UNSAFE') : undefined} onClick={() => props.onCopyStep?.(nodeId)} type="button"><Copy size={14} />{t('workbench.copy')}</Button>
      <Button disabled={!props.canEdit || !options.canMoveTo} onClick={() => props.onCutStep?.(nodeId)} type="button"><Scissors size={14} />{t('workbench.cut')}</Button>
      {before ? paste(before, t('workbench.structure.pasteBefore')) : null}
      {after ? paste(after, t('workbench.structure.pasteAfter')) : null}
      <Button disabled={!props.canEdit || !options.canMoveUp} aria-label={t('workbench.moveValue0Up', { value0: step.label })} onClick={() => props.onMoveStep?.(nodeId, 'up')} type="button"><ArrowUp size={14} />{t('workbench.moveUp')}</Button>
      <Button disabled={!props.canEdit || !options.canMoveDown} aria-label={t('workbench.moveValue0Down', { value0: step.label })} onClick={() => props.onMoveStep?.(nodeId, 'down')} type="button"><ArrowDown size={14} />{t('workbench.moveDown')}</Button>
      {step.kind === 'block' ? <Button disabled={!props.canEdit} onClick={() => confirm(`clear:${nodeId}`, step.label, { type: 'CLEAR_BLOCK', nodeId }, true)} type="button">{t('workbench.structure.clear')}</Button> : null}
      {!trigger ? <Button disabled={!props.canEdit || !options.canMoveTo} onClick={() => {
        moveNode.value = moveNode.value === nodeId ? undefined : nodeId
        destination.value = ''
      }} type="button">{t('workbench.structure.moveTo')}</Button> : null}
      <Button disabled={!props.canEdit || !options.canDelete} aria-label={t('workbench.deleteValue0', { value0: step.label })} onClick={() => props.onDeleteStep?.(nodeId)} title={t('workbench.deleteThisStepAndItsContentsUndoRestoresIt')} type="button"><Trash2 size={14} />{t('workbench.delete')}</Button>
      {moveNode.value === nodeId ? <div class="structure-move-target">
        <SelectMenu ariaLabel={t('workbench.structure.destinationBlock')} value={destination.value}
          options={[{ value: '', label: t('workbench.structure.chooseDestination') }, ...destinations()]}
          onChange={value => { destination.value = value }} />
        <Button disabled={!props.canEdit || !destination.value} onClick={() => {
          if (command({ type: 'MOVE_TO', nodeId, target: { kind: 'block', blockId: destination.value } })) moveNode.value = undefined
        }} type="button">{t('workbench.structure.moveHere')}</Button>
      </div> : null}
    </div>
  }

  const nodeHeader = (node: ControlSource | TriggerSource, structural: boolean): VNodeChild => {
    const step = metadata.value.get(node.id)
    if (!step) return null
    const Icon = step.icon
    const selected = props.activeStepId === step.id
    const collapsed = isCollapsed(node.id)
    const expandedActions = actionNode.value === node.id
    return <>
      <div class="structured-node-header">
        {props.canEdit && movableNodeIds.value.has(node.id) ? <button class="structure-drag-handle"
          draggable="true" data-drag-node-id={node.id} aria-label={t('workbench.structure.drag', { label: step.label })}
          title={t('workbench.structure.drag', { label: step.label })} onDragstart={event => drag.start(event, node.id)}
          onDragend={drag.cancel} type="button" tabindex={-1}><GripVertical size={15} aria-hidden="true" /></button> : null}
        {structural && node.id !== focusId.value ? <Button class="structure-collapse" aria-label={t(`workbench.structure.${collapsed ? 'expand' : 'collapse'}`, { label: step.label })}
          aria-expanded={!collapsed} onClick={() => toggleCollapse(node.id, !collapsed)} type="button">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </Button> : null}
        <button class="automation-step" data-node-id={node.id} data-selected={selected} aria-pressed={selected} type="button" onClick={() => select(node.id)}>
          <span class="step-icon" data-tone={step.tone}><Icon size={19} strokeWidth={1.7} /></span>
          <span class="step-copy"><strong>{step.label}</strong><small>{step.summary}</small></span>
          {step.problemCount ? <span class="step-problem-badge" aria-label={t('workbench.problemsCount', { count: step.problemCount })}>!</span> : null}
        </button>
        <Button class="structure-menu-button" aria-label={t('workbench.actionsForValue0', { value0: step.label })} aria-expanded={expandedActions}
          onClick={() => { actionNode.value = expandedActions ? undefined : node.id }} type="button"><MoreHorizontal size={17} /></Button>
        {dropZone(node.id, 'before')}
        {'type' in node && node.type === 'block' && collapsed ? dropZone(node.id, 'inside') : null}
        {dropZone(node.id, 'after')}
      </div>
      {expandedActions ? actions(node.id, step) : null}
    </>
  }

  const block = (value: BlockSource, label: string, extra?: VNodeChild, root = false, showHeader = true): VNodeChild => {
    const collapsed = isCollapsed(value.id)
    const target: AutomationInsertTarget = { kind: 'block', blockId: value.id }
    const step = metadata.value.get(value.id)
    const context = containers.value.get(value.id)
    return <section class="structure-block" data-block-id={value.id} data-root={root} data-slot={context?.role}>
      {!root && showHeader ? <header class="structure-block-header">
        <Button class="structure-collapse" aria-expanded={!collapsed} aria-label={t(`workbench.structure.${collapsed ? 'expand' : 'collapse'}`, { label })}
          onClick={() => toggleCollapse(value.id, !collapsed)} type="button">{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</Button>
        {step ? <button class="structure-block-title" aria-pressed={props.activeStepId === step.id} onClick={() => select(value.id)} type="button">{label}</button> : <strong>{label}</strong>}
        <span class="structure-block-count">{t('workbench.structure.stepsCount', { count: value.steps.length })}</span>
        {extra}
        {value.steps.length ? <Button class="structure-block-action" disabled={!props.canEdit} aria-label={t('workbench.structure.clearBlock', { label })}
          onClick={() => confirm(`clear:${value.id}`, label, { type: 'CLEAR_BLOCK', nodeId: value.id }, true)} type="button">{t('workbench.structure.clear')}</Button> : null}
      </header> : null}
      {confirmation(`clear:${value.id}`)}
      {!collapsed ? <div class="structure-block-content">
        {value.steps.map(control => node(control))}
        <div class="structure-insert-slot" data-empty={!value.steps.length}>
          {!value.steps.length && !root ? <span>{t('workbench.structure.emptyBlock')}</span> : null}
          {picker(target, root ? t('workbench.addStep') : t('workbench.structure.addTo', { label }), false, root)}
          {paste(target, t('workbench.structure.pasteInto', { label }))}
        </div>
      </div> : <p class="structure-collapsed-summary">{t('workbench.structure.hiddenSteps', { count: value.steps.length })}</p>}
      {dropZone(value.id, 'inside')}
    </section>
  }

  const node = (value: ControlSource): VNodeChild => {
    if (value.type === 'block') return <div class="structured-node" data-structure-node-id={value.id} data-control-kind={value.type} key={value.id}>
      {nodeHeader(value, true)}
      {!isCollapsed(value.id) ? block(value, metadata.value.get(value.id)?.label ?? value.id, undefined, false, false) : null}
    </div>
    const structural = value.type === 'if' || value.type === 'foreach' || value.type === 'parallel' || value.type === 'race'
    const elseLabel = t('workbench.structure.else')
    return <div class="structured-node" data-structure-node-id={value.id} data-control-kind={value.type} data-cut={props.clipboard?.mode === 'cut' && props.clipboard.nodeId === value.id} key={value.id}>
      {nodeHeader(value, structural)}
      {structural && !isCollapsed(value.id) ? <div class="structure-container-content">
        {value.type === 'if' ? <>
          {block(value.then, t('workbench.structure.then'))}
          {value.else ? <>
            {block(value.else, t('workbench.structure.else'), <Button class="structure-block-action" disabled={!props.canEdit} onClick={() => {
              confirm(`else:${value.id}`, elseLabel, { type: 'REMOVE_ELSE', nodeId: value.id }, !!value.else?.steps.length)
            }} type="button">{t('workbench.structure.removeElse')}</Button>)}
            {confirmation(`else:${value.id}`)}
          </> : <Button class="structure-add-branch" disabled={!props.canEdit} onClick={() => command({ type: 'ADD_ELSE', nodeId: value.id })} type="button">{t('workbench.structure.addElse')}</Button>}
        </> : value.type === 'foreach' ? block(value.body, t('workbench.structure.body'))
          : value.type === 'parallel' || value.type === 'race' ? <>
            {value.branches.map((branch, index) => {
              const branchLabel = t('workbench.structure.branch', { count: index + 1 })
              return <div key={branch.id}>
              {block(branch, branchLabel, <Button class="structure-block-action"
                disabled={!props.canEdit || value.branches.length <= 2} aria-label={t('workbench.structure.removeBranch', { count: index + 1 })}
                onClick={() => confirm(`branch:${branch.id}`, branchLabel, { type: 'REMOVE_BRANCH', nodeId: value.id, branchId: branch.id }, !!branch.steps.length)} type="button">{t('workbench.structure.remove')}</Button>)}
              {confirmation(`branch:${branch.id}`)}
            </div>})}
            <Button class="structure-add-branch" disabled={!props.canEdit} onClick={() => command({ type: 'ADD_BRANCH', nodeId: value.id })} type="button">{t('workbench.structure.addBranch')}</Button>
          </> : null}
      </div> : null}
    </div>
  }

  return () => <div class="structured-flow" ref={host} data-dragging-node-id={drag.session.value?.nodeId} data-focus-container-id={focusId.value}>
    <div class="structure-context-bar">
      <nav class="structure-breadcrumbs" aria-label={t('workbench.structure.containerPath')}>
        <button type="button" aria-label={t('workbench.structure.showFlow')} aria-current={!focused.value ? 'location' : undefined}
          onMousedown={event => event.preventDefault()} onClick={() => focusContainer()}>{t('workbench.structure.flow')}</button>
        {focusPath.value.map(container => <span key={container.node.id}>
          <ChevronRight size={12} aria-hidden="true" />
          <button type="button" title={container.node.id} aria-label={t('workbench.structure.showContainer', { id: container.node.id })}
            aria-current={focusId.value === container.node.id ? 'location' : undefined}
            onMousedown={event => event.preventDefault()} onClick={() => focusContainer(container.node.id)}>{containerLabel(container)}</button>
        </span>)}
      </nav>
      <div class="structure-view-actions" role="group" aria-label={t('workbench.structure.viewActions')}>
        {focused.value ? <Button type="button" aria-label={t('workbench.structure.parent')} onMousedown={event => event.preventDefault()}
          onClick={() => focusContainer(focused.value?.parentId)}><ArrowUp size={13} aria-hidden="true" />{t('workbench.structure.parent')}</Button> : null}
        <Button type="button" aria-label={t('workbench.structure.focusSelected')} title={focusCandidate.value ? containerLabel(focusCandidate.value) : undefined}
          disabled={!focusCandidate.value || focusCandidate.value.node.id === props.source.flow.id || focusCandidate.value.node.id === focusId.value}
          onMousedown={event => event.preventDefault()} onClick={() => { if (focusCandidate.value) focusContainer(focusCandidate.value.node.id) }}>
          <Focus size={13} aria-hidden="true" />{t('workbench.structure.focusSelected')}</Button>
        <Button type="button" disabled={!foldingIds.value.some(id => !isCollapsed(id))} onMousedown={event => event.preventDefault()}
          onClick={() => setCollapsed(true)}>{t('workbench.structure.collapseAll')}</Button>
        <Button type="button" disabled={!foldingIds.value.some(id => isCollapsed(id))} onMousedown={event => event.preventDefault()}
          onClick={() => setCollapsed(false)}>{t('workbench.structure.expandAll')}</Button>
      </div>
    </div>
    <details class="structure-outline" open={outlineOpen.value} onToggle={event => { outlineOpen.value = (event.currentTarget as HTMLDetailsElement).open }}
      onKeydown={event => {
        if (event.isComposing) return
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation()
          outlineOpen.value = false
          host.value?.querySelector<HTMLElement>('.structure-outline > summary')?.focus()
        }
      }}>
      <summary><ListTree size={15} aria-hidden="true" />{t('workbench.structure.outline')}<span>{props.steps.length}</span></summary>
      <div class="structure-search">
        <input type="search" value={search.value} aria-label={t('workbench.structure.findNode')} placeholder={t('workbench.structure.searchHint')}
          onInput={event => { search.value = (event.target as HTMLInputElement).value }}
          onKeydown={event => {
            if (event.isComposing) return
            if (event.key === 'Enter' && searchResults.value[0]) { event.preventDefault(); locate(searchResults.value[0].step) }
            else if (event.key === 'ArrowDown') { event.preventDefault(); host.value?.querySelector<HTMLButtonElement>('.structure-outline nav button')?.focus() }
          }} />
        <p role="status">{t(searchResults.value.length ? 'workbench.structure.matches' : 'workbench.structure.noMatches', { count: searchResults.value.length })}</p>
      </div>
      <nav aria-label={t('workbench.structure.flowOutline')}>
        <ol>{searchResults.value.map(({ step, capability }) => <li key={step.id} data-depth={search.value.trim() ? 0 : Math.min(step.depth ?? 0, 4)}>
          <button aria-label={t('workbench.structure.locate', { label: step.label, id: step.sourceId ?? step.id })}
            aria-current={props.activeStepId === step.id ? 'step' : undefined} onClick={() => locate(step)}
            type="button"><span>{step.label}{capability ? <em>{capability}</em> : null}</span><small>{step.sourceId}</small>{step.problemCount ? <em>{step.problemCount}</em> : null}</button>
        </li>)}</ol>
      </nav>
    </details>
    {props.clipboard ? <p class="structure-clipboard" role="status">{t(`workbench.structure.${props.clipboard.mode === 'cut' ? 'cutReady' : 'copyReady'}`, { label: props.clipboard.label ?? props.clipboard.nodeId })}</p> : null}
    {!focused.value && props.source.triggers.length ? <section class="structure-triggers" aria-label={t('workbench.triggers')}>
      <h2>{t('workbench.triggers')}</h2>
      {props.source.triggers.map(trigger => <div class="structured-node" data-structure-node-id={trigger.id} key={trigger.id}>
        {nodeHeader(trigger, false)}
      </div>)}
    </section> : null}
    <section class="structure-main" aria-label={t('workbench.structure.flow')}>
      <h2>{focused.value ? containerLabel(focused.value) : t('workbench.structure.flow')}</h2>
      {focused.value ? node(focused.value.node) : props.source.flow.type === 'block' ? block(props.source.flow, t('workbench.structure.flow'), undefined, true) : <>
        {node(props.source.flow)}
        {picker({ kind: 'root' }, t('workbench.addStep'), false, true)}
        {paste({ kind: 'root' }, t('workbench.structure.pasteInto', { label: t('workbench.structure.flow') }))}
      </>}
    </section>
  </div>
})
