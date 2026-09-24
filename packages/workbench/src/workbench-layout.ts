import { computed, inject, onMounted, onScopeDispose, provide, reactive, ref, type InjectionKey, type Ref } from 'vue'

export interface WorkbenchSizes { sidebar: number; inspector: number; panel: number }
export const defaultWorkbenchSizes: WorkbenchSizes = { sidebar: 260, inspector: 360, panel: 240 }
export const workbenchLayoutStorageKey = 'numen.workbench.layout.v1'
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value))

/** Persist only user preferences, not the temporary clamp caused by a smaller viewport. */
export function parseWorkbenchSizes(raw: string | null): WorkbenchSizes {
  const sizes = { ...defaultWorkbenchSizes }
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return sizes
    for (const key of ['sidebar', 'inspector', 'panel'] as const) {
      const field = (value as Record<string, unknown>)[key]
      if (typeof field === 'number' && Number.isFinite(field)) sizes[key] = Math.round(clamp(field, key === 'sidebar' ? 180 : key === 'inspector' ? 260 : 120, key === 'sidebar' ? 480 : key === 'inspector' ? 640 : 1200))
    }
  } catch { /* Invalid/old storage cannot prevent the workspace from opening. */ }
  return sizes
}

export function resolveWorkbenchSizes(preferred: WorkbenchSizes, width: number, height: number, inspectorOpen: boolean) {
  const mobile = width < 900
  const docked = width >= 1280
  const rail = mobile ? 0 : docked ? 76 : 68
  const inspector = clamp(preferred.inspector, 260, Math.min(640, width - rail - (docked ? 180 + 320 : 64)))
  const sidebarMax = Math.min(480, width - rail - 320 - (docked && inspectorOpen ? inspector : 0))
  const sidebar = clamp(preferred.sidebar, 180, sidebarMax)
  const inspectorMax = Math.min(640, width - rail - (docked ? sidebar + 320 : 64))
  const panelMax = Math.max(46, height - 44 - 24 - (mobile ? 54 : 0) - (mobile ? 300 : 200))
  return {
    mobile, docked, sidebar, inspector, panel: clamp(preferred.panel, Math.min(120, panelMax), panelMax),
    sidebarMax, inspectorMax, panelMax, panelMin: Math.min(120, panelMax),
  }
}

export function provideWorkbenchLayout(root: Ref<HTMLElement | undefined>, inspectorOpen: Ref<boolean>) {
  const preferred = reactive({ ...defaultWorkbenchSizes })
  const viewport = reactive({ width: 1440, height: 900 })
  const panelOpen = ref(false)
  const sizes = computed(() => resolveWorkbenchSizes(preferred, viewport.width, viewport.height, inspectorOpen.value))
  let observer: ResizeObserver | undefined
  onMounted(() => {
    try { Object.assign(preferred, parseWorkbenchSizes(localStorage.getItem(workbenchLayoutStorageKey))) } catch { /* Storage can be unavailable in embedded/private contexts. */ }
    const measure = () => {
      const rect = root.value?.getBoundingClientRect()
      if (rect) { viewport.width = rect.width; viewport.height = rect.height }
    }
    measure()
    observer = new ResizeObserver(measure)
    if (root.value) observer.observe(root.value)
  })
  onScopeDispose(() => observer?.disconnect())
  let beforeResize: { sizes: WorkbenchSizes; panelOpen: boolean } | undefined
  const snapshot = () => { beforeResize ??= { sizes: { ...preferred }, panelOpen: panelOpen.value } }
  const save = () => {
    beforeResize = undefined
    try { localStorage.setItem(workbenchLayoutStorageKey, JSON.stringify(preferred)) } catch { /* Resizing still works when preferences cannot be stored. */ }
  }
  const layout = {
    sizes, preferred, panelOpen, save,
    resize(key: 'sidebar' | 'inspector', value: number) { snapshot(); preferred[key] = value },
    cancel() {
      if (!beforeResize) return
      Object.assign(preferred, beforeResize.sizes)
      panelOpen.value = beforeResize.panelOpen
      beforeResize = undefined
    },
    setPanel(value: number) {
      snapshot()
      if (value <= (sizes.value.mobile ? 42 : 46)) { panelOpen.value = false; return }
      panelOpen.value = true
      preferred.panel = Math.max(sizes.value.panelMin, value)
    },
    reset(key: keyof WorkbenchSizes) { preferred[key] = defaultWorkbenchSizes[key]; save() },
  }
  provide(layoutKey, layout)
  return layout
}
export type WorkbenchLayout = ReturnType<typeof provideWorkbenchLayout>
const layoutKey: InjectionKey<WorkbenchLayout> = Symbol('numen.workbench.layout')
export const useWorkbenchLayout = () => inject(layoutKey, undefined)
