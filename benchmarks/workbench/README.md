# Workbench capacity baseline

This is an opt-in production-browser workload for N4-03. It does not run inside
the ordinary unit or browser suite. It publishes only temporary fixture Revisions
to check immutability, leaves Automations inactive, and never contacts external
integrations or uses the user's database/configuration.

```sh
pnpm bench:workbench
node benchmarks/workbench/summarize.mjs /tmp/numen-workbench-benchmark
```

Run serially on an otherwise quiet machine. `bench:workbench` builds the product,
typechecks this harness, then starts isolated temporary Runtime/SQLite instances
and a single Chromium worker. Reports and screenshots go to
`/tmp/numen-workbench-benchmark`; set `NUMEN_BENCH_OUTPUT` to retain another run.
Browser plugin is not available in the implementation session, so the repository's
installed Playwright/Chromium is used. No additional browser dependency is needed.

The fixed data consists of 100/300/1000 ControlSource nodes including the root and
structural slots, with maximum depth 6 (`root=0`), literal/reference/template/call
expressions, If/ForEach and three-way Parallel/Race branches. A separate annual
Trigger is counted explicitly and remains disabled. The 100/300 configuration
trees include all Runtime infrastructure instances and 18 groups arranged in
three six-level chains. All fixture instances are real schema-backed local
plugins; all groups start expanded. **1000 nodes is a pressure probe, not an
official supported capacity.**

## Measurement contract

- **First route ready:** three new browser contexts, HTTP cache disabled. Time
  starts at `performance.timeOrigin` and ends after the required enabled control
  is rendered and two animation frames pass. An immediate real selection verifies
  usability afterward. This is a route-ready proxy, not the browser TTI metric;
  it excludes Runtime startup and does not time first Inspector interaction.
  Preserve all three values and report median/maximum, not a reliable tail estimate.
- **Interactions:** one warm-up excluded from percentiles and 20 measured samples per
  operation. Document capture observes real pointerdown or **blur** before app
  handlers. The end is matching DOM state plus two animation frames, recorded
  inside the page. Locator setup, pre-scrolling, test-runner polling/IPC and later
  correctness assertions are outside the timing interval. There is no CPU/network
  throttling. Report nearest-rank P50/P95 and retain raw samples.
- **Draft field commit:** blur through the rendered DIRTY/pending-cleared state.
  Readiness is latched because the existing 600ms autosave timer can advance it.
  Each sample then waits for CLEAN and verifies the actual saved Source and one
  request. Network response duration is reported separately and excludes the
  debounce interval; do not describe local commit time as save latency.
- **Plugins:** local schema-field blur updates canonical JSON without writing.
  A separate series performs real Preview/Apply, times Apply to the newly rendered
  saved result, and verifies the response plus complete YAML after every sample.
  Write counts mean Apply requests/saved responses/verified YAML transitions,
  not filesystem syscall counts. Deep-link location uses the supported `entryId`
  document navigation (cache disabled, existing session) and is reported separately
  from Automation's in-page hidden-node location.
- **Resource lifecycle:** warm up a round trip, then perform ten editor/Home or
  Plugins/Home round trips. Compare the same fully loaded Home state after forced
  GC at every round. CDP reports heap bytes, documents, DOM nodes and event listeners;
  current document element counts are a separate measure. Browser subscription
  counts require server ACKs; pending/closing must settle. The Runtime's existing
  Console registry and Server WebSocket clients are read without adding endpoints.
  Unsupported instrumentation fails the workload instead of becoming a zero.
  Stable counts over ten rounds do not prove absence of all leaks.
- **Long tasks:** retain each document's startTime/duration and measured intervals.
  Whole-workload totals include setup, waits, correctness guards and GC, not just
  timed interactions. Interval overlap is an observation, not proof of causation.
  Independent cold/deep-link documents have separate time axes.

Each result includes machine/Node/Chromium information, product source HEAD and a
hash of the actual production assets. Results from mixed builds or environments
must not be merged. Temporary verification archives should pass their exact base
as `NUMEN_BENCH_SOURCE_HEAD`; an actual Git checkout records its live HEAD and
tracked dirty paths. Bootstrap URLs, Cookies and plugin configuration values are
not report metadata.

## Correctness and diagnostic runs

Timing samples still require real outcomes: selection must leave the Draft clean,
hidden targets must actually be folded before locating, each fold/locate must save
once, and location must preserve Source. Large fixtures also exercise Undo/Redo,
pending invalid JSON with rejected navigation, IME and keyboard focus, scrolling,
published Source immutability and desktop/mobile rendering. Plugin input guards
and unchanged active-instance counts remain mandatory.

For harness diagnosis only, reduce `NUMEN_BENCH_SAMPLES`,
`NUMEN_BENCH_COLD_TRIALS`, and `NUMEN_BENCH_LIFECYCLE_ROUNDS` (positive integers).
Such runs are not accepted by the formal summarizer. Later-stage failures retain
partial metrics marked `outcome: failed` and still fail Playwright; missing or
failed cases cannot become a successful baseline. Ordinary regression tests remain
the authority for conflicts, snapshots, response loss and restart recovery.

See the dated [N4-03 verification](../../docs/verification/workbench-capacity-2026-10-08.md)
for measured values, frozen local regression budgets, limits and the next diagnostic
step. Performance budgets apply to the recorded environment, not every machine.
