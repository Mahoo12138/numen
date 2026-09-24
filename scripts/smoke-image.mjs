import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const image = process.argv[2] ?? `numen:${version}`
if (process.argv.length > 3 || image.startsWith('-')) throw new Error('Usage: pnpm image:smoke [image]')
const name = `numen-smoke-${randomUUID()}`
const volume = `${name}-data`
const environment = { ...process.env, NUMEN_MASTER_KEY: randomBytes(32).toString('base64') }
let baseUrl
let cookie
let containerCreated = false
let volumeCreated = false

function docker(args) {
  // Never print Docker logs: the default command emits a private bootstrap URL.
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    }).trim()
  } catch {
    throw new Error(`Docker ${args[0]} failed during image verification (output withheld to protect credentials).`)
  }
}

async function until(description, check, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(5000) })
}

async function call(kind, procedure, input) {
  const response = await request('/api/console/call', {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ kind, procedure: `numen:${procedure}@1`, input }),
  })
  assert.equal(response.status, 200, `${procedure} HTTP status`)
  return (await response.json()).result
}

async function start() {
  docker(['run', '-d', '--name', name, '--env', 'NUMEN_MASTER_KEY',
    '--publish', '127.0.0.1::5140', '--volume', `${volume}:/var/lib/numen`, image])
  containerCreated = true
  const container = JSON.parse(docker(['inspect', name]))[0]
  const binding = container.NetworkSettings.Ports['5140/tcp'][0]
  assert.equal(binding.HostIp, '127.0.0.1')
  assert.equal(container.Config.User, 'node')
  baseUrl = `http://127.0.0.1:${binding.HostPort}`
  await until('Docker readiness health check', () => {
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]))
    if (!state.Running || state.Health?.Status === 'unhealthy') throw new Error('Container failed readiness.')
    return state.Health?.Status === 'healthy'
  }, 90_000)
  assert.equal((await request('/api/health')).status, 200)
  assert.equal((await request('/api/ready')).status, 200)
  const page = await request('/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  const html = await page.text()
  const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)
  assert.ok(script, 'production Workbench bootstrap script')
  const assetUrl = new URL(script[1], baseUrl)
  assert.equal(assetUrl.origin, baseUrl)
  assert.equal((await request(assetUrl.pathname)).status, 200)
  assert.equal((await request('/api/console/session')).status, 401)
  const launch = docker(['logs', name]).match(/Workbench launch URL \(keep private\): (\S+)/)
  assert.ok(launch, 'CLI bootstrap URL exists')
  const token = new URLSearchParams(new URL(launch[1]).hash.slice(1)).get('numen-bootstrap')
  assert.ok(token, 'fragment bootstrap token exists')
  assert.ok(!html.includes(token), 'HTML excludes the bootstrap secret')
  const session = await request('/api/console/session', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(session.status, 200)
  const setCookie = session.headers.get('set-cookie')
  assert.ok(setCookie?.includes('HttpOnly'), 'browser session is HttpOnly')
  cookie = setCookie.split(';')[0]
  docker(['exec', name, 'node', 'packages/cli/dist/bin.js', 'config', 'validate', '--config', '/etc/numen/numen.config.yml'])
  docker(['exec', name, 'node', 'packages/cli/dist/bin.js', 'doctor', '--config', '/etc/numen/numen.config.yml'])
}

async function completedRun(runId) {
  const detail = await until('completed Echo Run', async () => {
    const value = await call('query', 'run-detail', { runId, executionLimit: 20, eventLimit: 50 })
    assert.ok(value, 'Run is queryable')
    assert.ok(!['FAILED', 'CANCELLED'].includes(value.run.status), 'Run succeeds')
    return value.run.status === 'COMPLETED' && value
  })
  assert.ok(detail.executions.some(item => item.instructionId === 'echo' && item.status === 'COMPLETED'))
  assert.ok(detail.timeline.total > 0, 'durable Run Journal exists')
  assert.equal(detail.context.find(group => group.name === 'steps')?.value.echo.message,
    '[string · 18 chars]', 'Console projects Echo output without revealing its contents')
  const persisted = JSON.parse(docker(['exec', name, 'node', '--input-type=module', '-e', `
    import { createRequire } from 'node:module'
    const Database = createRequire('/app/packages/database/package.json')('better-sqlite3')
    const db = new Database('/var/lib/numen/numen.db', { readonly: true })
    const schema = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version
    const output = db.prepare('SELECT output_json FROM executions WHERE run_id = ? AND instruction_id = ?')
      .get(process.argv[1], 'echo').output_json
    db.close()
    console.log(JSON.stringify({ schema, output: JSON.parse(output) }))
  `, runId]))
  assert.equal(persisted.schema, 14, 'release database schema')
  assert.deepEqual(persisted.output, { message: 'Release smoke test' }, 'durable Echo output')
}

try {
  const metadata = JSON.parse(docker(['image', 'inspect', image]))[0]
  assert.equal(metadata.Config.Labels?.['org.opencontainers.image.version'], version, 'image version matches release')
  docker(['volume', 'create', volume])
  volumeCreated = true
  await start()
  console.log('PASS: non-root startup, readiness, Workbench assets, session exchange, config and doctor')
  const { automation, draft } = await call('action', 'automation-create', { name: 'Release smoke test' })
  const source = {
    triggers: [{ id: 'cron', capability: { id: 'schedule:cron', version: 1 },
      config: { cron: '* * * * *', timezone: 'UTC' } }],
    flow: { type: 'capability', id: 'echo', capability: { id: 'demo:echo', version: 1 },
      input: { message: { type: 'literal', value: 'Release smoke test' } } },
  }
  const saved = await call('action', 'automation-save-draft', {
    automationId: automation.id, expectedVersion: draft.version, source, presentation: {},
  })
  const { revision } = await call('action', 'automation-publish-draft', {
    automationId: automation.id, expectedVersion: saved.draft.version,
  })
  const activated = await call('action', 'automation-activate-revision', {
    automationId: automation.id, revisionId: revision.id, expectedActivationGeneration: automation.activationGeneration,
  })
  await call('action', 'automation-set-enabled', {
    automationId: automation.id, enabled: true,
    expectedActivationGeneration: activated.automation.activationGeneration,
  })
  const manualInput = { automationId: automation.id, requestId: randomUUID(), expectedRevisionId: revision.id, input: {} }
  const { runId } = await call('action', 'manual-run-start', manualInput)
  await completedRun(runId)
  const logHistory = await call('query', 'logs', { runId, limit: 100 })
  assert.equal(logHistory.persistence, 'ready', 'runtime logs are persisted')
  assert.ok(logHistory.records.some(record => record.attemptId && record.message === 'Attempt completed'), 'execution logs carry Run/Attempt correlation')
  assert.ok(!JSON.stringify(logHistory).includes('Release smoke test'), 'runtime logs exclude domain input/output')
  console.log('PASS: Console create/save/publish/activate/enable and real Echo execution')
  const previousCookie = cookie
  docker(['stop', '--time', '20', name])
  docker(['rm', name])
  containerCreated = false
  await start()
  assert.equal((await request('/api/console/session', { headers: { cookie: previousCookie } })).status, 401)
  const restored = await call('query', 'automation-detail', { automationId: automation.id })
  assert.equal(restored.automation.activeRevisionId, revision.id)
  assert.equal(restored.automation.enabled, true)
  assert.deepEqual(restored.draft.source, source)
  assert.equal((await call('action', 'manual-run-start', manualInput)).runId, runId)
  await completedRun(runId)
  const restoredLogs = await call('query', 'logs', { runId, limit: 100, before: { stream: logHistory.stream, sequence: 1 } })
  assert.equal(restoredLogs.reset, true, 'old log cursors reset after process recreation')
  assert.equal(restoredLogs.persistence, 'ready')
  assert.ok(logHistory.records.every(previous => restoredLogs.records.some(record => record.id === previous.id)), 'volume retains correlated log history across recreation')
  console.log('PASS: correlated runtime logs persist across container recreation and reset old cursors')
  console.log('PASS: container recreation retains Draft/Revision/Run and submission deduplication; sessions rotate')
  // A Run accepted after the recreated container started proves subscriptions were rebuilt.
  const afterRestart = Date.now()
  const scheduled = await until('next Cron Run after recreation', async () => {
    const runs = await call('query', 'runs-index', { automationId: automation.id, limit: 20 })
    return runs.items.find(item => item.id !== runId && Date.parse(item.createdAt) > afterRestart)
  }, 75_000)
  await completedRun(scheduled.id)
  console.log(`PASS: Cron subscription resumes after recreation (${metadata.Os}/${metadata.Architecture})`)
} catch (error) {
  // Assertions deliberately avoid logging actual values that might contain session credentials.
  console.error(`Image smoke failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`)
  process.exitCode = 1
} finally {
  if (containerCreated) {
    try { docker(['rm', '--force', name]) } catch { console.error(`Cleanup required: docker rm --force ${name}`); process.exitCode = 1 }
  }
  if (volumeCreated) {
    try { docker(['volume', 'rm', volume]) } catch { console.error(`Cleanup required: docker volume rm ${volume}`); process.exitCode = 1 }
  }
}
