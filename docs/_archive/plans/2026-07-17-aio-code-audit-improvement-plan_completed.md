# AIO Code Audit & Improvement Plan — 2026-07-17

**Status:** IMPLEMENTED and agent-verified 2026-07-17. Rebuilt-app/provider checks remain in the linked live-test document.

**Recorded decisions (review `2026-07-17-aio-code-audit-improvement-plan`):**
- Decision 1 (heartbeat): **(a) log and notify only** — no auto-reload.
- Decisions 2/3/4 (orphan primitives): **delete** `policy-engine.ts`, `authority-lease.ts`, `dispatch-log.ts` (+ specs).
- Decision 5 (legacy output-cache migration): **verify the migration ran, then delete**.
- Decision 6 (phase order): **recommended order approved** — 0 → 1 → 2 → 3 → (4+5 interleaved) → 6.
- All phase sections approved without changes.

**Final verification (2026-07-17):** both TypeScript configurations, repository lint, and the TypeScript max-LOC ratchet pass. The final full suite passes 1,524 files / 14,983 tests in 583.7 seconds. Rebuilt-app and real-provider checks are recorded in [the live-test plan](./2026-07-17-aio-code-audit-improvement-plan_livetest.md).
**Scope:** Whole repo (~600k LOC non-test source: 395k main process, 146k renderer).
**Method:** Seven parallel read-only audit agents (dead code, complexity, main-process stability, renderer, IPC/contracts, persistence, tests/build), each requiring file:line evidence. Two load-bearing Phase-0 claims re-verified by hand (marked ✓ below). All other findings are evidence-cited by the audit but MUST be re-verified/reproduced at implementation time per repo rules — treat each plan item as "verify, then fix."

**Explicitly out of scope (already done or in flight — do not redo):**
- The ~20 pending `*_livetest.md` docs (code-complete work awaiting live validation).
- In-flight browser-gateway console/network capture work (staged/modified in the tree).
- The conversation-ledger/code-search worker offloads (verified healthy by this audit).

---

## Headline verdict

The codebase is in better shape than its size suggests. Genuinely dead code is small (~1k LOC). Persistence is largely healthy (WAL, transactions, retention, caps all verified). The real leverage is in four places:

1. **Renderer stability** — the 7-hour-freeze class of bug is still fully possible: no heartbeat, no virtual scrolling, uncached markdown rendering on the hottest component, ~65 unprotected subscriptions.
2. **One live memory leak** — provider-limit park entries survive instance termination (park/resume has been ON since 2026-07-10, so this is accumulating now).
3. **IPC inconsistency** — three incompatible error-response patterns, ~40–50 handlers without payload validation, events with no schemas. A gold-standard `register()` pattern already exists (desktop/browser gateway) — the fix is convergence, not invention.
4. **Two god files** (`loop-coordinator.ts` 3,871 LOC, `codex-cli-adapter.ts` 3,269 LOC) whose cores have no direct spec coverage.

Counter-finding worth noting: `instance-manager.ts`, `session-continuity.ts`, and `base-cli-adapter.ts` look huge but are well-factored — **leave them alone**.

---

## Phase 0 — Quick wins (≈half a day total, near-zero risk)

> **As-built 2026-07-17:** all five items implemented and verified. Item 1: only `vitest.config.ts` needed the glob (`tsconfig.spec.json` already covered `src/**/*.test.ts`); all 18 dark files passed with zero rot (174 tests). Item 2: implemented as `InstanceProviderLimitHandler.release()` called from the termination coordinator; single terminate cancels durable resume automation, while bulk shutdown preserves it. Item 4 now enforces `no-console` (warn/error allowed, narrow diagnostic overrides), `no-debugger`, and underscore-aware unused-variable checks. Item 5 also fixed the connection-phase error listener surviving successful connect, added a destroy fallback on close, and split `app-server-process-utils.ts` out of `app-server-client.ts`. Phase 3's migration precondition was verified from recent startup logs before deletion.

1. **Wire `src/tests/**` into the test suite.** ✓ Verified: `vitest.config.ts` include globs omit `src/tests/`; 18 `*.test.ts` files there (memory, knowledge-graph, RLM persistence) never run in `test:quiet` or CI. Add the glob to `vitest.config.ts` and `tsconfig.spec.json`, then fix whatever those 18 tests surface (they may have rotted while dark).
2. **Fix the provider-limit park leak.** ✓ Verified: `instance-provider-limit-handler.ts:117-118` Maps (`parked`, `lastResumeAt`) are only cleared on resume/cancel; `instance-termination.ts` never calls `cancel(instanceId)`. Terminating a parked instance leaves a zombie entry with live timer callbacks. Add cleanup to the termination coordinator + a spec for terminate-while-parked.
3. **Add `busy_timeout = 5000` to `operator-database.ts:35`** — the only DB missing it (all others verified set). Prevents SQLITE_BUSY under concurrent access.
4. **ESLint hygiene rules** — `no-console`, `no-debugger`, `@typescript-eslint/no-unused-vars` (currently Angular defaults only). Run `npm run lint`, fix fallout or scope the rules.
5. **`SocketAppServerClient` listener cleanup** (`codex/app-server-client.ts:458-473`) — `removeAllListeners()` on close, `.once()` for one-shot handlers. Small leak per failed connection on flaky networks.

**Gate:** canonical verification checklist (tsc, tsc spec, lint, ts-max-loc, test:quiet).

---

## Phase 1 — Renderer stability (the freeze-killer phase, ≈4–6 days)

> **As-built 2026-07-17:** items 6, 7, 8, and 10 are implemented; item 9 was already fixed. For item 7, variable-height transcript rows made literal CDK virtualization unsuitable without a measurement layer, so normal streaming now uses a tested per-instance trailing render window (250 items, expandable in 250-item steps). Find, jump, scroll-edge, and stored-history loading reveal earlier content on demand; normal streaming DOM stays bounded. The window state was extracted to `OutputStreamRenderWindow` to keep the legacy component within its LOC ratchet. Rebuilt-app DOM-count and scroll-restoration inspection is deferred to [the live-test plan](./2026-07-17-aio-code-audit-improvement-plan_livetest.md).
> - **Item 6 (heartbeat, Decision 1 = log-only): built.** `RendererHeartbeatService` (renderer, 2s beats from the UI main thread, started via `provideAppInitializer`) → `renderer:heartbeat` send channel → `RendererHeartbeatMonitor` (main): logs one error at stall start (≥10s gap while the webContents is alive), one warn with duration + missed-beat count at recovery; watchdog unref'd; destroyed renderers pruned silently. 15 new specs across monitor/handlers/service.
> - **Bonus fix found during item 6:** the `log:message` channel had NO main-process handler — the renderer ErrorHandler's error forwarding has been silently failing the whole time. New `registerRendererTelemetryHandlers` wires LOG_MESSAGE (Zod-validated → main logger under `Renderer` subsystem) and the heartbeat listener.
> - **Item 10 (interrupt-respawn A7): verified already fixed** — `respawnPromise` is assigned synchronously inside `interrupt()` (interrupt-respawn-handler.ts:399), dispatchRecoveryActions captures it immediately with a generation fence + interruptSeq fence + fresh-adapter re-fetch (instance-lifecycle.ts:3396-3426); covered by existing specs. No change.
> - **Item 7 markdown memoization: already implemented** (`MarkdownRenderCache` LRU keyed by message id + incremental new-item-only rendering in `displayItems`). Audit finding was stale. Virtual scrolling remains open → deferred bucket.
> - **Item 9 (instance-detail IPC race): already fixed** (stale-resolve guard at instance-detail.component.ts:309). No change.
> - **Item 8 subscription sweep:** completed with lifecycle-safe teardown on the previously unprotected subscriptions.

6. **Renderer heartbeat + freeze detection.** The renderer has an ErrorHandler and unhandledrejection capture but nothing detects a silent freeze — exactly the 7-hour incident mode. Add a 1–2s renderer→main heartbeat; on missed-heartbeat threshold, main logs telemetry (and optionally offers renderer reload). This also gives future freeze incidents a diagnosis trail.
7. **Output-stream performance** (`output-stream.component.ts`, 1,297 LOC — on screen 100% of active sessions, prime freeze suspect):
   - Memoize markdown rendering keyed by message ID (currently re-rendered inside the `displayItems` computed on every message change).
   - CDK virtual scrolling — today every message in a session is a live DOM node; 1,000+ message sessions degrade linearly.
   - Audit its 10 effects / 6 rAF calls for batching.
8. **Subscription leak sweep.** 78 `.subscribe()` calls, only 13 protected with `takeUntilDestroyed()`. Bulk-fix the ~65 unprotected ones (mechanical; instance.store, voice services, diagnostics panels are the hotspots).
9. **`instance-detail` IPC race** — an effect fires `listSessionSnapshots` per instance switch with no abort/race guard; rapid switching queues stale responses. Move to a service method with abort token.
10. **Re-verify and fix the interrupt-respawn race** (the known "respawnPromise undefined when dispatchRecoveryActions awaits" finding from the Phase-1 review). Reproduce first; fix in `interrupt-respawn-handler.ts`.

**Gate:** canonical checklist + real-UI check in the dev app (seed InstanceStore, stream a long session, verify DOM node count stays bounded and heartbeat events flow).

---

## Phase 2 — IPC hardening (≈4–5 days, mostly mechanical)

> **As-built 2026-07-17:** complete. All priority registrations meet the boundary contract (Zod validation where payload-bearing, structured `IpcResponse`, trusted-sender guard); raw-response inventory is zero. `verify:ipc` enforces handler contracts, the transport schema registry and strict `verify:renderer-events` cover the static main→renderer inventory, unreachable channels were removed after four-layer tracing, and the final contracts → handler → preload → caller audit is clean. The migration also fixed watcher integration drift (wrong event names, return shape, and dropped error detail).

11. **Converge all handlers on the gold-standard `register()` pattern** (as used by desktop-gateway/browser-gateway handlers: Zod validation + consistent `{ success, error: { code, message, timestamp } }` envelope + trusted-sender check). Priority order: session handlers (`SESSION_RESUME`, `SESSION_CREATE_SNAPSHOT`), RLM/learning handlers (raw unvalidated string params driving DB writes), memory handlers. ~40–50 handlers currently unvalidated; ~20–30 use an incompatible string-error shape.
12. **Enforce it going forward** — lint rule (or a typed `registerHandler` helper that's the only allowed way to call `ipcMain.handle`) requiring `IpcResponse<T>` returns.
13. **Event payload schemas** for main→renderer `_EVENT`/`_CHANGED` sends (e.g. `REMOTE_NODE_NODES_CHANGED` currently sends an unvalidated, untyped payload).
14. **Close the orphan-channel gaps:** remove or wire `WORKFLOW_*` and `AUXILIARY_LLM_INITIALIZE/SHUTDOWN` channels; add missing preload exposure for `MEMORY_R1_*`, `RLM_EXECUTE_QUERY`, `OBSERVATION_FORCE_REFLECT/CLEANUP`; re-run the four-layer diff (contracts → handler → preload → renderer caller) on browser channels to confirm the past gap is fully closed.

**Gate:** canonical checklist + the four-layer inventory diff re-run clean.

---

## Phase 3 — Dead code & shims (≈1–2 days once decided)

> **As-built 2026-07-17:** complete. Deleted the three approved orphan primitives and their specs; deleted the verified no-op legacy output-cache migration path and removed its initialization/store/client/worker references; migrated Claude adapter error emission to `ErrorRecoveryManager` and deleted `cli-error-handler.ts`. `verification-cache.ts` and `confidence-analyzer.ts` remain unchanged as planned.

15. **DECISION NEEDED (answer by number):** the three test-only orchestration primitives, all deliberately unwired to date. For each, pick **(a) delete now**, **(b) keep parked as-is**, or **(c) create a wiring spec**:
    - 15.1 `policy-engine.ts` (128 LOC + spec) — rule-combinator engine for orchestration policies.
    - 15.2 `authority-lease.ts` (117 LOC + spec) — lease registry so only one agent at a time holds authority over a resource.
    - 15.3 `dispatch-log.ts` (121 LOC + spec) — idempotent agent-handoff log.
    My recommendation: (a) delete all three — they're preserved in git history and can be restored if a wiring spec ever materializes; dead-but-tested code still costs maintenance on every refactor.
16. **Legacy output-cache migration trio** (~270 LOC: `legacy-output-cache-ledger-store.ts`, `-reconciler.ts`, `-initialization.ts`) — one-shot startup migration. Verify from logs/DB that migration completed on your live instances, then delete.
17. **`cli-error-handler.ts` deprecated shim** (102 LOC) — migrate adapter callers to `ErrorRecoveryManager`, then delete.
18. Keep `verification-cache.ts` / `confidence-analyzer.ts` (single-caller but working; inlining is optional churn — skip unless touching multi-verify anyway).

---

## Phase 4 — Complexity refactors (highest ROI, do tests-first, ≈2–3 weeks spread out)

> **As-built checkpoint 2026-07-17:** complete. For item 19, `LoopLifecycleStateManager`, `LoopCompletionContextStore`, `LoopPreIterationGuard`, and `LoopBlockedFileHandler` now own the planned state/branches; the coordinator dropped 131 net lines and its runtime source contains no `any` annotations. Existing coordinator-level E2E/state-machine coverage was broader than the audit claimed, so focused class contracts were added and the complete coordinator suite was run rather than adding a redundant monolithic fixture. For item 20, the 3,269-line `CodexCliAdapter` is now a 158-line compatibility façade over `CodexBaseAdapter`, `CodexExecAdapter`, and `CodexAppServerAdapter`; bounded app-turn/notification layers and transactional initializer/process-runner helpers keep every new production file within the 700-line limit. The factory contract covers all three public layers, automatic app-server detection remains spawn-time behavior, and hardened mode still forces exec fallback. For item 21, `InstanceContinuityInputQueue` owns one-shot continuity/context-warning delivery and `InstanceToolResultProcessor` owns tool-result deduplication, parsing, evidence ingress, lifecycle hooks, and checkpoint counters; focused contracts plus the existing communication integration suite protect ordering, cleanup, and evidence-key parity. For item 22, `ModelSelectionResolver` now owns provider/model precedence, dynamic Codex model IDs, tier resolution, and degradation metadata, while `InstanceSpawnPreflightChain` owns warm/fresh selection, execution location, local-model validation, remote MCP scrubbing, and local codemem warm-up; the existing `SessionRecoveryCoordinator` already kept native-resume and replay-fallback orchestration separate. For item 23, the existing generic NDJSON parser/backoff primitives were retained and adapter-facing `CliStreamLineParser` and `CliRetryCoordinator` contracts were added; Codex app-server framing and thread start/resume retries now consume them with the existing 5s/15s policy preserved. For item 24, autocomplete was already a child component, so the remaining keystroke-risk was moved into a per-composer debounced, stale-result-fenced service and the inline queue was extracted into `ComposerQueueComponent`; the parent template dropped 54 lines and its stylesheet dropped 185. Canonical gates are green; the real-app loop, dual-mode Codex, and input-panel interaction smokes are deferred to [the live-test plan](./2026-07-17-aio-code-audit-improvement-plan_livetest.md).

Ordered by (win ÷ risk). Each item: write/extend the protective spec BEFORE moving code.

19. **`loop-coordinator.ts` (3,871 LOC, 18+ state Maps, ~800-line `runLoop`).** First write a coordinator-level integration spec for the state machine (currently only helper specs exist — the biggest test gap in the repo). Then extract: `LoopLifecycleStateManager` (active/cancel/pause/cleanup Maps), `LoopCompletionContextStore` (histories/convergence/downshift), `LoopPreIterationGuard` (pause/cancel/cap/maintenance pre-flight), `LoopBlockedFileHandler`. Target: `runLoop` readable end-to-end; no behavior change.
20. **Split `codex-cli-adapter.ts` (3,269 LOC)** into `CodexBaseAdapter` + `CodexAppServerAdapter` + `CodexExecAdapter` behind a factory. The two modes are near-separate implementations forced into one class with runtime branching. Existing specs move with their mode.
21. **`instance-communication.ts` (2,622 LOC, 8 Maps):** extract `InstanceToolResultProcessor` (tool parsing, dedup, evidence ingress) and `InstanceContinuityInputQueue` (pending preambles/warnings).
22. **`instance-lifecycle.ts` (3,442 LOC):** extract `ModelSelectionResolver` and spawn pre-flight chain; consider separating native-resume vs replay-fallback orchestration (currently interleaved).
23. **Shared CLI adapter utilities:** `CliStreamLineParser` (NDJSON buffering/deframing, currently re-implemented per adapter) and `CliRetryCoordinator` (backoff + error classification). ~2,800 LOC of cross-adapter duplication shrinks over time as adapters adopt them. Low risk — additive.
24. **`input-panel.component.ts` (1,737 LOC, 39 computeds/effects):** extract autocomplete into a service with debounced queries; split child components. Fixes keystroke-lag risk.
25. **Do NOT refactor:** `instance-manager.ts`, `session-continuity.ts`, `base-cli-adapter.ts`, `interrupt-respawn-handler.ts` (beyond item 10's race fix) — audited as cohesive; splitting them is churn without payoff.

**Gate per item:** targeted specs green before and after, canonical checklist, and for 19/20 a real-app smoke (run a loop; run a codex session in both modes).

---

## Phase 5 — Test coverage where regressions actually ship (ongoing, interleave with 4)

> **As-built 2026-07-17:** complete. Item 26 adds schema-invalid and happy-path coverage for all eight previously uncovered handler modules in one boundary-focused suite (16 tests). Item 27 extends the lifecycle integration contract through create→ready→terminate and a concurrent create/terminate race; those tests exposed and fixed two real cleanup bugs: terminal transition could recreate a deleted state machine, and termination could finish before in-flight RLM initialization settled, allowing post-termination resources to spawn. Termination now aborts and awaits pending initialization before cleanup, and state-machine deletion happens after the terminal transition. Item 28's targeted runtime inventory is clean: the coordinator and split Codex adapter sources contain no `any` annotations (remaining text matches are prose only).

26. **IPC handler specs** — the worst-covered subsystem (~33%). Eight handler files have zero specs (lsp, wake-context, parallel-worktree, consensus, conversation-mining, remote-observer, snapshot, task handlers). Phase 2's `register()` migration makes these cheap: one schema + happy-path + invalid-payload test each.
27. **`instance-lifecycle` integration specs** — consolidate the fragmented lifecycle tests into create→ready→terminate, concurrent create+terminate, and spawn-transaction-failure cases.
28. **`any` debt, targeted only:** 1,268 uses repo-wide is not worth a campaign; fix the 16 in `loop-coordinator.ts` during item 19 and the adapter ones during item 20/23. Skip the rest.

---

## Phase 6 — Perf & polish (≈2–3 days, low risk)

> **As-built 2026-07-17:** implementation and focused verification complete. Item 29 adds one-query CAS batch hydration, caps context restoration at 5,000 rows and episodic section scans at 10,000 rows, and stages evidence with one idempotent `INSERT ... SELECT ... ON CONFLICT ... RETURNING` statement. Item 30 consolidates the six independent renderer timers behind `RendererPollSchedulerService`, preserving page cadences while using one shared interval and preventing overlapping task executions. Item 31 used Angular's official signal-input and output migrations, then manually converted the 26 stateful setter inputs; production now has zero `@Output` decorators and only the two approved composer `@Input` exceptions. Vitest now applies Angular's compiler-provided JIT transform so signal-input metadata is registered in component tests; 12 affected suites / 125 tests pass. Item 32 exports throttled aggregate performance summaries and budget violations through the existing validated renderer logging IPC without forwarding arbitrary entry metadata.

29. **Persistence micro-fixes:** batch the N+1 `getChunk()` loop in `workspace-chunk-search.ts:54`; add limit guards to `getSections()` callers (`context-persistence-loader.ts:29`, `episodic-rlm-store.ts`); make evidence staging single-pass (`context-evidence-ledger-store.ts:79-99` currently does check → insert → re-fetch per tool output).
30. **Renderer polling → event-driven:** six page components poll at 1–10s intervals independently (cost, plan, worktree, training, loop panels). Replace with IPC push events or one shared poller.
31. **`@Input`/`@Output` migration:** 144 decorator usages across 25 files → signal `input()`/`output()` APIs (voice/composer deviation stays per prior decision). Mechanical codemod + spot checks.
32. **Perf telemetry export:** `perf-instrumentation.service.ts` records metrics locally but never exports; forward to main-process logs so the next freeze/jank report has data.

---

## Sequencing & effort summary

| Phase | Theme | Effort | Risk |
|-------|-------|--------|------|
| 0 | Quick wins (incl. live leak fix) | ~0.5 day | Minimal |
| 1 | Renderer stability / freeze prevention | 4–6 days | Low-Med |
| 2 | IPC hardening | 4–5 days | Low (mechanical) |
| 3 | Dead code (needs decision 15) | 1–2 days | Minimal |
| 4 | God-file refactors | 2–3 weeks, interleavable | Medium — tests-first |
| 5 | Coverage backfill | ongoing | Minimal |
| 6 | Perf & polish | 2–3 days | Low |

Phases 0–3 are independent and can each ship alone. Phase 4 items are individually shippable; 19 and 20 are the two that most need their protective specs written first. Recommended order: 0 → 1 → 2 → 3 → (4+5 interleaved) → 6.

One operational note: loop agents from the live app edit this repo and commit on shutdown — before any multi-file campaign (Phases 2/4), check for in-repo writers.

---

## Open decisions for James (answer by number)

- **15.1 / 15.2 / 15.3** — delete, keep parked, or spec-and-wire each orphan primitive (recommendation: delete).
- **16** — approve deleting the legacy output-cache migration code once its completed run is confirmed.
- **6** — heartbeat only (log + telemetry), or heartbeat + automatic renderer reload on sustained freeze? (Recommendation: log-only first; auto-reload behind a setting.)
- **Priority** — approve the phase order above, or promote a specific phase (e.g. if freezes hurt most, Phase 1 first is the default; if IPC bugs bite more, swap 1 and 2).
