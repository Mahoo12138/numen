import type { AutomationSource } from '@numen/core'
import { describe, expect, it } from 'vitest'
import {
  insertTemplateReference,
  magicVariableExpression,
  projectMagicVariables,
} from '../src/automation-variable-catalog.js'
import type {
  WorkbenchAutomationInputField,
  WorkbenchAutomationVariableCatalog,
} from '../src/contracts.js'

const catalog: WorkbenchAutomationVariableCatalog = {
  definitions: [
    {
      capability: { id: 'test:event', version: 1 },
      capabilityKind: 'trigger',
      title: 'Incoming event',
      outputSchemaSupported: true,
      outputFields: [
        { path: [], label: 'Output', valueType: 'object', schemaType: 'object' },
        { path: ['title'], label: 'Title', valueType: 'string', schemaType: 'string' },
      ],
    },
    {
      capability: { id: 'test:lookup', version: 1 },
      capabilityKind: 'query',
      title: 'Lookup',
      outputSchemaSupported: true,
      outputFields: [
        { path: [], label: 'Output', valueType: 'object', schemaType: 'object' },
        { path: ['name'], label: 'Name', valueType: 'string', schemaType: 'string' },
        { path: ['count'], label: 'Count', valueType: 'number', schemaType: 'number' },
      ],
    },
  ],
}

const stringField: WorkbenchAutomationInputField = {
  name: 'message',
  label: 'Message',
  type: 'string',
  schemaType: 'string',
  required: true,
}

function capability(id: string) {
  return {
    type: 'capability' as const,
    id,
    capability: { id: 'test:lookup', version: 1 },
    input: {},
  }
}

describe('scope-aware Automation variable projection', () => {
  it('includes trigger, ancestor, and same-branch prior outputs but excludes later and sibling-branch steps', () => {
    const source: AutomationSource = {
      triggers: [{ id: 'event', capability: { id: 'test:event', version: 1 }, config: {} }],
      flow: {
        type: 'block',
        id: 'root',
        steps: [
          capability('outside-before'),
          {
            type: 'if',
            id: 'branch',
            condition: { type: 'literal', value: true },
            then: {
              type: 'block',
              id: 'then',
              steps: [capability('inside-before'), capability('target'), capability('inside-later')],
            },
            else: {
              type: 'block',
              id: 'else',
              steps: [capability('sibling-branch')],
            },
          },
          capability('outside-later'),
        ],
      },
    }

    const variables = projectMagicVariables({ source, nodeId: 'target', field: stringField, catalog, mode: 'reference' })
    const paths = variables.map(item => item.path)

    expect(paths).toContain('trigger.title')
    expect(paths).toContain('steps.outside-before.name')
    expect(paths).toContain('steps.inside-before.name')
    expect(paths).toContain('steps.inside-before.count')
    expect(paths).toContain('run.id')
    expect(paths).not.toContain('trigger')
    expect(paths).not.toContain('steps.inside-later.name')
    expect(paths).not.toContain('steps.sibling-branch.name')
    expect(paths).not.toContain('steps.outside-later.name')
    expect(variables.find(item => item.path === 'steps.inside-before.count')).toMatchObject({
      compatibility: 'conversion',
      conversion: 'core:to-string',
    })
  })

  it('adds loop bindings only inside ForEach and filters them by the target type', () => {
    const source: AutomationSource = {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'items',
        items: { type: 'literal', value: [] },
        body: { type: 'block', id: 'body', steps: [capability('target')] },
      },
    }
    const numberField: WorkbenchAutomationInputField = {
      name: 'count', label: 'Count', type: 'number', schemaType: 'number', required: true,
    }

    expect(projectMagicVariables({ source, nodeId: 'target', field: numberField, catalog, mode: 'reference' }))
      .toContainEqual(expect.objectContaining({ path: 'loop.index', valueType: 'number', compatibility: 'direct' }))
    expect(projectMagicVariables({ source, nodeId: 'target', field: numberField, catalog, mode: 'reference' }).map(item => item.path))
      .not.toContain('loop.item')
    expect(projectMagicVariables({ source, nodeId: 'target', field: stringField, catalog, mode: 'template' }).map(item => item.path))
      .toContain('loop.item')
  })

  it('creates typed reference/conversion expressions and inserts template tokens at the selection', () => {
    expect(magicVariableExpression({
      path: 'steps.lookup.count',
      label: 'Count',
      sourceLabel: 'Lookup',
      group: 'steps',
      valueType: 'number',
      compatibility: 'conversion',
      conversion: 'core:to-string',
    })).toEqual({
      type: 'call',
      function: 'core:to-string',
      arguments: [{ type: 'ref', path: 'steps.lookup.count' }],
    })
    expect(insertTemplateReference('Hello !', 'trigger.title', 6, 6)).toEqual({
      value: 'Hello {{ trigger.title }}!',
      cursor: 25,
    })
  })
})
