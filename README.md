# Numen

Numen is a Cordis-native, plugin-first personal automation runtime. This repository is in its first implementation milestone: host/configuration loading, durable SQLite storage, stable capability contracts, and a minimal operational HTTP surface.

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
- `GET /api/ready` — database and contract-registry readiness

CLI commands:

```bash
pnpm numen --help
pnpm numen config validate
pnpm numen doctor
pnpm numen start --safe
```

Architecture decisions and the planned product surface live in [`docs/`](docs/README.md).
