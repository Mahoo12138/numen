import { describe, expect, it } from 'vitest'
import { defaultWorkbenchSizes, parseWorkbenchSizes, resolveWorkbenchSizes } from '../src/workbench-layout.js'

describe('Workbench size preferences', () => {
  it('recovers corrupt, partial and out-of-range storage without accepting coerced values', () => {
    for (const raw of [null, '{', 'null', '[]', '"text"', '12']) expect(parseWorkbenchSizes(raw)).toEqual(defaultWorkbenchSizes)
    expect(parseWorkbenchSizes('{"sidebar":"350","inspector":null,"panel":1e400}')).toEqual(defaultWorkbenchSizes)
    expect(parseWorkbenchSizes('{"sidebar":-12,"inspector":100000,"panel":310.4}')).toEqual({ sidebar: 180, inspector: 640, panel: 310 })
    expect(parseWorkbenchSizes('{"sidebar":330,"unknown":5}')).toEqual({ ...defaultWorkbenchSizes, sidebar: 330 })
  })

  it('preserves editor space under competing widths and preserves preferences across viewport changes', () => {
    const preferred = { sidebar: 480, inspector: 640, panel: 1000 }
    for (const width of [900, 1024, 1279, 1280, 1440, 1920]) {
      for (const height of [400, 600, 960]) {
        for (const inspectorOpen of [true, false]) {
          const resolved = resolveWorkbenchSizes(preferred, width, height, inspectorOpen)
          const available = width - (resolved.docked ? 76 : 68) - resolved.sidebar - (resolved.docked && inspectorOpen ? resolved.inspector : 0)
          expect(available).toBeGreaterThanOrEqual(320)
          expect(resolved.sidebar).toBeGreaterThanOrEqual(180)
          expect(resolved.inspector).toBeGreaterThanOrEqual(260)
          expect(resolved.panel + 44 + 24 + 200).toBeLessThanOrEqual(height)
        }
      }
    }
    expect(preferred).toEqual({ sidebar: 480, inspector: 640, panel: 1000 })
    expect(resolveWorkbenchSizes(preferred, 1920, 1400, true)).toMatchObject(preferred)
  })

  it('reserves the mobile activity bar and keeps very short viewports operable', () => {
    const mobile = resolveWorkbenchSizes(defaultWorkbenchSizes, 390, 520, true)
    expect(mobile).toMatchObject({ mobile: true, docked: false, panelMax: 98 })
    const short = resolveWorkbenchSizes(defaultWorkbenchSizes, 390, 320, false)
    expect(short.panel).toBe(46)
    expect(short.panelMin).toBe(46)
  })
})
