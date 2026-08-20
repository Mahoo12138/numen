import { writeConfig } from '@numen/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/index.js'

it('reports the default Console service as a safe-mode builtin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'numen-cli-'))
  try {
    const configPath = join(directory, 'numen.config.yml')
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        console: {}, consoleEntries: {}, consoleAuth: {}, consoleSession: {}, consoleHttp: {}, consoleWs: {},
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
        { key: 'consoleHttp', package: 'cordis:consoleHttp', enabled: true, builtin: true },
        { key: 'consoleWs', package: 'cordis:consoleWs', enabled: true, builtin: true },
      ],
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
