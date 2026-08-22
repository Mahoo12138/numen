import type { ConsoleProcedureRef } from '@numen/console'
import type { FrontendPage } from '@numen/webui/extensions'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import type { ComponentType } from 'react'

export interface WorkbenchConsoleClient {
  query<Input, Output>(ref: ConsoleProcedureRef, input: Input, signal?: AbortSignal): Promise<Output>
  action<Input, Output>(ref: ConsoleProcedureRef, input: Input, signal?: AbortSignal): Promise<Output>
  subscribe<Input, Event>(
    ref: ConsoleProcedureRef,
    input: Input,
    handlers: { event(event: Event): void | Promise<void> },
    signal?: AbortSignal,
  ): Promise<() => void>
}

export interface WorkbenchPageProps {
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
}

export type WorkbenchPageComponent = ComponentType<WorkbenchPageProps>

export interface WorkbenchPageChromeProps {
  page: WorkbenchPageDefinition
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  inspectorOpen: boolean
  onInspectorOpenChange(open: boolean): void
}

export type WorkbenchPageChromeComponent = ComponentType<WorkbenchPageChromeProps>

export interface WorkbenchPageChromeDefinition {
  component: WorkbenchPageChromeComponent
  hasInspector?: boolean
  ownsPanel?: boolean
  ownsStatus?: boolean
}

export interface WorkbenchPageDefinition extends FrontendPage<WorkbenchPageComponent> {
  chrome?: WorkbenchPageChromeDefinition
}
