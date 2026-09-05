import Server from '@cordisjs/plugin-server'
import {
  ConsoleEntryRegistry,
  ConsoleService,
  SingleUserConsoleAuthService,
} from '@numen/console'
import { Context } from 'cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  coreWorkbenchEntryId,
  workbenchRuntimePlugin,
} from '../src/runtime.js'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationInsertCatalogQueryRef,
  workbenchAutomationVariableCatalogQueryRef,
  workbenchAutomationsIndexQueryRef,
  workbenchPublishAutomationDraftActionRef,
  workbenchSaveAutomationDraftActionRef,
  workbenchConnectionsIndexQueryRef,
  workbenchCredentialsIndexQueryRef,
  workbenchCreateCredentialActionRef,
  workbenchRotateCredentialActionRef,
  workbenchDeleteCredentialActionRef,
  workbenchSetConnectionEnabledActionRef,
  workbenchHomeOverviewQueryRef,
  workbenchInvalidationSubscriptionRef,
  workbenchRunDetailQueryRef,
  workbenchCancelRunActionRef,
  workbenchRunsIndexQueryRef,
} from '../src/contracts.js'

const roots: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Workbench Runtime plugin', () => {
  it('owns the browser document and core frontend Entry in one Fiber', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-workbench-runtime-'))
    directories.push(directory)
    const buildRoot = join(directory, 'app')
    const entrySource = join(buildRoot, 'core-entry.js')
    await mkdir(buildRoot)
    await writeFile(join(buildRoot, 'index.html'), '<main id="root">Numen</main>')
    await writeFile(entrySource, 'export default function core() {}\n')

    const root = new Context()
    roots.push(root)
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    await root.plugin(ConsoleEntryRegistry)
    await root.plugin(ConsoleService)
    await root.plugin(SingleUserConsoleAuthService, { token: 'workbench-launch-token' })
    const fiber = await root.plugin(workbenchRuntimePlugin, { root: buildRoot, entrySource })

    expect(root.consoleEntries.list()).toEqual([{
      id: coreWorkbenchEntryId,
      prod: entrySource,
    }])
    expect(root.console.get(workbenchAutomationDetailQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchAutomationInsertCatalogQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchAutomationVariableCatalogQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchAutomationsIndexQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchPublishAutomationDraftActionRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchSaveAutomationDraftActionRef)).toMatchObject({ providerAvailable: false })
    for (const ref of [workbenchCredentialsIndexQueryRef, workbenchCreateCredentialActionRef, workbenchRotateCredentialActionRef, workbenchDeleteCredentialActionRef]) {
      expect(root.console.get(ref)).toMatchObject({ providerAvailable: false })
    }
    expect(root.console.get(workbenchConnectionsIndexQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchSetConnectionEnabledActionRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchHomeOverviewQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchInvalidationSubscriptionRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchRunDetailQueryRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchCancelRunActionRef)).toMatchObject({ providerAvailable: false })
    expect(root.console.get(workbenchRunsIndexQueryRef)).toMatchObject({ providerAvailable: false })
    const document = await fetch(`${root.server.baseUrl}/`)
    expect(document.status).toBe(200)
    expect(await document.text()).toContain('Numen')
    const launchUrl = new URL(root.workbench.getLaunchUrl('/runs?unsafe=query'))
    expect(launchUrl.pathname).toBe('/runs')
    expect(launchUrl.search).toBe('')
    expect(new URLSearchParams(launchUrl.hash.slice(1)).get('numen-bootstrap')).toBe('workbench-launch-token')
    expect(() => root.workbench.getLaunchUrl('https://untrusted.example/')).toThrow('same-origin')

    await fiber.dispose()
    expect(root.consoleEntries.list()).toEqual([])
    expect(root.console.get(workbenchAutomationDetailQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchAutomationInsertCatalogQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchAutomationVariableCatalogQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchAutomationsIndexQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchPublishAutomationDraftActionRef)).toBeUndefined()
    expect(root.console.get(workbenchSaveAutomationDraftActionRef)).toBeUndefined()
    for (const ref of [workbenchCredentialsIndexQueryRef, workbenchCreateCredentialActionRef, workbenchRotateCredentialActionRef, workbenchDeleteCredentialActionRef]) {
      expect(root.console.get(ref)).toBeUndefined()
    }
    expect(root.console.get(workbenchConnectionsIndexQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchSetConnectionEnabledActionRef)).toBeUndefined()
    expect(root.console.get(workbenchHomeOverviewQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchInvalidationSubscriptionRef)).toBeUndefined()
    expect(root.console.get(workbenchRunDetailQueryRef)).toBeUndefined()
    expect(root.console.get(workbenchCancelRunActionRef)).toBeUndefined()
    expect(root.console.get(workbenchRunsIndexQueryRef)).toBeUndefined()
    expect((await fetch(`${root.server.baseUrl}/`)).status).toBe(404)
  })
})
