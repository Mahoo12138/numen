import type { Context } from 'cordis'
import type {} from '@numenjs/console'

/** Server-side Entry ownership is tied to this plugin's Fiber. */
export default function componentsExample(ctx: Context): void {
  ctx.consoleEntries.addEntry(ctx, {
    id: '@numenjs/example-components-plugin:client',
    prod: new URL('./client.js', import.meta.url).href,
  })
}
componentsExample.inject = ['consoleEntries']
