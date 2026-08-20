# Numen Development Status

> Last updated: 2026-08-20
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
- [x] Encrypted Credential payload storage with metadata-only reads and versioned rotation
- [x] Credential-to-Connection fixed runtime snapshots and rotation-driven recreation
- [x] Content-addressed local Resource Store with atomic deduplication
- [x] Resource STAGED/COMMITTED/DELETING/GONE lifecycle, Owner, Lease, and recovery GC
- [x] Scheduler ResourceRef output validation and transactional Execution ownership
- [x] Durable Parallel Fork/Join scopes with concurrent dispatch, fail-fast, and restart recovery
- [x] Durable first-success Race with branch failure tracking and RACE loser cancellation
- [x] Durable ForEach iteration snapshots, bounded concurrency, loop bindings, fail-fast, and restart recovery
- [x] Scope-lineage step binding isolation across concurrent and nested structured scopes
- [x] Typed, versioned Console Query/Action/Subscription contracts with Schemastery validation
- [x] Console Procedure/Provider Effect lifecycle and abort-safe Subscription cleanup
- [x] Default Runtime/Loader integration for the Console procedure service
- [x] Authenticator Provider contract with server-owned Principal/Session construction
- [x] Console Query/Action HTTP transport with typed errors and disconnect cancellation
- [x] Default single-user bearer Authenticator with generated bootstrap credentials
- [x] Default Runtime activation for Console authentication and HTTP transport
- [x] Multiplexed Console Subscription WebSocket transport with bounded buffering
- [x] Subscription cleanup on unsubscribe, disconnect, and Provider lifecycle invalidation

## Milestone 3 — Completed

- [x] Source → Revision → Run end-to-end runtime path
- [x] Runtime readiness projection for Scheduler queues
- [x] SQLite migration v2 for explicit execution block reasons

## Milestone 4 — Completed

- [x] Trigger subscription and durable event acceptance
- [x] Retry policy and timeout handling
- [x] Cancellation intent, propagation, and recovery
- [x] Parallel/Race/ForEach structured concurrency

## In Progress — Milestone 5

- [x] Typed Console Query/Action/Subscription procedure registry
- [x] Console Query/Action HTTP transport and authenticated request-context bridge
- [x] Default single-user Console Authenticator and Runtime transport activation
- [x] Console Subscription WebSocket transport
- [ ] Browser Cordis Runtime and frontend extension lifecycle

## Next

1. Browser authentication bootstrap and Cordis Runtime
2. Frontend Entry/Page/Slot Effect registries
3. First Workbench shell and extension lifecycle

## Verification Baseline

```text
Typecheck: passing
Build: passing
Tests: 17 files, 68 tests passing
CLI config validate: passing
CLI doctor: passing
SQLite schema migration: v10
```

Run locally with:

```bash
pnpm install
pnpm test
pnpm build
pnpm dev
```

## Known Boundaries

- The current compiler supports Block, Capability, If, timer Wait, Parallel, first-success Race, and bounded ForEach controls. Block output lowering is diagnosed as unsupported.
- Drafts may remain invalid; authoritative validation happens during Publish.
- The current Scheduler executes the Core IR subset emitted by the compiler, including retry, timeout, cancellation, recovery, and structured concurrency.
- Parallel, first-success Race, and bounded ForEach use durable Execution scopes with interruptible concurrent dispatch; Try/Finally control flow remains planned work.
- Typed Console procedures, Query/Action HTTP calls, and multiplexed Subscription WebSockets are operational with a default single-user bearer Authenticator. Generated bootstrap tokens are memory-only and rotate on restart; browser-safe bootstrap/session delivery remains planned work.
- Manual Runs and event Trigger subscriptions are supported. State Trigger transition detection, filtering, debounce, and throttle remain planned work.
- Connection desired state, Adapter contracts, generation-fenced Runtime recreation, and Credential snapshots are operational; automatic reconnect policy remains planned work.
- Credential payloads use authenticated encryption with environment-provided keys; key-ring migration and external vault providers remain planned work.
- Local Resource bytes are content-addressed and lifecycle-managed, and Scheduler success commits Execution owners transactionally; authorized HTTP delivery remains planned work.
- The npm organization/scope is still an architecture placeholder.
- No arbitrary JavaScript evaluation, distributed scheduling, plugin sandbox, or multi-user authorization is implemented.
