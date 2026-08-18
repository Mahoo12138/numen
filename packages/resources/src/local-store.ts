import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface StoredResourceObject {
  digest: string
  size: number
}

export type ResourceContent = Uint8Array | AsyncIterable<Uint8Array>

const digestPattern = /^sha256:([a-f0-9]{64})$/

export class LocalResourceStore {
  readonly root: string
  readonly objectsDirectory: string
  readonly temporaryDirectory: string

  constructor(root: string) {
    this.root = resolve(root)
    this.objectsDirectory = join(this.root, 'objects', 'sha256')
    this.temporaryDirectory = join(this.root, 'temporary')
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.objectsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 }),
    ])
  }

  async write(content: ResourceContent): Promise<StoredResourceObject> {
    await this.init()
    const temporaryPath = join(this.temporaryDirectory, `${randomUUID()}.part`)
    const hash = createHash('sha256')
    let size = 0
    const inspect = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        hash.update(bytes)
        callback(null, bytes)
      },
    })
    const source = content instanceof Uint8Array ? Readable.from([content]) : Readable.from(content)
    try {
      await pipeline(source, inspect, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }))
      const hex = hash.digest('hex')
      const digest = `sha256:${hex}`
      const objectPath = this.pathForDigest(digest)
      await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
      try {
        await link(temporaryPath, objectPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await unlink(temporaryPath)
      return { digest, size }
    } catch (error) {
      await unlink(temporaryPath).catch(unlinkError => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
      throw error
    }
  }

  read(digest: string): Readable {
    return createReadStream(this.pathForDigest(digest))
  }

  async has(digest: string): Promise<boolean> {
    try {
      const info = await stat(this.pathForDigest(digest))
      return info.isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async delete(digest: string): Promise<boolean> {
    try {
      await unlink(this.pathForDigest(digest))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async cleanupTemporary(olderThan: Date): Promise<number> {
    await this.init()
    const entries = await readdir(this.temporaryDirectory, { withFileTypes: true })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue
      const path = join(this.temporaryDirectory, entry.name)
      const info = await stat(path)
      if (info.mtime > olderThan) continue
      try {
        await unlink(path)
        removed += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return removed
  }

  private pathForDigest(digest: string): string {
    const match = digestPattern.exec(digest)
    if (!match) throw new TypeError(`invalid resource digest: ${digest}`)
    const hex = match[1]!
    return join(this.objectsDirectory, hex.slice(0, 2), hex.slice(2))
  }
}
