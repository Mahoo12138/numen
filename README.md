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
pnpm dev
```

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
HTTPS, or SOCKS proxy. See [the deployment runbook](docs/13-engineering-operations.md#10-deployment)
for production startup, backup, restore, and upgrade procedures.

Architecture decisions and the planned product surface live in [`docs/`](docs/README.md).
