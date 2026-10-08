# @numenjs/workbench

Numen's workspace, Automation editor, business providers, and browser application.
Workbench is an independent product package and remains a private workspace
package during this development phase.

## Product plugin

In a Numen version 2 configuration, Console and Workbench are separate entries:

```yaml
version: 2
dataDir: .numen
plugins:
  server:
    host: 127.0.0.1
    port: 5140
  console: {}
  workbench: {}
```

The server composition plugin is the default export of
`@numenjs/workbench/plugin`; `workbenchPlugin`, `WorkbenchConfig`, and
`legacyWorkbenchBuiltins` are named exports of that subpath. Importing it does not
register plugins or start services. Cordis hosts load it with
`ctx.plugin(workbenchPlugin, config)`.

`WorkbenchConfig` preserves the existing runtime options:

| Option | Purpose |
| --- | --- |
| `root` | Built application directory containing `index.html` and public assets |
| `assetPath` | Public asset URL path; defaults to `/workbench` |
| `entrySource` | Workbench's authenticated frontend Entry source |

The default build uses `/workbench/` as its public asset base. Changing `assetPath`
requires an application build whose asset references use the same base.

Workbench owns its runtime and feature providers as Cordis child plugins.
Providers declare their own Console and domain-service dependencies. Missing
dependencies leave affected children unavailable and allow them to recover when
services return; the parent being installed does not mean every feature is ready.
Workbench never installs Console or the domain services itself.

Disabling Workbench removes its Procedures, providers, routes, and frontend Entry.
Console's authentication and transports, other plugins' Entries, and background
Automation services keep their independent lifecycles.

## Exports and built assets

Page layout follows the task rather than reserving every Workbench region.
Management pages use one main content area without a generic sidebar, log
panel, or page-name status footer. Runs keeps its compact summary and filters
next to the table. System separates health and runtime logs with page tabs;
links carrying `runId` or `connectionId` open scoped logs and preserve their
return path. Switching back from health keeps log filters, pause state, and
the historical cursor; hidden logs stop their live subscription. Plugins
retains a compact object list beside its details; Home
groups recent Automations and Runs side by side when space permits.

`chrome.hasSidebar` reserves a sidebar supplied by a page. The automation
editor keeps its explorer, inspector, diagnostic panel, and authoring status.
Custom chrome retains its legacy sidebar and panel defaults unless it opts
out. Removing these regions does not change their stored sizes or current
panel-open state, so returning to the editor restores its workspace.

Editor splitters collapse their region when dragged 24px beyond its expanded
minimum. Reversing the same gesture reopens it; cancellation restores its
original size and visibility. Collapsing preserves the gesture's initial
expanded-size preference. Reopen the sidebar through its activity button or
Mod+B, the inspector through its editor button, and the bottom panel through
its toggle or Mod+J.

The root export remains the existing browser-oriented API. The `/contracts`,
`/server`, `/runtime`, and `/i18n` subpaths are preserved. In particular, `/runtime`
still defaults to the legacy runtime service; its export does not silently become
the full product plugin. `legacyWorkbenchBuiltins` is for version 1 Host loading.

`pnpm build` at the repository root compiles workspace packages and builds the
Workbench application into this package's `dist/app`. That directory owns the
HTML, CSS, hashed JavaScript chunks, authenticated `core-entry.js`, and shared
`components.js`, `vue.js`, and `cordis.js` facades. Console delivers registered
Entry assets without taking ownership of the Workbench build.

Local build and tarball inspection do not establish independent registry
installation support. Workbench still depends on private domain workspace
packages. Its existing TypeScript configuration preserves JSX: a clean build
emits `pages.jsx` and `WorkbenchShell.jsx`, while the browser-oriented root
`index.js` refers to their `.js` names. The Vite application build is complete,
but the root library output needs a separate packaging correction before claiming
standalone library consumption. The new server `/plugin` entry emits JavaScript
and does not traverse these browser modules. No package publication or visibility
change is implied.
