# Shared-component Numen plugin

This private example demonstrates the server/frontend Entry boundary. It is built
independently of Workbench and uses only public package imports. The server registers
`dist/client.js`; the client contributes `/plugins/components` through the caller's
Cordis scope and imports the host's Vue/components facades.

From the repository root:

```sh
pnpm install
pnpm build
pnpm build:examples
pnpm dev
```

Add this entry under `plugins` in a **local development** Numen configuration,
replacing the path with your checkout's absolute path:

```yaml
plugins:
  componentsExample:
    $package: file:///absolute/path/to/numen/examples/components-plugin/dist/index.js
```

Keep the existing host plugins. Then open `/plugins/components` through the
authenticated Workbench. `$package` selects the module; the configuration key is
the plugin instance name (a file URL must not be used as that key).
Rebuild the example after edits and reload the host/plugin. The production Entry loader
serves this single JS bundle using its authenticated, revision-fenced asset endpoint.

Use TypeScript `module: "ESNext"` and `moduleResolution: "Bundler"` (see the example tsconfig). Cordis `4.0.0-rc.8` is the currently supported peer.

For a distributable plugin, use your own name, remove `private`, list `dist` in `files`,
and replace `workspace:*` with compatible released peer versions. The component, WebUI,
Console, Cordis, and Vue packages should be peers; install them locally as dev dependencies.
Do not publish this example or depend on Workbench internals. See the repository's
`docs/20-components-and-publishing.md` for release and compatibility details.
