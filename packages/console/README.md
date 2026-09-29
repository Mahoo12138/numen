# @numenjs/console

Typed Console procedures, authenticated transports, and frontend Entries.

This package is part of the Numen plugin SDK. Use the same release line as your host.
Cordis `4.0.0-rc.8` is a peer dependency. TypeScript plugin projects use
`module: "ESNext"` and `moduleResolution: "Bundler"`; the upstream Cordis declarations
currently require Bundler resolution. Runtime output is ESM.

## Product plugin

The default export is the Console composition plugin. In a Numen version 2
configuration, `console: {}` installs its RPC service, authentication, sessions,
Entry registry, asset delivery, and HTTP/WebSocket transports. The host supplies
the Server separately. Console does not load Workbench.

```yaml
version: 2
dataDir: .numen
plugins:
  server:
    host: 127.0.0.1
    port: 5140
  console: {}
```

The `ConsoleConfig` options group existing settings by responsibility:

| Option | Fields |
| --- | --- |
| `auth` | `token`, `ownerId` |
| `session` | `path`, `secureCookie` |
| `assets` | `mode`, `manifestPath`, `assetPath` |
| `http` | `path` |
| `websocket` | `path`, `maxMessageBytes`, `maxBufferedBytes` |

Omitting `auth.token` generates a token in memory. Authentication cannot be
disabled with `auth: false`. These objects configure the children; they do not
enable or disable individual infrastructure plugins. Existing session cookies
remain scoped to `/api/console`, so custom transport paths must account for that
scope when using cookie authentication.

Cordis hosts can load the default export with `ctx.plugin(consolePlugin, config)`.
All children belong to that Context and are released with the parent. Importing
the package alone does not register plugins or start a server.

## Export compatibility

Existing named SDK exports remain available. `consolePlugin` and `ConsoleConfig`
are also named exports. `legacyConsoleBuiltins` retains the original version 1
leaf mappings for Host compatibility; new configurations use the product entry.
In particular, version 1 `console` continues to mean `ConsoleService` alone.

Use explicit public exports. Bind registrations to the calling Cordis Context so
plugin unload removes owned effects. Frontend widgets are provided separately by
`@numenjs/components`; browser plugins should avoid importing server implementation
modules from Console or Logging (type-only imports are safe).

Within the Numen monorepo, `pnpm --filter @numenjs/console build` builds this package.
`pnpm release:check` at the repository root verifies every distributable tarball in
an independent npm consumer. No remote publication is performed by those commands.
