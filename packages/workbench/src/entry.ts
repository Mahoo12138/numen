import type { Context } from 'cordis'
import { coreWorkbenchPages } from './pages.js'
import { coreWorkbenchSchemaRenderers } from './SchemaRenderers.js'
import { registerWorkbenchLocales } from './i18n.js'

export function coreWorkbenchFrontend(ctx: Context): void {
  registerWorkbenchLocales(ctx)
  coreWorkbenchPages(ctx)
  coreWorkbenchSchemaRenderers(ctx)
}

coreWorkbenchFrontend.inject = ['webuiExtensions', 'schemaUI', 'i18n']

export default coreWorkbenchFrontend
