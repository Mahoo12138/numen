import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitManagedConfig, HostConfigError, mutateManagedConfig, parseManagedConfig, readManagedConfig } from '../src/index.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const builtins = new Set(['example'])
const directories: string[] = []
afterEach(async () => { vi.mocked(chmod).mockImplementation(actualFs.chmod); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
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

  it('rejects a changed runtime observation after preparing the temporary file and cleans it up', async () => {
    const { filename, directory, document } = await fixture(source)
    let observation = 'previewed'
    vi.mocked(chmod).mockImplementationOnce(async (...args) => {
      await actualFs.chmod(...args)
      observation = 'provider-replaced'
    })
    const guard = vi.fn(current => {
      expect(current.fingerprint).toBe(document.fingerprint)
      expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(true)
      if (observation !== 'previewed') throw new HostConfigError('PREVIEW_STALE', 'Preview observations changed.')
    })
    await expect(commitManagedConfig(filename, document.fingerprint, current => mutateManagedConfig(current, { kind: 'setEnabled', id: 'example', enabled: false }, builtins), builtins, false, guard)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await readFile(filename, 'utf8')).toBe(source)
    expect(await readdir(directory)).toEqual(['config.yml'])
  })

  it('runs the last guard for a no-op without creating a temporary file', async () => {
    const { filename, directory, document } = await fixture(source)
    const guard = vi.fn(() => {
      expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false)
      throw new HostConfigError('PREVIEW_STALE', 'Preview observations changed.')
    })
    await expect(commitManagedConfig(filename, document.fingerprint, current => current, builtins, false, guard)).rejects.toMatchObject({ code: 'PREVIEW_STALE' })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await readFile(filename, 'utf8')).toBe(source)
    expect(await readdir(directory)).toEqual(['config.yml'])
  })

  it('keeps an external edit made while preparing the temporary file and skips the runtime guard', async () => {
    const { filename, directory, document } = await fixture(source)
    vi.mocked(chmod).mockImplementationOnce(async (...args) => {
      await actualFs.chmod(...args)
      await writeFile(filename, `${source}# concurrent disk edit\n`)
    })
    const guard = vi.fn()
    await expect(commitManagedConfig(filename, document.fingerprint, current => mutateManagedConfig(current, { kind: 'setEnabled', id: 'example', enabled: false }, builtins), builtins, false, guard)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(guard).not.toHaveBeenCalled()
    expect(await readFile(filename, 'utf8')).toBe(`${source}# concurrent disk edit\n`)
    expect(await readdir(directory)).toEqual(['config.yml'])
  })

  it('does not yield between the last guard and replacing the file', async () => {
    const { filename, document } = await fixture(source)
    let fingerprintAtMicrotask: string | undefined
    const next = await commitManagedConfig(filename, document.fingerprint, current => mutateManagedConfig(current, { kind: 'setEnabled', id: 'example', enabled: false }, builtins), builtins, false, () => {
      queueMicrotask(() => { fingerprintAtMicrotask = parseManagedConfig(readFileSync(filename, 'utf8'), builtins).fingerprint })
    })
    expect(next.fingerprint).not.toBe(document.fingerprint)
    expect(fingerprintAtMicrotask).toBe(next.fingerprint)
  })

  it('does not overwrite a synchronous disk edit made by a validator in the final guard', async () => {
    const { filename, directory, document } = await fixture(source)
    const guard = vi.fn(() => { writeFileSync(filename, `${source}# validator changed disk\n`) })
    await expect(commitManagedConfig(filename, document.fingerprint, current => mutateManagedConfig(current, { kind: 'setEnabled', id: 'example', enabled: false }, builtins), builtins, false, guard)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await readFile(filename, 'utf8')).toBe(`${source}# validator changed disk\n`)
    expect(await readdir(directory)).toEqual(['config.yml'])
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
