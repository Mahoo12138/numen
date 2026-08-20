import { Service, type Context } from 'cordis'

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
    'numen/webui-extension-change'(kind: 'page' | 'slot' | 'contribution', id: string): void
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
}

function createState(): ExtensionState {
  return {
    pages: new Map(),
    pagePaths: new Map(),
    slots: new Map(),
    contributions: new Map(),
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
    const existingPath = this.state.pagePaths.get(page.path)
    if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    return owner.effect(() => {
      this.state.pages.set(key, page as FrontendPage)
      this.state.pagePaths.set(page.path, key)
      return () => {
        if (this.state.pages.get(key) === page) this.state.pages.delete(key)
        if (this.state.pagePaths.get(page.path) === key) this.state.pagePaths.delete(page.path)
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
    const existingPath = this.direct.pagePaths.get(page.path) ?? this.active?.state.pagePaths.get(page.path)
    if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    return owner.effect(() => {
      this.direct.pages.set(key, page as FrontendPage)
      this.direct.pagePaths.set(page.path, key)
      this.ctx.emit('numen/webui-extension-change', 'page', key)
      return () => {
        this.direct.pages.delete(key)
        if (this.direct.pagePaths.get(page.path) === key) this.direct.pagePaths.delete(page.path)
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

  listPages(): FrontendPage[] {
    return [...this.direct.pages.values(), ...(this.active?.state.pages.values() ?? [])].sort((left, right) => (
      left.path.localeCompare(right.path) || extensionKey(left).localeCompare(extensionKey(right))
    ))
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
      const existingPath = this.direct.pagePaths.get(page.path)
      if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    }
    for (const key of next.slots.keys()) {
      if (this.direct.slots.has(key)) throw new Error(`frontend slot already registered: ${key}`)
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
  }
}

export default BrowserExtensionRegistry
