import '@numenjs/components/style.css'
import type { Context } from 'cordis'
import { createApp } from 'vue'
import { I18nService } from '@numenjs/i18n'
import { BrowserLocaleService } from '@numenjs/webui/i18n'
import { WorkbenchShell } from './WorkbenchShell.js'

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Workbench root element was not found')
const rootElement = root

async function startContext(): Promise<{ context: Context; stop(): Promise<void> }> {
  if (import.meta.env.DEV) {
    const [{ Context }, { BrowserExtensionRegistry }, { BrowserRouterService }, { SchemaUIRegistry }] = await Promise.all([
      import('cordis'),
      import('@numenjs/webui/extensions'),
      import('@numenjs/webui/router'),
      import('@numenjs/webui/schema-ui'),
    ])
    const context = new Context()
    await context.plugin(I18nService)
    await context.plugin(BrowserLocaleService)
    await context.plugin(BrowserExtensionRegistry)
    await context.plugin(SchemaUIRegistry)
    await context.plugin(BrowserRouterService, { basePath: import.meta.env.BASE_URL })
    return { context, stop: () => context.fiber.dispose() }
  }
  return import('@numenjs/webui/runtime').then(({ startBrowserRuntime }) => startBrowserRuntime())
}

async function main(): Promise<void> {
  const runtime = await startContext()
  const { context } = runtime
  if (import.meta.env.DEV) {
    const { coreWorkbenchFrontend } = await import('./entry.js')
    await context.plugin(coreWorkbenchFrontend)
  }
  const app = createApp(() => (
    <WorkbenchShell
      localeService={context.webuiLocale}
      router={context.webuiRouter}
      schemaUI={context.schemaUI}
      {...(import.meta.env.DEV ? {} : { consoleClient: context.consoleClient })}
    />
  ))
  app.mount(rootElement)
  globalThis.addEventListener('beforeunload', () => {
    app.unmount()
    void runtime.stop()
  }, { once: true })
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
