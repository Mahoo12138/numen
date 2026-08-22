import type { Context } from 'cordis'
import { coreWorkbenchPages } from './pages.js'
import { coreWorkbenchSchemaRenderers } from './SchemaRenderers.js'

export function coreWorkbenchFrontend(ctx: Context): void {
  coreWorkbenchPages(ctx)
  coreWorkbenchSchemaRenderers(ctx)
}

coreWorkbenchFrontend.inject = ['webuiExtensions', 'schemaUI']

export default coreWorkbenchFrontend
