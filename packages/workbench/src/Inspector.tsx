import type { AutomationSource, CompileDiagnostic, ValueExpr } from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { ChevronDown, X } from '@lucide/vue'
import type { SetupContext } from 'vue'
import { CapabilityConnectionFields, CapabilityInputFields } from './CapabilityInspector.js'
import { findAutomationControl } from './automation-source-editing.js'
import type {
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationInsertItem,
  WorkbenchAutomationVariableCatalog,
} from './contracts.js'
import { automationSteps, type AutomationStep } from './model.js'

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
  onCapabilityInputChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
  onWaitDurationChange?(nodeId: string, durationMs: number): void
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
  durationMs,
  replacesUntil,
  canEdit,
  problem,
  focusRequest,
  onChange,
}: {
  nodeId: string
  durationMs: number | undefined
  replacesUntil: boolean
  canEdit: boolean
  problem: CompileDiagnostic | undefined
  focusRequest: number | undefined
  onChange?(nodeId: string, durationMs: number): void
}) {
  const seconds = durationMs === undefined ? '' : String(durationMs / 1_000)
  return (
    <>
      <label class="inspector-edit-field" data-invalid={!!problem}>
        Duration
        <span class="input-with-unit">
          <input
            aria-describedby={problem ? `${nodeId}-duration-problem` : undefined}
            aria-invalid={!!problem}
            aria-label="Wait duration in seconds"
            autofocus={focusRequest !== undefined}
            value={seconds}
            disabled={!canEdit}
            key={`${nodeId}:${durationMs ?? 'empty'}:${focusRequest ?? 'idle'}`}
            min="0"
            onBlur={event => {
              const nextSeconds = Number((event.target as HTMLInputElement).value)
              const nextDurationMs = Math.round(nextSeconds * 1_000)
              if (!(event.target as HTMLInputElement).value || !Number.isFinite(nextSeconds) || nextSeconds < 0) {
                (event.target as HTMLInputElement).value = seconds
                return
              }
              if (nextDurationMs !== durationMs) onChange?.(nodeId, nextDurationMs)
            }}
            onKeydown={event => {
              if (event.key === 'Enter') (event.target as HTMLElement).blur()
            }}
            placeholder={replacesUntil ? 'until expression' : 'seconds'}
            step="0.001"
            type="number"
          />
          <span>s</span>
        </span>
      </label>
      {replacesUntil ? <p class="inspector-field-help">Setting a duration replaces the current until expression.</p> : null}
      {problem ? <p class="inspector-field-error" id={`${nodeId}-duration-problem`}>{problem.message}</p> : null}
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
  onWaitDurationChange,
  onClose,
}: InspectorProps) {
  const projectedSteps = steps ?? automationSteps
  const step = projectedSteps.find(item => item.id === activeStepId) ?? projectedSteps[0]
  const isNotification = !steps && step?.id === 'notification'
  const control = source && step?.sourceId ? findAutomationControl(source, step.sourceId) : undefined
  const stepProblems = step?.sourceId
    ? problems.filter(problem => problem.source?.nodeId === step.sourceId)
    : []
  const durationProblem = stepProblems.find(problem => (
    problem.source?.fieldPath === 'durationMs'
    || (problem.code === 'WAIT_SOURCE_INVALID' && !problem.source?.fieldPath)
  ))
  const durationMs = control?.type === 'wait'
    && control.durationMs?.type === 'literal'
    && typeof control.durationMs.value === 'number'
    ? control.durationMs.value
    : undefined
  const capabilityDefinition = control?.type === 'capability'
    ? catalog?.items.find((item): item is Extract<WorkbenchAutomationInsertItem, { kind: 'capability' }> => item.kind === 'capability'
      && item.capability.id === control.capability.id
      && item.capability.version === control.capability.version)
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
      ) : control?.type === 'wait' && step.sourceId ? (
        <InspectorGroup title="Configuration">
          <WaitConfiguration
            canEdit={canEdit}
            durationMs={durationMs}
            focusRequest={fieldFocus?.nodeId === step.sourceId && fieldFocus.fieldPath === 'durationMs'
              ? fieldFocus.request
              : undefined}
            nodeId={step.sourceId}
            {...(onWaitDurationChange ? { onChange: onWaitDurationChange } : {})}
            problem={durationProblem}
            replacesUntil={!!control.until}
          />
          <dl class="inspector-source-fields">
            <div><dt>Source ID</dt><dd>{step.sourceId}</dd></div>
            <div><dt>Kind</dt><dd>wait</dd></div>
          </dl>
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
