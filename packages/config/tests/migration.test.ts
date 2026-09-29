import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { applyConfigMigration, configFingerprint, legacyConsoleNames, legacyWorkbenchNames, planConfigMigration, writeConfig } from '../src/index.js'

const builtins = new Set<string>([...legacyConsoleNames, ...legacyWorkbenchNames, 'health'])
const family = (names: readonly string[], disabled = false) => Object.fromEntries(names.map(name => [name, disabled ? { $if: false } : {}]))
const sourceFor = (plugins: Record<string, unknown>) => stringify({ version: 1, dataDir: '.numen', plugins })
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture(source: string) { const directory = await mkdtemp(join(tmpdir(), 'numen-migration-')); directories.push(directory); const filename = join(directory, 'config.yml'); await writeFile(filename, source, { mode: 0o600 }); return { directory, filename } }

describe('explicit migration', () => {
  it('migrates separate products with independent intent, options and unrelated data', async () => {
    const source = sourceFor({ ...family(legacyConsoleNames), consoleAuth: { token: 'private-bootstrap-token', ownerId: 'me' }, consoleHttp: { path: '/custom-rpc' }, ...family(legacyWorkbenchNames, true), workbench: { $if: false, root: './web', entrySource: './entry.js' }, other: { untouched: { account: 'abc' } } })
    const { filename } = await fixture(source)
    const before = await lstat(filename)
    const plan = planConfigMigration(source, builtins)
    expect(JSON.stringify(plan)).not.toContain('private-bootstrap-token')
    expect(plan.conflicts).toEqual([])
    expect(await readFile(filename, 'utf8')).toBe(source)
    const result = await applyConfigMigration(filename, plan.fingerprint, builtins)
    const migrated = parse(await readFile(filename, 'utf8'))
    expect(migrated).toMatchObject({ version: 2, plugins: { console: { auth: { token: 'private-bootstrap-token', ownerId: 'me' }, http: { path: '/custom-rpc' } }, workbench: { $if: false, root: './web', entrySource: './entry.js' }, other: { untouched: { account: 'abc' } } } })
    expect(Object.keys(migrated.plugins)).toEqual(['console', 'workbench', 'other'])
    expect(await readFile(result.backup, 'utf8')).toBe(source)
    expect((await lstat(result.backup)).mode & 0o777).toBe(0o600)
    expect((await lstat(filename)).mode & 0o777).toBe(0o600)
    for (const path of [filename, result.backup]) expect(await lstat(path)).toMatchObject({ uid: before.uid, gid: before.gid })
  })

  it('supports Console alone and preserves all comments and restrictive permissions', async () => {
    const source = `# top note\nversion: 1 # version note\ndataDir: .numen\nplugins:\n  # service note\n  console: {}\n  consoleEntries: null # registry note\n  # auth note\n  consoleAuth:\n    # token note\n    token: secret\n  consoleSession: {} # session note\n  consoleAssets: {}\n  consoleHttp: {}\n  consoleWs: {}\n  other: # unrelated note\n    arbitrary: value # field note\n`
    const { filename } = await fixture(source)
    await chmod(filename, 0o400)
    const result = await applyConfigMigration(filename, configFingerprint(source), builtins)
    const migrated = await readFile(filename, 'utf8')
    for (const comment of ['top note', 'version note', 'service note', 'registry note', 'auth note', 'token note', 'session note', 'unrelated note', 'field note']) expect(migrated).toContain(comment)
    expect(parse(migrated).plugins.workbench).toBeUndefined()
    expect((await lstat(filename)).mode & 0o777).toBe(0o400)
    expect((await lstat(result.backup)).mode & 0o777).toBe(0o400)
  })

  it('preserves aliased builtin primary identity and warns without activating Console', async () => {
    const plugins = family(legacyWorkbenchNames)
    delete plugins.workbench
    plugins['dashboard:main'] = { $package: 'cordis:workbench' } as never
    const source = sourceFor(plugins)
    const plan = planConfigMigration(source, builtins)
    expect(plan.conflicts).toEqual([])
    expect(plan.diagnostics[0]).toContain('Console is unavailable')
    const { filename } = await fixture(source)
    await applyConfigMigration(filename, plan.fingerprint, builtins)
    expect(parse(await readFile(filename, 'utf8')).plugins).toEqual({ 'dashboard:main': { $package: 'cordis:workbench' } })
  })

  it('maps exact legacy Workbench package aliases while preserving both disabled product intents', async () => {
    for (const direct of [false, true]) {
      const plugins: Record<string, unknown> = { ...family(legacyConsoleNames, true), ...family(legacyWorkbenchNames, true) }
      delete plugins.workbench
      const key = direct ? '@numenjs/workbench/runtime' : 'dashboard:main'
      plugins[key] = { $if: false, ...(!direct ? { $package: '@numenjs/workbench/runtime' } : {}) }
      const source = sourceFor(plugins)
      const plan = planConfigMigration(source, builtins)
      expect(plan.conflicts).toEqual([])
      const { filename } = await fixture(source)
      await applyConfigMigration(filename, plan.fingerprint, builtins)
      const migrated = parse(await readFile(filename, 'utf8'))
      expect(migrated.plugins.console.$if).toBe(false)
      expect(migrated.plugins[key]).toEqual({ $if: false, $package: '@numenjs/workbench/plugin' })
    }
  })

  it('leaves similarly named external plugins untouched and reports resulting ID collisions', async () => {
    const plugins = { unrelatedAuth: { $package: '@example/consoleAuth', own: 'value' }, consoleExtra: { custom: true } }
    const source = sourceFor(plugins)
    const { filename } = await fixture(source)
    await applyConfigMigration(filename, configFingerprint(source), builtins)
    expect(parse(await readFile(filename, 'utf8')).plugins).toEqual(plugins)
    expect(planConfigMigration(sourceFor({ 'custom:a': {}, 'custom-a': {} }), builtins).conflicts.join()).toContain('duplicate plugin entry id')
  })

  it('blocks partial assembly, mixed enablement, unknown options and changed builtin sources', () => {
    for (const plugins of [
      { console: {}, consoleAuth: {} },
      { ...family(legacyConsoleNames), consoleHttp: { $if: false } },
      { ...family(legacyConsoleNames), consoleAuth: { provider: 'external-auth', token: 'private' } },
      { ...family(legacyConsoleNames), consoleAuth: { $package: '@external/auth' } },
      { health: { $package: '@external/health' } },
      { other: { $label: 'original payload' } },
      { other: { $package: '@numenjs/workbench/server' } },
    ]) expect(planConfigMigration(sourceFor(plugins), builtins).conflicts.length).toBeGreaterThan(0)
  })

  it('rejects anchored product data instead of silently breaking external references', () => {
    const source = sourceFor(family(legacyConsoleNames)).replace('consoleAuth: {}', 'consoleAuth: &authentication { token: secret }') + '  other: *authentication\n'
    expect(planConfigMigration(source, builtins).conflicts.join()).toContain('anchors or aliases')
    const anchoredKey = sourceFor(family(legacyConsoleNames)).replace('consoleAuth:', '&authkey consoleAuth:') + '  other: { name: *authkey }\n'
    expect(planConfigMigration(anchoredKey, builtins).conflicts.join()).toContain('anchors or aliases')
  })

  it('rejects stale fingerprints, concurrent migrations and symlinks without replacing data', async () => {
    const source = sourceFor(family(legacyConsoleNames))
    const { filename, directory } = await fixture(source)
    const plan = planConfigMigration(source, builtins)
    await writeFile(filename, `${source}# edited\n`)
    await expect(applyConfigMigration(filename, plan.fingerprint, builtins)).rejects.toThrow('changed since dry-run')
    expect(await readdir(directory)).toEqual(['config.yml'])
    await writeFile(`${filename}.migrate.lock`, '')
    await expect(applyConfigMigration(filename, plan.fingerprint, builtins)).rejects.toThrow('another configuration migration')
    await expect(writeConfig(filename, { version: 2, dataDir: '.numen', plugins: {} })).rejects.toThrow('another configuration migration')
    await rm(`${filename}.migrate.lock`)
    const link = join(directory, 'link.yml'); await symlink(filename, link)
    await expect(applyConfigMigration(link, plan.fingerprint, builtins)).rejects.toThrow('symbolic link')
    expect(await readFile(filename, 'utf8')).toBe(`${source}# edited\n`)
  })
})
