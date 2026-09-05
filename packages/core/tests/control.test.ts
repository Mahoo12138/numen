import { Context } from 'cordis'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { ControlRegistry, coreControlsPlugin, type ExtensionControlDefinition } from '../src/index.js'

const definition: ExtensionControlDefinition = {
  kind: 'extension', id: 'test:pause', version: 1, title: 'Pause', description: 'A plugin control',
  input: z.object({ milliseconds: z.number().min(0).required() }),
  lower: ({ nodeId, input }) => ({ type: 'wait', id: nodeId, durationMs: input.milliseconds! }),
}

describe('ControlRegistry', () => {
  it('owns core and extension definitions through plugin effects and permits re-registration after unload', async () => {
    const root = new Context()
    await root.plugin(ControlRegistry)
    const events: string[] = []
    root.on('numen/control-change', ref => { events.push(ref.id) })
    const core = await root.plugin(coreControlsPlugin)
    expect(root.controls.list()).toHaveLength(5)
    const plugin = (ctx: Context) => { ctx.controls.defineControl(ctx, definition) }
    plugin.inject = ['controls']
    const owner = await root.plugin(plugin)
    expect(root.controls.get(definition)?.title).toBe('Pause')
    expect(() => root.controls.defineControl(root, definition)).toThrow('already defined')
    await owner.dispose()
    expect(root.controls.get(definition)).toBeUndefined()
    const dispose = root.controls.defineControl(root, definition)
    dispose()
    await core.dispose()
    expect(root.controls.list()).toEqual([])
    expect(events.filter(id => id === definition.id)).toHaveLength(4)
    await root.fiber.dispose()
  })

  it('rejects invalid identities and non-object extension input contracts', async () => {
    const root = new Context()
    await root.plugin(ControlRegistry)
    expect(() => root.controls.defineControl(root, { ...definition, version: 0 })).toThrow('identity')
    expect(() => root.controls.defineControl(root, { ...definition, id: 'not-namespaced' })).toThrow('identity')
    expect(() => root.controls.defineControl(root, { ...definition, input: z.string() as never })).toThrow('object input')
    expect(() => root.controls.defineControl(root, { kind: 'core', id: 'test:wait', version: 1, title: 'Wait', description: '', control: 'wait' })).toThrow('intrinsic')
    await root.fiber.dispose()
  })
})
