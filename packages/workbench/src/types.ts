import type { ComponentType } from 'react'

export interface WorkbenchPageProps {
  automationId: string
  activeStepId: string
  activeTab: string
  onOpenInspector(): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
}

export type WorkbenchPageComponent = ComponentType<WorkbenchPageProps>
