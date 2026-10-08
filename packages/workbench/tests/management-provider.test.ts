import { HostConfigError, type HostConfigApplyRequest, type HostConfigMutationRequest, type HostConfigPreview } from '@numenjs/config'
import { ConsoleProcedureUnavailableError, ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { Context, type Logger } from 'cordis'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchManagementProviderPlugin, workbenchPluginApply, workbenchPluginPreview, workbenchPluginsQuery } from '../src/management-provider.js'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })
const request = (): ConsoleRequestContext => ({ requestId: 'plugin-management-test', principal: { authenticated: true, subject: { type: 'user', id: 'owner' } }, signal: new AbortController().signal,
  logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger })
const mutation: HostConfigMutationRequest = { fingerprint: 'configuration-fingerprint', operation: { kind: 'setConfig', id: 'business-entry', config: { nested: { value: 2 }, futureField: ['preserved'] } } }
const snapshot = { fingerprint: mutation.fingerprint, version: 2 as const, writable: true, safeMode: false, restartRequired: false, entries: [] }
const result = { saved: true, runtimeApplied: true, fingerprint: 'saved-fingerprint', restartRequired: false, snapshot }
const preview = (input: HostConfigMutationRequest, token?: string): HostConfigPreview => ({ ...input, affectedEntryIds: [input.operation.id], impact: { status: 'unknown', operationEffect: 'runtime', computedAt: '2026-10-08T00:00:00.000Z', message: 'Observed scope only.', nodes: [], edges: [], history: [], unknownReasons: [], coverage: [], truncated: false }, ...(token ? { previewToken: token } : {}) })

async function fixture() {
  const root = new Context(); roots.push(root)
  const host = {
    read: vi.fn(async () => snapshot),
    preview: vi.fn(async (input: HostConfigMutationRequest) => preview(input, 'host-issued-proof')),
    apply: vi.fn(async (_input: HostConfigApplyRequest) => result),
    diagnose: vi.fn(async () => []),
  }
  root.provide('hostConfig', host)
  await root.plugin(ConsoleService)
  for (const definition of [workbenchPluginsQuery, workbenchPluginPreview, workbenchPluginApply]) root.console.define(root, definition)
  workbenchManagementProviderPlugin(root)
  const read = () => root.console.query(workbenchPluginsQuery, {}, request())
  const prepare = (input = mutation) => root.console.query<HostConfigMutationRequest, HostConfigPreview>(workbenchPluginPreview, input, request())
  const apply = (input: unknown) => root.console.action(workbenchPluginApply, input, request())
  return { root, host, read, prepare, apply }
}

describe('Workbench Host management transport', () => {
  it('forwards an issued proof with the exact operation and leaves forged proof decisions to Host', async () => {
    const { host, read, prepare, apply } = await fixture()
    const calls: string[] = []
    host.read.mockImplementation(async () => { calls.push('read'); return snapshot })
    host.preview.mockImplementation(async input => { calls.push('preview'); return preview(input, 'host-issued-proof') })
    host.apply.mockImplementation(async input => {
      calls.push('apply')
      if (input.previewToken !== 'host-issued-proof') throw new HostConfigError('PREVIEW_STALE', 'Review the current impact before applying.')
      return result
    })
    expect(await read()).toEqual(snapshot)
    const prepared = await prepare()
    expect(host.preview).toHaveBeenCalledWith(mutation)
    expect(host.apply).not.toHaveBeenCalled()
    const approved = { ...mutation, previewToken: prepared.previewToken! }
    expect(await apply(approved)).toEqual(result)
    expect(host.apply).toHaveBeenLastCalledWith(approved)
    const forged = { ...mutation, previewToken: 'not-issued-by-host' }
    await expect(apply(forged)).rejects.toMatchObject({ status: 409, code: 'PREVIEW_STALE', details: { saved: false } })
    expect(host.apply).toHaveBeenLastCalledWith(forged)
    expect(calls).toEqual(['read', 'preview', 'apply', 'apply'])
  })

  it.each([undefined, '', 'x'.repeat(257), false, 42])('rejects invalid Apply proof %s before calling Host', async token => {
    const { host, apply } = await fixture()
    await expect(apply({ ...mutation, ...(token === undefined ? {} : { previewToken: token }) })).rejects.toBeInstanceOf(z.ValidationError)
    expect(host.apply).not.toHaveBeenCalled()
    expect(host.preview).not.toHaveBeenCalled()
  })

  it.each(['x', 'x'.repeat(256)])('passes valid proof-length boundaries to Host without rewriting the proof', async previewToken => {
    const { host, apply } = await fixture()
    const input = { ...mutation, previewToken }
    await apply(input)
    expect(host.apply).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('preserves blocked Preview without issuing a proof and rejects a direct management shutdown at Host', async () => {
    const { host, prepare, apply } = await fixture()
    const operation = { fingerprint: mutation.fingerprint, operation: { kind: 'setEnabled' as const, id: 'group-management', enabled: false } }
    host.preview.mockImplementation(async input => ({ ...preview(input), blockedReason: 'The current management channel is protected.' }))
    host.apply.mockRejectedValue(new HostConfigError('MANAGEMENT_CHANNEL_PROTECTED', 'The current management channel is protected.'))
    const blocked = await prepare(operation)
    expect(blocked).toHaveProperty('blockedReason')
    expect(blocked).not.toHaveProperty('previewToken')
    await expect(apply(operation)).rejects.toBeInstanceOf(z.ValidationError)
    expect(host.apply).not.toHaveBeenCalled()
    await expect(apply({ ...operation, previewToken: 'forged' })).rejects.toMatchObject({ status: 400, code: 'MANAGEMENT_CHANNEL_PROTECTED', details: { saved: false } })
  })

  it('marks known Host rejections unsaved while keeping unexpected failures outcome-unknown and sanitized', async () => {
    const { host, apply, prepare } = await fixture()
    const input = { ...mutation, previewToken: 'host-issued-proof' }
    for (const code of ['PREVIEW_STALE', 'CONFIG_CONFLICT']) {
      host.apply.mockRejectedValueOnce(new HostConfigError(code, 'Refresh and review the pending edit.'))
      await expect(apply(input)).rejects.toMatchObject({ status: 409, code, details: { saved: false } })
    }
    host.apply.mockRejectedValueOnce(new Error('/private/host/config.yml contains SECRET_CANARY'))
    const failure = await apply(input).catch(error => error)
    expect(failure).toBeInstanceOf(ConsoleProcedureUnavailableError)
    expect(failure).toMatchObject({ name: 'ConsoleProcedureUnavailableError' })
    expect(failure.details).toBeUndefined()
    expect(failure.message).not.toMatch(/private|SECRET_CANARY/)
    host.preview.mockRejectedValueOnce(new HostConfigError('CONFIG_CONFLICT', 'Refresh the configuration.'))
    const queryFailure = await prepare().catch(error => error)
    expect(queryFailure).toMatchObject({ status: 409, code: 'CONFIG_CONFLICT' })
    expect(queryFailure.details).toBeUndefined()
  })
})
