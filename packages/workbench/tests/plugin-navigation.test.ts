import { expect, it } from 'vitest'
import { pluginReturnTarget } from '../src/plugin-navigation.js'
import { coreWorkbenchRoutes, coreWorkbenchRunTimelineRoute } from '../src/routes.js'

it('restores only internal object routes and retains Run list context', () => {
  expect(pluginReturnTarget('/connections?connectionId=connection_1')).toEqual([coreWorkbenchRoutes.connections, { query: { connectionId: 'connection_1' } }])
  expect(pluginReturnTarget('/runs/run_1/timeline?from=status%3DRUNNING%26cursor%3Dpage2')).toEqual([coreWorkbenchRunTimelineRoute,
    { parameters: { id: 'run_1' }, query: { from: 'status=RUNNING&cursor=page2' } }])
  for (const input of ['https://example.com/', '//example.com/', '/\\example.com/', '/\\%', '/\\[', '/plugins?entryId=another', '/runs/%2Fother/flow', '/runs/%ZZ/flow', '/connections#script', '/system']) {
    expect(pluginReturnTarget(input)).toBeUndefined()
  }
})
