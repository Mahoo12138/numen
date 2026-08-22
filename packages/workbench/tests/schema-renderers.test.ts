import { BrowserExtensionRegistry, SchemaUIRegistry } from '@numen/webui'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  parseAutomationTemplate,
  printAutomationTemplate,
} from '../src/CapabilityInspector.js'
import { coreWorkbenchFrontend } from '../src/entry.js'

describe('Workbench Schema UI adapters', () => {
  it('registers core Literal renderers with the frontend Entry Fiber', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(SchemaUIRegistry)
    const fiber = await root.plugin(coreWorkbenchFrontend)

    for (const type of ['string', 'number', 'boolean', 'enum', 'json']) {
      expect(root.schemaUI.resolveRenderer({ type }, 'editor')).toBeTypeOf('function')
    }
    expect(root.schemaUI.resolveRenderer({ role: 'numen/expression', type: 'string' }, 'editor')).toBeTypeOf('function')

    await fiber.dispose()
    expect(root.schemaUI.resolveRenderer({ type: 'string' }, 'editor')).toBeUndefined()
    expect(root.webuiExtensions.listPages()).toEqual([])
    await root.fiber.dispose()
  })

  it('parses and prints structured templates without evaluating JavaScript', () => {
    const expression = parseAutomationTemplate('Hello {{ trigger.name }} from {{ steps.lookup.city }}')
    expect(expression).toEqual({
      type: 'template',
      parts: ['Hello ', { ref: 'trigger.name' }, ' from ', { ref: 'steps.lookup.city' }],
    })
    expect(printAutomationTemplate(expression)).toBe('Hello {{ trigger.name }} from {{ steps.lookup.city }}')
    expect(() => parseAutomationTemplate('Hello {{ process.exit }}')).toThrow('Invalid reference path')
    expect(() => parseAutomationTemplate('Hello {{ trigger.name')).toThrow('Template braces')
  })
})
