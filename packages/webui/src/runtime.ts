import { Context } from 'cordis'
import { I18nService, type I18nConfig } from '@numenjs/i18n'
import { BrowserLocaleService, type BrowserLocaleConfig } from './i18n.js'
import { BrowserExtensionRegistry } from './extensions.js'
import { BrowserEntryLoader, type BrowserEntryLoaderConfig } from './loader.js'
import { BrowserRouterService, type BrowserRouterConfig } from './router.js'
import { SchemaUIRegistry } from './schema-ui.js'
import { BrowserConsoleClient, type BrowserConsoleClientConfig } from './service.js'

export interface StartBrowserRuntimeOptions {
  i18n?: I18nConfig
  locale?: BrowserLocaleConfig
  console?: BrowserConsoleClientConfig
  entries?: BrowserEntryLoaderConfig
  router?: BrowserRouterConfig
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
    await context.plugin(I18nService, options.i18n ?? {})
    await context.plugin(BrowserLocaleService, options.locale ?? {})
    await context.plugin(BrowserExtensionRegistry)
    await context.plugin(SchemaUIRegistry)
    await context.plugin(BrowserRouterService, options.router ?? {})
    await context.plugin(BrowserConsoleClient, options.console ?? {})
    await context.plugin(BrowserEntryLoader, options.entries ?? {})
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
