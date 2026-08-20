import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workbenchServerPlugin } from '../src/server.js'

const roots: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(): Promise<{ root: Context; baseUrl: string; buildRoot: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'numen-workbench-server-'))
  directories.push(directory)
  const buildRoot = join(directory, 'app')
  await mkdir(join(buildRoot, 'assets'), { recursive: true })
  await writeFile(join(buildRoot, 'index.html'), [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/workbench/assets/app-12345678.css">',
    '</head><body><div id="root"></div>',
    '<script type="module" src="/workbench/assets/app-12345678.js"></script>',
    '</body></html>',
  ].join(''))
  await writeFile(join(buildRoot, 'assets/app-12345678.js'), 'export const bootstrap = true\n')
  await writeFile(join(buildRoot, 'assets/app-12345678.css'), ':root { color: black }\n')
  await writeFile(join(directory, 'outside.js'), 'export const privateValue = true\n')
  await symlink(join(directory, 'outside.js'), join(buildRoot, 'assets/link.js'))
  const root = new Context()
  roots.push(root)
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  const plugin = await root.plugin(workbenchServerPlugin, { root: buildRoot })
  return {
    root,
    baseUrl: root.server.baseUrl,
    buildRoot,
    dispose: () => plugin.dispose(),
  }
}

describe('Workbench bootstrap delivery', () => {
  it('serves a secret-free no-store SPA document on core routes', async () => {
    const fixture = await setup()
    for (const path of ['/', '/automations', '/runs/run-1', '/plugins/installed', '/system/overview']) {
      const response = await fetch(`${fixture.baseUrl}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self' ws: wss:")
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('permissions-policy')).toContain('camera=()')
      const document = await response.text()
      expect(document).toContain('/workbench/assets/app-12345678.js')
      expect(document).not.toContain('numen-bootstrap')
      expect(document).not.toContain('token')
      expect(document).not.toContain(fixture.buildRoot)
    }
    expect((await fetch(`${fixture.baseUrl}/api/health`)).status).toBe(404)
  })

  it('serves hashed assets immutably with MIME and same-origin fencing', async () => {
    const fixture = await setup()
    const script = await fetch(`${fixture.baseUrl}/workbench/assets/app-12345678.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(script.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(script.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await script.text()).toContain('bootstrap = true')

    const css = await fetch(`${fixture.baseUrl}/workbench/assets/app-12345678.css`)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('rejects traversal and symlink escapes and removes routes with its Fiber', async () => {
    const fixture = await setup()
    const traversal = await fetch(`${fixture.baseUrl}/workbench/..%2Foutside.js`)
    expect(traversal.status).toBe(404)
    const symlinkEscape = await fetch(`${fixture.baseUrl}/workbench/assets/link.js`)
    expect(symlinkEscape.status).toBe(404)

    await fixture.dispose()
    expect((await fetch(`${fixture.baseUrl}/`)).status).toBe(404)
    expect((await fetch(`${fixture.baseUrl}/workbench/assets/app-12345678.js`)).status).toBe(404)
  })

  it('returns a non-leaking service response when the build is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-workbench-missing-'))
    directories.push(directory)
    const root = new Context()
    roots.push(root)
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    await root.plugin(workbenchServerPlugin, { root: join(directory, 'missing') })

    const response = await fetch(`${root.server.baseUrl}/`)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('Workbench build is unavailable')
  })
})
