import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsoleEntryRegistry,
  ConsoleService,
  SingleUserConsoleAuthService,
  consoleAssetPlugin,
  type ConsoleEntryManifest,
} from '../src/index.js'

const roots: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(): Promise<{
  root: Context
  baseUrl: string
  pluginDirectory: string
  outsideFile: string
  disposeAssets(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'numen-console-assets-'))
  directories.push(directory)
  const pluginDirectory = join(directory, 'plugin')
  const dist = join(pluginDirectory, 'dist')
  const outsideFile = join(pluginDirectory, 'outside.mjs')
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'main.mjs'), "import './chunk.mjs'; export const value = 1\n")
  await writeFile(join(dist, 'chunk.mjs'), 'export const chunk = true\n')
  await writeFile(outsideFile, 'export const secret = true\n')
  await symlink(outsideFile, join(dist, 'link.mjs'))

  const root = new Context()
  roots.push(root)
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  await root.plugin(ConsoleService)
  await root.plugin(ConsoleEntryRegistry)
  await root.plugin(SingleUserConsoleAuthService, { token: 'asset-token' })
  const owner = root.extend({ baseUrl: pathToFileURL(pluginDirectory + sep).href })
  root.consoleEntries.addEntry(owner, {
    id: '@example/foo:webui',
    prod: './dist/main.mjs',
  })
  const assets = await root.plugin(consoleAssetPlugin, { mode: 'prod' })
  return {
    root,
    baseUrl: root.server.baseUrl,
    pluginDirectory,
    outsideFile,
    disposeAssets: () => assets.dispose(),
  }
}

function authorized(): HeadersInit {
  return { authorization: 'Bearer asset-token' }
}

describe('Console Entry asset delivery', () => {
  it('serves an authenticated path-free manifest and immutable same-root assets', async () => {
    const fixture = await setup()
    const unauthorized = await fetch(`${fixture.baseUrl}/api/console/entries`)
    expect(unauthorized.status).toBe(401)

    const manifestResponse = await fetch(`${fixture.baseUrl}/api/console/entries`, {
      headers: authorized(),
    })
    expect(manifestResponse.status).toBe(200)
    const etag = manifestResponse.headers.get('etag')!
    const manifestText = await manifestResponse.text()
    expect(manifestText).not.toContain(fixture.pluginDirectory)
    const manifest = JSON.parse(manifestText) as ConsoleEntryManifest
    expect(manifest.unavailable).toEqual([])
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        id: '@example/foo:webui',
        url: expect.stringMatching(/^\/api\/console\/assets\//),
      }),
    ])

    const notModified = await fetch(`${fixture.baseUrl}/api/console/entries`, {
      headers: { ...authorized(), 'if-none-match': etag },
    })
    expect(notModified.status).toBe(304)
    const mainUrl = new URL(manifest.entries[0]!.url, fixture.baseUrl)
    expect((await fetch(mainUrl)).status).toBe(401)
    const main = await fetch(mainUrl, { headers: authorized() })
    expect(main.status).toBe(200)
    expect(main.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(main.headers.get('cache-control')).toContain('immutable')
    expect(main.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await main.text()).toContain("import './chunk.mjs'")

    const chunk = await fetch(new URL('./chunk.mjs', mainUrl), { headers: authorized() })
    expect(chunk.status).toBe(200)
    expect(await chunk.text()).toContain('chunk = true')
  })

  it('rejects lexical traversal and symlink escapes, and fences stale revisions', async () => {
    const fixture = await setup()
    const manifest = await fetch(`${fixture.baseUrl}/api/console/entries`, {
      headers: authorized(),
    }).then(response => response.json()) as ConsoleEntryManifest
    const mainUrl = new URL(manifest.entries[0]!.url, fixture.baseUrl)
    const rootPrefix = mainUrl.href.slice(0, -'main.mjs'.length)

    const traversal = await fetch(`${rootPrefix}..%2Foutside.mjs`, { headers: authorized() })
    expect(traversal.status).toBe(404)
    const symlinkEscape = await fetch(new URL('./link.mjs', mainUrl), { headers: authorized() })
    expect(symlinkEscape.status).toBe(404)

    const owner = fixture.root.extend({ baseUrl: pathToFileURL(fixture.pluginDirectory + sep).href })
    fixture.root.consoleEntries.addEntry(owner, {
      id: '@example/foo:second',
      prod: './dist/chunk.mjs',
    })
    const stale = await fetch(mainUrl, { headers: authorized() })
    expect(stale.status).toBe(410)
    expect(await stale.json()).toMatchObject({ error: { code: 'ENTRY_GENERATION_STALE' } })
  })

  it('reports unresolvable sources without exposing them and removes routes with the plugin Fiber', async () => {
    const fixture = await setup()
    fixture.root.consoleEntries.addEntry(fixture.root, {
      id: '@example/broken:webui',
      prod: './private/absolute-path.js',
    })
    const response = await fetch(`${fixture.baseUrl}/api/console/entries`, { headers: authorized() })
    const text = await response.text()
    expect(text).not.toContain('private/absolute-path.js')
    expect(JSON.parse(text)).toMatchObject({
      unavailable: [{ id: '@example/broken:webui', code: 'SOURCE_UNRESOLVABLE' }],
    })

    await fixture.disposeAssets()
    expect((await fetch(`${fixture.baseUrl}/api/console/entries`, { headers: authorized() })).status).toBe(404)
  })
})
