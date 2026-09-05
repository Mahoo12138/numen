import {
  CredentialConflictError,
  CredentialInUseError,
  CredentialKeyUnavailableError,
  CredentialNotFoundError,
  CredentialTypeUnavailableError,
  CredentialValidationError,
  type CredentialMetadata,
} from '@numen/credentials'
import type { NumenValue } from '@numen/core'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numen/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchCredentialsIndexQueryRef,
  workbenchCreateCredentialActionRef,
  workbenchRotateCredentialActionRef,
  workbenchDeleteCredentialActionRef,
  type WorkbenchCredential,
  type WorkbenchCredentialsIndex,
  type WorkbenchCreateCredentialInput,
  type WorkbenchRotateCredentialInput,
  type WorkbenchDeleteCredentialInput,
  type WorkbenchCredentialMutationResult,
  type WorkbenchDeleteCredentialResult,
} from './contracts.js'
import { humanizeFieldName } from './schema-field-projection.js'

const version = z.number().step(1).min(1).required()
const credentialSchema = z.object({
  id: z.string().required(), name: z.string().required(),
  typeId: z.string().required(), typeVersion: version, typeTitle: z.string().required(),
  typeAvailable: z.boolean().required(), secretVersion: version,
  connectionCount: z.number().min(0).required(),
  createdAt: z.string().required(), updatedAt: z.string().required(),
})

export const workbenchCredentialsIndexQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchCredentialsIndex> = {
  ...workbenchCredentialsIndexQueryRef, kind: 'query', title: 'Workbench Credentials index',
  input: z.object({}),
  output: z.object({
    encryptionConfigured: z.boolean().required(),
    items: z.array(credentialSchema).required(),
    types: z.array(z.object({
      id: z.string().required(), version, title: z.string().required(),
      secretSchemaSupported: z.boolean().required(),
      secretFields: z.array(z.object({
        name: z.string().required(), label: z.string().required(),
        type: z.union(['string', 'number', 'boolean', 'json']).required(),
        required: z.boolean().required(),
      })).required(),
    })).required(),
  }),
}

// Secret shape validation belongs to CredentialService. Schema error text may echo values.
const secret = z.any<Record<string, NumenValue>>().required()
export const workbenchCreateCredentialAction: ConsoleActionDefinition<WorkbenchCreateCredentialInput, WorkbenchCredentialMutationResult> = {
  ...workbenchCreateCredentialActionRef, kind: 'action', title: 'Create Credential',
  input: z.object({ name: z.string().required(), typeId: z.string().required(), typeVersion: version, secret }),
  output: z.object({ credential: credentialSchema.required() }),
}
export const workbenchRotateCredentialAction: ConsoleActionDefinition<WorkbenchRotateCredentialInput, WorkbenchCredentialMutationResult> = {
  ...workbenchRotateCredentialActionRef, kind: 'action', title: 'Rotate Credential',
  input: z.object({ credentialId: z.string().required(), expectedSecretVersion: version, secret }),
  output: z.object({ credential: credentialSchema.required() }),
}
export const workbenchDeleteCredentialAction: ConsoleActionDefinition<WorkbenchDeleteCredentialInput, WorkbenchDeleteCredentialResult> = {
  ...workbenchDeleteCredentialActionRef, kind: 'action', title: 'Delete Credential',
  input: z.object({ credentialId: z.string().required(), expectedSecretVersion: version }),
  output: z.object({ credentialId: z.string().required() }),
}

function projectCredential(ctx: Context, credential: CredentialMetadata): WorkbenchCredential {
  const definition = ctx.credentials.listTypes().find(type => type.id === credential.type.id && type.version === credential.type.version)
  return {
    id: credential.id, name: credential.name,
    typeId: credential.type.id, typeVersion: credential.type.version,
    typeTitle: definition?.title ?? credential.type.id, typeAvailable: credential.typeAvailable,
    secretVersion: credential.secretVersion, connectionCount: credential.connectionCount,
    createdAt: credential.createdAt, updatedAt: credential.updatedAt,
  }
}

function publicError(error: unknown): never {
  if (error instanceof CredentialConflictError) throw new ConsoleProcedureError(409, 'CREDENTIAL_VERSION_CONFLICT', 'The Credential changed.', {
    expectedSecretVersion: error.expectedVersion, actualSecretVersion: error.actualVersion,
  })
  if (error instanceof CredentialInUseError) throw new ConsoleProcedureError(409, 'CREDENTIAL_IN_USE', 'Remove Connection bindings before deleting this Credential.', { connectionCount: error.connectionCount })
  if (error instanceof CredentialNotFoundError) throw new ConsoleProcedureError(404, 'CREDENTIAL_NOT_FOUND', 'The Credential was not found.')
  if (error instanceof CredentialKeyUnavailableError) throw new ConsoleProcedureError(422, 'CREDENTIAL_KEY_UNAVAILABLE', 'Credential encryption is not configured.')
  if (error instanceof CredentialTypeUnavailableError) throw new ConsoleProcedureError(422, 'CREDENTIAL_TYPE_UNAVAILABLE', 'The Credential type is unavailable.')
  if (error instanceof TypeError || error instanceof CredentialValidationError) throw new ConsoleProcedureError(422, 'CREDENTIAL_INVALID', 'Review the Credential fields and try again.')
  throw error
}

export function workbenchCredentialsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchCredentialsIndexQueryRef, {
    query() {
      return {
        encryptionConfigured: ctx.credentials.health().encryptionConfigured,
        items: ctx.credentials.list().map(credential => projectCredential(ctx, credential)),
        types: ctx.credentials.listTypes().map(definition => ({
          id: definition.id, version: definition.version, title: definition.title,
          secretSchemaSupported: definition.secret.type === 'object' && !!definition.secret.dict,
          // Deliberately omit defaults, options, examples, and descriptions from secret Schemas.
          secretFields: definition.secret.type === 'object' ? Object.entries(definition.secret.dict ?? {}).map(([name, schema]) => ({
            name, label: humanizeFieldName(name), required: !!schema.meta.required,
            type: schema.type === 'string' || schema.type === 'number' || schema.type === 'boolean' ? schema.type : 'json' as const,
          })) : [],
        })),
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchCreateCredentialActionRef, {
    action({ input }: { input: WorkbenchCreateCredentialInput }) {
      try { return { credential: projectCredential(ctx, ctx.credentials.create(input.name, { id: input.typeId, version: input.typeVersion }, input.secret)) } }
      catch (error) { return publicError(error) }
    },
  })
  ctx.console.provideAction(ctx, workbenchRotateCredentialActionRef, {
    action({ input }: { input: WorkbenchRotateCredentialInput }) {
      try { return { credential: projectCredential(ctx, ctx.credentials.rotate(input.credentialId, input.expectedSecretVersion, input.secret)) } }
      catch (error) { return publicError(error) }
    },
  })
  ctx.console.provideAction(ctx, workbenchDeleteCredentialActionRef, {
    action({ input }: { input: WorkbenchDeleteCredentialInput }) {
      try { ctx.credentials.remove(input.credentialId, input.expectedSecretVersion); return { credentialId: input.credentialId } }
      catch (error) { return publicError(error) }
    },
  })
}
workbenchCredentialsProviderPlugin.inject = ['workbench', 'console', 'credentials']
