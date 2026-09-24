import type { ConsoleProcedureRef } from '@numenjs/console'
import type { FrontendPage } from '@numenjs/webui/extensions'
import type { FrontendExtensionRef } from '@numenjs/webui/extensions'
import type { BrowserNavigateOptions, BrowserRouteState } from '@numenjs/webui/router'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import type { Component } from 'vue'

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
  navigation?: WorkbenchNavigation
}

export interface WorkbenchNavigation {
  route: BrowserRouteState
  navigate(ref: FrontendExtensionRef, options?: BrowserNavigateOptions): BrowserRouteState
}

export type WorkbenchPageComponent = Component<WorkbenchPageProps>

export interface WorkbenchPageChromeProps {
  page: WorkbenchPageDefinition
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  navigation?: WorkbenchNavigation
  inspectorOpen: boolean
  onInspectorOpenChange(open: boolean): void
}

export type WorkbenchPageChromeComponent = Component<WorkbenchPageChromeProps>

export interface WorkbenchPageChromeDefinition {
  component: WorkbenchPageChromeComponent
  hasInspector?: boolean
  ownsPanel?: boolean
  ownsStatus?: boolean
}

export interface WorkbenchPageDefinition extends FrontendPage<WorkbenchPageComponent> {
  chrome?: WorkbenchPageChromeDefinition
}
