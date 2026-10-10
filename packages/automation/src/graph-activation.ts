/** A reduced ordered BDD proves structural branch exclusivity without enumerating paths. */
interface Decision { variable: number; low: number; high: number }

export class GraphActivationComplexityError extends Error {
  override name = 'GraphActivationComplexityError'
}

export class GraphActivation {
  readonly false = 0
  readonly true = 1
  private readonly nodes: Array<Decision | undefined> = [undefined, undefined]
  private readonly unique = new Map<string, number>()
  private readonly operations = new Map<string, number>()
  private readonly complements = new Map<number, number>([[0, 1], [1, 0]])
  private readonly variables: Map<string, number>
  private work = 0

  constructor(
    conditionIds: string[],
    private readonly limits = { nodes: 16_384, operations: 200_000 },
  ) {
    this.variables = new Map([...conditionIds].sort().map((id, index) => [id, index]))
  }

  private spend(): void {
    if (++this.work > this.limits.operations) throw new GraphActivationComplexityError('Graph activation proof exceeds the operation limit.')
  }

  private decision(variable: number, low: number, high: number): number {
    if (low === high) return low
    const key = `${variable}:${low}:${high}`
    const cached = this.unique.get(key)
    if (cached !== undefined) return cached
    if (this.nodes.length >= this.limits.nodes) throw new GraphActivationComplexityError('Graph activation proof exceeds the decision limit.')
    const id = this.nodes.push({ variable, low, high }) - 1
    this.unique.set(key, id)
    return id
  }

  condition(id: string): number {
    const variable = this.variables.get(id)
    if (variable === undefined) throw new Error('Unknown graph condition.')
    return this.decision(variable, this.false, this.true)
  }

  not(value: number): number {
    this.spend()
    const cached = this.complements.get(value)
    if (cached !== undefined) return cached
    const node = this.nodes[value]!
    const result = this.decision(node.variable, this.not(node.low), this.not(node.high))
    this.complements.set(value, result)
    this.complements.set(result, value)
    return result
  }

  and(left: number, right: number): number { return this.apply('and', left, right) }
  or(left: number, right: number): number { return this.apply('or', left, right) }
  implies(left: number, right: number): boolean { return this.and(left, this.not(right)) === this.false }

  private apply(operation: 'and' | 'or', left: number, right: number): number {
    this.spend()
    if (left === right) return left
    if (operation === 'and') {
      if (left === this.false || right === this.false) return this.false
      if (left === this.true) return right
      if (right === this.true) return left
    } else {
      if (left === this.true || right === this.true) return this.true
      if (left === this.false) return right
      if (right === this.false) return left
    }
    // Both operations commute; canonical pairs share a cache entry.
    if (left > right) [left, right] = [right, left]
    const key = `${operation}:${left}:${right}`
    const cached = this.operations.get(key)
    if (cached !== undefined) return cached
    const a = this.nodes[left]!
    const b = this.nodes[right]!
    const variable = Math.min(a.variable, b.variable)
    const low = this.apply(operation, a.variable === variable ? a.low : left, b.variable === variable ? b.low : right)
    const high = this.apply(operation, a.variable === variable ? a.high : left, b.variable === variable ? b.high : right)
    const result = this.decision(variable, low, high)
    this.operations.set(key, result)
    return result
  }
}
