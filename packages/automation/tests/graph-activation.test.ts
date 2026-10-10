import { describe, expect, it } from 'vitest'
import { GraphActivation, GraphActivationComplexityError } from '../src/graph-activation.js'

describe('bounded graph activation proofs', () => {
  it('canonicalizes commutation, complements, distributivity, and nested implications', () => {
    const proof = new GraphActivation(['y', 'x', 'z'])
    const x = proof.condition('x'), y = proof.condition('y'), z = proof.condition('z')
    expect(proof.and(x, y)).toBe(proof.and(y, x))
    expect(proof.not(proof.not(x))).toBe(x)
    expect(proof.or(x, proof.not(x))).toBe(proof.true)
    expect(proof.and(x, proof.not(x))).toBe(proof.false)
    expect(proof.and(x, proof.or(y, z))).toBe(proof.or(proof.and(x, y), proof.and(x, z)))
    expect(proof.not(proof.and(x, y))).toBe(proof.or(proof.not(x), proof.not(y)))
    expect(proof.implies(proof.and(x, y), x)).toBe(true)
    expect(proof.implies(proof.or(x, y), x)).toBe(false)
  })

  it('bounds both unique decision allocation and proof work with a distinguishable error', () => {
    const nodes = new GraphActivation(['x', 'y'], { nodes: 3, operations: 100 })
    nodes.condition('x')
    expect(() => nodes.condition('y')).toThrow(GraphActivationComplexityError)
    const operations = new GraphActivation(['x'], { nodes: 10, operations: 2 })
    const x = operations.condition('x')
    operations.and(x, x); operations.and(x, x)
    expect(() => operations.and(x, x)).toThrow(GraphActivationComplexityError)
  })

  it('agrees with exhaustive boolean truth tables for composed conditions and implication', () => {
    const proof = new GraphActivation(['a', 'b', 'c', 'd'])
    const variables = ['a', 'b', 'c', 'd'].map(id => proof.condition(id))
    const valuations = Array.from({ length: 16 }, (_, mask) => variables.map((_value, bit) => Boolean(mask & (1 << bit))))
    const assignments = valuations.map(values => values.reduce((result, value, index) => (
      proof.and(result, value ? variables[index]! : proof.not(variables[index]!))
    ), proof.true))
    const formulas = variables.map((id, index) => ({ id, table: valuations.map(value => value[index]!) }))
    let seed = 7
    const choose = (length: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % length }
    for (let index = 0; index < 128; index++) {
      const left = formulas[choose(formulas.length)]!, right = formulas[choose(formulas.length)]!
      const kind = index % 3
      const id = kind === 0 ? proof.and(left.id, right.id) : kind === 1 ? proof.or(left.id, right.id) : proof.not(left.id)
      const table = left.table.map((value, position) => kind === 0 ? value && right.table[position]! : kind === 1 ? value || right.table[position]! : !value)
      formulas.push({ id, table })
      for (const [position, assignment] of assignments.entries()) expect(proof.and(id, assignment) !== proof.false).toBe(table[position])
      expect(proof.implies(id, right.id)).toBe(table.every((value, position) => !value || right.table[position]))
    }
  })
})
