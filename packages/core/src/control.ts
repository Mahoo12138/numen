import { Service, type Context } from 'cordis'
import type Schema from 'schemastery'
import type { ControlRef, CoreControlSource, ValueExpr } from './automation.js'
import type { NumenValue } from './value.js'

export type CoreControlKind = 'wait' | 'if' | 'parallel' | 'race' | 'foreach'
interface ControlIdentity extends ControlRef { title: string; description: string }
export interface CoreControlDefinition extends ControlIdentity { kind: 'core'; control: CoreControlKind }
export interface ExtensionControlDefinition extends ControlIdentity {
  kind: 'extension'
  input: Schema<Record<string, NumenValue>>
  /** Pure, synchronous lowering. Root ID must match nodeId; child IDs must start with `${nodeId}.`. */
  lower(context: { readonly nodeId: string; readonly input: Readonly<Record<string, ValueExpr>> }): CoreControlSource
}
export type ControlDefinition = CoreControlDefinition | ExtensionControlDefinition
export interface ControlResolver { get(ref: ControlRef): ControlDefinition | undefined }

export const coreControlDefinitions: readonly CoreControlDefinition[] = [
  { kind: 'core', id: 'numen:wait', version: 1, control: 'wait', title: 'Wait', description: 'Pause for a duration or until a date and time.' },
  { kind: 'core', id: 'numen:if', version: 1, control: 'if', title: 'If', description: 'Branch into structured then and optional else blocks.' },
  { kind: 'core', id: 'numen:parallel', version: 1, control: 'parallel', title: 'Parallel', description: 'Run structured branches concurrently and join all results.' },
  { kind: 'core', id: 'numen:race', version: 1, control: 'race', title: 'Race', description: 'Run branches concurrently and keep the first successful result.' },
  { kind: 'core', id: 'numen:foreach', version: 1, control: 'foreach', title: 'For each', description: 'Iterate a structured body with bounded concurrency.' },
]

export const controlKey = (ref: ControlRef): string => `${ref.id}@${ref.version}`
declare module 'cordis' {
  interface Context { controls: ControlRegistry }
  interface Events { 'numen/control-change'(ref: ControlRef): void }
}

export class ControlRegistry extends Service {
  private readonly definitions = new Map<string, ControlDefinition>()
  constructor(ctx: Context) { super(ctx, 'controls') }

  defineControl(owner: Context, definition: ControlDefinition): () => void {
    if (!/^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/.test(definition.id)
      || !Number.isSafeInteger(definition.version) || definition.version < 1
      || typeof definition.title !== 'string' || !definition.title.trim()
      || typeof definition.description !== 'string') throw new TypeError('invalid Control identity')
    if (definition.kind === 'core') {
      if (!coreControlDefinitions.some(core => core.id === definition.id && core.version === definition.version && core.control === definition.control)) {
        throw new TypeError('core Control identity must match a supported intrinsic control')
      }
    } else if (definition.kind !== 'extension' || typeof definition.lower !== 'function' || definition.input?.type !== 'object') {
      throw new TypeError('extension Control requires an object input Schema and a synchronous lower function')
    }
    const key = controlKey(definition)
    if (this.definitions.has(key)) throw new Error(`Control already defined: ${key}`)
    const registered = Object.freeze({ ...definition })
    return owner.effect(() => {
      if (this.definitions.has(key)) throw new Error(`Control already defined: ${key}`)
      this.definitions.set(key, registered)
      this.ctx.emit('numen/control-change', registered)
      return () => {
        this.definitions.delete(key)
        this.ctx.emit('numen/control-change', registered)
      }
    }, `controls.defineControl(${JSON.stringify(key)})`)
  }
  get(ref: ControlRef): ControlDefinition | undefined { return this.definitions.get(controlKey(ref)) }
  list(): ControlDefinition[] { return [...this.definitions.values()] }
}

export function coreControlsPlugin(ctx: Context): void {
  for (const definition of coreControlDefinitions) ctx.controls.defineControl(ctx, definition)
}
coreControlsPlugin.inject = ['controls']
