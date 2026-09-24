# Numen

Numen is a Cordis-native, plugin-first personal automation runtime. The current implementation includes host/configuration loading, durable SQLite storage, authenticated encrypted Credentials, fixed-version Connection secret snapshots, content-addressed local Resources with Owner/Lease GC and transactional Scheduler ownership, stable Capability, Connection Type, Adapter, and READY Runtime injection contracts, a shared proxy-aware outbound HTTP substrate, bounded HTTP Request, network-free Echo, and cron Schedule integrations, typed Console procedures with authenticated transports, atomic frontend Entry generations, revision-fenced asset delivery, and Effect-owned Page/Slot registries, generation-fenced Connection runtimes, Automation Draft authoring, deterministic Core IR compilation, immutable Revision publishing, Active Revision trigger subscriptions, durable event acceptance, and a single-node Scheduler with durable Parallel, first-success Race, and bounded ForEach scopes, Run/Execution/Attempt journaling, retry, timeout, cancellation, and restart recovery.

## Prerequisites

- Node.js 22+
- pnpm 10+

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm dev
```

`pnpm test` runs the fast Node integration/unit suite. `pnpm test:e2e` builds the
production Workbench and drives the real browser/server authoring path on an
isolated temporary database.

The default server listens on `http://127.0.0.1:5140`. Operational endpoints:

- `GET /api/health` — process liveness
- `GET /api/ready` — database, contract-registry, and Automation service readiness

CLI commands:

```bash
pnpm numen --help
pnpm numen key generate
pnpm numen config validate
pnpm numen doctor
pnpm numen start --safe
```

## Languages

Workbench supports English and Simplified Chinese. Use the language selector in
the top bar, or follow the browser language. Explicit choices persist locally;
switching languages preserves open editors and user data. Plugin translations
use the shared Cordis i18n service and unload with their owning Entry.
See [the i18n guide](docs/18-i18n.md) for service and Vue examples.

## Runtime logs

Open System or the bottom Logs panel for authenticated runtime logs, or jump from a
Run to its correlated records. Namespace levels, bounded history, sanitized terminal
output, and rotating files under `<dataDir>/logs` share one host collector.
See [the logging guide](docs/19-logging.md) for configuration and plugin usage.

## Docker first run

The Compose deployment keeps SQLite and Resources in one named volume, requires
a 256-bit Credential master key, and only publishes Workbench on the host loopback
interface by default.

```bash
docker build -t numen:local .
cp .env.example .env
docker run --rm numen:local key generate
```

Put the generated value in `.env` as `NUMEN_MASTER_KEY`, then start Numen:

```bash
docker compose up --build -d
docker compose logs numen
```

The startup log contains a private Workbench bootstrap URL. Open it once; the
credential is carried in the URL fragment, so it is excluded from the browser's
initial HTTP request and exchanged by Workbench after startup. The default
address is `http://127.0.0.1:5140`.

For a network-free first Automation, select `Cron Schedule` as its Trigger and
`Echo` as its Capability. Publish, activate, and enable it, then inspect the Run
timeline after the next scheduled minute. `docker compose restart numen` verifies
that its revision, subscription, and future Runs survive a process restart.

Set `NUMEN_HTTP_PROXY` in `.env` when outbound Integrations need a shared HTTP,
HTTPS, or SOCKS proxy. Set `NO_PROXY` for direct destinations such as
`localhost,127.0.0.1,::1,.home.arpa`. See [the deployment runbook](docs/13-engineering-operations.md#10-deployment)
for production startup, backup, restore, and upgrade procedures.

Architecture decisions and the planned product surface live in [`docs/`](docs/README.md).

## MVP 0.1.0

The current application version is `0.1.0`. Build and verify it locally:

```bash
pnpm release:verify
pnpm image:build
pnpm image:smoke
```

The container smoke test exercises authenticated authoring, an actual Echo Run,
container recreation, persisted state, and the next Cron Run using an isolated
temporary volume. It removes its test container and volume afterward.

For the frozen scope, release checklist, registry publication steps, and
`compose.release.yml` deployment, see [the release runbook](docs/17-mvp-release.md).
No registry image is published by these local commands.

## Shared components and plugin packages

All workspace packages use `@numenjs/*`. `packages/components` supplies the Vue
controls shared by Workbench and plugins; `examples/components-plugin` demonstrates
a separately built Entry using the host runtime. Run `pnpm build:examples` after
`pnpm build`, and `pnpm release:check` to pack and test the public packages in an
independent npm consumer. These commands do not publish to npm.
See [components and publishing](docs/20-components-and-publishing.md).
