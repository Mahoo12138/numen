import { Service, type Context } from 'cordis'
import type {
  SchemaRendererDefinition,
  SchemaRendererMode,
  SchemaRendererRequest,
} from './schema-ui.js'

export interface FrontendExtensionRef {
  id: string
  version: number
}

export interface FrontendPage<Component = unknown> extends FrontendExtensionRef {
  path: string
  title: string
  component: Component
}

export interface FrontendSlot extends FrontendExtensionRef {
  description?: string
}

export interface FrontendSlotContribution<Content = unknown> {
  id: string
  slot: FrontendExtensionRef
  content: Content
  order?: number
  before?: string[]
  after?: string[]
}

declare module 'cordis' {
  interface Context {
    webuiExtensions: BrowserExtensionRegistry
  }

  interface Events {
    'numen/webui-extension-change'(kind: 'page' | 'slot' | 'contribution' | 'renderer', id: string): void
  }
}

const extensionIdPattern = /^[a-zA-Z0-9@][a-zA-Z0-9@/_.:-]*$/

function extensionKey(ref: FrontendExtensionRef): string {
  return `${ref.id}@${ref.version}`
}

function validateRef(ref: FrontendExtensionRef, kind: string): void {
  if (!extensionIdPattern.test(ref.id)) throw new TypeError(`invalid ${kind} id: ${ref.id}`)
  if (!Number.isSafeInteger(ref.version) || ref.version < 1) {
    throw new TypeError(`invalid ${kind} version: ${ref.version}`)
  }
}

function validatePage(page: FrontendPage): void {
  validateRef(page, 'frontend page')
  if (!page.path.startsWith('/')) throw new TypeError(`frontend page path must start with /: ${page.path}`)
  pagePattern(page.path)
}

function pagePattern(path: string): string {
  if (
    path.includes('?')
    || path.includes('#')
    || path.includes('//')
    || (path.length > 1 && path.endsWith('/'))
  ) {
    throw new TypeError(`invalid frontend page path: ${path}`)
  }
  const parameters = new Set<string>()
  return path.split('/').map((segment) => {
    if (segment === '.' || segment === '..') throw new TypeError(`invalid frontend page path: ${path}`)
    if (!segment.startsWith(':')) return segment
    const name = segment.slice(1)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || parameters.has(name)) {
      throw new TypeError(`invalid frontend page parameter: ${segment}`)
    }
    parameters.add(name)
    return ':'
  }).join('/')
}

function validateContribution(contribution: FrontendSlotContribution): void {
  validateRef(contribution.slot, 'frontend slot reference')
  if (!extensionIdPattern.test(contribution.id)) {
    throw new TypeError(`invalid frontend contribution id: ${contribution.id}`)
  }
  if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
    throw new TypeError(`invalid frontend contribution order: ${contribution.order}`)
  }
}

function schemaRendererTarget(definition: SchemaRendererDefinition): string {
  const hasRole = typeof definition.role === 'string' && !!definition.role
  const hasType = typeof definition.type === 'string' && !!definition.type
  if (hasRole === hasType) throw new TypeError('schema renderer requires exactly one role or type target')
  const value = hasRole ? definition.role! : definition.type!
  if (!extensionIdPattern.test(value)) throw new TypeError(`invalid schema renderer target: ${value}`)
  return `${hasRole ? 'role' : 'type'}:${value}`
}

function validateSchemaRenderer(definition: SchemaRendererDefinition): string {
  validateRef(definition, 'schema renderer')
  if (definition.editor === undefined && definition.viewer === undefined && definition.compact === undefined) {
    throw new TypeError('schema renderer requires an editor, viewer, or compact implementation')
  }
  return schemaRendererTarget(definition)
}

function baseCompare(
  left: FrontendSlotContribution,
  right: FrontendSlotContribution,
): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)
}

function sortContributions<Content>(
  contributions: FrontendSlotContribution<Content>[],
): FrontendSlotContribution<Content>[] {
  const byId = new Map(contributions.map(item => [item.id, item]))
  const outgoing = new Map(contributions.map(item => [item.id, new Set<string>()]))
  const indegree = new Map(contributions.map(item => [item.id, 0]))
  const addEdge = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || outgoing.get(from)!.has(to)) return
    outgoing.get(from)!.add(to)
    indegree.set(to, indegree.get(to)! + 1)
  }
  for (const contribution of contributions) {
    for (const target of contribution.before ?? []) addEdge(contribution.id, target)
    for (const target of contribution.after ?? []) addEdge(target, contribution.id)
  }
  const available = contributions.filter(item => indegree.get(item.id) === 0).sort(baseCompare)
  const result: FrontendSlotContribution<Content>[] = []
  while (available.length) {
    const current = available.shift()!
    result.push(current)
    for (const target of outgoing.get(current.id)!) {
      indegree.set(target, indegree.get(target)! - 1)
      if (indegree.get(target) === 0) {
        available.push(byId.get(target)!)
        available.sort(baseCompare)
      }
    }
  }
  if (result.length !== contributions.length) {
    const cycle = contributions.filter(item => indegree.get(item.id)! > 0).map(item => item.id).sort()
    throw new Error(`frontend slot ordering cycle: ${cycle.join(', ')}`)
  }
  return result
}

interface ExtensionState {
  pages: Map<string, FrontendPage>
  pagePaths: Map<string, string>
  slots: Map<string, FrontendSlot>
  contributions: Map<string, Map<string, FrontendSlotContribution>>
  schemaRenderers: Map<string, SchemaRendererDefinition>
  schemaRendererTargets: Map<string, string>
}

function createState(): ExtensionState {
  return {
    pages: new Map(),
    pagePaths: new Map(),
    slots: new Map(),
    contributions: new Map(),
    schemaRenderers: new Map(),
    schemaRendererTargets: new Map(),
  }
}

function cloneState(state: ExtensionState): ExtensionState {
  return {
    pages: new Map(state.pages),
    pagePaths: new Map(state.pagePaths),
    slots: new Map(state.slots),
    contributions: new Map(
      [...state.contributions].map(([slot, entries]) => [slot, new Map(entries)]),
    ),
    schemaRenderers: new Map(state.schemaRenderers),
    schemaRendererTargets: new Map(state.schemaRendererTargets),
  }
}

/**
 * An isolated registration target used while a complete Entry manifest is loading.
 * Its registrations remain invisible until BrowserExtensionRegistry activates it.
 */
export class FrontendExtensionStage {
  private readonly state = createState()

  page<Component>(owner: Context, page: FrontendPage<Component>): () => void {
    validatePage(page)
    const key = extensionKey(page)
    if (this.state.pages.has(key)) throw new Error(`frontend page already registered: ${key}`)
    const pattern = pagePattern(page.path)
    const existingPath = this.state.pagePaths.get(pattern)
    if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    return owner.effect(() => {
      this.state.pages.set(key, page as FrontendPage)
      this.state.pagePaths.set(pattern, key)
      return () => {
        if (this.state.pages.get(key) === page) this.state.pages.delete(key)
        if (this.state.pagePaths.get(pattern) === key) this.state.pagePaths.delete(pattern)
      }
    }, `webui.stage.page(${JSON.stringify(key)})`)
  }

  slot(owner: Context, slot: FrontendSlot): () => void {
    validateRef(slot, 'frontend slot')
    const key = extensionKey(slot)
    if (this.state.slots.has(key)) throw new Error(`frontend slot already registered: ${key}`)
    return owner.effect(() => {
      this.state.slots.set(key, slot)
      return () => {
        if (this.state.slots.get(key) === slot) this.state.slots.delete(key)
      }
    }, `webui.stage.slot(${JSON.stringify(key)})`)
  }

  contribute<Content>(
    owner: Context,
    contribution: FrontendSlotContribution<Content>,
  ): () => void {
    validateContribution(contribution)
    const slotKey = extensionKey(contribution.slot)
    const current = this.state.contributions.get(slotKey) ?? new Map()
    if (current.has(contribution.id)) {
      throw new Error(`frontend contribution already registered: ${slotKey}/${contribution.id}`)
    }
    sortContributions([...current.values(), contribution as FrontendSlotContribution])
    return owner.effect(() => {
      let entries = this.state.contributions.get(slotKey)
      if (!entries) this.state.contributions.set(slotKey, entries = new Map())
      entries.set(contribution.id, contribution as FrontendSlotContribution)
      return () => {
        if (entries.get(contribution.id) === contribution) entries.delete(contribution.id)
        if (!entries.size) this.state.contributions.delete(slotKey)
      }
    }, `webui.stage.contribute(${JSON.stringify(`${slotKey}/${contribution.id}`)})`)
  }

  defineSchemaRenderer<Renderer>(owner: Context, definition: SchemaRendererDefinition<Renderer>): () => void {
    const target = validateSchemaRenderer(definition)
    const key = extensionKey(definition)
    if (this.state.schemaRenderers.has(key)) throw new Error(`schema renderer already registered: ${key}`)
    const existingTarget = this.state.schemaRendererTargets.get(target)
    if (existingTarget) throw new Error(`schema renderer target already registered: ${target} (${existingTarget})`)
    return owner.effect(() => {
      this.state.schemaRenderers.set(key, definition as SchemaRendererDefinition)
      this.state.schemaRendererTargets.set(target, key)
      return () => {
        if (this.state.schemaRenderers.get(key) === definition) this.state.schemaRenderers.delete(key)
        if (this.state.schemaRendererTargets.get(target) === key) this.state.schemaRendererTargets.delete(target)
      }
    }, `webui.stage.schemaRenderer(${JSON.stringify(key)})`)
  }

  materialize(): ExtensionState {
    return cloneState(this.state)
  }
}

export class BrowserExtensionRegistry extends Service {
  private readonly direct = createState()
  private active: { revision: number; state: ExtensionState } | undefined

  constructor(ctx: Context) {
    super(ctx, 'webuiExtensions')
  }

  page<Component>(owner: Context, page: FrontendPage<Component>): () => void {
    validatePage(page)
    const key = extensionKey(page)
    if (this.direct.pages.has(key) || this.active?.state.pages.has(key)) {
      throw new Error(`frontend page already registered: ${key}`)
    }
    const pattern = pagePattern(page.path)
    const existingPath = this.direct.pagePaths.get(pattern) ?? this.active?.state.pagePaths.get(pattern)
    if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    return owner.effect(() => {
      this.direct.pages.set(key, page as FrontendPage)
      this.direct.pagePaths.set(pattern, key)
      this.ctx.emit('numen/webui-extension-change', 'page', key)
      return () => {
        this.direct.pages.delete(key)
        if (this.direct.pagePaths.get(pattern) === key) this.direct.pagePaths.delete(pattern)
        this.ctx.emit('numen/webui-extension-change', 'page', key)
      }
    }, `webui.page(${JSON.stringify(key)})`)
  }

  slot(owner: Context, slot: FrontendSlot): () => void {
    validateRef(slot, 'frontend slot')
    const key = extensionKey(slot)
    if (this.direct.slots.has(key) || this.active?.state.slots.has(key)) {
      throw new Error(`frontend slot already registered: ${key}`)
    }
    return owner.effect(() => {
      this.direct.slots.set(key, slot)
      this.ctx.emit('numen/webui-extension-change', 'slot', key)
      return () => {
        this.direct.slots.delete(key)
        this.ctx.emit('numen/webui-extension-change', 'slot', key)
      }
    }, `webui.slot(${JSON.stringify(key)})`)
  }

  contribute<Content>(
    owner: Context,
    contribution: FrontendSlotContribution<Content>,
  ): () => void {
    validateContribution(contribution)
    const slotKey = extensionKey(contribution.slot)
    if (!this.direct.slots.has(slotKey) && !this.active?.state.slots.has(slotKey)) {
      throw new Error(`frontend slot not found: ${slotKey}`)
    }
    const current = this.combinedContributions(slotKey)
    if (current.some(item => item.id === contribution.id)) {
      throw new Error(`frontend contribution already registered: ${slotKey}/${contribution.id}`)
    }
    sortContributions([...current, contribution as FrontendSlotContribution])
    return owner.effect(() => {
      let entries = this.direct.contributions.get(slotKey)
      if (!entries) this.direct.contributions.set(slotKey, entries = new Map())
      entries.set(contribution.id, contribution as FrontendSlotContribution)
      this.ctx.emit('numen/webui-extension-change', 'contribution', `${slotKey}/${contribution.id}`)
      return () => {
        entries.delete(contribution.id)
        if (!entries.size) this.direct.contributions.delete(slotKey)
        this.ctx.emit('numen/webui-extension-change', 'contribution', `${slotKey}/${contribution.id}`)
      }
    }, `webui.contribute(${JSON.stringify(`${slotKey}/${contribution.id}`)})`)
  }

  defineSchemaRenderer<Renderer>(owner: Context, definition: SchemaRendererDefinition<Renderer>): () => void {
    const target = validateSchemaRenderer(definition)
    const key = extensionKey(definition)
    if (this.direct.schemaRenderers.has(key) || this.active?.state.schemaRenderers.has(key)) {
      throw new Error(`schema renderer already registered: ${key}`)
    }
    const existingTarget = this.direct.schemaRendererTargets.get(target)
      ?? this.active?.state.schemaRendererTargets.get(target)
    if (existingTarget) throw new Error(`schema renderer target already registered: ${target} (${existingTarget})`)
    return owner.effect(() => {
      this.direct.schemaRenderers.set(key, definition as SchemaRendererDefinition)
      this.direct.schemaRendererTargets.set(target, key)
      this.ctx.emit('numen/webui-extension-change', 'renderer', key)
      return () => {
        if (this.direct.schemaRenderers.get(key) === definition) this.direct.schemaRenderers.delete(key)
        if (this.direct.schemaRendererTargets.get(target) === key) this.direct.schemaRendererTargets.delete(target)
        this.ctx.emit('numen/webui-extension-change', 'renderer', key)
      }
    }, `webui.schemaRenderer(${JSON.stringify(key)})`)
  }

  resolveSchemaRenderer<Renderer = unknown>(
    request: SchemaRendererRequest,
    mode: SchemaRendererMode,
  ): Renderer | undefined {
    const targets = [
      ...(request.role ? [`role:${request.role}`] : []),
      `type:${request.type}`,
    ]
    for (const target of targets) {
      const key = this.direct.schemaRendererTargets.get(target)
        ?? this.active?.state.schemaRendererTargets.get(target)
      if (!key) continue
      const definition = this.direct.schemaRenderers.get(key) ?? this.active?.state.schemaRenderers.get(key)
      const renderer = definition?.[mode]
      if (renderer !== undefined) return renderer as Renderer
    }
  }

  listPages(): FrontendPage[] {
    return [...this.direct.pages.values(), ...(this.active?.state.pages.values() ?? [])].sort((left, right) => (
      left.path.localeCompare(right.path) || extensionKey(left).localeCompare(extensionKey(right))
    ))
  }

  getPage(ref: FrontendExtensionRef): FrontendPage | undefined {
    const key = extensionKey(ref)
    return this.direct.pages.get(key) ?? this.active?.state.pages.get(key)
  }

  listSlots(): FrontendSlot[] {
    return [...this.direct.slots.values(), ...(this.active?.state.slots.values() ?? [])]
      .sort((left, right) => extensionKey(left).localeCompare(extensionKey(right)))
  }

  listContributions<Content = unknown>(slot: FrontendExtensionRef): FrontendSlotContribution<Content>[] {
    const slotKey = extensionKey(slot)
    if (!this.direct.slots.has(slotKey) && !this.active?.state.slots.has(slotKey)) return []
    const entries = this.combinedContributions(slotKey)
    return sortContributions(entries) as FrontendSlotContribution<Content>[]
  }

  getSnapshotRevision(): number | undefined {
    return this.active?.revision
  }

  activateSnapshot(revision: number, stage: FrontendExtensionStage): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError(`invalid frontend snapshot revision: ${revision}`)
    }
    if (this.active && revision <= this.active.revision) {
      throw new Error(`frontend snapshot revision is stale: ${revision} <= ${this.active.revision}`)
    }
    const next = stage.materialize()
    this.validateSnapshot(next)
    const previous = this.active?.state
    this.active = { revision, state: next }
    this.emitSnapshotChanges(previous, next)
  }

  deactivateSnapshot(revision: number): boolean {
    if (this.active?.revision !== revision) return false
    const previous = this.active.state
    this.active = undefined
    this.emitSnapshotChanges(previous)
    return true
  }

  private combinedContributions(slotKey: string): FrontendSlotContribution[] {
    return [
      ...(this.direct.contributions.get(slotKey)?.values() ?? []),
      ...(this.active?.state.contributions.get(slotKey)?.values() ?? []),
    ]
  }

  private validateSnapshot(next: ExtensionState): void {
    for (const [key, page] of next.pages) {
      if (this.direct.pages.has(key)) throw new Error(`frontend page already registered: ${key}`)
      const existingPath = this.direct.pagePaths.get(pagePattern(page.path))
      if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    }
    for (const key of next.slots.keys()) {
      if (this.direct.slots.has(key)) throw new Error(`frontend slot already registered: ${key}`)
    }
    for (const [key, renderer] of next.schemaRenderers) {
      if (this.direct.schemaRenderers.has(key)) throw new Error(`schema renderer already registered: ${key}`)
      const target = schemaRendererTarget(renderer)
      const existingTarget = this.direct.schemaRendererTargets.get(target)
      if (existingTarget) throw new Error(`schema renderer target already registered: ${target} (${existingTarget})`)
    }
    const slotKeys = new Set([
      ...this.direct.contributions.keys(),
      ...next.contributions.keys(),
    ])
    for (const slotKey of slotKeys) {
      if (!this.direct.slots.has(slotKey) && !next.slots.has(slotKey)) {
        throw new Error(`frontend slot not found: ${slotKey}`)
      }
      const direct = [...(this.direct.contributions.get(slotKey)?.values() ?? [])]
      const staged = [...(next.contributions.get(slotKey)?.values() ?? [])]
      const ids = new Set(direct.map(item => item.id))
      for (const contribution of staged) {
        if (ids.has(contribution.id)) {
          throw new Error(`frontend contribution already registered: ${slotKey}/${contribution.id}`)
        }
        ids.add(contribution.id)
      }
      sortContributions([...direct, ...staged])
    }
  }

  private emitSnapshotChanges(previous?: ExtensionState, next?: ExtensionState): void {
    for (const key of new Set([...previous?.pages.keys() ?? [], ...next?.pages.keys() ?? []])) {
      this.ctx.emit('numen/webui-extension-change', 'page', key)
    }
    for (const key of new Set([...previous?.slots.keys() ?? [], ...next?.slots.keys() ?? []])) {
      this.ctx.emit('numen/webui-extension-change', 'slot', key)
    }
    const contributionKeys = (state?: ExtensionState) => [...state?.contributions ?? []]
      .flatMap(([slot, entries]) => [...entries.keys()].map(id => `${slot}/${id}`))
    for (const key of new Set([...contributionKeys(previous), ...contributionKeys(next)])) {
      this.ctx.emit('numen/webui-extension-change', 'contribution', key)
    }
    for (const key of new Set([
      ...previous?.schemaRenderers.keys() ?? [],
      ...next?.schemaRenderers.keys() ?? [],
    ])) {
      this.ctx.emit('numen/webui-extension-change', 'renderer', key)
    }
  }
}

export default BrowserExtensionRegistry
