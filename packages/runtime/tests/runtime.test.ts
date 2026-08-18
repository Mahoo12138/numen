import { writeConfig } from '@numen/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startRuntime, type NumenApplication } from '../src/index.js'

const applications: NumenApplication[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Numen runtime', () => {
  it('boots the configured Cordis tree and exposes operational health', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-runtime-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        database: { path: 'data/numen.db' },
        capabilities: {},
        server: { host: '127.0.0.1', port: 0 },
        health: {},
      },
    })

    const application = await startRuntime({ configPath })
    applications.push(application)
    const baseUrl = application.serverUrl!

    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', name: 'numen' })

    const ready = await fetch(`${baseUrl}/api/ready`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      checks: { database: { migrationVersion: 1 } },
    })
  })
})
