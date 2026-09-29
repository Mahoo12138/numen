import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createWorkbenchCommands, installCommandShortcuts, shortcutLabel, shortcutMatches } from '../src/commands.js'

afterEach(() => vi.unstubAllGlobals())

describe('Workbench commands', () => {
  it('rechecks current visibility and disabled state and removes exactly its disposed provider', () => {
    const registry = createWorkbenchCommands()
    const visible = ref(true)
    const disabled = ref('Unavailable')
    const base = vi.fn(); const local = vi.fn()
    const removeBase = registry.register(() => [{ id: 'open', label: 'Open', execute: base }])
    const removeLocal = registry.register(() => [{ id: 'open', label: 'Open selected', visible: visible.value, disabledReason: disabled.value, execute: local }])
    expect(registry.execute('open')).toBe(false)
    disabled.value = ''
    expect(registry.execute('open')).toBe(true)
    expect(local).toHaveBeenCalledTimes(1)
    visible.value = false
    expect(registry.commands).toHaveLength(0)
    expect(registry.execute('open')).toBe(false)
    removeLocal()
    expect(registry.execute('open')).toBe(true)
    expect(base).toHaveBeenCalledTimes(1)
    removeLocal(); removeBase()
    expect(registry.execute('open')).toBe(false)
  })

  it('uses one platform modifier and shows shortcuts that match the accepted keys', () => {
    const shortcut = { key: 'z', mod: true, shift: true }
    expect(shortcutLabel(shortcut, true)).toBe('⌘⇧Z')
    expect(shortcutLabel(shortcut, false)).toBe('Ctrl+Shift+Z')
    const event = { key: 'Z', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }
    expect(shortcutMatches(event, shortcut, true)).toBe(true)
    expect(shortcutMatches(event, shortcut, false)).toBe(false)
    expect(shortcutMatches({ ...event, ctrlKey: true }, shortcut, true)).toBe(false)
    expect(shortcutMatches({ ...event, shiftKey: false }, shortcut, true)).toBe(false)
  })

  it('protects editable focus, IME, modal interactions and repeat, then fully removes its listener', () => {
    class TestElement { constructor(readonly editable: boolean) {} closest() { return this.editable ? this : null } }
    vi.stubGlobal('Element', TestElement)
    const modal = ref(false)
    vi.stubGlobal('document', { querySelector: () => modal.value ? {} : null })
    const registry = createWorkbenchCommands()
    const undo = vi.fn(); const center = vi.fn()
    registry.register(() => [
      { id: 'undo', label: 'Undo', shortcut: { key: 'z', mod: true }, execute: undo },
      { id: 'center', label: 'Commands', shortcut: { key: 'k', mod: true }, allowInInput: true, execute: center },
    ])
    const listeners = new Set<(event: KeyboardEvent) => void>()
    const environment = { addEventListener(_type: string, listener: (event: KeyboardEvent) => void) { listeners.add(listener) }, removeEventListener(_type: string, listener: (event: KeyboardEvent) => void) { listeners.delete(listener) } }
    const remove = installCommandShortcuts(registry, environment as unknown as Window, false)
    const dispatch = (override: Record<string, unknown> = {}) => {
      const event = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, keyCode: 90, defaultPrevented: false, target: new TestElement(false), preventDefault: vi.fn(), ...override }
      for (const listener of listeners) listener(event as unknown as KeyboardEvent)
      return event
    }
    expect(dispatch().preventDefault).toHaveBeenCalled()
    expect(undo).toHaveBeenCalledTimes(1)
    for (const override of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { target: new TestElement(true) }]) {
      expect(dispatch(override).preventDefault).not.toHaveBeenCalled()
    }
    expect(undo).toHaveBeenCalledTimes(1)
    dispatch({ key: 'k', target: new TestElement(true) })
    expect(center).toHaveBeenCalledTimes(1)
    modal.value = true
    dispatch(); dispatch({ key: 'k' })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(center).toHaveBeenCalledTimes(1)
    modal.value = false
    remove(); dispatch()
    expect(listeners.size).toBe(0)
    expect(undo).toHaveBeenCalledTimes(1)
  })
})
