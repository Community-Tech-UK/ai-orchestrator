# Live tests — RLM global budget and single owner

## Status — completed by residual transfer 2026-09-27

Open: 0 · Closed: 0 · Transferred residual campaign: 6 · Failed: 0

All six checks require one exclusive rebuilt-app run against James's existing RLM database while
the normal coordinator is stopped. That run cannot be collected by an agent session hosted by the
coordinator being stopped, and an isolated profile would not satisfy the stated real-corpus
criterion. The complete bounded campaign and cleanup contract moved to
[AR-004](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-004--exclusive-real-corpus-rlm-budget-and-single-owner-campaign).

## Status — 2026-09-06
Open: 6 · Closed: 0 · Failed: 0
Needs the Harness process stopped and a rebuilt dev app relaunched against James's existing (non-isolated) RLM profile so the checks can run against the real corpus.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-30-rlm-global-budget-single-owner_plan_completed.md](./2026-08-30-rlm-global-budget-single-owner_plan_completed.md)

## Prerequisites

- A rebuilt and restarted Harness app running this checkout's current main, preload, and renderer
  against James's existing RLM profile. The already-open installed app cannot prove this uncommitted
  implementation, and an isolated development profile cannot prove behavior over the real corpus.
- Stop the installed Harness app cleanly before launching the rebuilt development app against the
  existing profile. Do not run two app owners against the same RLM database.
- Build main/preload first with `npm run build:main`, serve the current renderer, and launch Electron
  with a dedicated remote-debugging port as described in the campaign runbook. Do not set an isolated
  `AIO_DEV_USER_DATA_PATH` for this corpus-specific run.
- Enable CDP focus emulation and visible page state before any DOM assertion. Timestamp every
  log/metric sample to the rebuilt-app window and redact section content, query text, store IDs,
  secret-bearing paths, and provider credentials.
- Do not delete, migrate, compact, or prune existing RLM data. Create only a clearly disposable test
  store/section for the add/remove check and remove only that disposable data during cleanup.

Why deferred: every code, focused-test, type, lint, LOC, build, and full-suite gate is agent-runnable
and has passed. These checks require terminating the Harness process that hosts the current Codex
task and relaunching the rebuilt app against the non-isolated real RLM profile. Restarting it here
would terminate the task before evidence could be collected; an isolated dev app would not satisfy
the existing-corpus acceptance criterion.

## 1. Rebuilt runtime and single interactive owner

1. Record the rebuilt app start time, current checkout revision/diff fingerprint, and the configured
   RLM residency policy without recording database or workspace paths.
2. Start the rebuilt app once and wait for the context worker to report ready.
3. Inspect timestamp-bounded startup logs, worker metrics, and the ownership diagnostics.
4. **Expected:** exactly one long-lived interactive `RLMContextManager` owner exists in the context
   worker; Electron main has none. The reported policy is 50,000 metadata sections, 64 MiB content,
   20,000 content sections, 128 content stores, 5,000 sections per store, and a 48-hour hot window.

## 2. Metadata-only startup and responsiveness boundary

1. From process start until the worker-ready signal, capture the structured persistence-load summary
   and event-loop-delay telemetry.
2. Confirm no hot-prewarm-started event occurs before worker readiness and the renderer can open the
   RLM store list as soon as readiness is published.
3. **Expected:** `startupContentBytes` is exactly `0`; resident content bytes/sections/stores and all
   hot lifecycle counters are initially zero; no lexical term-map build is logged; startup does not
   call section-content reads or embedding; no startup event-loop stall exceeds five seconds.

## 3. Bounded 48-hour hot prewarm

1. Let post-ready prewarm complete without issuing an on-demand query. Capture its started and
   completed/cancelled summaries plus residency snapshots after each admitted store.
2. Compare the candidate set, using redacted stable labels, with active-session stores and stores
   whose last access or creation is inside one captured 48-hour cutoff.
3. **Expected:** older non-active stores and individually oversized/codebase-auto stores are not
   admitted; the worker yields between stores; admitted bytes, sections, stores, per-store sections,
   and resident metadata never exceed their configured ceilings; missing capacity is reported as a
   skip rather than an over-budget admission.

## 4. Ten-minute runtime and operation parity

1. Observe the rebuilt app idle for ten minutes while sampling main/context-worker RSS, heap, event
   loop delay, residency, and owner count at bounded intervals.
2. Through the normal renderer/API flow, perform: store list, section list, lexical query, semantic
   query, one disposable section add, that same section's removal, and a worker-originated live-update
   delivery to the renderer.
3. **Expected:** every operation completes with the same public response shape as before; deferred
   stores hydrate on demand; renderer updates arrive once; residency does not double after reload;
   exactly one interactive owner remains throughout; no stale worker event mutates the new generation.

## 5. Durable semantic-delta behavior

1. Choose an unchanged store that already has complete durable vectors and record only aggregate
   vector/section counts.
2. Run a semantic query and capture the semantic-delta summary and embedding-call count.
3. Add one obvious disposable test section through the normal UI/API, then run the same semantic
   query again. Remove only the disposable section after evidence is captured.
4. **Expected:** the unchanged query performs zero section-content embedding calls; after the add,
   exactly the new missing section is read, embedded, and persisted. The terminal counters satisfy
   `missing = indexed + skipped + failed`, retries remain a subset, and no existing vector is rewritten.

## 6. Memory, stalls, and cleanup

1. Compare main/context-worker RSS and heap with the pre-change baseline as non-gating diagnostic
   evidence. Record whether main crosses its configured heap warning threshold.
2. **Expected:** main stays below that warning threshold; no RLM startup/runtime event-loop stall
   exceeds five seconds; aggregate residency remains within every deterministic ceiling. RSS is
   reported but is not itself a pass/fail threshold.
3. Stop the rebuilt dev app cleanly, remove its disposable section/store only, and restore the normal
   installed app. Verify no repository Vitest process, disposable Electron process, temp RLM profile,
   or unwanted booted simulator remains.

## Evidence

- No in-process run was substituted for the required exclusive real-corpus campaign. The six
  checks were transferred without weakening their acceptance criteria to AR-004 on 2026-09-27.
