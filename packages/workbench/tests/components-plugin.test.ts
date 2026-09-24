import { Context } from 'cordis'
import { BrowserExtensionRegistry, SchemaUIRegistry } from '@numenjs/webui'
import { describe, expect, it } from 'vitest'
import componentsFrontend, { ComponentsPage } from '../../../examples/components-plugin/src/client.js'
import { SelectMenu as WorkbenchSelectMenu } from '../src/SelectMenu.js'
import { SelectMenu, StringLiteralEditor, coreSchemaLiteralRenderers } from '@numenjs/components'
import { coreWorkbenchSchemaRenderers } from '../src/SchemaRenderers.js'

describe('public components in host and plugin Entries', () => {
  it('uses identical component implementations, retains host renderers after plugin unload, and can reload', async () => {
    expect(WorkbenchSelectMenu).toBe(SelectMenu)
    const root = new Context()
    try {
      await root.plugin(BrowserExtensionRegistry)
      await root.plugin(SchemaUIRegistry)
      await root.plugin(coreWorkbenchSchemaRenderers)
      expect(root.schemaUI.resolveRenderer({ type: 'string' }, 'editor')).toBe(StringLiteralEditor)
      expect(coreSchemaLiteralRenderers).toHaveLength(7)
      const first = await root.plugin(componentsFrontend)
      expect(root.webuiExtensions.getPage({ id: 'example:components', version: 1 })?.component).toBe(ComponentsPage)
      await first.dispose()
      expect(root.webuiExtensions.listPages()).toEqual([])
      expect(root.schemaUI.resolveRenderer({ type: 'string' }, 'editor')).toBe(StringLiteralEditor)
      const second = await root.plugin(componentsFrontend)
      expect(root.webuiExtensions.listPages()).toHaveLength(1)
      await second.dispose()
      expect(root.webuiExtensions.listPages()).toEqual([])
    } finally { await root.fiber.dispose() }
  })
})
