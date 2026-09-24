import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { OutboundHttpService } from '@numenjs/http'
import { ResourceService } from '@numenjs/resources'
import { SchedulerService } from '@numenjs/scheduler'
import { Context } from 'cordis'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import httpIntegrationPlugin, {
  HttpRequestError,
  httpRequestCapability,
  type HttpRequestInput,
  type HttpRequestOutput,
} from '../src/index.js'

const roots: Context[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
const directories: string[] = []

function track(server: Server): Server {
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  servers.push(server)
  return server
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP server address')
  return `http://127.0.0.1:${address.port}`
}

async function createRoot(config: { maxResponseBytes?: number } = {}): Promise<Context> {
  const root = new Context()
  roots.push(root)
  await root.plugin(CapabilityRegistry)
  await root.plugin(OutboundHttpService, { proxyAgentEnv: '', timeout: 1_000 })
  httpIntegrationPlugin(root, config)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('HTTP Integration', () => {
  it('executes a bounded request through publish, manual Run, Scheduler, and persisted output', async () => {
    let receivedBody = ''
    const server = track(createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', chunk => { receivedBody += chunk })
      request.on('end', () => {
        response.writeHead(418, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': 'session=must-not-enter-run-history',
        })
        response.end(JSON.stringify({
          method: request.method,
          path: request.url,
          header: request.headers['x-numen-test'],
        }))
      })
    }))
    const baseUrl = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'numen-http-integration-'))
    directories.push(directory)
    const root = await createRoot()
    await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })

    const { automation } = root.automations.create({ name: 'HTTP request demo', source: {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'request',
        capability: httpRequestCapability,
        input: {
          method: { type: 'literal', value: 'POST' },
          url: { type: 'literal', value: `${baseUrl}/inspect` },
          headers: { type: 'literal', value: { 'x-numen-test': 'ready' } },
          query: { type: 'literal', value: { source: 'automation' } },
          body: { type: 'literal', value: { type: 'json', value: { alive: true } } },
        },
      },
    } })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()

    expect(receivedBody).toBe('{"alive":true}')
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'request')?.output).toEqual({
      ok: false,
      status: 418,
      statusText: "I'm a Teapot",
      headers: expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': '[redacted]',
      }),
      bodyType: 'json',
      body: {
        method: 'POST',
        path: '/inspect?source=automation',
        header: 'ready',
      },
    })
  })

  it('rejects non-HTTP targets before transport access', async () => {
    const root = await createRoot()
    const provider = root.capabilities.resolveProvider<HttpRequestInput, HttpRequestOutput>(httpRequestCapability)!
    await expect(provider.invoke({
      input: { method: 'GET', url: 'file:///etc/passwd' },
      connections: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject<HttpRequestError>({ code: 'HTTP_SCHEME_UNSUPPORTED' })
  })

  it('cancels oversized responses without persisting a partial body', async () => {
    const server = track(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('response exceeds the configured limit')
    }))
    const baseUrl = await listen(server)
    const root = await createRoot({ maxResponseBytes: 8 })
    const provider = root.capabilities.resolveProvider<HttpRequestInput, HttpRequestOutput>(httpRequestCapability)!
    await expect(provider.invoke({
      input: { method: 'GET', url: baseUrl },
      connections: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject<HttpRequestError>({ code: 'HTTP_RESPONSE_TOO_LARGE' })
  })
})
