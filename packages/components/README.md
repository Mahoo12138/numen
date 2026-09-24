# @numenjs/components

Vue 3 components shared by the Numen Workbench and frontend plugins. ESM JavaScript,
TypeScript declarations, and scoped CSS are distributed separately. No Numen server,
database, or Workbench dependency is required. Vue is a peer dependency.

```ts
import { createApp, h } from 'vue'
import { Button, SelectMenu, FormSection, StatePanel } from '@numenjs/components'
import '@numenjs/components/style.css'

createApp({ render: () => h(Button, { onClick: () => console.log('save') }, () => 'Save') }).mount('#app')
```

| API | Purpose |
| --- | --- |
| `Button` | Primary, secondary, danger, ghost; disabled/busy; defaults to `type="button"` |
| `Input`, `Textarea` | Native attributes/events, shared tokens and focus/error/disabled styles; `inputRef` provides the native element for focus/selection |
| `SelectMenu` | Controlled string `value`, `options`, `onChange`; disabled options; keyboard navigation; outside-click/Escape dismissal; viewport-aware popup outside scroll containers |
| `StatePanel` | Loading, empty, unavailable, or error state; optional retry action |
| `FormSection` | Native accessible collapsible section with a default slot |
| `StringLiteralEditor`, `NumberLiteralEditor`, `BooleanLiteralEditor`, `EnumLiteralEditor`, `JsonLiteralEditor` | Schema-driven literal inputs |
| `DurationLiteralEditor`, `IsoDateTimeLiteralEditor` | Milliseconds and ISO date-time inputs |
| `coreSchemaLiteralRenderers` | Definitions for a host-owned Schema UI registry |
| `provideComponentI18n` | Vue-subtree translator injection, with English defaults |
| `defineSetupComponent`, `useTextDraft` | Typed setup helper and presentation-safe input drafts |

Schema editors take `field: SchemaField`, `controlId`, `inputId`, `canEdit`, `invalid`,
optional `value`, and `onCommit`. IDs must be unique within the page. String/number/
JSON/date/duration editors commit on blur, and text inputs also commit on Enter.
JSON validation reports through `onValidationChange`; invalid text stays editable
without replacing the committed value. These are literal editors, not a full recursive
Schemastery form or Automation expression editor. Validate domain contracts on the server.

`FormSection.open` initializes the native disclosure; users can toggle it with the
summary button. A changed prop synchronizes the open state. Slots compose its content.

## Numen frontend Entries

Numen plugin bundles must share the host Vue runtime and component facade:

```ts
// vite.config.ts (frontend Entry build)
import { defineConfig } from 'vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { numenPluginRuntime } from '@numenjs/components/vite'

export default defineConfig({
  plugins: [vueJsx(), numenPluginRuntime()],
  build: {
    lib: { entry: 'src/client.tsx', formats: ['es'], fileName: () => 'client.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
```

The adapter maps `vue`, `cordis`, and `@numenjs/components` to `/workbench/vue.js`,
`/workbench/cordis.js`, and `/workbench/components.js`. It omits the component CSS import because Workbench
already loads it. The adapter targets Numen's production Entry asset loader; use
`pnpm build:examples` and a running Numen host for plugin development. It is not a
standalone Vite dev-server integration. For SFCs, use `@vitejs/plugin-vue` instead of
the JSX plugin. Import only from `vue`, not Vue's private runtime subpaths.

The host is responsible for compatible component versions, CSS, and Vue. Keep
`@numenjs/components`, `@numenjs/webui`, and `vue` as peers in published Numen frontend
plugins and as dev dependencies for authoring/building. Do not instantiate another
Vue app inside a contributed page. Register pages/renderers with the Entry's Cordis
Context so unloading the Entry removes its contributions.

## Themes and localization

CSS uses `--n-text`, `--n-muted`, `--n-border`, `--n-border-strong`, `--n-surface`,
`--n-accent`, `--n-accent-strong`, and `--n-selection`, with Workbench palette and
standalone defaults. No global reset or `body` rule is shipped. Define theme variables
on a containing element to theme a subtree. Import `style.css` once in a standalone app.

Call `provideComponentI18n(key => translate(key))` in a parent's setup function.
The translator can read reactive locale state. Workbench supplies its own translator,
so contributed components inherit the current user language and keep in-progress input
when that language changes.

## Development

From the monorepo root: `pnpm install`, `pnpm --filter @numenjs/components build`,
`pnpm test`, `pnpm test:e2e`, `pnpm release:check`. Published archives contain compiled
ESM, declarations and CSS; consumers do not need Vue JSX compilation.

`SelectMenu` forwards `id`, `aria-describedby`, `aria-invalid`, and other button attributes to its trigger; `class` and `style` apply to the wrapper. Options use `{ value, label, description?, disabled? }`. Values remain strings; schema Boolean/Enum editors map them back to their original data types. The popup is portaled to `document.body`, closes on focus leaving, and restores focus after selection or Escape. Arrow keys, Home/End and Tab work without selecting disabled options.

`Input` and `Textarea` preserve native `onInput` versus `onChange` behavior. Keep parsing, commit timing and draft ownership in the caller (or use a schema editor); the primitive does not coerce values. Use `inputRef` rather than a component `ref` when manipulating native focus or text selection.
