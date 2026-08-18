import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialConflictError,
  CredentialService,
  type CredentialTypeDefinition,
} from '../src/index.js'

const directories: string[] = []
const masterKeyEnv = 'NUMEN_TEST_MASTER_KEY'

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  delete process.env[masterKeyEnv]
})

const type: CredentialTypeDefinition = {
  id: 'test:token',
  version: 1,
  title: 'API token',
  secret: z.object({ token: z.string().required() }),
}

async function createContext(path: string, masterKey?: string): Promise<Context> {
  if (masterKey) process.env[masterKeyEnv] = masterKey
  else delete process.env[masterKeyEnv]
  const root = new Context()
  await root.plugin(DatabaseService, { path })
  await root.plugin(CredentialService, { keyId: 'test-key', masterKeyEnv })
  root.credentials.defineType(root, type)
  return root
}

describe('CredentialService', () => {
  it('encrypts the entire payload, exposes metadata, and rotates by secret version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-credentials-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const masterKey = randomBytes(32).toString('base64')
    const root = await createContext(databasePath, masterKey)
    const credential = root.credentials.create('Primary token', type, { token: 'super-secret-value' })
    expect(credential).toMatchObject({
      configured: true,
      keyId: 'test-key',
      secretVersion: 1,
      typeAvailable: true,
    })
    expect(credential).not.toHaveProperty('token')
    const stored = root.database.db.prepare(`
      SELECT ciphertext, nonce FROM credentials WHERE id = ?
    `).get(credential.id) as { ciphertext: Buffer; nonce: Buffer }
    expect(stored.nonce).toHaveLength(12)
    expect(stored.ciphertext.toString('utf8')).not.toContain('super-secret-value')
    expect(root.credentials.readSecretSnapshot(credential.id)).toEqual({
      credentialId: credential.id,
      secretVersion: 1,
      value: { token: 'super-secret-value' },
    })

    const rotated = root.credentials.rotate(credential.id, 1, { token: 'rotated-secret' })
    expect(rotated.secretVersion).toBe(2)
    expect(() => root.credentials.rotate(credential.id, 1, { token: 'stale-secret' }))
      .toThrow(CredentialConflictError)
    expect(root.credentials.readSecretSnapshot(credential.id).value).toEqual({ token: 'rotated-secret' })
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, masterKey)
    expect(restarted.credentials.readSecretSnapshot(credential.id)).toMatchObject({
      secretVersion: 2,
      value: { token: 'rotated-secret' },
    })
    await restarted.fiber.dispose()
  })

  it('refuses secret writes when no external master key is configured', async () => {
    const root = await createContext(':memory:')
    expect(root.credentials.health()).toMatchObject({ ready: true, encryptionConfigured: false })
    expect(() => root.credentials.create('Missing key', type, { token: 'secret' }))
      .toThrow('master key is unavailable')
    expect(root.credentials.list()).toEqual([])
    await root.fiber.dispose()
  })

  it('rejects authenticated ciphertext tampering', async () => {
    const masterKey = randomBytes(32).toString('base64')
    const root = await createContext(':memory:', masterKey)
    const credential = root.credentials.create('Tamper test', type, { token: 'protected' })
    const row = root.database.db.prepare('SELECT ciphertext FROM credentials WHERE id = ?').get(credential.id) as {
      ciphertext: Buffer
    }
    const tampered = Buffer.from(row.ciphertext)
    tampered[0] = tampered[0]! ^ 1
    root.database.db.prepare('UPDATE credentials SET ciphertext = ? WHERE id = ?').run(tampered, credential.id)
    expect(() => root.credentials.readSecretSnapshot(credential.id)).toThrow()
    await root.fiber.dispose()
  })
})
