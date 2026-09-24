import type { Context } from 'cordis'
import { coreSchemaLiteralRenderers } from '@numenjs/components'
export { coreSchemaLiteralRenderers, type SchemaLiteralRenderer, type SchemaLiteralRendererProps } from '@numenjs/components'

export function coreWorkbenchSchemaRenderers(ctx: Context): void {
  for (const renderer of coreSchemaLiteralRenderers) ctx.schemaUI.defineRenderer(ctx, renderer)
}
coreWorkbenchSchemaRenderers.inject = ['schemaUI']
export default coreWorkbenchSchemaRenderers
