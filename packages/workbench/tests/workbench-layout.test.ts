import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { defaultWorkbenchSizes, parseWorkbenchSizes, provideWorkbenchLayout, resolveWorkbenchSizes, type WorkbenchLayout } from '../src/workbench-layout.js'
import { renderToMarkup } from './render.js'

async function createLayout() {
  let layout!: WorkbenchLayout
  await renderToMarkup(h(defineComponent({ setup() {
    layout = provideWorkbenchLayout(ref<HTMLElement>(), ref(true))
    return () => h('div')
  } })))
  return layout
}

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

  it('does not charge sidebar-free pages for stored sidebar widths when sizing the inspector', () => {
    const preferred = { sidebar: 480, inspector: 640, panel: 240 }
    for (const width of [900, 1280, 1440]) {
      const resolved = resolveWorkbenchSizes(preferred, width, 960, true, false)
      const rail = resolved.docked ? 76 : 68
      const available = width - rail - (resolved.docked ? resolved.inspector : 0)
      expect(available).toBeGreaterThanOrEqual(320)
      expect(resolved.inspectorMax).toBe(Math.min(640, width - rail - (resolved.docked ? 320 : 64)))
    }
    const withoutSidebar = resolveWorkbenchSizes({ ...preferred, inspector: 260 }, 1280, 960, true, false)
    const withSidebar = resolveWorkbenchSizes({ ...preferred, inspector: 260 }, 1280, 960, true, true)
    expect(withoutSidebar.inspectorMax).toBe(640)
    expect(withSidebar.inspectorMax).toBeLessThan(withoutSidebar.inspectorMax)
    expect(preferred).toEqual({ sidebar: 480, inspector: 640, panel: 240 })
    expect(resolveWorkbenchSizes(preferred, 1920, 960, true, true).sidebar).toBe(480)
  })

  it('keeps the unclamped expanded preference when a region collapses and restores the whole cancelled gesture', async () => {
    const layout = await createLayout()
    Object.assign(layout.preferred, { sidebar: 480, inspector: 640, panel: 360 })
    expect(layout.sizes.value.sidebar).toBeLessThan(layout.preferred.sidebar)
    layout.resize('sidebar', 180)
    layout.setCollapsed('sidebar', true)
    expect(layout.sidebarOpen.value).toBe(false)
    expect(layout.preferred.sidebar).toBe(480)
    layout.setCollapsed('sidebar', false)
    layout.resize('sidebar', 200)
    layout.cancel()
    expect(layout.sidebarOpen.value).toBe(true)
    expect(layout.preferred).toEqual({ sidebar: 480, inspector: 640, panel: 360 })
    layout.resize('inspector', 260)
    layout.setCollapsed('inspector', true)
    layout.save()
    expect(layout.inspectorOpen.value).toBe(false)
    expect(layout.preferred.inspector).toBe(640)
    layout.inspectorOpen.value = true
    layout.resize('inspector', 300)
    layout.cancel()
    expect(layout.inspectorOpen.value).toBe(true)
    expect(layout.preferred.inspector).toBe(640)
  })

  it('restores a collapsed panel after an aborted opening and commits the next gesture independently', async () => {
    const layout = await createLayout()
    layout.preferred.panel = 360
    layout.setCollapsed('panel', false)
    layout.setPanel(180)
    layout.cancel()
    expect(layout.panelOpen.value).toBe(false)
    expect(layout.preferred.panel).toBe(360)
    layout.setCollapsed('panel', false)
    layout.setPanel(180)
    layout.save()
    layout.setPanel(120)
    layout.setCollapsed('panel', true)
    layout.save()
    expect(layout.panelOpen.value).toBe(false)
    expect(layout.preferred.panel).toBe(180)
  })
})
