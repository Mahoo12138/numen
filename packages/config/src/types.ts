import type { LoggingConfig } from '@numenjs/logging/config'
export interface PluginConfig {
  $if?: boolean
  $package?: string
  [key: string]: unknown
}

export interface NumenConfig {
  version: 1
  dataDir: string
  logger?: LoggingConfig
  plugins: Record<string, PluginConfig | null>
}

export interface RuntimeEntry {
  id: string
  key: string
  name: string
  config: Record<string, unknown>
  disabled: boolean
  builtin: boolean
}

export interface LoadedConfig {
  filename: string
  baseDir: string
  config: NumenConfig
}
