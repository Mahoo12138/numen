import type { FrontendExtensionRef } from '@numen/webui/extensions'

export const coreWorkbenchRoutes = {
  home: { id: 'numen:home', version: 1 },
  automations: { id: 'numen:automations', version: 1 },
  runs: { id: 'numen:runs', version: 1 },
  connections: { id: 'numen:connections', version: 1 },
  plugins: { id: 'numen:plugins', version: 1 },
  system: { id: 'numen:system', version: 1 },
} as const satisfies Record<string, FrontendExtensionRef>

export const coreWorkbenchRunRoutes = {
  flow: { id: 'numen:run-flow', version: 1 },
  timeline: { id: 'numen:run-timeline', version: 1 },
  context: { id: 'numen:run-context', version: 1 },
} as const satisfies Record<string, FrontendExtensionRef>

export const coreWorkbenchRunFlowRoute = coreWorkbenchRunRoutes.flow
export const coreWorkbenchRunTimelineRoute = coreWorkbenchRunRoutes.timeline
export const coreWorkbenchRunContextRoute = coreWorkbenchRunRoutes.context

export type CoreWorkbenchActivityId = keyof typeof coreWorkbenchRoutes

const activityByRouteId = new Map<string, CoreWorkbenchActivityId>(
  Object.entries(coreWorkbenchRoutes).map(([activityId, route]) => [route.id, activityId as CoreWorkbenchActivityId]),
)
for (const route of Object.values(coreWorkbenchRunRoutes)) activityByRouteId.set(route.id, 'runs')

export function activityIdForRoute(route?: FrontendExtensionRef): CoreWorkbenchActivityId | undefined {
  if (!route) return
  const activityId = activityByRouteId.get(route.id)
  if (!activityId) return
  const runRoute = Object.values(coreWorkbenchRunRoutes).find(candidate => candidate.id === route.id)
  if (runRoute) {
    return route.version === runRoute.version ? activityId : undefined
  }
  return coreWorkbenchRoutes[activityId].version === route.version ? activityId : undefined
}
