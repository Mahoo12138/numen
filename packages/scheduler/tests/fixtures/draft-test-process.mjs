import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
// Deliberately use compiled modules in a fresh Node process, without Vitest's aliases or clock.
import { startRuntime } from '../../../runtime/dist/index.js'

const [phase, configPath, recordPath] = process.argv.slice(2)
let app

function count(root, table, where = '') {
  return root.database.db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get().total
}

async function readResource(root, resourceId) {
  const chunks = []
  for await (const chunk of root.resources.open(resourceId)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

async function result(root, record) {
  return {
    pid: process.pid,
    runId: record.runId,
    snapshotId: record.snapshotId,
    resourceId: record.resourceId,
    draftVersion: root.automations.getDraft(record.automationId).version,
    status: root.scheduler.getRun(record.runId).status,
    snapshots: count(root, 'automation_revisions', "WHERE purpose = 'draft-test'"),
    runs: count(root, 'runs'),
    owners: root.resources.listOwners(record.resourceId).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id)),
  }
}

async function run() {
  app = await startRuntime({ configPath })
  const root = app.context
  if (phase === 'accept') {
    process.on('message', () => {})
    const resource = await root.resources.stage({
      name: 'Process recovery attachment', mediaType: 'text/plain', content: Buffer.from('durable test attachment'), stagingTtlMs: 0,
    })
    const source = {
      inputs: { file: { type: 'object', default: resource.ref } },
      triggers: [],
      flow: { type: 'parallel', id: 'saved-parallel', branches: [
        { type: 'block', id: 'wait-branch', steps: [
          { type: 'wait', id: 'saved-wait', durationMs: { type: 'literal', value: 1800 } },
          { type: 'capability', id: 'after-wait', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'saved after wait' } } },
        ] },
        { type: 'block', id: 'immediate-branch', steps: [
          { type: 'capability', id: 'immediate-echo', capability: { id: 'demo:echo', version: 1 }, input: { message: { type: 'literal', value: 'saved parallel branch' } } },
        ] },
      ] },
    }
    const { automation } = root.automations.create({ name: 'Process interrupted Draft test', source, presentation: { attachment: resource.ref } })
    const requestId = 'process-draft-request-0001'
    const trigger = { type: 'draft-test', explicit: true }
    const run = await root.scheduler.startDraftTest(automation.id, 1, {}, trigger, requestId)
    await root.scheduler.dispatchUntilIdle()
    assert.equal(root.scheduler.getRun(run.id).status, 'RUNNING')
    assert.equal(root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'saved-wait').status, 'WAITING')
    assert.deepEqual(root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'immediate-echo').output, { message: 'saved parallel branch' })
    const record = { automationId: automation.id, runId: run.id, snapshotId: run.revisionId, resourceId: resource.id, requestId, trigger, source }
    await writeFile(recordPath, JSON.stringify(record))
    process.send({ type: 'result', result: await result(root, record) })
    // The IPC handle keeps this process alive until the parent deliberately interrupts it.
    return
  }

  assert.equal(phase, 'recover')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.equal(root.scheduler.getRun(record.runId).status, 'RUNNING')
  assert.equal(root.scheduler.listExecutions(record.runId).find(item => item.instructionId === 'saved-wait').status, 'WAITING')
  root.automations.saveDraft({ automationId: record.automationId, expectedVersion: 1, source: { triggers: [], flow: { type: 'block', id: 'changed-current-draft', steps: [] } }, presentation: {} })
  const recovered = await root.scheduler.startDraftTest(record.automationId, 1, {}, record.trigger, record.requestId)
  assert.equal(recovered.id, record.runId)
  assert.equal(recovered.revisionId, record.snapshotId)
  assert.equal(count(root, 'manual_run_requests'), 1)
  const snapshot = root.automations.getExecutionSnapshot(record.snapshotId)
  assert.equal(snapshot.purpose, 'draft-test')
  assert.equal(snapshot.sourceDraftVersion, 1)
  assert.deepEqual(snapshot.source, record.source)
  assert.equal(root.automations.listRevisions(record.automationId).length, 0)
  assert.equal(root.automations.get(record.automationId).enabled, false)

  assert.equal(await readResource(root, record.resourceId), 'durable test attachment')
  await root.resources.collectGarbage(new Date(Date.now() + 86_400_000))
  assert.equal(root.resources.get(record.resourceId).state, 'COMMITTED')
  assert.equal(await readResource(root, record.resourceId), 'durable test attachment')
  const deadline = Date.now() + 5000
  while (root.scheduler.getRun(record.runId).status !== 'COMPLETED' && Date.now() < deadline) {
    await root.scheduler.dispatchUntilIdle()
    await delay(25)
  }
  assert.equal(root.scheduler.getRun(record.runId).status, 'COMPLETED')
  const executions = root.scheduler.listExecutions(record.runId)
  assert.deepEqual(executions.find(item => item.instructionId === 'after-wait').output, { message: 'saved after wait' })
  assert.deepEqual(executions.find(item => item.instructionId === 'immediate-echo').output, { message: 'saved parallel branch' })
  assert.equal(executions.filter(item => item.instructionId === 'immediate-echo').length, 1)
  assert.equal(executions.filter(item => item.instructionId === 'after-wait').length, 1)
  await root.resources.collectGarbage(new Date(Date.now() + 86_400_000))
  assert.equal(await readResource(root, record.resourceId), 'durable test attachment')
  process.send({ type: 'result', result: await result(root, record) })
  await app.stop()
  process.disconnect()
}

run().catch(async error => {
  process.send?.({ type: 'error', error: error.stack ?? String(error) })
  await app?.stop().catch(() => {})
  process.exit(1)
})
