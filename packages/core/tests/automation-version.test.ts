import { describe, expect, it } from 'vitest'
import { isSupportedAutomationVersion } from '../src/index.js'

describe('Automation Source/IR version compatibility', () => {
  it('accepts the explicit historical and graph pairs only', () => {
    expect(isSupportedAutomationVersion(1, 1)).toBe(true)
    expect(isSupportedAutomationVersion(2, 2)).toBe(true)
    for (const [source, ir] of [[1, 2], [2, 1], [0, 0], [3, 3], [2, 3], [1.5, 1.5], [NaN, NaN], [Infinity, Infinity]]) {
      expect(isSupportedAutomationVersion(source!, ir!)).toBe(false)
    }
  })
})
