import { ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { CredentialService } from '@numen/credentials'
import { ConnectionService } from '@numen/connections'
import { DatabaseService } from '@numen/database'
import { Context, type Logger } from 'cordis'
import { randomBytes } from 'node:crypto'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import {
  workbenchCredentialsIndexQuery, workbenchCreateCredentialAction, workbenchRotateCredentialAction,
  workbenchDeleteCredentialAction, workbenchCredentialsProviderPlugin,
} from '../src/credentials-provider.js'

const roots: Context[] = []
const keyEnv = 'NUMEN_WORKBENCH_CREDENTIAL_QA_KEY'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())); delete process.env[keyEnv] })
const request = (): ConsoleRequestContext => ({
  requestId: 'credential-request', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
  signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
})
async function setup(encrypted = true) {
  if (encrypted) process.env[keyEnv] = randomBytes(32).toString('base64')
  const root = new Context(); roots.push(root)
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CredentialService, { masterKeyEnv: keyEnv })
  await root.plugin(ConnectionService)
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchCredentialsIndexQuery)
  root.console.define(root, workbenchCreateCredentialAction)
  root.console.define(root, workbenchRotateCredentialAction)
  root.console.define(root, workbenchDeleteCredentialAction)
  const plugin = (ctx: Context) => workbenchCredentialsProviderPlugin(ctx)
  plugin.inject = ['console', 'credentials']
  const fiber = await root.plugin(plugin)
  const definition = { id: 'test:token', version: 1, title: 'API token', secret: z.object({
    token: z.string().pattern(/^valid-/).required().description('private-example').default('private-default'),
  }) }
  const undefine = root.credentials.defineType(root, definition)
  return { root, fiber, definition, undefine }
}

describe('Workbench Credential Provider', () => {
  it('creates and rotates with metadata-only reads/results and fenced deletion', async () => {
    const { root, fiber, definition } = await setup()
    const created = await root.console.action(workbenchCreateCredentialAction, {
      name: 'Primary token', typeId: definition.id, typeVersion: 1, secret: { token: 'valid-sensitive-value' },
    }, request())
    const index = await root.console.query(workbenchCredentialsIndexQuery, {}, request())
    expect(index).toMatchObject({ encryptionConfigured: true, items: [{ secretVersion: 1, connectionCount: 0 }], types: [{
      secretSchemaSupported: true, secretFields: [{ name: 'token', type: 'string' }],
    }] })
    expect(JSON.stringify([created, index])).not.toMatch(/valid-sensitive-value|private-example|private-default|ciphertext|keyId/)
    const rotated = await root.console.action(workbenchRotateCredentialAction, {
      credentialId: created.credential.id, expectedSecretVersion: 1, secret: { token: 'valid-rotated' },
    }, request())
    expect(rotated.credential.secretVersion).toBe(2)
    expect(JSON.stringify(rotated)).not.toContain('valid-rotated')
    await expect(root.console.action(workbenchRotateCredentialAction, {
      credentialId: created.credential.id, expectedSecretVersion: 1, secret: { token: 'valid-stale' },
    }, request())).rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_VERSION_CONFLICT', details: { actualSecretVersion: 2 } })
    const adapter = { id: 'test:api', version: 1, title: 'API', config: z.object({}), credentialType: definition.id }
    root.connections.defineAdapter(root, adapter)
    const connection = root.connections.create({ name: 'Bound', adapter, config: {}, credentialId: created.credential.id })
    await expect(root.console.action(workbenchDeleteCredentialAction, {
      credentialId: created.credential.id, expectedSecretVersion: 2,
    }, request())).rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_IN_USE' })
    expect((await root.console.query(workbenchCredentialsIndexQuery, {}, request())).items[0]?.connectionCount).toBe(1)
    root.connections.remove(connection.id, connection.generation)
    await expect(root.console.action(workbenchDeleteCredentialAction, {
      credentialId: created.credential.id, expectedSecretVersion: 1,
    }, request())).rejects.toMatchObject({ code: 'CREDENTIAL_VERSION_CONFLICT' })
    await root.console.action(workbenchDeleteCredentialAction, { credentialId: created.credential.id, expectedSecretVersion: 2 }, request())
    expect(root.credentials.list()).toEqual([])
    await fiber.dispose()
    expect(root.console.get(workbenchCredentialsIndexQuery)).toMatchObject({ providerAvailable: false })
  })

  it('sanitizes schema errors and preserves unavailable-type metadata with deletion still available', async () => {
    const { root, definition, undefine } = await setup()
    const secret = 'must-never-appear-in-error'
    await expect(root.console.action(workbenchCreateCredentialAction, {
      name: 'Invalid', typeId: definition.id, typeVersion: 1, secret: { token: secret },
    }, request())).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID', message: 'Review the Credential fields and try again.' })
    const credential = root.credentials.create('Unload', definition, { token: 'valid-token' })
    undefine()
    expect(await root.console.query(workbenchCredentialsIndexQuery, {}, request())).toMatchObject({ types: [], items: [{ typeAvailable: false }] })
    await expect(root.console.action(workbenchRotateCredentialAction, {
      credentialId: credential.id, expectedSecretVersion: 1, secret: { token: 'valid-next' },
    }, request())).rejects.toMatchObject({ code: 'CREDENTIAL_TYPE_UNAVAILABLE' })
    await root.console.action(workbenchDeleteCredentialAction, { credentialId: credential.id, expectedSecretVersion: 1 }, request())
    await expect(root.console.action(workbenchDeleteCredentialAction, { credentialId: credential.id, expectedSecretVersion: 1 }, request())).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' })
  })

  it('reports missing encryption without exposing environment configuration', async () => {
    const { root, definition } = await setup(false)
    expect((await root.console.query(workbenchCredentialsIndexQuery, {}, request())).encryptionConfigured).toBe(false)
    await expect(root.console.action(workbenchCreateCredentialAction, {
      name: 'No key', typeId: definition.id, typeVersion: 1, secret: { token: 'valid-secret' },
    }, request())).rejects.toMatchObject({ code: 'CREDENTIAL_KEY_UNAVAILABLE', message: 'Credential encryption is not configured.' })
  })
})
