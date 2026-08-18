import { isNumenValue, isResourceRef, type NumenValue } from '@numen/core'
import '@numen/database'
import { Service, type Context } from 'cordis'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type Schema from 'schemastery'

export interface CredentialTypeRef {
  id: string
  version: number
}

export interface CredentialTypeDefinition<Secret = Record<string, NumenValue>> extends CredentialTypeRef {
  title: string
  secret: Schema<Secret>
}

export interface CredentialMetadata {
  id: string
  name: string
  type: CredentialTypeRef
  configured: true
  keyId: string
  secretVersion: number
  typeAvailable: boolean
  createdAt: string
  updatedAt: string
}

export interface CredentialSecretSnapshot {
  credentialId: string
  secretVersion: number
  value: Record<string, NumenValue>
}

export interface CredentialConfig {
  keyId?: string
  masterKeyEnv?: string
}

export interface CredentialHealth {
  ready: boolean
  encryptionConfigured: boolean
  count: number
  unavailableTypes: number
}

interface CredentialRow {
  id: string
  name: string
  type_id: string
  type_version: number
  ciphertext: Buffer
  nonce: Buffer
  key_id: string
  secret_version: number
  created_at: string
  updated_at: string
}

export class CredentialNotFoundError extends Error {
  override name = 'CredentialNotFoundError'
}

export class CredentialConflictError extends Error {
  override name = 'CredentialConflictError'

  constructor(public readonly expectedVersion: number, public readonly actualVersion: number) {
    super(`credential secret version conflict: expected ${expectedVersion}, actual ${actualVersion}`)
  }
}

declare module 'cordis' {
  interface Context {
    credentials: CredentialService
  }

  interface Events {
    'numen/credential-change'(credentialId: string, secretVersion: number): void
  }
}

const typeIdPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

function typeKey(ref: CredentialTypeRef): string {
  return `${ref.id}@${ref.version}`
}

function assertSecret(value: unknown): asserts value is Record<string, NumenValue> {
  if (!isNumenValue(value) || !value || typeof value !== 'object' || Array.isArray(value) || isResourceRef(value)) {
    throw new TypeError('credential secret must be a Numen object')
  }
}

function aad(row: Pick<CredentialRow, 'id' | 'type_id' | 'type_version' | 'key_id' | 'secret_version'>): Buffer {
  return Buffer.from(`${row.id}\0${row.type_id}\0${row.type_version}\0${row.key_id}\0${row.secret_version}`, 'utf8')
}

export class CredentialService extends Service {
  static inject = ['database']

  private ready = false
  private masterKey: Buffer | undefined
  private readonly types = new Map<string, CredentialTypeDefinition>()
  private readonly keyId: string
  private readonly masterKeyEnv: string

  constructor(ctx: Context, public config: CredentialConfig = {}) {
    super(ctx, 'credentials')
    this.keyId = config.keyId ?? 'local-v1'
    this.masterKeyEnv = config.masterKeyEnv ?? 'NUMEN_MASTER_KEY'
  }

  async *[Service.init]() {
    const encodedKey = process.env[this.masterKeyEnv]
    if (encodedKey) {
      const key = Buffer.from(encodedKey, 'base64')
      if (key.length !== 32) throw new TypeError('credential master key must decode to 32 bytes')
      this.masterKey = key
    }
    this.ready = true
    yield () => {
      this.ready = false
      this.masterKey?.fill(0)
      this.masterKey = undefined
      this.types.clear()
    }
  }

  defineType(owner: Context, definition: CredentialTypeDefinition): () => void {
    if (!typeIdPattern.test(definition.id)) throw new TypeError(`invalid credential type id: ${definition.id}`)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid credential type version: ${definition.version}`)
    }
    const key = typeKey(definition)
    if (this.types.has(key)) throw new Error(`credential type already defined: ${key}`)
    return owner.effect(() => {
      this.types.set(key, definition)
      return () => {
        this.types.delete(key)
      }
    }, `credentials.defineType(${JSON.stringify(key)})`)
  }

  create(
    nameInput: string,
    type: CredentialTypeRef,
    secretInput: Record<string, NumenValue>,
  ): CredentialMetadata {
    const name = nameInput.trim()
    if (!name) throw new TypeError('credential name is required')
    const definition = this.requireType(type)
    const secret = this.validateSecret(definition, secretInput)
    const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
    const secretVersion = 1
    const encrypted = this.encrypt({
      id: credentialId,
      type_id: type.id,
      type_version: type.version,
      key_id: this.keyId,
      secret_version: secretVersion,
    }, secret)
    const now = new Date().toISOString()
    this.ctx.database.db.prepare(`
      INSERT INTO credentials (
        id, name, type_id, type_version, ciphertext, nonce, key_id,
        secret_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credentialId,
      name,
      type.id,
      type.version,
      encrypted.ciphertext,
      encrypted.nonce,
      this.keyId,
      secretVersion,
      now,
      now,
    )
    this.ctx.emit('numen/credential-change', credentialId, secretVersion)
    return this.get(credentialId)!
  }

  get(credentialId: string): CredentialMetadata | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM credentials WHERE id = ?').get(credentialId) as CredentialRow | undefined
    return row ? this.mapMetadata(row) : undefined
  }

  list(): CredentialMetadata[] {
    return (this.ctx.database.db.prepare('SELECT * FROM credentials ORDER BY updated_at DESC, id').all() as CredentialRow[])
      .map(row => this.mapMetadata(row))
  }

  readSecretSnapshot(credentialId: string): CredentialSecretSnapshot {
    const row = this.requireRow(credentialId)
    const value = this.decrypt(row)
    const definition = this.requireType({ id: row.type_id, version: row.type_version })
    const validated = this.validateSecret(definition, value)
    return { credentialId, secretVersion: row.secret_version, value: validated }
  }

  rotate(
    credentialId: string,
    expectedSecretVersion: number,
    secretInput: Record<string, NumenValue>,
  ): CredentialMetadata {
    const current = this.requireRow(credentialId)
    if (current.secret_version !== expectedSecretVersion) {
      throw new CredentialConflictError(expectedSecretVersion, current.secret_version)
    }
    const definition = this.requireType({ id: current.type_id, version: current.type_version })
    const secret = this.validateSecret(definition, secretInput)
    const nextVersion = expectedSecretVersion + 1
    const encrypted = this.encrypt({
      id: current.id,
      type_id: current.type_id,
      type_version: current.type_version,
      key_id: this.keyId,
      secret_version: nextVersion,
    }, secret)
    const now = new Date().toISOString()
    const result = this.ctx.database.db.prepare(`
      UPDATE credentials
      SET ciphertext = ?, nonce = ?, key_id = ?, secret_version = ?, updated_at = ?
      WHERE id = ? AND secret_version = ?
    `).run(
      encrypted.ciphertext,
      encrypted.nonce,
      this.keyId,
      nextVersion,
      now,
      credentialId,
      expectedSecretVersion,
    )
    if (!result.changes) {
      const latest = this.requireRow(credentialId)
      throw new CredentialConflictError(expectedSecretVersion, latest.secret_version)
    }
    this.ctx.emit('numen/credential-change', credentialId, nextVersion)
    return this.get(credentialId)!
  }

  health(): CredentialHealth {
    const credentials = this.list()
    return {
      ready: this.ready,
      encryptionConfigured: !!this.masterKey,
      count: credentials.length,
      unavailableTypes: credentials.filter(credential => !credential.typeAvailable).length,
    }
  }

  private requireType(ref: CredentialTypeRef): CredentialTypeDefinition {
    const definition = this.types.get(typeKey(ref))
    if (!definition) throw new Error(`credential type not found: ${typeKey(ref)}`)
    return definition
  }

  private validateSecret(
    definition: CredentialTypeDefinition,
    input: Record<string, NumenValue>,
  ): Record<string, NumenValue> {
    assertSecret(input)
    const secret = definition.secret(input)
    assertSecret(secret)
    return secret
  }

  private requireRow(credentialId: string): CredentialRow {
    const row = this.ctx.database.db.prepare('SELECT * FROM credentials WHERE id = ?').get(credentialId) as CredentialRow | undefined
    if (!row) throw new CredentialNotFoundError(`credential not found: ${credentialId}`)
    return row
  }

  private encrypt(
    identity: Pick<CredentialRow, 'id' | 'type_id' | 'type_version' | 'key_id' | 'secret_version'>,
    secret: Record<string, NumenValue>,
  ): { ciphertext: Buffer; nonce: Buffer } {
    if (!this.masterKey) throw new Error(`credential master key is unavailable; set ${this.masterKeyEnv}`)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce)
    cipher.setAAD(aad(identity))
    const body = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce }
  }

  private decrypt(row: CredentialRow): Record<string, NumenValue> {
    if (!this.masterKey) throw new Error(`credential master key is unavailable; set ${this.masterKeyEnv}`)
    if (row.key_id !== this.keyId) throw new Error(`credential key is unavailable: ${row.key_id}`)
    if (row.ciphertext.length < 16) throw new Error('credential ciphertext is invalid')
    const body = row.ciphertext.subarray(0, -16)
    const tag = row.ciphertext.subarray(-16)
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, row.nonce)
    decipher.setAAD(aad(row))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    const value = JSON.parse(plaintext) as unknown
    assertSecret(value)
    return value
  }

  private mapMetadata(row: CredentialRow): CredentialMetadata {
    const type = { id: row.type_id, version: row.type_version }
    return {
      id: row.id,
      name: row.name,
      type,
      configured: true,
      keyId: row.key_id,
      secretVersion: row.secret_version,
      typeAvailable: this.types.has(typeKey(type)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export default CredentialService
