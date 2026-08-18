# Numen Development Status

> Last updated: 2026-08-18
>
> Architecture baseline: V1 Draft in [`docs/`](docs/README.md)

## Current State

Numen is a runnable TypeScript/Node.js monorepo built on Cordis. Configuration, SQLite durability, Capability contracts, Automation authoring/publishing, and the first durable single-node Scheduler are operational.

## Completed

- [x] pnpm/TypeScript monorepo, build, typecheck, and Vitest setup
- [x] YAML configuration validation, plugin key mapping, atomic writes, and safe-mode overlay
- [x] Cordis Host, Loader, Server, CLI, health, and readiness lifecycle
- [x] SQLite service with versioned, transactional core migrations
- [x] Capability Definition/Provider registry bound to Cordis Effect lifecycle
- [x] Automation and mutable Draft persistence with optimistic concurrency
- [x] Structural validation and deterministic Source → Core IR compilation
- [x] Dependency Manifest and Contract Snapshot generation
- [x] Immutable Revision publishing and semantic content hashing
- [x] Separate Revision activation and Automation enable/disable desired state
- [x] Restart recovery tests for Automation, Draft, and Revision state
- [x] Durable Run / Execution / Attempt state transitions
- [x] Manual Run acceptance and single-node dispatch
- [x] Safe ValueExpr evaluation and Capability invocation
- [x] Append-only Run Journal with strict per-Run sequence
- [x] Durable timer suspension and due-timer recovery
- [x] Provider-unavailable BLOCKED state and runtime reconciliation
- [x] Retry-safe interrupted-attempt recovery
- [x] Unsafe interrupted-attempt fencing as OUTCOME_UNKNOWN
- [x] Per-invocation timeout and bounded retry policy with exponential backoff
- [x] Retry attempts modeled as new Attempts on the same Execution
- [x] Unsafe timeout fencing as OUTCOME_UNKNOWN
- [x] Durable Run cancellation intent, active invocation abort, and restart recovery
- [x] Trigger Provider lifecycle and Active Revision subscription ownership
- [x] Durable Trigger acceptance with generation fencing and event deduplication
- [x] Durable Connection configuration with Adapter contracts and optimistic generation
- [x] Connection Runtime open/close lifecycle with generation-fenced recreation

## Milestone 3 — Completed

- [x] Source → Revision → Run end-to-end runtime path
- [x] Runtime readiness projection for Scheduler queues
- [x] SQLite migration v2 for explicit execution block reasons

## In Progress — Milestone 4

- [x] Trigger subscription and durable event acceptance
- [x] Retry policy and timeout handling
- [x] Cancellation intent, propagation, and recovery
- [ ] Parallel/Race/ForEach structured concurrency

## Next

1. Credential and Resource services
2. Parallel/Race/ForEach structured concurrency
3. Typed Console Query/Action/Subscription protocol
4. Browser Cordis Runtime and the first Workbench UI

## Verification Baseline

```text
Typecheck: passing
Build: passing
Tests: 9 files, 30 tests passing
CLI config validate: passing
CLI doctor: passing
SQLite schema migration: v5
```

Run locally with:

```bash
pnpm install
pnpm test
pnpm build
pnpm dev
```

## Known Boundaries

- The current compiler supports Block, Capability, If, and timer Wait controls. Block output lowering is diagnosed as unsupported.
- Drafts may remain invalid; authoritative validation happens during Publish.
- The current Scheduler executes the Core IR subset emitted by the compiler, including retry, timeout, cancellation, and recovery. Parallel/Race/ForEach structured concurrency remains planned work.
- Manual Runs and event Trigger subscriptions are supported. State Trigger transition detection, filtering, debounce, and throttle remain planned work.
- Connection desired state, Adapter contracts, and generation-fenced Runtime recreation are operational; automatic reconnect policy and Credential binding are not implemented yet.
- The npm organization/scope is still an architecture placeholder.
- No arbitrary JavaScript evaluation, distributed scheduling, plugin sandbox, or multi-user authorization is implemented.
