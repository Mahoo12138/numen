import { BrowserExtensionRegistry } from '@numen/webui/extensions'
import { BrowserRouterService } from '@numen/webui/router'
import { Context } from 'cordis'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { coreWorkbenchPages } from './pages.js'
import { WorkbenchShell } from './WorkbenchShell.js'

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Workbench root element was not found')

const context = new Context()
await context.plugin(BrowserExtensionRegistry)
await context.plugin(BrowserRouterService)
await context.plugin(coreWorkbenchPages)
globalThis.addEventListener('beforeunload', () => void context.fiber.dispose(), { once: true })

createRoot(root).render(
  <StrictMode>
    <WorkbenchShell router={context.webuiRouter} />
  </StrictMode>,
)
