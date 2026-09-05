import type { AutomationSource, CompileDiagnostic, WaitSource, ValueExpr } from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { ChevronDown, X } from '@lucide/vue'
import type { SetupContext } from 'vue'
import { CapabilityConnectionFields, CapabilityInputFields } from './CapabilityInspector.js'
import { findAutomationControl } from './automation-source-editing.js'
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
  onControlExpressionChange?(nodeId: string, field: 'condition' | 'items', expression: ValueExpr): void
  onWaitExpressionChange?(nodeId: string, field: 'durationMs' | 'until', expression: ValueExpr): void
  onClose(): void
}

function InspectorGroup({ title, open = true }: {
  title: string
  open?: boolean
}, context: SetupContext) {
  return (
    <section class="inspector-group">
      <button class="inspector-group-heading" type="button">
        <span>{title}</span><ChevronDown size={15} data-open={open} />
      </button>
      {open ? <div class="inspector-group-content">{context.slots.default?.()}</div> : null}
    </section>
  )
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
        label: 'Duration',
        type: 'number',
        schemaType: 'number',
        required: true,
        role: 'numen/duration-ms',
        min: 0,
        step: 1,
        defaultValue: 60_000,
        description: 'Evaluated when the Wait starts, then persisted as one durable wake time.',
      }
    : {
        name: 'until',
        label: 'Wake time',
        type: 'string',
        schemaType: 'string',
        required: true,
        role: 'numen/iso-date-time',
        defaultValue: '',
        description: 'An ISO date-time or expression evaluated when the Wait starts.',
      }
  const expression = control[fieldName]
  return (
    <>
      <label class="wait-source-field">
        <span>Wake source</span>
        <select
          aria-label="Wait wake source"
          disabled={!canEdit}
          onChange={event => {
            const next = (event.target as HTMLInputElement).value as 'durationMs' | 'until'
            if (next === fieldName) return
            onChange?.(nodeId, next, next === 'durationMs'
              ? { type: 'literal', value: 60_000 }
              : { type: 'literal', value: new Date(Date.now() + 60 * 60 * 1_000).toISOString() })
          }}
          value={fieldName}
        >
          <option value="durationMs">For a duration</option>
          <option value="until">Until a date and time</option>
        </select>
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
  onExtensionInputChange,
  onControlExpressionChange,
  onWaitExpressionChange,
  onClose,
}: InspectorProps) {
  const projectedSteps = steps ?? automationSteps
  const step = projectedSteps.find(item => item.id === activeStepId) ?? projectedSteps[0]
  const isNotification = !steps && step?.id === 'notification'
  const control = source && step?.sourceId ? findAutomationControl(source, step.sourceId) : undefined
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
  const extensionDefinition = control?.type === 'extension'
    ? catalog?.items.find((item): item is Extract<WorkbenchAutomationInsertItem, { kind: 'extension' }> => item.kind === 'extension' && item.control.id === control.control.id && item.control.version === control.control.version)
    : undefined
  const connectionBindings = control?.type === 'capability'
    ? control.connections ?? (control.connection
      ? { [capabilityDefinition?.connectionRequirements[0]?.name ?? 'default']: control.connection }
      : {})
    : {}
  return (
    <aside class="inspector" data-open={open} aria-label="Inspector">
      <header class="inspector-header">
        <div><span>{step ? `STEP ${projectedSteps.indexOf(step) + 1}` : 'NO SELECTION'}</span><h2>{step?.label ?? 'Inspector'}</h2></div>
        <button aria-label="Close inspector" class="icon-button inspector-close" onClick={onClose} type="button"><X size={17} /></button>
      </header>
      {!step ? (
        <div class="inspector-empty">Select a projected Source step to inspect its configuration.</div>
      ) : isNotification ? (
        <>
          <InspectorGroup title="Connection">
            <label>Provider<select value="Slack"><option>Slack</option></select></label>
            <label>Connection<select value="Slack (Workspace)"><option>Slack (Workspace)</option></select></label>
            <button class="secondary-button" type="button">Test connection</button>
          </InspectorGroup>
          <InspectorGroup title="Message">
            <label>Channel<select value="#morning-brief"><option>#morning-brief</option></select></label>
            <label>Message template<textarea value={'{{ summary }}'} /></label>
            <button class="secondary-button compact" type="button">Insert variable <ChevronDown size={14} /></button>
          </InspectorGroup>
          <InspectorGroup title="Execution policy">
            <label>On failure<select value="Continue to next step"><option>Continue to next step</option></select></label>
            <label>Retry<select value="3 attempts"><option>3 attempts</option></select></label>
            <label>Timeout<span class="input-with-unit"><input value="30" /><span>s</span></span></label>
            <label class="checkbox-row">
              <input checked type="checkbox" />
              <span>Run step only if previous steps succeeded</span>
            </label>
          </InspectorGroup>
        </>
      ) : control?.type === 'extension' && step.sourceId ? (
        <InspectorGroup title="Configuration">
          {extensionDefinition ? <CapabilityInputFields
            nodeId={step.sourceId} definition={extensionDefinition} control={control} problems={stepProblems} canEdit={canEdit}
            {...(source ? { source } : {})}
            {...(variableCatalog ? { variableCatalog } : {})}
            {...(schemaUI ? { schemaUI } : {})}
            {...(onExtensionInputChange ? { onChange: onExtensionInputChange } : {})}
            {...(fieldFocus?.nodeId === step.sourceId && fieldFocus.fieldPath ? { focusFieldPath: fieldFocus.fieldPath, focusRequest: fieldFocus.request } : {})}
          /> : <p class="inspector-schema-notice">Unknown Control. Restore {control.control.id}@{control.control.version} to edit or publish. Saved inputs are preserved.</p>}
          <dl class="inspector-source-fields"><div><dt>Source ID</dt><dd>{step.sourceId}</dd></div><div><dt>Control</dt><dd>{control.control.id}@{control.control.version}</dd></div></dl>
        </InspectorGroup>
      ) : control?.type === 'wait' && step.sourceId ? (
        <InspectorGroup title="Configuration">
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
            <div><dt>Source ID</dt><dd>{step.sourceId}</dd></div>
            <div><dt>Kind</dt><dd>wait</dd></div>
          </dl>
        </InspectorGroup>
      ) : (control?.type === 'if' || control?.type === 'foreach') && step.sourceId ? (
        <InspectorGroup title="Configuration">
          <ValueExpressionField
            canEdit={canEdit}
            field={control.type === 'if' ? {
              name: 'condition', label: 'Condition', type: 'boolean', schemaType: 'boolean',
              required: true, defaultValue: true,
              description: 'Evaluated before choosing the Then or Else branch.',
            } : {
              name: 'items', label: 'Items', type: 'json', schemaType: 'array',
              required: true, defaultValue: [],
              description: 'An array evaluated once and saved for iteration. The body can reference loop.item and loop.index.',
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
            <div><dt>Source ID</dt><dd>{step.sourceId}</dd></div>
            <div><dt>Kind</dt><dd>{control.type}</dd></div>
            {control.type === 'foreach' ? <div><dt>Concurrency</dt><dd>{control.concurrency ?? 1}</dd></div> : null}
          </dl>
          {stepProblems.length ? <div class="inspector-diagnostics">
            {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{problem.message}</p>)}
          </div> : null}
        </InspectorGroup>
      ) : control?.type === 'capability' && step.sourceId ? (
        <>
          {capabilityDefinition?.connectionRequirements.length ? (
            <InspectorGroup title="Connection">
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
          <InspectorGroup title="Input">
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
              <div class="inspector-schema-notice">
                The Capability contract is unavailable. The Draft reference and existing inputs are preserved.
              </div>
            )}
          </InspectorGroup>
          <InspectorGroup title="Source">
            <p class="inspector-summary">{step.summary}</p>
            <dl class="inspector-source-fields">
              <div><dt>Source ID</dt><dd>{step.sourceId}</dd></div>
              <div><dt>Capability</dt><dd>{control.capability.id}@{control.capability.version}</dd></div>
            </dl>
          </InspectorGroup>
          {stepProblems.length ? (
            <InspectorGroup title="Diagnostics">
              <div class="inspector-diagnostics">
                {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{problem.message}</p>)}
              </div>
            </InspectorGroup>
          ) : null}
        </>
      ) : (
        <InspectorGroup title="Configuration">
          <p class="inspector-summary">{step.summary}</p>
          <dl class="inspector-source-fields">
            <div><dt>Source ID</dt><dd>{step.sourceId ?? step.id}</dd></div>
            <div><dt>Kind</dt><dd>{step.kind ?? 'step'}</dd></div>
          </dl>
          {stepProblems.length ? (
            <div class="inspector-diagnostics">
              {stepProblems.map(problem => <p key={`${problem.code}:${problem.source?.fieldPath ?? ''}`}>{problem.message}</p>)}
            </div>
          ) : null}
        </InspectorGroup>
      )}
    </aside>
  )
}
