import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionConfigurationPanel } from '../src/ConnectionConfigurationPanel.js'
import type { WorkbenchConnectionAdapter, WorkbenchConnectionIndexItem } from '../src/contracts.js'
import { coreSchemaLiteralRenderers } from '../src/SchemaRenderers.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { renderToMarkup } from './render.js'

const schemaUI: SchemaUIResolver = {
  getSnapshot: () => 1,
  subscribe: () => () => {},
  resolveRenderer<Renderer>(request, mode): Renderer | undefined {
    if (mode !== 'editor') return
    return (coreSchemaLiteralRenderers.find(renderer => request.role && renderer.role === request.role)
      ?? coreSchemaLiteralRenderers.find(renderer => renderer.type === request.type))?.editor as Renderer | undefined
  },
}

const client: WorkbenchConsoleClient = {
  action: vi.fn(),
  query: vi.fn(),
  subscribe: vi.fn(),
}

const adapter: WorkbenchConnectionAdapter = {
  id: 'test:http',
  version: 1,
  title: 'HTTP Adapter',
  providerAvailable: true,
  configSchemaSupported: true,
  configFields: [{
    name: 'baseUrl',
    label: 'Base URL',
    type: 'string',
    schemaType: 'string',
    required: true,
    description: 'Remote endpoint',
    defaultValue: 'https://example.test',
  }],
  credentials: [],
}

const connection: WorkbenchConnectionIndexItem = {
  id: 'conn_primary',
  name: 'Primary API',
  adapterId: adapter.id,
  adapterVersion: adapter.version,
  adapterTitle: adapter.title,
  enabled: false,
  adapterAvailable: true,
  credentialBound: false,
  config: { baseUrl: 'https://primary.example.test' },
  status: 'DISABLED',
  statusDetail: 'Disabled by configuration',
  generation: 2,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

describe('Connection configuration UI', () => {
  it('renders a schema-driven create form with Adapter defaults', async () => {
    const markup = await renderToMarkup(<ConnectionConfigurationPanel
      adapters={[adapter]}
      client={client}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      schemaUI={schemaUI}
    />)

    expect(markup).toContain('New Connection')
    expect(markup).toContain('HTTP Adapter')
    expect(markup).toContain('https://example.test')
    expect(markup).toContain('Create Connection')
  })

  it('renders preserved edit values and an explicit destructive entry point', async () => {
    const markup = await renderToMarkup(<ConnectionConfigurationPanel
      adapters={[adapter]}
      client={client}
      connection={connection}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      schemaUI={schemaUI}
    />)

    expect(markup).toContain('Connection settings')
    expect(markup).toContain('Primary API')
    expect(markup).toContain('https://primary.example.test')
    expect(markup).toContain('Save changes')
    expect(markup).toContain('Delete')
  })

  it('blocks creation when a required Credential has no compatible metadata', async () => {
    const protectedAdapter = { ...adapter, credentialType: 'test:token' }
    const markup = await renderToMarkup(<ConnectionConfigurationPanel
      adapters={[protectedAdapter]}
      client={client}
      onChanged={vi.fn()}
      onClose={vi.fn()}
      schemaUI={schemaUI}
    />)

    expect(markup).toContain('No compatible Credentials')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>.*Create Connection/s)
  })
})
