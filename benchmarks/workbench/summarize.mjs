#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Only complete, comparable runs become a baseline. Never copy arbitrary report
// objects: navigation URLs, bootstrap fragments, configuration and errors stay out.
const caseIds = ['automation-100', 'automation-300', 'automation-1000', 'plugins-100', 'plugins-300']
const requiredSettings = { samples: 20, coldTrials: 3, lifecycleRounds: 10 }
const snapshotFields = ['heapUsedBytes', 'backingStorageBytes', 'documents', 'nodes', 'jsEventListeners', 'documentElements',
  'liveSocketTransports', 'openSockets', 'activeSubscriptions', 'pendingSubscriptions', 'closingSubscriptions']
const fail = message => { throw new Error(message) }
const check = (condition, message) => { if (!condition) fail(message) }
const record = (value, path) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: expected an object`)
  return value
}
const array = (value, length, path) => {
  check(Array.isArray(value) && (length === undefined || value.length === length), `${path}: invalid sample count`)
  return value
}
const number = (value, path, integer = false) => {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)), `${path}: invalid nonnegative number`)
  return value
}
const text = (value, path, pattern = /^[\p{L}\p{N} ._():+@/-]{1,200}$/u) => {
  check(typeof value === 'string' && pattern.test(value) && !/:\/\/|numen-bootstrap|[\r\n]/i.test(value), `${path}: invalid metadata text`)
  return value
}
const id = (value, path) => text(value, path, /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/)
const procedure = (value, path) => text(value, path, /^[A-Za-z0-9][A-Za-z0-9_:-]*@[1-9][0-9]*$/)
const equal = (left, right, path) => check(JSON.stringify(left) === JSON.stringify(right), `${path}: inconsistent observations`)
const close = (left, right, path) => check(Math.abs(left - right) < 0.001, `${path}: inconsistent raw samples`)
const numericFields = (value, fields, path) => {
  record(value, path)
  return Object.fromEntries(fields.map(key => [key, number(value[key], `${path}.${key}`, true)]))
}

function distribution(raw, count, path, p95 = true) {
  record(raw, path)
  const samplesMs = array(raw.samplesMs, count, path).map(value => number(value, path))
  check(raw.count === count, `${path}: count differs from raw samples`)
  const sorted = [...samplesMs].sort((a, b) => a - b)
  return { count, samplesMs, p50Ms: sorted[Math.ceil(count * .5) - 1],
    ...(p95 ? { p95Ms: sorted[Math.ceil(count * .95) - 1] } : {}), maxMs: sorted.at(-1) }
}

function environment(report) {
  const env = record(report.environment, 'environment')
  const viewport = numericFields(env.viewport, ['width', 'height'], 'environment.viewport')
  check(viewport.width > 0 && viewport.height > 0, 'environment.viewport: empty viewport')
  return {
    workbenchAssetSha256: text(env.workbenchAssetSha256, 'environment.workbenchAssetSha256', /^[a-f0-9]{64}$/),
    sourceHead: text(env.sourceHead, 'environment.sourceHead', /^[a-f0-9]{40,64}$/),
    cpu: text(env.cpu, 'environment.cpu'), os: text(env.os, 'environment.os'), arch: text(env.arch, 'environment.arch'),
    release: text(env.release, 'environment.release'), node: text(env.node, 'environment.node', /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
    chromiumVersion: text(report.chromiumVersion, 'chromiumVersion', /^\d+(?:\.\d+){1,3}$/),
    logicalCpus: number(env.logicalCpus, 'environment.logicalCpus', true), memoryBytes: number(env.memoryBytes, 'environment.memoryBytes', true), viewport,
  }
}

function fixtureMetadata(report, kind, size) {
  const fixture = record(report.fixture, 'fixture'), targets = record(fixture.targets, 'fixture.targets')
  if (kind === 'automation') {
    check(fixture.nodeCount === size && fixture.maxDepth === 6 && fixture.depthConvention === 'root=0', 'fixture: invalid automation size/depth')
    const countsByType = numericFields(fixture.countsByType, ['block', 'capability', 'if', 'foreach', 'parallel', 'race', 'wait', 'extension'], 'fixture.countsByType')
    check(Object.values(countsByType).reduce((sum, count) => sum + count, 0) === size, 'fixture: control counts do not add up')
    return { nodeCount: size, maxDepth: 6, depthConvention: 'root=0', triggerCount: number(fixture.triggerCount, 'fixture.triggerCount', true), countsByType,
      targets: Object.fromEntries(['rootId', 'containerId', 'deepNodeId', 'editNodeId', 'selectionNodeId', 'searchNodeId', 'referenceNodeId', 'loopNodeId'].map(key => [key, id(targets[key], `fixture.targets.${key}`)])) }
  }
  const counts = numericFields(fixture, ['entryCount', 'instanceCount', 'groupCount', 'maxGroupDepth', 'fixtureInstanceCount'], 'fixture')
  check(counts.entryCount === size && counts.instanceCount + counts.groupCount === size && counts.maxGroupDepth === 6
    && counts.fixtureInstanceCount <= counts.instanceCount, 'fixture: invalid plugin counts/depth')
  return { ...counts, targets: {
    ...Object.fromEntries(['entryId', 'instanceKey', 'groupId', 'deepEntryId'].map(key => [key, id(targets[key], `fixture.targets.${key}`)])),
    groupPathIds: array(targets.groupPathIds, 6, 'fixture.targets.groupPathIds').map(value => id(value, 'fixture.targets.groupPathIds')),
  } }
}

function procedureCounts(value, path) {
  return Object.fromEntries(Object.entries(record(value, path)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => [procedure(key, path), number(count, path, true)]))
}

function snapshot(value, path, host = false) {
  const result = numericFields(value, snapshotFields, path)
  check(value.socketCountKind === 'live-transport', `${path}: unsupported socket count kind`)
  result.socketCountKind = 'live-transport'
  result.subscriptions = array(value.subscriptions, result.activeSubscriptions, `${path}.subscriptions`).map(item => procedure(item, `${path}.subscriptions`)).sort()
  if (host) {
    const observed = record(value.host, `${path}.host`)
    check(observed.consoleSubscriptions?.supported === true && observed.consoleSockets?.supported === true, `${path}: host observations are unsupported`)
    const byProcedure = procedureCounts(observed.consoleSubscriptions.byProcedure, `${path}.host.byProcedure`)
    const active = number(observed.consoleSubscriptions.activeSubscriptions, `${path}.host.activeSubscriptions`, true)
    check(active === Object.values(byProcedure).reduce((sum, count) => sum + count, 0), `${path}: host subscription counts do not add up`)
    result.host = { consoleSubscriptions: { supported: true, activeSubscriptions: active, byProcedure },
      consoleSockets: { supported: true, ...numericFields(observed.consoleSockets, ['liveSocketTransports', 'openSockets'], `${path}.host.consoleSockets`) } }
  }
  return result
}

function lifecycle(value) {
  const samples = array(value, 11, 'lifecycle').map((item, round) => ({ round, ...snapshot(item, `lifecycle[${round}]`, true) }))
  const first = samples[0], last = samples.at(-1)
  for (const sample of samples) {
    check(sample.pendingSubscriptions === 0 && sample.closingSubscriptions === 0, 'lifecycle: unfinished subscriptions')
    equal(sample.subscriptions, first.subscriptions, 'lifecycle.subscriptions')
    equal(sample.host, first.host, 'lifecycle.host')
    check(sample.liveSocketTransports === first.liveSocketTransports && sample.openSockets === first.openSockets, 'lifecycle: transport count changed')
  }
  return { samples, firstToLastDelta: {
    ...Object.fromEntries(snapshotFields.map(key => [key, last[key] - first[key]])),
    heapUsedPercent: first.heapUsedBytes ? (last.heapUsedBytes - first.heapUsedBytes) / first.heapUsedBytes * 100 : null,
    hostActiveSubscriptions: last.host.consoleSubscriptions.activeSubscriptions - first.host.consoleSubscriptions.activeSubscriptions,
    hostLiveSocketTransports: last.host.consoleSockets.liveSocketTransports - first.host.consoleSockets.liveSocketTransports,
    hostOpenSockets: last.host.consoleSockets.openSockets - first.host.consoleSockets.openSockets,
  } }
}

function intervals(value) {
  return array(value, undefined, 'measuredIntervals').map(item => {
    record(item, 'measuredIntervals.item')
    const label = text(item.label, 'measuredIntervals.label', /^[A-Za-z][A-Za-z0-9-]{0,79}$/)
    const start = number(item.start, 'measuredIntervals.start'), end = number(item.end, 'measuredIntervals.end')
    check(end >= start, 'measuredIntervals: negative duration')
    return { label, start, end }
  })
}

function longTasks(observation, measured = []) {
  check(observation.longTaskSupported === true, 'longTasks: browser observation is unsupported')
  const samples = array(observation.longTasks, undefined, 'longTasks').map(item => ({
    startTime: number(item.startTime, 'longTasks.startTime'), duration: number(item.duration, 'longTasks.duration'),
  }))
  const byLabel = {}
  const overlapping = new Set()
  for (const label of [...new Set(measured.map(item => item.label))]) {
    const windows = measured.filter(item => item.label === label), taskIndexes = new Set()
    for (let index = 0; index < samples.length; index++) {
      const task = samples[index]
      if (windows.some(window => task.startTime < window.end && task.startTime + task.duration > window.start)) {
        taskIndexes.add(index); overlapping.add(index)
      }
    }
    byLabel[label] = { intervalCount: windows.length, overlappingTaskCount: taskIndexes.size,
      overlappingTaskDurationMs: [...taskIndexes].reduce((sum, index) => sum + samples[index].duration, 0) }
  }
  return { count: samples.length, totalDurationMs: samples.reduce((sum, task) => sum + task.duration, 0),
    maxDurationMs: samples.reduce((max, task) => Math.max(max, task.duration), 0), samples,
    measuredIntervals: measured, uniqueOverlappingTaskCount: overlapping.size, overlapByLabel: byLabel }
}

function latency(report, kind, measured) {
  const values = record(report.latency, 'latency')
  const required = kind === 'automation' ? ['nodeSelection', 'fieldCommitRender', 'hiddenNodeLocate']
    : ['instanceSelection', 'groupSelection', 'localFieldCommit', 'applyToRendered']
  for (const label of required) check(Object.hasOwn(values, label), `latency.${label}: missing required series`)
  const result = {}
  for (const [label, raw] of Object.entries(values)) {
    text(label, 'latency.label', /^[A-Za-z][A-Za-z0-9-]{0,79}$/)
    const warmup = /warmup/i.test(label), data = distribution(raw, warmup ? 1 : 20, `latency.${label}`)
    const windows = measured.filter(item => item.label === label)
    check(windows.length === data.count, `latency.${label}: missing or duplicate measurement intervals`)
    windows.forEach((window, index) => close(window.end - window.start, data.samplesMs[index], `latency.${label}`))
    if (!warmup) result[label] = data
  }
  for (const item of measured) check(Object.hasOwn(values, item.label), 'measuredIntervals: unknown latency series')
  return result
}

function persistence(report, kind) {
  const requestCounts = procedureCounts(report.requestCounts, 'requestCounts')
  if (kind === 'automation') {
    const saves = numericFields(report.saves, ['selectionSaves', 'fieldSaves', 'expectedFieldSaves', 'locationSaves', 'expectedLocationSaves'], 'saves')
    check(saves.selectionSaves === 0 && saves.fieldSaves === 21 && saves.expectedFieldSaves === 21
      && saves.locationSaves === 42 && saves.expectedLocationSaves === 42, 'saves: incomplete or unexpected measured writes')
    check((requestCounts['numen:automation-save-draft@1'] ?? 0) >= 63, 'saves: total requests cannot explain measured writes')
    return { saves, requestCounts, counting: 'Measured-phase save requests include one warm-up per phase; whole-page requestCounts also include correctness guards. Filesystem syscall counts are not measured.' }
  }
  const counts = numericFields(report.persistence, ['previews', 'applies', 'successfulApplyResponses', 'yamlVerifiedWrites', 'warmupWrites', 'measuredWrites'], 'persistence')
  check(counts.previews === 21 && counts.applies === 21 && counts.successfulApplyResponses === 21 && counts.yamlVerifiedWrites === 21
    && counts.warmupWrites === 1 && counts.measuredWrites === 20, 'persistence: incomplete or unexpected writes')
  check(requestCounts['numen:plugin-preview@1'] === 21 && requestCounts['numen:plugin-apply@1'] === 21, 'persistence: network counts differ from verified writes')
  const applyEvidence = array(report.persistence.applyEvidence, 21, 'persistence.applyEvidence').map((item, index) => {
    check(item.sample === index - 1 && item.runtimeApplied === true && item.yamlChanged === true, 'persistence: missing successful YAML evidence')
    return { sample: item.sample, runtimeApplied: true, yamlChanged: true }
  })
  return { persistence: { ...counts, applyEvidence }, requestCounts,
    counting: 'Apply requests, saved responses and changed YAML snapshots are separate observations; counts include one warm-up write. Filesystem syscall counts are not measured.' }
}

function summarizeCase(report) {
  const [kind, sizeText] = report.id.split('-'), size = Number(sizeText)
  const measured = intervals(report.measuredIntervals)
  const firstInteractive = distribution(report.firstInteractive, 3, 'firstInteractive', false)
  const cold = kind === 'automation' ? array(report.coldSnapshots, 3, 'coldSnapshots').map((item, trial) => {
    check(item.trial === trial, 'coldSnapshots: unexpected trial order')
    return { trial, elapsedMs: firstInteractive.samplesMs[trial], snapshot: snapshot(item, `coldSnapshots[${trial}]`), longTasks: longTasks(item.observation) }
  }) : array(report.coldTrials, 3, 'coldTrials').map((item, trial) => {
    close(number(item.elapsedMs, 'coldTrials.elapsedMs'), firstInteractive.samplesMs[trial], 'coldTrials.elapsedMs')
    return { trial, elapsedMs: item.elapsedMs, snapshot: snapshot(item.snapshot, `coldTrials[${trial}]`), longTasks: longTasks(item.summary) }
  })
  const mainLongTasks = longTasks(report, measured)
  const result = {
    id: report.id, outcome: 'passed', kind, pressureProbe: kind === 'automation' && size === 1000,
    measuredAt: text(report.measuredAt, 'measuredAt', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    sourceWasDirty: array(report.environment.dirtyPaths, undefined, 'environment.dirtyPaths').length > 0,
    fixture: fixtureMetadata(report, kind, size),
    ...(kind === 'automation' ? { fixtureSha256: text(report.fixtureSha256, 'fixtureSha256', /^[a-f0-9]{64}$/) } : {}),
    firstInteractive, coldTrials: cold, latency: latency(report, kind, measured), initial: snapshot(report.initial, 'initial'),
    longTasks: { main: mainLongTasks }, ...persistence(report, kind), lifecycle: lifecycle(report.lifecycle),
  }
  if (kind === 'plugins') {
    result.deepLinkLocate = { ...distribution(report.deepLinkLocate, 20, 'deepLinkLocate'),
      method: 'Full document navigation in a new page sharing the main session, cache disabled; not an in-place automation lookup.' }
    result.deepLinkTrials = array(report.locateTrials, 21, 'locateTrials').map((item, index) => {
      check(item.sample === index - 1, 'locateTrials: missing or duplicate sample')
      const elapsedMs = number(item.elapsedMs, 'locateTrials.elapsedMs')
      if (index) close(elapsedMs, result.deepLinkLocate.samplesMs[index - 1], 'locateTrials.elapsedMs')
      return { sample: item.sample, warmup: index === 0, elapsedMs, longTasks: longTasks(item.summary) }
    })
  }
  const observations = [mainLongTasks, ...cold.map(item => item.longTasks), ...(result.deepLinkTrials ?? []).map(item => item.longTasks)]
  result.longTasks.allObservedPages = {
    count: observations.reduce((sum, item) => sum + item.count, 0), totalDurationMs: observations.reduce((sum, item) => sum + item.totalDurationMs, 0),
    maxDurationMs: Math.max(...observations.map(item => item.maxDurationMs)),
  }
  return result
}

async function metricsFiles(directory) {
  const found = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    // Ignore Playwright attachment copies and do not follow directory/file links.
    if (entry.isDirectory() && entry.name.toLowerCase() !== 'attachments') found.push(...await metricsFiles(join(directory, entry.name)))
    else if (entry.isFile() && entry.name === 'metrics.json') found.push(join(directory, entry.name))
  }
  return found
}

async function main() {
  check(process.argv.length === 3, 'Usage: node benchmarks/workbench/summarize.mjs OUTPUT_DIR')
  const files = await metricsFiles(resolve(process.argv[2]))
  check(files.length === 5, `Expected exactly five metrics.json reports outside attachments; found ${files.length}`)
  const reports = new Map()
  for (const file of files) {
    let report
    try { report = JSON.parse(await readFile(file, 'utf8')) } catch { fail('Cannot read a metrics.json report as JSON') }
    record(report, 'report')
    check(caseIds.includes(report.id) && !reports.has(report.id), 'Unexpected or duplicate benchmark case ID')
    check(report.schemaVersion === 1 && report.outcome === 'passed' && report.diagnosticOnly !== true
      && (report.status === undefined || report.status === 'passed'), `${report.id}: not a passed report`)
    for (const [key, expected] of Object.entries(requiredSettings)) check(report.settings?.[key] === expected, `${report.id}: non-baseline ${key}`)
    reports.set(report.id, report)
  }
  const sharedEnvironment = environment(reports.get(caseIds[0]))
  for (const report of reports.values()) equal(environment(report), sharedEnvironment, `${report.id}.environment`)
  const result = {
    schemaVersion: 1, kind: 'workbench-capacity-baseline', outcome: 'passed', diagnosticOnly: false,
    settings: requiredSettings, environment: sharedEnvironment,
    methodology: {
      percentiles: 'Nearest-rank percentiles recomputed from raw samples; cold navigation has only three trials, so only P50 and max are reported.',
      firstInteractive: 'Navigation start to document readiness and two animation frames. Subsequent usability checks are outside this interval.',
      measuredLatency: 'Twenty non-warm-up event-to-render samples per label; one separately measured warm-up is excluded from these distributions.',
      longTasks: 'Main-page totals include navigation, warm-ups, preparation, correctness checks and lifecycle work. Cold and deep-link pages have independent clocks and are summarized separately. Label overlap is temporal overlap, not causal attribution; a task can overlap several intervals/labels. Overlapping duration is the full duration of each distinct overlapping task, not clipped time.',
      lifecycle: 'Eleven post-GC snapshots: one warm neutral Home baseline followed by ten round trips back to Home. Deltas describe observed retained state; they do not prove absence of leaks.',
      pressureProbe: 'Automation 1000 is a stress probe, not an official supported-capacity promise. No performance threshold is inferred by this script.',
    },
    cases: caseIds.map(caseId => summarizeCase(reports.get(caseId))),
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch(error => {
  // OS/JSON errors may contain paths or input excerpts. Only our validation
  // messages are useful here; external error details are deliberately omitted.
  const message = error?.code ? 'Cannot read the benchmark output directory' : error instanceof Error ? error.message : 'Cannot summarize benchmark reports'
  process.stderr.write(`Benchmark summary rejected: ${message}\n`)
  process.exitCode = 1
})
