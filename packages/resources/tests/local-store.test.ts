import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalResourceStore } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function readText(store: LocalResourceStore, digest: string): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of store.read(digest)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('LocalResourceStore', () => {
  it('streams content into atomically deduplicated SHA-256 objects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resource-store-'))
    directories.push(directory)
    const store = new LocalResourceStore(directory)
    const first = await store.write(Buffer.from('hello resource'))
    async function* chunks() {
      yield Buffer.from('hello ')
      yield Buffer.from('resource')
    }
    const duplicate = await store.write(chunks())

    expect(first).toEqual({
      digest: 'sha256:606740c4ca6a3fb6538f810ccc8164cdf879fa97dbcd07473cc97616c888d339',
      size: 14,
    })
    expect(duplicate).toEqual(first)
    expect(await store.has(first.digest)).toBe(true)
    expect(await readText(store, first.digest)).toBe('hello resource')
    expect(await readdir(store.temporaryDirectory)).toEqual([])
    expect(() => store.read('../../etc/passwd')).toThrow('invalid resource digest')
  })

  it('deletes objects idempotently and cleans only expired temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resource-store-'))
    directories.push(directory)
    const store = new LocalResourceStore(directory)
    await store.init()
    const oldPath = join(store.temporaryDirectory, 'old.part')
    const newPath = join(store.temporaryDirectory, 'new.part')
    await Promise.all([writeFile(oldPath, 'old'), writeFile(newPath, 'new')])
    const oldTime = new Date(Date.now() - 60_000)
    await utimes(oldPath, oldTime, oldTime)

    expect(await store.cleanupTemporary(new Date(Date.now() - 1_000))).toBe(1)
    expect(await readdir(store.temporaryDirectory)).toEqual(['new.part'])
    const object = await store.write(Buffer.from('delete me'))
    expect(await store.delete(object.digest)).toBe(true)
    expect(await store.delete(object.digest)).toBe(false)
    expect(await store.has(object.digest)).toBe(false)
  })
})
