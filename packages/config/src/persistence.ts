import { open, rm } from 'node:fs/promises'

/** Cooperative lock for this package's writers; external editors do not participate. */
export async function withConfigFileLock<T>(filename: string, write: () => Promise<T>): Promise<T> {
  const path = `${filename}.migrate.lock`
  let handle
  try { handle = await open(path, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('another configuration migration or write is in progress')
    throw error
  }
  try { return await write() } finally {
    try { await handle.close() } finally { await rm(path, { force: true }) }
  }
}
