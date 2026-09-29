import { computed, inject, onScopeDispose, provide, shallowReactive, type InjectionKey } from 'vue'

export interface CommandShortcut { key: string; mod?: boolean; shift?: boolean; alt?: boolean }
export interface WorkbenchCommand {
  id: string
  label: string
  description?: string
  shortcut?: CommandShortcut
  allowInInput?: boolean
  visible?: boolean
  disabledReason?: string
  execute(): void | boolean
}
export interface WorkbenchCommands {
  readonly commands: readonly WorkbenchCommand[]
  register(resolve: () => readonly WorkbenchCommand[]): () => void
  find(id: string): WorkbenchCommand | undefined
  execute(id: string): boolean
}
const commandsKey: InjectionKey<WorkbenchCommands> = Symbol('workbench-commands')

/** One registry for the mounted Shell. Providers remain owners of domain state and guards. */
export function createWorkbenchCommands(): WorkbenchCommands {
  const providers = shallowReactive(new Map<symbol, () => readonly WorkbenchCommand[]>())
  const commands = computed(() => {
    const byId = new Map<string, WorkbenchCommand>()
    for (const resolve of providers.values()) for (const command of resolve()) byId.set(command.id, command)
    return [...byId.values()].filter(command => command.visible !== false)
  })
  const registry: WorkbenchCommands = {
    get commands() { return commands.value },
    register(resolve) { const token = Symbol(); providers.set(token, resolve); return () => { providers.delete(token) } },
    find(id) { return commands.value.find(command => command.id === id) },
    execute(id) {
      const command = registry.find(id)
      if (!command || command.disabledReason) return false
      return command.execute() !== false
    },
  }
  return registry
}
export function provideWorkbenchCommands() { const registry = createWorkbenchCommands(); provide(commandsKey, registry); return registry }
export const useWorkbenchCommands = () => inject(commandsKey, undefined)
export function useCommandRegistration(resolve: () => readonly WorkbenchCommand[]) {
  const registry = useWorkbenchCommands()
  const dispose = registry?.register(resolve)
  onScopeDispose(() => dispose?.())
  return registry
}

export const isApplePlatform = (platform = typeof navigator === 'undefined' ? '' : navigator.platform) => /Mac|iPhone|iPad|iPod/i.test(platform)
export function shortcutLabel(shortcut: CommandShortcut, apple = isApplePlatform()): string {
  const key = ({ ArrowUp: '↑', ArrowDown: '↓', Delete: 'Delete', Escape: 'Esc' } as Record<string, string>)[shortcut.key] ?? shortcut.key.toUpperCase()
  return [shortcut.mod ? apple ? '⌘' : 'Ctrl' : '', shortcut.alt ? apple ? '⌥' : 'Alt' : '', shortcut.shift ? apple ? '⇧' : 'Shift' : '', key].filter(Boolean).join(apple ? '' : '+')
}
export function shortcutMatches(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, shortcut: CommandShortcut, apple = isApplePlatform()): boolean {
  return event.key.toLowerCase() === shortcut.key.toLowerCase()
    && (apple ? event.metaKey : event.ctrlKey) === !!shortcut.mod
    && !(apple ? event.ctrlKey : event.metaKey)
    && event.altKey === !!shortcut.alt && event.shiftKey === !!shortcut.shift
}
export function commandShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}
export function installCommandShortcuts(registry: WorkbenchCommands, environment: Pick<Window, 'addEventListener' | 'removeEventListener'> = window, apple = isApplePlatform()): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="listbox"], [role="menu"]')) return
    const command = registry.commands.find(item => item.shortcut && shortcutMatches(event, item.shortcut, apple))
    if (!command || command.disabledReason || (commandShortcutTarget(event.target) && !command.allowInInput)) return
    event.preventDefault()
    registry.execute(command.id)
  }
  environment.addEventListener('keydown', onKey as EventListener)
  return () => environment.removeEventListener('keydown', onKey as EventListener)
}
