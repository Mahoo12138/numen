import type { AutomationSource } from '@numen/core'
import { describe, expect, it } from 'vitest'
import { projectAutomationSteps } from '../src/automation-projection.js'

describe('Automation Source projection', () => {
  it('derives a stable read-only step list from structured Source', () => {
    const source: AutomationSource = {
      triggers: [{
        id: 'daily-trigger',
        capability: { id: 'numen.trigger.schedule', version: 1 },
        config: { cron: '0 7 * * *' },
      }],
      flow: {
        type: 'block',
        id: 'root',
        steps: [{
          type: 'if',
          id: 'check-weather',
          condition: { type: 'ref', path: 'trigger.rain' },
          then: {
            type: 'block',
            id: 'rainy-path',
            steps: [{
              type: 'capability',
              id: 'send-alert',
              capability: { id: 'slack.message.send', version: 2 },
              connection: 'conn_slack',
              input: {},
            }],
          },
          else: {
            type: 'block',
            id: 'dry-path',
            steps: [{
              type: 'wait',
              id: 'wait-one-minute',
              durationMs: { type: 'literal', value: 60_000 },
            }],
          },
        }],
      },
    }

    expect(projectAutomationSteps(source).map(item => ({
      id: item.id,
      kind: item.kind,
      depth: item.depth,
      summary: item.summary,
    }))).toEqual([
      { id: 'trigger:daily-trigger', kind: 'trigger', depth: 0, summary: 'Trigger · numen.trigger.schedule@1' },
      { id: 'source:check-weather', kind: 'if', depth: 0, summary: 'If · trigger.rain' },
      { id: 'source:rainy-path', kind: 'block', depth: 1, summary: '1 step' },
      { id: 'source:send-alert', kind: 'capability', depth: 2, summary: 'Capability · slack.message.send@2 · conn_slack' },
      { id: 'source:dry-path', kind: 'block', depth: 1, summary: '1 step' },
      { id: 'source:wait-one-minute', kind: 'wait', depth: 2, summary: 'Wait · 60000' },
    ])
  })

  it('projects an empty root block as an empty Canvas rather than a shadow node', () => {
    expect(projectAutomationSteps({
      triggers: [],
      flow: { type: 'block', id: 'root', steps: [] },
    })).toEqual([])
  })

  it('uses registry presentation metadata without changing Source identity', () => {
    const steps = projectAutomationSteps({
      triggers: [],
      flow: {
        type: 'capability',
        id: 'capability-1',
        capability: { id: 'demo:weather', version: 1 },
        input: {},
      },
    }, [], new Map([['demo:weather@1', 'Weather lookup']]))

    expect(steps[0]).toMatchObject({
      sourceId: 'capability-1',
      label: 'Weather lookup',
      summary: 'Capability · demo:weather@1',
    })
  })
})
