# Numen Development Status

> Last updated: 2026-09-01
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
- [x] Revision- and process-generation-fenced immutable asset delivery with MIME and same-origin headers
- [x] Lexical traversal and realpath/symlink escape protection for frontend assets
- [x] Browser Entry manifest client with authenticated same-origin module loading
- [x] Generation-scoped frontend staging with complete snapshot validation
- [x] Atomic frontend snapshot activation, stale fencing, and failed-generation rollback
- [x] Entry snapshot reconciliation before WebSocket subscription restoration
- [x] Default Vue 3 Workbench package with Activity Rail, Sidebar, Main, Inspector, Panel, and Status regions
- [x] Vue Composition API migration for Router snapshots, Console Queries, Draft authoring, Pages, Chrome, and Schema Renderers
- [x] Automation detail shell with interactive tabs, step selection, grouped Inspector, and bottom panel
- [x] Responsive desktop/tablet/mobile Workbench profiles with Inspector drawer behavior
- [x] Browser-verified Workbench visual baseline at 1440×960 and 390×844
- [x] Stable Route ID Browser Router with typed parameters and deterministic query encoding
- [x] History/popstate reconciliation with Page Effect lifecycle and Entry snapshot replacement
- [x] Dynamic Page path validation with ambiguous route-shape collision prevention
- [x] Core Home / Automations / Runs / Connections / Plugins / System Page entries
- [x] Workbench Activity navigation bound to stable Router IDs and browser History
- [x] Vue reactive route snapshots with Page Effect and Back/Forward reconciliation
- [x] Direct WebUI subpath imports for bounded Workbench bootstrap bundles
- [x] Secret-free Workbench SPA bootstrap document with strict CSP and no-store delivery
- [x] Confined Workbench asset delivery with immutable hashed caching and security headers
- [x] Production Browser Runtime bootstrap bundle with controlled startup failure UI
- [x] Root production build including the deployable Workbench application bundle
- [x] Default Runtime Workbench server activation through the Cordis Loader tree
- [x] Stable production core Entry bundle delivered only through authenticated Console assets
- [x] Browser-verified fragment exchange, core Entry activation, and routed Page rendering
- [x] Explicit CLI Workbench launch URL with fragment-only bootstrap credentials
- [x] Typed Home Overview Query with default Automation/Scheduler/Connection Provider
- [x] Abort-safe reusable browser Console Query hook with loading, empty, and retry states
- [x] Shared Vue runtime identity across the public shell and authenticated core Entry
- [x] Typed Runs Index Query with status totals and aggregate Execution/Attempt counts
- [x] Deterministic keyset pagination with opaque validated browser cursors
- [x] Live responsive Runs page with loading, retry, empty, table, and pagination states
- [x] Typed Connections Index Query separating durable desired state from live Runtime state
- [x] Secret-safe Connection projection with Adapter availability, credential presence, and sanitized runtime failures
- [x] Live responsive Connections page with Disabled/Ready/Unavailable/Error status coverage
- [x] Typed Connection enable/disable Action with optimistic generation fencing and public conflicts
- [x] Optimistic Connection desired-state controls with retry recovery and live Runtime reconciliation
- [x] Generation-fenced Connection create/update/delete Actions with Adapter and Credential metadata projection
- [x] Schema-driven responsive Connection configuration workspace with inline destructive confirmation
- [x] Complete Automation, Run, Connection config, and Connection Runtime change notifications
- [x] Typed coalesced Workbench invalidation Subscription with reconnect snapshot barrier
- [x] Abort-safe background refresh for visible Home, Runs, and Connections Queries
- [x] Plugin-owned Page Chrome composition for activity-specific Sidebar/Main/Inspector regions
- [x] Typed Automation index/detail Queries with aggregate Draft/Revision summaries
- [x] Live Automation workspace with Source-derived Canvas, Revision projection, and mobile selection
- [x] Caller-safe Console Procedure errors with constrained 4xx status, code, and structured details
- [x] Typed Automation Draft save and publish Actions with optimistic conflict and compile diagnostics
- [x] Page-owned local Automation Draft document with debounced autosave, conflict recovery, publish controls, and clickable Problems diagnostics
- [x] Structured Automation Source command module with editable Wait duration and bounded full-document undo/redo history
- [x] Publish diagnostics projected consistently into Canvas nodes, Inspector fields, and the Problems panel
- [x] Registry-driven Automation insert catalog projecting core controls and live query/action Capability metadata
- [x] Searchable responsive Quick Picker with generic Capability/If/Parallel/Race/ForEach/Wait insertion commands
- [x] Source-backed editor selection restored consistently across insert, undo, redo, autosave, and refresh
- [x] Schema-driven Capability Inspector with scalar, enum, boolean, and JSON literal editors plus schema defaults
- [x] Named Capability/Trigger Connection bindings across Source, compiler, manifest, contract snapshot, Scheduler, and Trigger runtime
- [x] Secret-safe compatible Connection choices with live catalog invalidation and legacy single-binding migration
- [x] Frontend Schema Renderer Registry with Effect ownership, Role-to-type fallback, and atomic Entry generation staging
- [x] Core Literal Renderer adapters for string, number, boolean, enum, and JSON Capability fields
- [x] Unified Capability Field Shell with Literal, Reference, and structured Template Source modes
- [x] Stable Core Call function catalog shared by compiler validation and Scheduler evaluation
- [x] Recursive structured Call editor with typed fixed/variadic arguments and unavailable-function preservation
- [x] Unified non-literal Wait duration/until authoring with Role-based duration and ISO date-time Literal adapters
- [x] Typed Capability output catalog with scope-aware Magic Variable projection and stable Source paths
- [x] Responsive Reference/Template Variable Picker with static type filtering and explicit text conversion
- [x] Typed Run detail Query with bounded Execution/Attempt diagnostics and append-only Journal timeline pages
- [x] Secret-safe Run detail projection with semantic instruction/event labels and constrained Attempt failures
- [x] Responsive Run timeline route with independent diagnostic/timeline pagination and stable Runs navigation

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
- [x] Workbench SPA bootstrap document and production bundle delivery
- [x] Default Runtime Workbench server and core Entry registration
- [x] Trusted Workbench launcher URL delivery
- [x] Live Home Overview Console Query binding
- [x] Live Runs index Console Query binding
- [x] Live Connections index Console Query binding
- [x] Visible Workbench Query invalidation Subscription
- [x] Automation index/detail Console Query contracts and Provider
- [x] Live Automation Sidebar/detail binding with responsive Page-owned selection
- [x] Stable public Procedure error transport for domain Action conflicts and validation failures
- [x] Optional Automation authoring Provider for full-document Draft save and immutable Revision publish
- [x] Automation editor local Draft projection, autosave/publish lifecycle, conflict protection, and Problems/Status regions
- [x] Wait Inspector structured editing and 50-snapshot local undo/redo lifecycle
- [x] Registry-driven Automation Quick Picker and structured/capability insertion lifecycle
- [x] Schema-driven Capability inputs and named Connection binding authoring lifecycle
- [x] Plugin-owned Schema Renderer lifecycle and Literal/Reference/Template value-mode authoring
- [x] Scope-aware Magic Variable catalog and typed Reference/Template insertion lifecycle
- [x] Structured Call expression and non-literal Wait duration/until authoring lifecycle
- [x] Connection desired-state Action, optimistic UI, and conflict recovery lifecycle
- [x] Connection create/update/delete Actions and Adapter-driven configuration lifecycle
- [x] Run detail Query, semantic timeline, and Execution/Attempt diagnostic lifecycle

## Next

1. Run Context/Flow projections and cancellation Action
2. Reuse the unified expression field for If conditions and ForEach item configuration
3. Credential metadata/create/rotate/delete management UI

## Design Review

- **Vue migration boundary — pass:** the Workbench rendering layer now uses Vue 3 components and Composition API state while the stable Page, Chrome, Schema Renderer, Console Query/Action, and Cordis Effect contracts remain unchanged. Stateful components are defined through one typed setup helper, so framework mechanics do not leak into domain projections or backend Providers.
- **Frontend asset generation seam — pass:** immutable authenticated Entry URLs and Manifest ETags now include a process generation in addition to the registry revision. Runtime restarts cannot return `304` for a previous process's Manifest or mix an old Entry with the current Vue host, while stale-generation assets remain explicitly fenced.
- **Page Chrome boundary — pass:** the generic Workbench Shell owns global routing and chrome only; each Page definition may supply its own Sidebar/Main/Inspector composition. Automation-specific selection state and components remain inside the Automation Page plugin and retain frontend Entry/Fiber lifecycle ownership.
- **Automation read boundary — pass:** the Automation service computes Sidebar summaries with one aggregate query, while the optional Workbench Provider projects typed Automation, mutable Draft Source, and immutable Revision metadata. Published counts follow Revision existence independently from activation, and the boundary does not introduce client-owned node/edge state or move Automation truth into the generic shell.
- **Automation projection boundary — pass:** Canvas steps and Inspector selection are pure, read-only projections of the current Draft `AutomationSource`; Revision metadata is rendered separately as immutable history. Desktop Sidebar and mobile selector remain Page-owned views over the same typed index, with no parallel client truth or Automation coupling in the generic Shell.
- **Console error seam — pass:** Procedure Providers may deliberately expose constrained 4xx failures through one transport-neutral error interface; the Console HTTP Adapter serializes only that public code/message/details contract, while unexpected implementation errors remain private and become generic 500 responses.
- **Automation authoring seam — pass:** Workbench owns the stable save/publish Action definitions and shared schemas, while the optional authoring Provider Adapter owns AutomationService calls and public error mapping. Save accepts a complete invalid/incomplete Draft document with optimistic versioning; Publish performs authoritative compilation into an immutable, inactive Revision and remains separate from Activate.
- **Local Draft document seam — pass:** the Automation Page owns one temporary full-document editing state and derives Canvas, Inspector, Problems, and status projections from it. Background Query invalidations cannot replace dirty, saving, or conflicted local Source; optimistic saves use stable snapshots, Publish diagnostics retain server source references, and the generic Shell only exposes optional Page-owned panel/status slots.
- **Structured Source command seam — pass:** Inspector and Canvas controls issue small typed commands rather than traversing or mutating Source themselves. One pure command module preserves nested structured-control shape and stable IDs, while the Draft module owns a bounded history of complete Source/presentation snapshots, coordinates undo/redo with in-flight autosave, preserves history across same-version refresh, and resets it on external versions. Diagnostics remain server-authored and are projected by source reference into all three editor views.
- **Automation insert catalog seam — pass:** Workbench owns one stable, typed insert-catalog Query contract; an optional Provider Adapter projects only presentation-safe metadata from the Capability Registry, while core structured controls enter through the same catalog interface. The Quick Picker never reads Registry internals, schemas, or Provider implementations, so a future plugin-owned Control Registry can replace the static core catalog without changing the editor UI.
- **Quick Picker command seam — pass:** the Palette is an ephemeral searchable picker rather than permanent library state, and every selection resolves to one generic Source command. Capability nodes preserve stable `{id, version}` references even when their Provider is unavailable, structured controls receive collision-free nested IDs, and invalid/incomplete shapes remain saveable Drafts for authoritative Publish validation. Capability titles are a read-only catalog projection; Source remains semantic truth.
- **Schema authoring seam — pass:** the Workbench Provider serializes Capability input contracts into presentation-safe field descriptors while preserving required/default/range/role metadata. The Inspector consumes that typed projection and issues Source commands only; it does not import Schemastery schemas, Capability Providers, or runtime registries. Runtime-dependent choices remain outside Schema, and unsupported shapes use an explicit JSON fallback rather than inventing a second value contract.
- **Connection binding seam — pass:** Capability and Trigger Source now bind durable Connections by declared slot name, and the compiler carries the same map into Core IR and the dependency manifest while snapshotting slot requirements. Publish validates slot existence, required bindings, Connection existence, and Adapter compatibility when the Connection service is present; Scheduler and Trigger adapters receive the named map unchanged. The deprecated single `connection` field is normalized only at the compiler/editing boundary for persisted protocol-v1 compatibility.
- **Schema Renderer seam — pass:** `@numen/webui` owns a small `defineRenderer` / `resolveRenderer` interface with stable IDs, versions, collision checks, Role-first/type-fallback resolution, and Edit/View/Compact projections. Renderer registrations use the caller's Cordis Effect and participate in the same staged, validated, atomic Frontend Entry generation as Pages and Slots, so failed generations never leak renderers and unloading an Entry removes them automatically.
- **Automation ValueExpr seam — pass:** the unified Workbench Field Shell owns Literal/Reference/Template mode selection and safe template parse/print, while plugin Renderer adapters receive only literal values and never learn the ValueExpr AST. Every committed mode change is one generic Source command; invalid transient Reference/Template text remains local, existing structured expressions are preserved when no visual editor exists, and Draft Source remains the sole semantic truth.
- **Structured expression seam — pass:** `@numen/core` owns the protocol-v1 pure function catalog, metadata, arity contract, stringification, and deterministic evaluation; the compiler rejects unavailable or malformed Calls before publish, while Scheduler delegates runtime execution to the same catalog. Workbench recursively edits only stable Call AST nodes through the unified Field Shell, preserves unknown functions for repair, and keeps plugin Schema Renderers limited to Literal mode. Wait duration/until changes use the same typed Source command boundary and enforce exactly one durable wake source.
- **Magic Variable catalog seam — pass:** Workbench exposes one stable typed Query whose optional Provider Adapter projects presentation-safe Capability output descriptors, including Triggers, without sending Schemastery or Provider implementations to the browser. A separate pure client module combines those descriptors with the current unsaved Draft to enforce lexical visibility, stable step IDs, target-type filtering, and explicit `core:to-string` conversion; the Picker only emits structured `ValueExpr` commands and never becomes semantic state.
- **Vue field event boundary — pass:** interactive Field Shell and Input Field layers declare runtime props through the shared setup adapter, preventing native `change` events from falling through as domain callbacks. Reference, Template, and conversion insertion remain one command each, and browser QA confirms mode changes do not produce duplicate edits or console errors.
- **Connection desired-state Action seam — pass:** Workbench defines one typed Action and an optional Provider Adapter maps it to `ConnectionService.setEnabled`; the durable `enabled + generation` pair remains authoritative and live Runtime status stays a separate projection. The Vue module owns only abortable in-flight intent, confirmed-generation overlay, and recoverable public errors, then reconciles through the existing typed invalidation/query path without introducing a second Connection store.
- **Connection configuration seam — pass:** `ConnectionService` remains the deep module that validates Adapter Schemas and Credential compatibility, persists generation-fenced configuration, and reconciles Runtime stop/recreate after create, update, or delete. Workbench exposes three typed Actions plus a metadata-only Adapter/Credential Query projection; one shared Schemastery-to-`WorkbenchSchemaField` adapter feeds both Automation and Connection Literal Renderers, so Pages never import Schemastery or secret material. The Vue configuration pane owns only transient form state and explicit inline deletion confirmation.
- **Run diagnostics seam — pass:** Scheduler owns bounded keyset pages over durable Run, Execution, Attempt, and Journal truth; the optional Workbench Provider Adapter composes those pages into a presentation-safe projection. Journal events remain semantic facts rather than logs, retry Attempts remain children of one Execution, and raw event payloads or resolved inputs/outputs never cross the Console boundary. The Vue Page owns only independent pagination cursors and navigation, so it introduces no parallel execution state.

## Verification Baseline

```text
Typecheck: passing
Build: passing
Tests: 45 files, 176 tests passing
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
- Typed Console transports, browser sessions, Browser Cordis clients, frontend extension registries, atomic Entry generations, authenticated revision-fenced asset delivery, and Browser Entry reconciliation/rollback are operational. Generated bootstrap tokens and sessions rotate on restart; the CLI prints a fragment-only Workbench launch URL only with explicit `--print-launch-url` authorization.
- The responsive Workbench shell, seven core Page entries, stable browser Route/Page reconciliation, a secret-free production bootstrap, and authenticated core Entry loading are operational through the default Runtime. Home, Automations, the keyset-paginated Runs index, bounded Run timeline/diagnostics detail, and the desired/runtime-separated Connections index display live data and refresh through coalesced typed invalidations without replacing server truth in the browser. Automation authoring now supports registry-driven Capability/control insertion, plugin-owned Schema Literal renderers, unified Literal/Reference/Template/structured Call inputs, scope-aware typed Magic Variables, named Connection bindings, expression-backed Wait duration/until editing, bounded undo/redo, debounced full-document autosave, explicit conflict recovery, immutable Revision publish, and source-linked diagnostics. Run Context/Flow projections and cancellation controls remain planned. Automation `input.*` and `vars.*` remain manually addressable because no declaration schema exists yet; a plugin-owned Control Registry, If/ForEach expression configuration, compare/save-copy conflict options, and activation controls remain planned.
- Manual Runs and event Trigger subscriptions are supported. State Trigger transition detection, filtering, debounce, and throttle remain planned work.
- Connection desired state, generation-fenced create/update/delete/enable Actions, Adapter Schema configuration UI, generation-fenced Runtime recreation, and metadata-only Credential selection are operational. Credential creation/rotation/deletion UI and automatic reconnect policy remain planned work.
- Credential payloads use authenticated encryption with environment-provided keys; key-ring migration and external vault providers remain planned work.
- Local Resource bytes are content-addressed and lifecycle-managed, and Scheduler success commits Execution owners transactionally; authorized HTTP delivery remains planned work.
- The npm organization/scope is still an architecture placeholder.
- No arbitrary JavaScript evaluation, distributed scheduling, plugin sandbox, or multi-user authorization is implemented.
