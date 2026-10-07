import { writeConfig } from '@numenjs/config'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const processes = new Set<ChildProcess>()
const fixturePath = fileURLToPath(new URL('./fixtures/draft-test-process.mjs', import.meta.url))

interface ChildResult {
  pid: number
  runId: string
  snapshotId: string
  resourceId: string
  draftVersion: number
  status: string
  snapshots: number
  runs: number
  owners: { type: string; id: string }[]
}

function startChild(phase: 'accept' | 'recover', configPath: string, recordPath: string) {
  const child = spawn(process.execPath, [fixturePath, phase, configPath, recordPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  processes.add(child)
  let output = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { output += String(chunk) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      processes.delete(child)
      resolve({ code, signal })
    })
  })
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      const event = message as { type: string; result?: ChildResult; error?: string }
      if (event.type === 'result') resolve(event.result!)
      if (event.type === 'error') reject(new Error(event.error))
    })
    child.once('exit', (code, signal) => {
      reject(new Error(`Draft test child ${phase} exited before reporting (${code ?? signal}): ${output}`))
    })
  })
  return { child, result, exited }
}

afterEach(async () => {
  await Promise.all([...processes].map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { processes.delete(child); resolve(); return }
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Draft tests across independent Node processes', () => {
  it('recovers the accepted Wait/parallel snapshot and resource owners after SIGKILL, despite later Draft edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-draft-process-'))
    directories.push(directory)
    const configPath = join(directory, 'numen.config.yml')
    const recordPath = join(directory, 'accepted.json')
    await writeConfig(configPath, {
      version: 2,
      dataDir: 'data',
      logger: { console: false },
      plugins: {
        database: { path: 'data/numen.db' }, capabilities: {}, controls: {}, credentials: {},
        resources: { path: 'data/resources', gcGraceMs: 0 }, connections: {}, demo: {},
        automations: {}, scheduler: { autoDispatch: false },
      },
    })
    const first = startChild('accept', configPath, recordPath)
    const accepted = await first.result
    expect(accepted).toMatchObject({ status: 'RUNNING', draftVersion: 1, snapshots: 1, runs: 1 })
    expect(accepted.owners).toEqual(expect.arrayContaining([
      { type: 'snapshot', id: accepted.snapshotId }, { type: 'run', id: accepted.runId },
    ]))
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ runId: accepted.runId, snapshotId: accepted.snapshotId })
    first.child.kill('SIGKILL')
    expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' })

    const second = startChild('recover', configPath, recordPath)
    const recovered = await second.result
    expect(recovered.pid).not.toBe(accepted.pid)
    expect(recovered).toMatchObject({
      runId: accepted.runId, snapshotId: accepted.snapshotId, resourceId: accepted.resourceId,
      status: 'COMPLETED', draftVersion: 2, snapshots: 1, runs: 1,
    })
    expect(recovered.owners).toEqual(accepted.owners)
    expect(await second.exited).toEqual({ code: 0, signal: null })
  }, 20_000)
})
