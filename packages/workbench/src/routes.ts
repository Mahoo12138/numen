import type { FrontendExtensionRef } from '@numen/webui/extensions'

export const coreWorkbenchRoutes = {
  home: { id: 'numen:home', version: 1 },
  automations: { id: 'numen:automations', version: 1 },
  runs: { id: 'numen:runs', version: 1 },
  connections: { id: 'numen:connections', version: 1 },
  plugins: { id: 'numen:plugins', version: 1 },
  system: { id: 'numen:system', version: 1 },
} as const satisfies Record<string, FrontendExtensionRef>

export type CoreWorkbenchActivityId = keyof typeof coreWorkbenchRoutes

const activityByRouteId = new Map<string, CoreWorkbenchActivityId>(
  Object.entries(coreWorkbenchRoutes).map(([activityId, route]) => [route.id, activityId as CoreWorkbenchActivityId]),
)

export function activityIdForRoute(route?: FrontendExtensionRef): CoreWorkbenchActivityId | undefined {
  if (!route) return
  const activityId = activityByRouteId.get(route.id)
  return activityId && coreWorkbenchRoutes[activityId].version === route.version ? activityId : undefined
}
