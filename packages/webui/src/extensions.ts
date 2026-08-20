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

export class BrowserExtensionRegistry extends Service {
  private readonly pages = new Map<string, FrontendPage>()
  private readonly pagePaths = new Map<string, string>()
  private readonly slots = new Map<string, FrontendSlot>()
  private readonly contributions = new Map<string, Map<string, FrontendSlotContribution>>()

  constructor(ctx: Context) {
    super(ctx, 'webuiExtensions')
  }

  page<Component>(owner: Context, page: FrontendPage<Component>): () => void {
    validateRef(page, 'frontend page')
    if (!page.path.startsWith('/')) throw new TypeError(`frontend page path must start with /: ${page.path}`)
    const key = extensionKey(page)
    if (this.pages.has(key)) throw new Error(`frontend page already registered: ${key}`)
    const existingPath = this.pagePaths.get(page.path)
    if (existingPath) throw new Error(`frontend page path already registered: ${page.path} (${existingPath})`)
    return owner.effect(() => {
      this.pages.set(key, page as FrontendPage)
      this.pagePaths.set(page.path, key)
      this.ctx.emit('numen/webui-extension-change', 'page', key)
      return () => {
        this.pages.delete(key)
        if (this.pagePaths.get(page.path) === key) this.pagePaths.delete(page.path)
        this.ctx.emit('numen/webui-extension-change', 'page', key)
      }
    }, `webui.page(${JSON.stringify(key)})`)
  }

  slot(owner: Context, slot: FrontendSlot): () => void {
    validateRef(slot, 'frontend slot')
    const key = extensionKey(slot)
    if (this.slots.has(key)) throw new Error(`frontend slot already registered: ${key}`)
    return owner.effect(() => {
      this.slots.set(key, slot)
      this.ctx.emit('numen/webui-extension-change', 'slot', key)
      return () => {
        this.slots.delete(key)
        this.ctx.emit('numen/webui-extension-change', 'slot', key)
      }
    }, `webui.slot(${JSON.stringify(key)})`)
  }

  contribute<Content>(
    owner: Context,
    contribution: FrontendSlotContribution<Content>,
  ): () => void {
    validateRef(contribution.slot, 'frontend slot reference')
    if (!extensionIdPattern.test(contribution.id)) {
      throw new TypeError(`invalid frontend contribution id: ${contribution.id}`)
    }
    if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
      throw new TypeError(`invalid frontend contribution order: ${contribution.order}`)
    }
    const slotKey = extensionKey(contribution.slot)
    if (!this.slots.has(slotKey)) throw new Error(`frontend slot not found: ${slotKey}`)
    const current = this.contributions.get(slotKey) ?? new Map()
    if (current.has(contribution.id)) {
      throw new Error(`frontend contribution already registered: ${slotKey}/${contribution.id}`)
    }
    sortContributions([...current.values(), contribution as FrontendSlotContribution])
    return owner.effect(() => {
      let entries = this.contributions.get(slotKey)
      if (!entries) this.contributions.set(slotKey, entries = new Map())
      entries.set(contribution.id, contribution as FrontendSlotContribution)
      this.ctx.emit('numen/webui-extension-change', 'contribution', `${slotKey}/${contribution.id}`)
      return () => {
        entries.delete(contribution.id)
        if (!entries.size) this.contributions.delete(slotKey)
        this.ctx.emit('numen/webui-extension-change', 'contribution', `${slotKey}/${contribution.id}`)
      }
    }, `webui.contribute(${JSON.stringify(`${slotKey}/${contribution.id}`)})`)
  }

  listPages(): FrontendPage[] {
    return [...this.pages.values()].sort((left, right) => (
      left.path.localeCompare(right.path) || extensionKey(left).localeCompare(extensionKey(right))
    ))
  }

  listSlots(): FrontendSlot[] {
    return [...this.slots.values()].sort((left, right) => extensionKey(left).localeCompare(extensionKey(right)))
  }

  listContributions<Content = unknown>(slot: FrontendExtensionRef): FrontendSlotContribution<Content>[] {
    const slotKey = extensionKey(slot)
    if (!this.slots.has(slotKey)) return []
    const entries = [...(this.contributions.get(slotKey)?.values() ?? [])]
    return sortContributions(entries) as FrontendSlotContribution<Content>[]
  }
}

export default BrowserExtensionRegistry
