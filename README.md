# Numen

Numen is a Cordis-native, plugin-first personal automation runtime. The current implementation includes host/configuration loading, durable SQLite storage, authenticated encrypted Credentials, fixed-version Connection secret snapshots, content-addressed local Resources with Owner/Lease GC and transactional Scheduler ownership, stable capability and Connection Adapter contracts, typed Console Query/Action/Subscription procedures with single-user authenticated HTTP, WebSocket, browser sessions, and a Browser Cordis Query/Action/Subscription client, generation-fenced Connection runtimes, Automation Draft authoring, deterministic Core IR compilation, immutable Revision publishing, Active Revision trigger subscriptions, durable event acceptance, and a single-node Scheduler with durable Parallel, first-success Race, and bounded ForEach scopes, Run/Execution/Attempt journaling, retry, timeout, cancellation, and restart recovery.

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
