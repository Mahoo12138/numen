import type { Context } from 'cordis'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchShell } from './WorkbenchShell.js'

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Workbench root element was not found')
const rootElement = root

async function startContext(): Promise<{ context: Context; stop(): Promise<void> }> {
  if (import.meta.env.DEV) {
    const [{ Context }, { BrowserExtensionRegistry }, { BrowserRouterService }] = await Promise.all([
      import('cordis'),
      import('@numen/webui/extensions'),
      import('@numen/webui/router'),
    ])
    const context = new Context()
    await context.plugin(BrowserExtensionRegistry)
    await context.plugin(BrowserRouterService)
    return { context, stop: () => context.fiber.dispose() }
  }
  return import('@numen/webui/runtime').then(({ startBrowserRuntime }) => startBrowserRuntime())
}

async function main(): Promise<void> {
  const runtime = await startContext()
  const { context } = runtime
  if (import.meta.env.DEV) {
    const { coreWorkbenchPages } = await import('./pages.js')
    await context.plugin(coreWorkbenchPages)
  }
  globalThis.addEventListener('beforeunload', () => void runtime.stop(), { once: true })
  createRoot(rootElement).render(
    <StrictMode>
      <WorkbenchShell router={context.webuiRouter} />
    </StrictMode>,
  )
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
