import { writeConfig } from '@numen/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runCli } from '../src/index.js'

it('reports the default Console service as a safe-mode builtin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-cli-'))
  try {
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        console: {}, consoleEntries: {}, consoleAuth: {}, consoleSession: {},
        consoleAssets: {}, consoleHttp: {}, consoleWs: {},
      },
    })
    const output: string[] = []
    const result = await runCli(['doctor', '--safe', '--config', configPath], {
      out: message => output.push(message),
      error: message => output.push(message),
    })

    expect(result).toBe(0)
    expect(JSON.parse(output[0]!)).toMatchObject({
      plugins: [
        { key: 'console', package: 'cordis:console', enabled: true, builtin: true },
        { key: 'consoleEntries', package: 'cordis:consoleEntries', enabled: true, builtin: true },
        { key: 'consoleAuth', package: 'cordis:consoleAuth', enabled: true, builtin: true },
        { key: 'consoleSession', package: 'cordis:consoleSession', enabled: true, builtin: true },
        { key: 'consoleAssets', package: 'cordis:consoleAssets', enabled: true, builtin: true },
        { key: 'consoleHttp', package: 'cordis:consoleHttp', enabled: true, builtin: true },
        { key: 'consoleWs', package: 'cordis:consoleWs', enabled: true, builtin: true },
      ],
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('prints a fragment-only Workbench launch URL only when explicitly requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-cli-launch-'))
  try {
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        console: {},
        consoleEntries: {},
        consoleAuth: { token: 'cli-launch-token' },
        server: { host: '127.0.0.1', port: 0 },
        workbench: {},
      },
    })
    const output: string[] = []
    const task = runCli(['start', '--config', configPath, '--print-launch-url'], {
      out: message => output.push(message),
      error: message => output.push(message),
    })

    await vi.waitFor(() => expect(output).toHaveLength(2))
    process.emit('SIGTERM', 'SIGTERM')
    await expect(task).resolves.toBe(0)
    const line = output[1]!
    expect(line).toMatch(/^Workbench launch URL \(keep private\): /)
    const url = new URL(line.slice(line.indexOf('http')))
    expect(url.search).toBe('')
    expect(url.pathname).toBe('/')
    expect(new URLSearchParams(url.hash.slice(1)).get('numen-bootstrap')).toBe('cli-launch-token')
    expect(output[0]).not.toContain('cli-launch-token')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
