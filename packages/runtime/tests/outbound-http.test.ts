import { writeConfig } from '@numen/config'
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startRuntime, type NumenApplication } from '../src/index.js'

const applications: NumenApplication[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
const temporaryDirectories: string[] = []
const proxyEnvironmentName = 'NUMEN_TEST_RUNTIME_HTTP_PROXY'
const previousProxyEnvironment = process.env[proxyEnvironmentName]

function track(server: Server): Server {
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  servers.push(server)
  return server
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP server address')
  return address.port
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  if (previousProxyEnvironment === undefined) {
    delete process.env[proxyEnvironmentName]
  } else {
    process.env[proxyEnvironmentName] = previousProxyEnvironment
  }
})

describe('outbound HTTP substrate', () => {
  it('shares defaults, scoped clients, status errors, timeout, and the configured HTTP proxy', async () => {
    const target = track(createServer((request, response) => {
      if (request.url === '/slow') return
      if (request.url === '/unavailable') {
        response.writeHead(503, { 'content-type': 'text/plain', connection: 'close' })
        response.end('try later')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({
        header: request.headers['x-numen-client'],
        path: request.url,
      }))
    }))
    const targetPort = await listen(target)

    let proxyConnections = 0
    const proxy = track(createServer())
    proxy.on('connect', (request, clientSocket, head) => {
      proxyConnections += 1
      const destination = new URL(`http://${request.url}`)
      const serverSocket = connect(Number(destination.port), destination.hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) serverSocket.write(head)
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
      })
      sockets.add(serverSocket)
      serverSocket.once('close', () => sockets.delete(serverSocket))
      serverSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => serverSocket.destroy())
    })
    const proxyPort = await listen(proxy)

    const directory = await mkdtemp(join(tmpdir(), 'numen-outbound-http-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'numen.config.yml')
    process.env[proxyEnvironmentName] = `http://127.0.0.1:${proxyPort}`
    await writeConfig(configPath, {
      version: 1,
      dataDir: 'data',
      plugins: {
        http: {
          timeout: 1_000,
          proxyAgentEnv: proxyEnvironmentName,
        },
      },
    })

    const application = await startRuntime({ configPath })
    applications.push(application)
    const client = application.context.http.extend({
      baseUrl: `http://127.0.0.1:${targetPort}`,
      headers: { 'x-numen-client': 'integration-test' },
    })

    await expect(client.get('/echo', {
      params: { q: 'numen' },
      responseType: 'json',
    })).resolves.toEqual({
      header: 'integration-test',
      path: '/echo?q=numen',
    })
    expect(proxyConnections).toBe(1)

    await expect(client.get('/unavailable', { responseType: 'text' })).rejects.toMatchObject({
      code: 'STATUS_ERROR',
      response: { status: 503 },
    })
    await expect(client.get('/slow', { timeout: 20, responseType: 'text' })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })
})
