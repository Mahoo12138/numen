import type { LucideIcon } from 'lucide-react'
import {
  Archive,
  Bot,
  Boxes,
  CloudSun,
  FileText,
  Home,
  Network,
  Play,
  Plug,
  Send,
  Settings,
} from 'lucide-react'
import { coreWorkbenchRoutes, type CoreWorkbenchActivityId } from './routes.js'

export interface ActivityItem {
  id: CoreWorkbenchActivityId
  label: string
  icon: LucideIcon
  route: typeof coreWorkbenchRoutes[CoreWorkbenchActivityId]
}

export interface AutomationItem {
  id: string
  label: string
  icon: LucideIcon
}

export interface AutomationStep {
  id: string
  label: string
  summary: string
  icon: LucideIcon
  tone: 'neutral' | 'accent'
}

export const activities: ActivityItem[] = [
  { id: 'home', label: 'Home', icon: Home, route: coreWorkbenchRoutes.home },
  { id: 'automations', label: 'Automations', icon: Network, route: coreWorkbenchRoutes.automations },
  { id: 'runs', label: 'Runs', icon: Play, route: coreWorkbenchRoutes.runs },
  { id: 'connections', label: 'Connections', icon: Plug, route: coreWorkbenchRoutes.connections },
  { id: 'plugins', label: 'Plugins', icon: Boxes, route: coreWorkbenchRoutes.plugins },
  { id: 'system', label: 'System', icon: Settings, route: coreWorkbenchRoutes.system },
]

export const automations: AutomationItem[] = [
  { id: 'morning-brief', label: 'Morning Brief', icon: Network },
  { id: 'inbox-triage', label: 'Inbox Triage', icon: Bot },
  { id: 'weekly-archive', label: 'Weekly Archive', icon: Archive },
]

export const automationSteps: AutomationStep[] = [
  {
    id: 'trigger',
    label: 'Trigger',
    summary: 'Schedule  •  Every day at 07:00',
    icon: Play,
    tone: 'neutral',
  },
  {
    id: 'weather',
    label: 'Fetch weather',
    summary: 'Connection: OpenWeather  •  Get current weather for location',
    icon: CloudSun,
    tone: 'neutral',
  },
  {
    id: 'summary',
    label: 'Prepare summary',
    summary: 'Template  •  Format weather and key updates',
    icon: FileText,
    tone: 'neutral',
  },
  {
    id: 'notification',
    label: 'Send notification',
    summary: 'Connection: Slack  •  Post message to #morning-brief',
    icon: Send,
    tone: 'accent',
  },
]
