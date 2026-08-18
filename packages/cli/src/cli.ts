import { createRuntimeEntries, loadConfig } from '@numen/config'
import { startRuntime } from '@numen/runtime'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { parseArgs } from 'node:util'

const help = `Numen personal automation runtime

Usage:
  numen start [--config <file>] [--safe]
  numen config validate [--config <file>]
  numen doctor [--config <file>]
  numen --help
`

interface CliIo {
  out(message: string): void
  error(message: string): void
}

const defaultIo: CliIo = {
  out: console.log,
  error: console.error,
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      stop().then(resolve, reject)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

export async function runCli(argv = process.argv.slice(2), io = defaultIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: 'numen.config.yml' },
      safe: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help || positionals.length === 0) {
    io.out(help)
    return 0
  }

  const command = positionals[0]
  if (command === 'config' && positionals[1] === 'validate') {
    const loaded = await loadConfig(values.config)
    createRuntimeEntries(loaded.config, new Set(['database', 'capabilities', 'server', 'health']))
    io.out(`valid: ${loaded.filename}`)
    return 0
  }

  if (command === 'doctor') {
    const loaded = await loadConfig(values.config)
    const entries = createRuntimeEntries(
      loaded.config,
      new Set(['database', 'capabilities', 'server', 'health']),
      values.safe,
    )
    let writable = true
    try {
      await access(loaded.baseDir, constants.R_OK | constants.W_OK)
    } catch {
      writable = false
    }
    io.out(JSON.stringify({
      config: loaded.filename,
      configDirectoryWritable: writable,
      node: process.version,
      safeMode: values.safe,
      plugins: entries.map(entry => ({
        key: entry.key,
        package: entry.name,
        enabled: !entry.disabled,
        builtin: entry.builtin,
      })),
    }, null, 2))
    return writable ? 0 : 1
  }

  if (command === 'start') {
    const application = await startRuntime({ configPath: values.config, safeMode: values.safe })
    const serverUrl = application.serverUrl
    io.out(`Numen ${values.safe ? '(safe mode) ' : ''}started${serverUrl ? ` at ${serverUrl}` : ''}`)
    await waitForShutdown(application.stop)
    return 0
  }

  io.error(`unknown command: ${positionals.join(' ')}`)
  io.error(help)
  return 2
}
