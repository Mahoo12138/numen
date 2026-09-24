# @numenjs/console

Typed Console procedures, authenticated transports, and frontend Entries.

This package is part of the Numen plugin SDK. Use the same release line as your host.
Cordis `4.0.0-rc.8` is a peer dependency. TypeScript plugin projects use
`module: "ESNext"` and `moduleResolution: "Bundler"`; the upstream Cordis declarations
currently require Bundler resolution. Runtime output is ESM.

Use explicit public exports. Bind registrations to the calling Cordis Context so
plugin unload removes owned effects. Frontend widgets are provided separately by
`@numenjs/components`; browser plugins should avoid importing server implementation
modules from Console or Logging (type-only imports are safe).

Within the Numen monorepo, `pnpm --filter @numenjs/console build` builds this package.
`pnpm release:check` at the repository root verifies every distributable tarball in
an independent npm consumer. No remote publication is performed by those commands.
