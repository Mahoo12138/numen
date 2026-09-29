import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commitManagedConfig, mutateManagedConfig, parseManagedConfig, readManagedConfig } from '../src/index.js'

const builtins = new Set(['example'])
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'numen-managed-yaml-')); directories.push(directory)
  const filename = join(directory, 'config.yml'); await writeFile(filename, source, { mode: 0o600 })
  return { filename, directory, document: await readManagedConfig(filename, builtins) }
}
const source = `# document note
version: 2
dataDir: .numen
unknownTopLevel: # retained extension
  own: value
plugins:
  # instance note
  example:
    $label: Example # label note
    nested:
      # retry note
      retries: 3 # count note
      extra: retained # extra note
    unknown: retained # unknown note
  other:
    own: value # other plugin note
`

describe('managed configuration persistence', () => {
  it('preserves YAML comments, unknown fields and ownership through nested config edits', async () => {
    const { filename, document } = await fixture(source)
    await chmod(filename, 0o640)
    const before = await lstat(filename)
    const next = await commitManagedConfig(filename, document.fingerprint, async current => mutateManagedConfig(current, { kind: 'setConfig', id: 'example', config: { nested: { retries: 5, extra: 'retained' }, unknown: 'retained' } }, builtins), builtins)
    const text = await readFile(filename, 'utf8')
    for (const comment of ['document note', 'retained extension', 'instance note', 'label note', 'retry note', 'count note', 'extra note', 'unknown note', 'other plugin note']) expect(text).toContain(comment)
    expect(next.config.plugins.example).toMatchObject({ $label: 'Example', nested: { retries: 5, extra: 'retained' }, unknown: 'retained' })
    expect(next.config).toHaveProperty('unknownTopLevel.own', 'value')
    expect(await lstat(filename)).toMatchObject({ uid: before.uid, gid: before.gid })
    expect((await lstat(filename)).mode & 0o777).toBe(0o640)
  })

  it('detects an external edit during validation and does not overwrite it', async () => {
    const { filename, document } = await fixture(source)
    await expect(commitManagedConfig(filename, document.fingerprint, async current => {
      const next = mutateManagedConfig(current, { kind: 'setEnabled', id: 'example', enabled: false }, builtins)
      await writeFile(filename, `${source}# external update\n`)
      return next
    }, builtins)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(await readFile(filename, 'utf8')).toBe(`${source}# external update\n`)
  })

  it('blocks aliases, nonempty removal, missing targets, cycles and colliding group IDs', () => {
    const aliased = parseManagedConfig('version: 2\ndataDir: .numen\nplugins:\n  example: &shared { retries: 3 }\n  other: *shared\n', builtins)
    expect(() => mutateManagedConfig(aliased, { kind: 'setEnabled', id: 'example', enabled: false }, builtins)).toThrow('anchors or aliases')
    const grouped = parseManagedConfig('version: 2\ndataDir: .numen\nplugins:\n  group:a:\n    plugins:\n      group:b:\n        plugins: {}\n', builtins)
    for (const operation of [
      { kind: 'createGroup' as const, id: 'a', parentId: 'group-b' },
      { kind: 'move' as const, id: 'group-a', parentId: 'group-b' },
      { kind: 'move' as const, id: 'group-b', parentId: 'missing' },
      { kind: 'removeGroup' as const, id: 'group-a' },
    ]) expect(() => mutateManagedConfig(grouped, operation, builtins)).toThrow()
  })

  it('does not follow a symlink when replacing managed configuration', async () => {
    const { filename, directory, document } = await fixture(source)
    const link = join(directory, 'symlink.yml'); await symlink(filename, link)
    await expect(commitManagedConfig(link, document.fingerprint, async current => current, builtins)).rejects.toMatchObject({ code: 'CONFIG_FILE_UNSUPPORTED' })
    expect(await readFile(filename, 'utf8')).toBe(source)
  })
})
