import { ChevronDown, X } from 'lucide-react'
import { automationSteps } from './model.js'

export interface InspectorProps {
  activeStepId: string
  open: boolean
  onClose(): void
}

function InspectorGroup({ title, children, open = true }: {
  title: string
  children: React.ReactNode
  open?: boolean
}) {
  return (
    <section className="inspector-group">
      <button className="inspector-group-heading" type="button">
        <span>{title}</span><ChevronDown size={15} data-open={open} />
      </button>
      {open ? <div className="inspector-group-content">{children}</div> : null}
    </section>
  )
}

export function Inspector({ activeStepId, open, onClose }: InspectorProps) {
  const step = automationSteps.find(item => item.id === activeStepId) ?? automationSteps.at(-1)!
  const isNotification = step.id === 'notification'
  return (
    <aside className="inspector" data-open={open} aria-label="Inspector">
      <header className="inspector-header">
        <div><span>STEP {automationSteps.indexOf(step) + 1}</span><h2>{step.label}</h2></div>
        <button aria-label="Close inspector" className="icon-button inspector-close" onClick={onClose} type="button"><X size={17} /></button>
      </header>
      {isNotification ? (
        <>
          <InspectorGroup title="Connection">
            <label>Provider<select defaultValue="Slack"><option>Slack</option></select></label>
            <label>Connection<select defaultValue="Slack (Workspace)"><option>Slack (Workspace)</option></select></label>
            <button className="secondary-button" type="button">Test connection</button>
          </InspectorGroup>
          <InspectorGroup title="Message">
            <label>Channel<select defaultValue="#morning-brief"><option>#morning-brief</option></select></label>
            <label>Message template<textarea defaultValue={'{{ summary }}'} /></label>
            <button className="secondary-button compact" type="button">Insert variable <ChevronDown size={14} /></button>
          </InspectorGroup>
          <InspectorGroup title="Execution policy">
            <label>On failure<select defaultValue="Continue to next step"><option>Continue to next step</option></select></label>
            <label>Retry<select defaultValue="3 attempts"><option>3 attempts</option></select></label>
            <label>Timeout<span className="input-with-unit"><input defaultValue="30" /><span>s</span></span></label>
            <label className="checkbox-row">
              <input defaultChecked type="checkbox" />
              <span>Run step only if previous steps succeeded</span>
            </label>
          </InspectorGroup>
        </>
      ) : (
        <InspectorGroup title="Configuration">
          <p className="inspector-summary">{step.summary}</p>
          <label>Name<input defaultValue={step.label} /></label>
          <label>Status<select defaultValue="Enabled"><option>Enabled</option></select></label>
        </InspectorGroup>
      )}
    </aside>
  )
}
