import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { Context, type Logger } from 'cordis'
import { expect, it, vi } from 'vitest'
import { workbenchPluginOwnershipProviderPlugin, workbenchPluginOwnershipQuery } from '../src/plugin-ownership-provider.js'

it('uses the immutable instruction, fences foreign executions, distinguishes missing connections and sanitizes host failures', async () => {
  const root = new Context()
  const diagnose = vi.fn(async refs => refs.map(ref => ({ ...ref, owners: [] })))
  const connection = { adapter: { id: 'fixture:adapter', version: 2 }, type: { id: 'fixture:type', version: 1 }, config: { password: 'secret-config' } }
  const inspectExecution = vi.fn((runId, executionId) => runId === 'run' && executionId === 'execution' ? { execution: { instructionId: 'invoke', resolvedInput: 'secret-input' } } : undefined)
  root.provide('hostConfig', { diagnose })
  root.provide('connections', { get: (id: string) => id === 'current' ? connection : undefined })
  root.provide('scheduler', { getRunIdentity: (id: string) => id === 'run' ? { id, revisionId: 'immutable' } : undefined, inspectExecution })
  const getRevision = vi.fn((id: string) => id === 'immutable' ? { compiledPlan: { instructions: { invoke: {
    op: 'invoke', capability: { id: 'fixture:original', version: 1 }, connections: { a: 'current', b: 'current', c: 'deleted' },
  } } } } : undefined)
  root.provide('automations', { getRevision, getDraft() { throw new Error('Draft must not be read') } })
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchPluginOwnershipQuery)
  workbenchPluginOwnershipProviderPlugin(root)
  const request: ConsoleRequestContext = { requestId: 'ownership-test', principal: { authenticated: true, subject: { type: 'user', id: 'owner' } }, signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger }
  try {
    const result = await root.console.query(workbenchPluginOwnershipQuery, { kind: 'execution', runId: 'run', executionId: 'execution' }, request)
    expect(result).toEqual({ registrations: [
      { kind: 'capability', id: 'fixture:original', version: 1, owners: [] },
      { kind: 'connection-adapter', id: 'fixture:adapter', version: 2, owners: [] },
      { kind: 'connection-type', id: 'fixture:type', version: 1, owners: [] },
    ], missingConnectionIds: ['deleted'] })
    expect(inspectExecution).toHaveBeenCalledWith('run', 'execution', 1)
    expect(JSON.stringify(result)).not.toContain('secret-')
    await expect(root.console.query(workbenchPluginOwnershipQuery, { kind: 'execution', runId: 'run', executionId: 'foreign' }, request)).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' })
    expect(diagnose).toHaveBeenCalledTimes(1)
    await expect(root.console.query(workbenchPluginOwnershipQuery, { kind: 'connection', connectionId: 'deleted' }, request)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })
    diagnose.mockRejectedValueOnce(new Error('/private/config.yml contains secret-input'))
    await expect(root.console.query(workbenchPluginOwnershipQuery, { kind: 'connection', connectionId: 'current' }, request)).rejects.toMatchObject({ name: 'ConsoleProcedureUnavailableError', message: expect.not.stringContaining('private') })
    await root.console.query(workbenchPluginOwnershipQuery, { kind: 'connection', connectionId: 'current' }, request)
    root.set('connections', undefined)
    await expect(root.console.query(workbenchPluginOwnershipQuery, { kind: 'connection', connectionId: 'current' }, request)).rejects.toMatchObject({ name: 'ConsoleProcedureUnavailableError', message: 'Connection diagnostics are unavailable.' })
  } finally { await root.fiber.dispose() }
})
