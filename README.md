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
pnpm numen config validate
pnpm numen doctor
pnpm numen start --safe
```

Architecture decisions and the planned product surface live in [`docs/`](docs/README.md).
