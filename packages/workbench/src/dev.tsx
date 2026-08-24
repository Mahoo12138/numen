import type { Context } from 'cordis'
import { createApp } from 'vue'
import { WorkbenchShell } from './WorkbenchShell.js'

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Workbench root element was not found')
const rootElement = root

async function startContext(): Promise<{ context: Context; stop(): Promise<void> }> {
  if (import.meta.env.DEV) {
    const [{ Context }, { BrowserExtensionRegistry }, { BrowserRouterService }, { SchemaUIRegistry }] = await Promise.all([
      import('cordis'),
      import('@numen/webui/extensions'),
      import('@numen/webui/router'),
      import('@numen/webui/schema-ui'),
    ])
    const context = new Context()
    await context.plugin(BrowserExtensionRegistry)
    await context.plugin(SchemaUIRegistry)
    await context.plugin(BrowserRouterService, { basePath: import.meta.env.BASE_URL })
    return { context, stop: () => context.fiber.dispose() }
  }
  return import('@numen/webui/runtime').then(({ startBrowserRuntime }) => startBrowserRuntime())
}

async function main(): Promise<void> {
  const runtime = await startContext()
  const { context } = runtime
  if (import.meta.env.DEV) {
    const { coreWorkbenchFrontend } = await import('./entry.js')
    await context.plugin(coreWorkbenchFrontend)
  }
  globalThis.addEventListener('beforeunload', () => void runtime.stop(), { once: true })
  const app = createApp(() => (
    <WorkbenchShell
      router={context.webuiRouter}
      schemaUI={context.schemaUI}
      {...(import.meta.env.DEV ? {} : { consoleClient: context.consoleClient })}
    />
  ))
  app.mount(rootElement)
  globalThis.addEventListener('beforeunload', () => app.unmount(), { once: true })
}

void main().catch((error) => {
  console.error('Workbench startup failed', error)
  const container = document.createElement('main')
  container.className = 'bootstrap-error'
  const heading = document.createElement('h1')
  heading.textContent = 'Unable to start Numen Workbench'
  const message = document.createElement('p')
  message.textContent = 'Open Workbench from the trusted Numen launcher, then try again.'
  container.append(heading, message)
  rootElement.replaceChildren(container)
})
