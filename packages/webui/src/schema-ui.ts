import { Service, type Context } from 'cordis'
import type { BrowserExtensionRegistry, FrontendExtensionRef } from './extensions.js'
import './extensions.js'

export type SchemaRendererMode = 'editor' | 'viewer' | 'compact'

export interface SchemaRendererDefinition<Renderer = unknown> extends FrontendExtensionRef {
  role?: string
  type?: string
  editor?: Renderer
  viewer?: Renderer
  compact?: Renderer
}

export interface SchemaRendererRequest {
  role?: string
  type: string
}

export interface SchemaUIResolver {
  getSnapshot(): number
  subscribe(listener: () => void): () => void
  resolveRenderer<Renderer = unknown>(
    request: SchemaRendererRequest,
    mode: SchemaRendererMode,
  ): Renderer | undefined
}

declare module 'cordis' {
  interface Context {
    schemaUI: SchemaUIRegistry
  }
}

/** Frontend Schema renderer seam; registrations remain owned by the caller's Entry Fiber. */
export class SchemaUIRegistry extends Service implements SchemaUIResolver {
  static inject = ['webuiExtensions']

  private revision = 0
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'schemaUI')
  }

  *[Service.init]() {
    const dispose = this.ctx.on('numen/webui-extension-change', (kind) => {
      if (kind !== 'renderer') return
      this.revision += 1
      for (const listener of [...this.listeners]) listener()
    })
    yield () => {
      dispose()
      this.listeners.clear()
    }
  }

  defineRenderer<Renderer>(owner: Context, definition: SchemaRendererDefinition<Renderer>): () => void {
    return (owner.get('webuiExtensions') as BrowserExtensionRegistry).defineSchemaRenderer(owner, definition)
  }

  resolveRenderer<Renderer = unknown>(
    request: SchemaRendererRequest,
    mode: SchemaRendererMode,
  ): Renderer | undefined {
    return this.ctx.webuiExtensions.resolveSchemaRenderer<Renderer>(request, mode)
  }

  getSnapshot(): number {
    return this.revision
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export default SchemaUIRegistry
