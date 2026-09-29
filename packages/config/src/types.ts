import type { LoggingConfig } from '@numenjs/logging/config'

export interface PluginConfig {
  $if?: boolean
  $package?: string
  $label?: string
  $collapsed?: boolean
  [key: string]: unknown
}

export interface NumenConfig {
  version: 1 | 2
  dataDir: string
  logger?: LoggingConfig
  plugins: Record<string, PluginConfig | null>
}

export interface RuntimeEntry {
  id: string
  key: string
  name: string
  config: Record<string, unknown>
  /** Local disable/safety constraint. Ancestor constraints belong to Cordis Group. */
  disabled: boolean
  builtin: boolean
  children?: RuntimeEntry[]
  selfEnabled?: boolean
  effectiveEnabled?: boolean
  parentId?: string
  path?: string
  label?: string
  collapsed?: boolean
}

export interface LoadedConfig {
  filename: string
  baseDir: string
  config: NumenConfig
}
