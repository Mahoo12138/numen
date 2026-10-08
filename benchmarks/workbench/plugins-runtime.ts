import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, writeConfig, type NumenConfig } from '../../packages/config/dist/index.js'
import { startRuntime } from '../../packages/runtime/dist/index.js'
import { createPluginCapacityFixture } from './fixtures.js'

export interface FixturePluginObservations {
  starts: number
  disposals: number
  active: number
}

/** No network, registrations, schedules or external side effects in fixture instances. */
export async function createPluginBenchmarkRuntime(entryCount: 100 | 300) {
  const directory = await mkdtemp(join(tmpdir(), `numen-plugin-benchmark-${entryCount}-`))
  const configPath = join(directory, 'numen.config.yml')
  const modulePath = join(directory, 'benchmark-instance.mjs')
  const schemaUrl = pathToFileURL(createRequire(new URL('../../packages/runtime/package.json', import.meta.url)).resolve('schemastery')).href
  await writeFile(modulePath, `import z from ${JSON.stringify(schemaUrl)};
export const observations = { starts: 0, disposals: 0, active: 0 };
export default { name: 'workbench-benchmark-instance', Config: z.object({
  label: z.string().required(), enabled: z.boolean().required(),
  settings: z.object({ value: z.string().required(), retries: z.number().min(0).required() }).required(),
}), apply(ctx) {
  ctx.effect(() => {
    observations.starts++; observations.active++;
    return () => { observations.disposals++; observations.active--; };
  });
} };
`)
  const basePlugins: NumenConfig['plugins'] = {
    database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, coreControls: {}, credentials: {},
    resources: { path: 'data/resources' }, connections: {}, automations: {}, scheduler: { autoDispatch: false },
    triggers: {}, console: {}, server: { host: '127.0.0.1', port: 0 }, workbench: {},
  }
  const fixture = createPluginCapacityFixture(entryCount, modulePath, basePlugins)
  await writeConfig(configPath, { version: 2, dataDir: 'data', logger: { console: false }, plugins: fixture.plugins })
  let application: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    application = await startRuntime({ configPath })
    const snapshot = await application.context.hostConfig.read()
    assert.equal(snapshot.entries.length, entryCount, 'The total measured tree includes infrastructure entries and groups.')
    const fixtureEntries = snapshot.entries.filter(entry => !entry.group && entry.id.startsWith('bench-fixture-'))
    assert.equal(fixtureEntries.length, fixture.metadata.fixtureInstanceCount)
    assert(fixtureEntries.every(entry => entry.actualState === 'ACTIVE'), 'Every fixture instance must finish loading before browser measurement.')
    assert(fixtureEntries.every(entry => entry.configEditable), 'Benchmark instances need an editable public configuration schema.')
    const target = snapshot.entries.find(entry => entry.id === fixture.metadata.targets.entryId)
    assert(target?.configEditable, 'The benchmark target must be a real editable instance.')
    const other = fixtureEntries.find(entry => entry.id !== target.id)
    assert(other, 'Alternating selection needs a second fixture instance.')
    const group = snapshot.entries.find(entry => entry.id === fixture.metadata.targets.groupId)
    assert(group?.group)
    const otherGroup = snapshot.entries.find(entry => entry.group && entry.id !== group.id)
    assert(otherGroup)
    const module = await import(pathToFileURL(modulePath).href) as { observations: FixturePluginObservations }
    const app = application
    return {
      application: app, directory, configPath, modulePath, fixture,
      targets: { instanceIds: [target.id, other.id], groupIds: [group.id, otherGroup.id] } as const,
      observations: (): FixturePluginObservations => ({ ...module.observations }),
      readYaml: () => readFile(configPath, 'utf8'),
      async readTargetConfig() {
        const { config } = await loadConfig(configPath)
        const pending = [config.plugins]
        while (pending.length) {
          const plugins = pending.pop()!
          for (const [key, entry] of Object.entries(plugins)) {
            if (!entry) continue
            if (key === fixture.metadata.targets.instanceKey) {
              const { $package, $label, $collapsed, $disabled, ...value } = entry
              return value
            }
            if (key.startsWith('group:') && entry.plugins && typeof entry.plugins === 'object') pending.push(entry.plugins as NumenConfig['plugins'])
          }
        }
        throw new Error('The measured fixture instance disappeared from YAML.')
      },
      async stop() { try { await app.stop() } finally { await rm(directory, { recursive: true, force: true }) } },
    }
  } catch (error) {
    try { await application?.stop() } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

export type PluginBenchmarkRuntime = Awaited<ReturnType<typeof createPluginBenchmarkRuntime>>
