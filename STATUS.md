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
- [x] Browser bootstrap-token exchange for HttpOnly same-origin Console sessions
- [x] Cookie authentication for Console HTTP and WebSocket transports with Origin fencing
- [x] Browser Cordis Console Client with fragment scrubbing and session restoration
- [x] Browser typed Query/Action client with AbortSignal and structured transport errors
- [x] Real Server-to-Browser Context authentication and Query integration coverage
- [x] Browser multiplexed Subscription client with Cordis lifecycle ownership
- [x] Truth-first reconnect reconciliation before subscription restoration
- [x] Real Server-to-Browser authenticated WebSocket integration coverage
- [x] Browser Page/Slot/Contribution registries with deterministic ordering
- [x] Frontend extension collision/cycle validation and Fiber-owned cleanup
- [x] Composed Browser Cordis Runtime bootstrap and idempotent shutdown
- [x] Backend Console Entry registry with direct Effect ownership
- [x] Validated generation staging, stale fencing, atomic swap, and old-scope retirement
- [x] Authenticated Entry manifest with ETag and path-free browser URLs
- [x] Revision-fenced immutable asset delivery with MIME and same-origin headers
- [x] Lexical traversal and realpath/symlink escape protection for frontend assets
- [x] Browser Entry manifest client with authenticated same-origin module loading
- [x] Generation-scoped frontend staging with complete snapshot validation
- [x] Atomic frontend snapshot activation, stale fencing, and failed-generation rollback
- [x] Entry snapshot reconciliation before WebSocket subscription restoration
- [x] Default React Workbench package with Activity Rail, Sidebar, Main, Inspector, Panel, and Status regions
- [x] Automation detail shell with interactive tabs, step selection, grouped Inspector, and bottom panel
- [x] Responsive desktop/tablet/mobile Workbench profiles with Inspector drawer behavior
- [x] Browser-verified Workbench visual baseline at 1440×960 and 390×844
- [x] Stable Route ID Browser Router with typed parameters and deterministic query encoding
- [x] History/popstate reconciliation with Page Effect lifecycle and Entry snapshot replacement
- [x] Dynamic Page path validation with ambiguous route-shape collision prevention
- [x] Core Home / Automations / Runs / Connections / Plugins / System Page entries
- [x] Workbench Activity navigation bound to stable Router IDs and browser History
- [x] React external-store route snapshots with Page Effect and Back/Forward reconciliation
- [x] Direct WebUI subpath imports for bounded Workbench bootstrap bundles

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
- [x] Server-side browser session bootstrap and same-origin cookie authentication
- [x] Browser Cordis Runtime bootstrap and typed Query/Action client
- [x] Browser Subscription client and reconnect reconciliation
- [x] Frontend Page/Slot Effect registries and extension lifecycle
- [x] Backend Console Entry registry and atomic generation staging
- [x] Authenticated Console Entry manifest and asset delivery
- [x] Browser Entry loader with generation-scoped activation
- [x] First Workbench shell and responsive interaction lifecycle
- [x] Stable Route service and Page extension lifecycle
- [x] Core product Page entries and Workbench Router binding
- [ ] Authenticated Workbench bootstrap and bundled core Entry delivery

## Next

1. Authenticated Workbench bootstrap document and bundled core Entry delivery
2. Default Runtime registration of the Workbench frontend Entry
3. Live Console Query bindings for Home and core index Pages

## Verification Baseline

```text
Typecheck: passing
Build: passing
Tests: 28 files, 109 tests passing
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
- Typed Console transports, browser sessions, Browser Cordis clients, frontend extension registries, atomic Entry generations, authenticated revision-fenced asset delivery, and Browser Entry reconciliation/rollback are operational. Generated bootstrap tokens and sessions rotate on restart; trusted launcher delivery and Workbench runtime integration remain planned work.
- The responsive Workbench shell, six core Page entries, and stable browser Route/Page reconciliation are operational. Server-delivered browser bootstrap and live Console data binding remain planned work.
- Manual Runs and event Trigger subscriptions are supported. State Trigger transition detection, filtering, debounce, and throttle remain planned work.
- Connection desired state, Adapter contracts, generation-fenced Runtime recreation, and Credential snapshots are operational; automatic reconnect policy remains planned work.
- Credential payloads use authenticated encryption with environment-provided keys; key-ring migration and external vault providers remain planned work.
- Local Resource bytes are content-addressed and lifecycle-managed, and Scheduler success commits Execution owners transactionally; authorized HTTP delivery remains planned work.
- The npm organization/scope is still an architecture placeholder.
- No arbitrary JavaScript evaluation, distributed scheduling, plugin sandbox, or multi-user authorization is implemented.
