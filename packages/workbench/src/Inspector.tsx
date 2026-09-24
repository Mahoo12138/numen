import { Textarea, Input, Button, SelectMenu, FormSection as InspectorGroup } from '@numenjs/components'
import { diagnosticText, t } from './i18n.js'
import type { AutomationSource, CompileDiagnostic, NumenValue, WaitSource, ValueExpr } from '@numenjs/core'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { ChevronDown, X } from '@lucide/vue'
import { CapabilityConnectionFields, CapabilityInputFields, TriggerConfigurationFields } from './CapabilityInspector.js'
import { findAutomationControl, findAutomationTrigger } from './automation-source-editing.js'
import type {
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationInputField,
  WorkbenchAutomationInsertItem,
  WorkbenchAutomationVariableCatalog,
} from './contracts.js'
import { automationSteps, type AutomationStep } from './model.js'
import { ValueExpressionField } from './ValueExpressionEditor.js'

const noDiagnostics: CompileDiagnostic[] = []

export interface InspectorFieldFocus {
  nodeId: string
  fieldPath?: string
  request: number
}

export interface InspectorProps {
  activeStepId: string
  open: boolean
  steps?: AutomationStep[]
  source?: AutomationSource
  problems?: CompileDiagnostic[]
  canEdit?: boolean
  fieldFocus?: InspectorFieldFocus
  catalog?: WorkbenchAutomationInsertCatalog
  variableCatalog?: WorkbenchAutomationVariableCatalog
  schemaUI?: SchemaUIResolver
  onCapabilityConnectionChange?(nodeId: string, slotName: string, connectionId?: string): void
  onExtensionInputChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
  onCapabilityInputChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
  onTriggerConfigChange?(nodeId: string, fieldName: string, value?: NumenValue): void
  onControlExpressionChange?(nodeId: string, field: 'condition' | 'items', expression: ValueExpr): void
  onWaitExpressionChange?(nodeId: string, field: 'durationMs' | 'until', expression: ValueExpr): void
  onClose(): void
}

function WaitConfiguration({
  nodeId,
  control,
  canEdit,
  problem,
  source,
  variableCatalog,
  schemaUI,
  focusRequest,
  onChange,
}: {
  nodeId: string
  control: WaitSource
  canEdit: boolean
  problem: CompileDiagnostic | undefined
  source: AutomationSource
  variableCatalog?: WorkbenchAutomationVariableCatalog
  schemaUI?: SchemaUIResolver
  focusRequest: number | undefined
  onChange?(nodeId: string, field: 'durationMs' | 'until', expression: ValueExpr): void
}) {
  const fieldName: 'durationMs' | 'until' = control.until ? 'until' : 'durationMs'
  const field: WorkbenchAutomationInputField = fieldName === 'durationMs'
    ? {
        name: 'durationMs',
        label: t('workbench.duration'),
        type: 'number',
        schemaType: 'number',
        required: true,
        role: 'numen/duration-ms',
        min: 0,
        step: 1,
        defaultValue: 60_000,
        description: t('workbench.waitDurationDescription'),
      }
    : {
        name: 'until',
        label: t('workbench.wakeTime'),
        type: 'string',
        schemaType: 'string',
        required: true,
        role: 'numen/iso-date-time',
        defaultValue: '',
        description: t('workbench.waitUntilDescription'),
      }
  const expression = control[fieldName]
  return (
    <>
      <label class="wait-source-field">
        <span>{t('workbench.wakeSource')}</span>
        <SelectMenu ariaLabel={t('workbench.waitWakeSource')} disabled={!canEdit}
          onChange={value => {
            const next = value as 'durationMs' | 'until'
            if (next === fieldName) return
            onChange?.(nodeId, next, next === 'durationMs'
              ? { type: 'literal', value: 60_000 }
              : { type: 'literal', value: new Date(Date.now() + 60 * 60 * 1_000).toISOString() })
          }} value={fieldName} options={[
            { value: 'durationMs', label: t('workbench.forADuration') },
            { value: 'until', label: t('workbench.untilADateAndTime') },
          ]} />
      </label>
      <ValueExpressionField
        canEdit={canEdit}
        field={field}
        {...(focusRequest !== undefined ? { focusRequest } : {})}
        nodeId={nodeId}
        onChange={next => {
          if (next) onChange?.(nodeId, fieldName, next)
        }}
        source={source}
        {...(expression ? { expression } : {})}
        {...(problem ? { problem } : {})}
        {...(schemaUI ? { schemaUI } : {})}
        {...(variableCatalog ? { variableCatalog } : {})}
      />
    </>
  )
}

export function Inspector({
  activeStepId,
  open,
  steps,
  source,
  problems = noDiagnostics,
  canEdit = false,
  fieldFocus,
  catalog,
  variableCatalog,
  schemaUI,
  onCapabilityConnectionChange,
  onCapabilityInputChange,
  onTriggerConfigChange,
  onExtensionInputChange,
  onControlExpressionChange,
  onWaitExpressionChange,
  onClose,
}: InspectorProps) {
  const projectedSteps = steps ?? automationSteps
  const step = projectedSteps.find(item => item.id === activeStepId) ?? projectedSteps[0]
  const isNotification = !steps && step?.id === 'notification'
  const control = source && step?.sourceId ? findAutomationControl(source, step.sourceId) : undefined
  const trigger = source && step?.sourceId ? findAutomationTrigger(source, step.sourceId) : undefined
  const stepProblems = step?.sourceId
    ? problems.filter(problem => problem.source?.nodeId === step.sourceId)
    : []
  const waitField = control?.type === 'wait' && control.until ? 'until' : 'durationMs'
  const waitProblem = stepProblems.find(problem => (
    problem.source?.fieldPath === waitField
    || (problem.code === 'WAIT_SOURCE_INVALID' && !problem.source?.fieldPath)
  ))
  const controlField = control?.type === 'if' ? 'condition' : 'items'
  const controlProblem = stepProblems.find(problem => problem.source?.fieldPath?.split('.')[0] === controlField)
  const capabilityDefinition = control?.type === 'capability'
    ? catalog?.items.find((item): item is Extract<WorkbenchAutomationInsertItem, { kind: 'capability' }> => item.kind === 'capability'
      && item.capability.id === control.capability.id
      && item.capability.version === control.capability.version)
    : undefined
  const triggerDefinition = trigger
    ? catalog?.items.find((item): item is Extract<WorkbenchAutomationInsertItem, { kind: 'trigger' }> => item.kind === 'trigger'
      && item.capability.id === trigger.capability.id
      && item.capability.version === trigger.capability.version)
    : undefined
  const extensionDefinition = control?.type === 'extension'
    ? catalog?.items.find((item): item is Extract<WorkbenchAutomationInsertItem, { kind: 'extension' }> => item.kind === 'extension' && item.control.id === control.control.id && item.control.version === control.control.version)
    : undefined
  const connectionNode = control?.type === 'capability' ? control : trigger
  const connectionDefinition = control?.type === 'capability' ? capabilityDefinition : triggerDefinition
  const connectionBindings = connectionNode
    ? connectionNode.connections ?? (connectionNode.connection
      ? { [connectionDefinition?.connectionRequirements[0]?.name ?? 'default']: connectionNode.connection }
      : {})
    : {}
  return (
    <aside class="inspector" data-open={open} aria-label={t('workbench.inspector')}>
      <header class="inspector-header">
        <div><span>{step ? t('workbench.stepValue0', { value0: projectedSteps.indexOf(step) + 1 }) : t('workbench.noSelection')}</span><h2>{step?.label ?? t('workbench.inspector')}</h2></div>
        <Button variant="ghost" size="icon" aria-label={t('workbench.closeInspector2')} class="icon-button inspector-close" onClick={onClose} type="button"><X size={17} /></Button>
      </header>
      {!step ? (
        <div class="inspector-empty">{t('workbench.selectAProjectedSourceStepToInspectItsConfiguration')}</div>
      ) : isNotification ? (
        <>
          <InspectorGroup title={t('workbench.connection3')}>
            <label>{t('workbench.provider')}<SelectMenu ariaLabel={t('workbench.provider')} value="Slack" options={[{ value: 'Slack', label: 'Slack' }]} disabled onChange={() => {}} /></label>
            <label>{t('workbench.connection3')}<SelectMenu ariaLabel={t('workbench.connection3')} value="Slack (Workspace)" options={[{ value: 'Slack (Workspace)', label: 'Slack (Workspace)' }]} disabled onChange={() => {}} /></label>
            <Button variant="secondary" class="secondary-button" type="button">{t('workbench.testConnection')}</Button>
          </InspectorGroup>
          <InspectorGroup title={t('workbench.message2')}>
            <label>{t('workbench.channel')}<SelectMenu ariaLabel={t('workbench.channel')} value="#morning-brief" options={[{ value: '#morning-brief', label: '#morning-brief' }]} disabled onChange={() => {}} /></label>
            <label>{t('workbench.messageTemplate')}<Textarea value={'{{ summary }}'} /></label>
            <Button variant="secondary" class="secondary-button compact" type="button">{t('workbench.insertVariable')}<ChevronDown size={14} /></Button>
          </InspectorGroup>
          <InspectorGroup title={t('workbench.executionPolicy')}>
            <label>{t('workbench.onFailure')}<SelectMenu ariaLabel={t('workbench.onFailure')} value="continue" options={[{ value: 'continue', label: t('workbench.continueToNextStep') }]} disabled onChange={() => {}} /></label>
            <label>{t('workbench.retry')}<SelectMenu ariaLabel={t('workbench.retry')} value="3" options={[{ value: '3', label: t('workbench.3Attempts') }]} disabled onChange={() => {}} /></label>
            <label>{t('workbench.timeout')}<span class="input-with-unit"><Input value="30" /><span>s</span></span></label>
            <label class="checkbox-row">
              <Input checked type="checkbox" />
              <span>{t('workbench.runStepOnlyIfPreviousStepsSucceeded')}</span>
            </label>
          </InspectorGroup>
        </>
      ) : trigger && step.sourceId ? (
        <>
          {triggerDefinition?.connectionRequirements.length ? (
            <InspectorGroup title={t('workbench.connection3')}>
              <CapabilityConnectionFields
                bindings={connectionBindings}
                canEdit={canEdit}
                connections={catalog?.connections ?? []}
                nodeId={step.sourceId}
                {...(onCapabilityConnectionChange ? { onChange: onCapabilityConnectionChange } : {})}
                problems={stepProblems}
                slots={triggerDefinition.connectionRequirements}
              />
            </InspectorGroup>
          ) : null}
          <InspectorGroup title={t('workbench.triggerConfiguration')}>
            {triggerDefinition ? <TriggerConfigurationFields
              canEdit={canEdit}
              definition={triggerDefinition}
              nodeId={step.sourceId}
              {...(onTriggerConfigChange ? { onChange: onTriggerConfigChange } : {})}
              problems={stepProblems}
              {...(schemaUI ? { schemaUI } : {})}
              trigger={trigger}
            /> : <p class="inspector-schema-notice">{t('workbench.theTriggerContractIsUnavailableRestore')}{trigger.capability.id}@{trigger.capability.version}{t('workbench.toEditOrPublish')}</p>}
          </InspectorGroup>
          <InspectorGroup title={t('workbench.source')}>
            <p class="inspector-summary">{step.summary}</p>
            <dl class="inspector-source-fields">
              <div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId}</dd></div>
              <div><dt>{t('workbench.trigger')}</dt><dd>{trigger.capability.id}@{trigger.capability.version}</dd></div>
            </dl>
          </InspectorGroup>
          {stepProblems.length ? <InspectorGroup title={t('workbench.diagnostics')}><div class="inspector-diagnostics">
            {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{diagnosticText(problem)}</p>)}
          </div></InspectorGroup> : null}
        </>
      ) : control?.type === 'extension' && step.sourceId ? (
        <InspectorGroup title={t('workbench.configuration')}>
          {extensionDefinition ? <CapabilityInputFields
            nodeId={step.sourceId} definition={extensionDefinition} control={control} problems={stepProblems} canEdit={canEdit}
            {...(source ? { source } : {})}
            {...(variableCatalog ? { variableCatalog } : {})}
            {...(schemaUI ? { schemaUI } : {})}
            {...(onExtensionInputChange ? { onChange: onExtensionInputChange } : {})}
            {...(fieldFocus?.nodeId === step.sourceId && fieldFocus.fieldPath ? { focusFieldPath: fieldFocus.fieldPath, focusRequest: fieldFocus.request } : {})}
          /> : <p class="inspector-schema-notice">{t('workbench.unknownControlRestore')}{control.control.id}@{control.control.version}{t('workbench.toEditOrPublishSavedInputsArePreserved')}</p>}
          <dl class="inspector-source-fields"><div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId}</dd></div><div><dt>{t('workbench.control')}</dt><dd>{control.control.id}@{control.control.version}</dd></div></dl>
        </InspectorGroup>
      ) : control?.type === 'wait' && step.sourceId ? (
        <InspectorGroup title={t('workbench.configuration')}>
          <WaitConfiguration
            canEdit={canEdit}
            control={control}
            focusRequest={fieldFocus?.nodeId === step.sourceId && fieldFocus.fieldPath === waitField
              ? fieldFocus.request
              : undefined}
            nodeId={step.sourceId}
            {...(onWaitExpressionChange ? { onChange: onWaitExpressionChange } : {})}
            problem={waitProblem}
            source={source!}
            {...(schemaUI ? { schemaUI } : {})}
            {...(variableCatalog ? { variableCatalog } : {})}
          />
          <dl class="inspector-source-fields">
            <div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId}</dd></div>
            <div><dt>{t('workbench.kind')}</dt><dd>wait</dd></div>
          </dl>
        </InspectorGroup>
      ) : (control?.type === 'if' || control?.type === 'foreach') && step.sourceId ? (
        <InspectorGroup title={t('workbench.configuration')}>
          <ValueExpressionField
            canEdit={canEdit}
            field={control.type === 'if' ? {
              name: 'condition', label: t('workbench.condition'), type: 'boolean', schemaType: 'boolean',
              required: true, defaultValue: true,
              description: t('workbench.conditionDescription'),
            } : {
              name: 'items', label: t('workbench.items'), type: 'json', schemaType: 'array',
              required: true, defaultValue: [],
              description: t('workbench.foreachDescription'),
            }}
            expression={control.type === 'if' ? control.condition : control.items}
            nodeId={step.sourceId}
            onChange={expression => {
              if (expression) onControlExpressionChange?.(step.sourceId!, control.type === 'if' ? 'condition' : 'items', expression)
            }}
            source={source!}
            {...(schemaUI ? { schemaUI } : {})}
            {...(variableCatalog ? { variableCatalog } : {})}
            {...(controlProblem ? { problem: controlProblem } : {})}
            {...(fieldFocus?.nodeId === step.sourceId && fieldFocus.fieldPath?.split('.')[0] === controlField
              ? { focusRequest: fieldFocus.request } : {})}
          />
          <dl class="inspector-source-fields">
            <div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId}</dd></div>
            <div><dt>{t('workbench.kind')}</dt><dd>{control.type}</dd></div>
            {control.type === 'foreach' ? <div><dt>{t('workbench.concurrency')}</dt><dd>{control.concurrency ?? 1}</dd></div> : null}
          </dl>
          {stepProblems.length ? <div class="inspector-diagnostics">
            {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{diagnosticText(problem)}</p>)}
          </div> : null}
        </InspectorGroup>
      ) : control?.type === 'capability' && step.sourceId ? (
        <>
          {capabilityDefinition?.connectionRequirements.length ? (
            <InspectorGroup title={t('workbench.connection3')}>
              <CapabilityConnectionFields
                bindings={connectionBindings}
                canEdit={canEdit}
                connections={catalog?.connections ?? []}
                nodeId={step.sourceId}
                {...(onCapabilityConnectionChange ? { onChange: onCapabilityConnectionChange } : {})}
                problems={stepProblems}
                slots={capabilityDefinition.connectionRequirements}
              />
            </InspectorGroup>
          ) : null}
          <InspectorGroup title={t('workbench.input2')}>
            {capabilityDefinition ? (
              <CapabilityInputFields
                canEdit={canEdit}
                control={control}
                definition={capabilityDefinition}
                {...(fieldFocus?.nodeId === step.sourceId ? {
                  focusFieldPath: fieldFocus.fieldPath,
                  focusRequest: fieldFocus.request,
                } : {})}
                nodeId={step.sourceId}
                {...(onCapabilityInputChange ? { onChange: onCapabilityInputChange } : {})}
                problems={stepProblems}
                {...(source ? { source } : {})}
                {...(variableCatalog ? { variableCatalog } : {})}
                {...(schemaUI ? { schemaUI } : {})}
              />
            ) : (
              <div class="inspector-schema-notice">{t('workbench.theCapabilityContractIsUnavailableTheDraftReferenceAndExistingInputsArePreserved')}</div>
            )}
          </InspectorGroup>
          <InspectorGroup title={t('workbench.source')}>
            <p class="inspector-summary">{step.summary}</p>
            <dl class="inspector-source-fields">
              <div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId}</dd></div>
              <div><dt>{t('workbench.capability')}</dt><dd>{control.capability.id}@{control.capability.version}</dd></div>
            </dl>
          </InspectorGroup>
          {stepProblems.length ? (
            <InspectorGroup title={t('workbench.diagnostics')}>
              <div class="inspector-diagnostics">
                {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{diagnosticText(problem)}</p>)}
              </div>
            </InspectorGroup>
          ) : null}
        </>
      ) : (
        <InspectorGroup title={t('workbench.configuration')}>
          <p class="inspector-summary">{step.summary}</p>
          <dl class="inspector-source-fields">
            <div><dt>{t('workbench.sourceId')}</dt><dd>{step.sourceId ?? step.id}</dd></div>
            <div><dt>{t('workbench.kind')}</dt><dd>{step.kind ?? t('workbench.step')}</dd></div>
          </dl>
          {stepProblems.length ? (
            <div class="inspector-diagnostics">
              {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{diagnosticText(problem)}</p>)}
            </div>
          ) : null}
        </InspectorGroup>
      )}
    </aside>
  )
}
