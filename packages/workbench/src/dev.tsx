import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchShell } from './WorkbenchShell.js'

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Workbench root element was not found')

createRoot(root).render(
  <StrictMode>
    <WorkbenchShell />
  </StrictMode>,
)
