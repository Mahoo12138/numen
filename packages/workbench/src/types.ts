import type { ConsoleProcedureRef } from '@numen/console'
import type { ComponentType } from 'react'

export interface WorkbenchConsoleClient {
  query<Input, Output>(ref: ConsoleProcedureRef, input: Input, signal?: AbortSignal): Promise<Output>
  subscribe<Input, Event>(
    ref: ConsoleProcedureRef,
    input: Input,
    handlers: { event(event: Event): void | Promise<void> },
    signal?: AbortSignal,
  ): Promise<() => void>
}

export interface WorkbenchPageProps {
  automationId: string
  activeStepId: string
  activeTab: string
  consoleClient?: WorkbenchConsoleClient
  onOpenInspector(): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
}

export type WorkbenchPageComponent = ComponentType<WorkbenchPageProps>
