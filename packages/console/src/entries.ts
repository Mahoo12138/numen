import { Service, type Context } from 'cordis'

export interface ConsoleFrontendEntry {
  id: string
  dev?: string
  prod?: string
}

export interface ConsoleFrontendEntryStatus extends ConsoleFrontendEntry {
  scopeId?: string
  generation?: number
}

export interface ConsoleEntryGeneration {
  scopeId: string
  generation: number
  entries: ConsoleFrontendEntry[]
  retire?(): void | Promise<void>
}

interface ActiveGeneration extends ConsoleEntryGeneration {
  entries: ConsoleFrontendEntry[]
  baseUrl?: string
}

export interface ConsoleEntrySource {
  entry: ConsoleFrontendEntryStatus
  source: string
  baseUrl?: string
  revision: number
}

declare module 'cordis' {
  interface Context {
    consoleEntries: ConsoleEntryRegistry
  }

  interface Events {
    'numen/console-entry-change'(): void
  }
}

const entryIdPattern = /^[a-zA-Z0-9@][a-zA-Z0-9@/_.:-]*$/

function validateEntry(entry: ConsoleFrontendEntry): ConsoleFrontendEntry {
  if (!entryIdPattern.test(entry.id)) throw new TypeError(`invalid console entry id: ${entry.id}`)
  const dev = entry.dev?.trim()
  const prod = entry.prod?.trim()
  if (!dev && !prod) throw new TypeError(`console entry requires dev or prod source: ${entry.id}`)
  if (entry.dev !== undefined && !dev) throw new TypeError(`console entry dev source is empty: ${entry.id}`)
  if (entry.prod !== undefined && !prod) throw new TypeError(`console entry prod source is empty: ${entry.id}`)
  return { id: entry.id, ...(dev ? { dev } : {}), ...(prod ? { prod } : {}) }
}

export class ConsoleEntryRegistry extends Service {
  private readonly direct = new Map<string, ConsoleFrontendEntry>()
  private readonly directBaseUrls = new Map<string, string>()
  private readonly generations = new Map<string, ActiveGeneration>()
  private revision = 0

  constructor(ctx: Context) {
    super(ctx, 'consoleEntries')
  }

  addEntry(owner: Context, definition: ConsoleFrontendEntry): () => void {
    const entry = validateEntry(definition)
    this.assertIdAvailable(entry.id)
    return owner.effect(() => {
      this.direct.set(entry.id, entry)
      if (owner.baseUrl) this.directBaseUrls.set(entry.id, owner.baseUrl)
      this.bumpRevision()
      return () => {
        if (this.direct.get(entry.id) === entry) this.direct.delete(entry.id)
        this.directBaseUrls.delete(entry.id)
        this.bumpRevision()
      }
    }, `consoleEntries.add(${JSON.stringify(entry.id)})`)
  }

  async replaceGeneration(
    owner: Context,
    generation: ConsoleEntryGeneration,
  ): Promise<() => Promise<void>> {
    if (!entryIdPattern.test(generation.scopeId)) {
      throw new TypeError(`invalid console entry scope id: ${generation.scopeId}`)
    }
    if (!Number.isSafeInteger(generation.generation) || generation.generation < 1) {
      throw new TypeError(`invalid console entry generation: ${generation.generation}`)
    }
    if (!Array.isArray(generation.entries)) throw new TypeError('console entry generation requires entries')
    const previous = this.generations.get(generation.scopeId)
    if (previous && generation.generation <= previous.generation) {
      throw new Error(
        `stale console entry generation for ${generation.scopeId}: ${generation.generation} <= ${previous.generation}`,
      )
    }
    const entries = generation.entries.map(validateEntry)
    const stagedIds = new Set<string>()
    for (const entry of entries) {
      if (stagedIds.has(entry.id)) throw new Error(`duplicate staged console entry: ${entry.id}`)
      stagedIds.add(entry.id)
      this.assertIdAvailable(entry.id, generation.scopeId)
    }
    const active: ActiveGeneration = {
      ...generation,
      entries,
      ...(owner.baseUrl ? { baseUrl: owner.baseUrl } : {}),
    }
    const dispose = owner.effect(() => {
      this.generations.set(generation.scopeId, active)
      this.bumpRevision()
      return () => {
        if (this.generations.get(generation.scopeId) === active) {
          this.generations.delete(generation.scopeId)
          this.bumpRevision()
        }
      }
    }, `consoleEntries.replace(${JSON.stringify(`${generation.scopeId}@${generation.generation}`)})`)
    if (previous?.retire) {
      try {
        await previous.retire()
      } catch (error) {
        this.ctx.logger('console:entries').warn(error)
      }
    }
    return dispose
  }

  list(): ConsoleFrontendEntryStatus[] {
    const entries: ConsoleFrontendEntryStatus[] = [...this.direct.values()]
    for (const generation of this.generations.values()) {
      entries.push(...generation.entries.map(entry => ({
        ...entry,
        scopeId: generation.scopeId,
        generation: generation.generation,
      })))
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id))
  }

  resolve(entryId: string, mode: 'dev' | 'prod'): string | undefined {
    const entry = this.list().find(item => item.id === entryId)
    if (!entry) return
    return mode === 'dev' ? (entry.dev ?? entry.prod) : (entry.prod ?? entry.dev)
  }

  getRevision(): number {
    return this.revision
  }

  resolveSource(entryId: string, mode: 'dev' | 'prod'): ConsoleEntrySource | undefined {
    const direct = this.direct.get(entryId)
    if (direct) {
      const source = mode === 'dev' ? (direct.dev ?? direct.prod) : (direct.prod ?? direct.dev)
      if (!source) return
      return {
        entry: direct,
        source,
        ...(this.directBaseUrls.get(entryId) ? { baseUrl: this.directBaseUrls.get(entryId)! } : {}),
        revision: this.revision,
      }
    }
    for (const generation of this.generations.values()) {
      const entry = generation.entries.find(item => item.id === entryId)
      if (!entry) continue
      const source = mode === 'dev' ? (entry.dev ?? entry.prod) : (entry.prod ?? entry.dev)
      if (!source) return
      return {
        entry: {
          ...entry,
          scopeId: generation.scopeId,
          generation: generation.generation,
        },
        source,
        ...(generation.baseUrl ? { baseUrl: generation.baseUrl } : {}),
        revision: this.revision,
      }
    }
  }

  private assertIdAvailable(entryId: string, replacingScopeId?: string): void {
    if (this.direct.has(entryId)) throw new Error(`console entry already registered: ${entryId}`)
    for (const [scopeId, generation] of this.generations) {
      if (scopeId === replacingScopeId) continue
      if (generation.entries.some(entry => entry.id === entryId)) {
        throw new Error(`console entry already registered: ${entryId}`)
      }
    }
  }

  private bumpRevision(): void {
    this.revision += 1
    this.ctx.emit('numen/console-entry-change')
  }
}

export default ConsoleEntryRegistry
