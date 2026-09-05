import { describe, expect, it, vi } from 'vitest'
import { CredentialConfigurationPanel } from '../src/CredentialConfigurationPanel.js'
import type { WorkbenchCredential, WorkbenchCredentialType } from '../src/contracts.js'
import { renderToMarkup } from './render.js'

const type: WorkbenchCredentialType = { id: 'test:token', version: 1, title: 'API token', secretSchemaSupported: true,
  secretFields: [{ name: 'token', label: 'Token', type: 'string', required: true }] }
const credential: WorkbenchCredential = { id: 'cred_one', name: 'Primary token', typeId: type.id, typeVersion: 1,
  typeTitle: type.title, typeAvailable: true, secretVersion: 4, connectionCount: 1,
  createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }

describe('Credential configuration UI', () => {
  it('uses empty masked fields for complete replacement and protects bound deletion', async () => {
    const markup = await renderToMarkup(<CredentialConfigurationPanel
      credential={credential} types={[type]} encryptionConfigured onClose={vi.fn()} onChanged={vi.fn()} />)
    expect(markup).toContain('version 4')
    expect(markup).toContain('Current values cannot be read back.')
    expect(markup).toMatch(/type="password"[^>]*value(?:="")?[ >]/)
    expect(markup).toContain('autocomplete="new-password"')
    expect(markup).toContain('Used by 1 Connection.')
    expect(markup).toMatch(/disabled[^>]*>Delete<\/button>/)
  })
  it('explains unavailable type and encryption while retaining metadata', async () => {
    const markup = await renderToMarkup(<CredentialConfigurationPanel
      credential={credential} types={[]} encryptionConfigured={false} onClose={vi.fn()} onChanged={vi.fn()} />)
    expect(markup).toContain('Primary token')
    expect(markup).toContain('test:token@1 · unavailable')
    expect(markup).toContain('Configure runtime Credential encryption')
    expect(markup).not.toContain('type="password"')
  })
})
