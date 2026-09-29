import { coreWorkbenchRoutes, coreWorkbenchRunRoutes } from './routes.js'
import type { WorkbenchNavigation } from './types.js'

/** Only known internal object routes can be restored from an untrusted deep-link query. */
export function pluginReturnTarget(value: string | null): Parameters<WorkbenchNavigation['navigate']> | undefined {
  if (!value || value.length > 4096 || !value.startsWith('/') || value.startsWith('//')) return
  let url: URL
  try { url = new URL(value, 'http://numen.local') } catch { return }
  if (url.origin !== 'http://numen.local' || url.hash) return
  if (url.pathname === '/connections') return [coreWorkbenchRoutes.connections, { query: { connectionId: url.searchParams.get('connectionId') ?? undefined } }]
  const run = /^\/runs\/([^/]+)\/(flow|timeline|context)$/.exec(url.pathname)
  if (run) {
    let id: string
    try { id = decodeURIComponent(run[1]!) } catch { return }
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return
    return [coreWorkbenchRunRoutes[run[2] as keyof typeof coreWorkbenchRunRoutes], { parameters: { id }, query: { from: url.searchParams.get('from') ?? undefined } }]
  }
}
