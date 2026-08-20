import { Context } from 'cordis'
import { BrowserExtensionRegistry } from './extensions.js'
import { BrowserConsoleClient, type BrowserConsoleClientConfig } from './service.js'

export interface StartBrowserRuntimeOptions {
  console?: BrowserConsoleClientConfig
}

export interface NumenBrowserRuntime {
  context: Context
  stop(): Promise<void>
}

export async function startBrowserRuntime(
  options: StartBrowserRuntimeOptions = {},
): Promise<NumenBrowserRuntime> {
  const context = new Context()
  try {
    await context.plugin(BrowserExtensionRegistry)
    await context.plugin(BrowserConsoleClient, options.console ?? {})
  } catch (error) {
    await context.fiber.dispose()
    throw error
  }
  let stopTask: Promise<void> | undefined
  return {
    context,
    stop() {
      return stopTask ??= context.fiber.dispose()
    },
  }
}
