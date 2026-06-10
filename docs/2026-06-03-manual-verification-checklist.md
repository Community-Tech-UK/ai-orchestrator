# Manual Verification Checklist & Remaining-Work Catalog

> **Date:** 2026-06-03
> **Status:** Untracked working doc (do not commit per AGENTS.md until reviewed).
> **Purpose:** Two things in one place:
> 1. **Manual verification steps** for every feature implemented headlessly this
>    session — each is already build/test/lint-verified; these are only the
>    human-in-the-loop checks an agent cannot perform.
> 2. **Remaining-work catalog** — what was deliberately NOT built, with the exact
>    blocker and the precise next step, so nothing is lost.
>
> Verification levels:
> - **Automated** ✅ — `tsc` + `vitest` + `ng lint`/`oxlint` + `ng build` (all green).
> - **Manual-UI** 👁️ — needs a person to drive the running app and look.
> - **Live-dep** 🔌 — needs an external runtime (a specific CLI build, a node-pty worker, a flaky mobile link).

---

## Automated gates (all currently GREEN)

```bash
npx tsc --noEmit                                  # renderer/base
npx tsc --noEmit -p tsconfig.electron.json        # main
npx tsc --noEmit -p tsconfig.spec.json            # specs
npm run lint            # ng lint (renderer)       -> 0 errors
npm run lint:fast       # oxlint (main/shared)     -> 0 errors (529 pre-existing warnings)
npm run check:contracts && npm run verify:ipc && npm run verify:exports && npm run verify:architecture
npm run build:renderer  # full ng build            -> success
npx vitest run          # full suite               -> 827 files / 7849+ tests pass
```

---

## Implemented this session — manual verification per feature

### Browser audits + Android worker automation (built this turn)
Automated ✅ pending final gate run in this turn (capability detection, config push, routing, settings UI, MCP injection, worker axe runner, and focused Vitest coverage).
- 🔌 **Windows worker provisioning:** on the worker, verify Node 22+, `adb --version`, `emulator -accel-check`, `emulator -list-avds`, and `maestro --version` if Maestro injection will be enabled.
- 🔌 **Managed emulator path:** enable Android automation in Settings, pick a known AVD, start an Android-routed task, and confirm the worker boots/reuses one `emulator-55xx` serial, injects `ANDROID_SERIAL`, and releases the lease when the instance exits.
- 🔌 **Physical device path:** plug in a test device, accept the USB-debugging prompt, request `/offload android on` with `androidDeviceKind=physical` where applicable, and confirm the node is selected only when the device reports `state=device`.
- 👁️ **Settings UI:** confirm the Android badge moves through Off / SDK only / Enabled / Ready states, the device list shows unauthorized devices as warnings, and saving Android automation updates the node without restarting the coordinator.
- 👁️ **Browser audit smoke:** run a browser-routed audit task and confirm the agent sees chrome-devtools MCP plus `AIO_BROWSER_URL` / `AIO_AXE_RUNNER`; run the axe runner once against a local page and confirm JSON output includes violations/passes counts.

### B10b — Automation retry/backoff (committed)
Automated ✅ (durable retry, deterministic jitter, policy-aware, one-time-fix; 65 tests).
- 👁️ **Live-ish:** create a oneTime automation whose action fails (e.g. a command that exits non-zero). Confirm in the Automations UI it shows a retry scheduled, retries with growing delay, and only marks the automation failed/auto-disabled after `max_attempts` exhausted (not on each intermediate retry).
- 🔌 Restart the app while a retry is pending (`next_retry_at` set) and confirm the retry still fires after relaunch (durable rehydration).

### A1 — Unified model catalog backend (committed)
Automated ✅ (models.dev-only inclusion, pricing attribution, startup refresh, IPC read/push; 41 tests).
- 👁️ **None required for the backend.** The catalog is populated at startup and on models.dev refresh. To eyeball: call the `MODELS_UNIFIED_CATALOG` IPC channel from devtools and confirm it returns static + models.dev-only entries with correct `source`/`pricingSource`.
- ⚠️ **Not consumed by any UI yet** — see Remaining-Work §A1-renderer.

### B5 — PreToolUse modify contract (committed)
Automated ✅ (Zod contract, IPC+mobile+preload threading, fail-safe guard; tests across 4 suites).
- 🔌 **Live-CLI:** the only way to confirm `modify` actually rewrites a tool's input is to approve a modify decision against a **real Claude CLI build** and observe the tool runs with the replacement input. If the installed CLI ignores `updatedInput`, the fail-safe means it never silently runs the original — you'll see the `MODIFY_WITHOUT_UPDATED_INPUT` guard / WARN. **This is unverified until tested against a live CLI.**
- ⚠️ No UI initiates `modify` yet — see Remaining-Work §B5-UI.

### A8a — Per-provider model memory (committed)
Automated ✅ (`resolveInitialModel` precedence: explicit > agent > per-provider > default; 8 tests).
- 👁️ In the model picker, switch a provider (e.g. Codex) to a non-default model. Spawn a **new** Codex instance with no explicit model. Confirm it starts on the model you last picked for Codex (not the global default). Then switch provider to one you've never set and confirm it falls back to the global default.

### A7#18 — Child-instance permission inheritance (committed) — SECURITY
Automated ✅ (parent deny-rules forwarded, correctly keyed by child instanceId, Plan-Mode write-forwarding, opt-in default-denies; 7 tests + 1903-test regression sweep).
- 👁️ Put a parent instance in **Plan Mode**, have it spawn a child (orchestration), and confirm the child is also blocked from file writes (it must not bypass the parent's planning restriction). With the parent unrestricted, confirm child spawns are unaffected (no new denies).

### A7#15 — Project-lessons injection (committed)
Automated ✅ (`extractAuthoredLessons` strips skeleton, injects only real entries; 3 tests).
- 👁️ Add a real `## ` entry to `.aio/lessons.md` in a project, start a fresh root session there, and confirm (via the session's system prompt / a probe question) the lesson text was injected. With only the skeleton file, confirm nothing is injected.

### B2 — Transport idempotency + lastSeq resume (committed + this turn)
Automated ✅ (at-most-once for input/respond/terminate; per-client `?fromSeq=N`; 4 + 69 tests).
- 🔌 **Idempotency:** from the mobile app (or curl) send the same `terminate`/`respond` twice with the same key/requestId and confirm the second returns `{ duplicate: true }` and does NOT act twice.
- 🔌 **lastSeq resume:** on a paired iPhone, burst 10 messages, go to airplane mode, reconnect, and confirm the app fetches `/api/instances/:id/messages?fromSeq=<lastSeq>` returning only the delta (capture with Proxyman). With 301+ new messages, confirm `meta.hasMore=true` triggers a second fetch.

### B4 — Doctor repair actions (backend committed + renderer this turn)
Automated ✅ (error taxonomy + repair-command previews flow into the IPC snapshot + redacted bundle; 29 tests; renderer display ng-lint/build-clean).
- 👁️ **Needs a degraded provider to see it:** uninstall or break a provider CLI (e.g. rename the `claude` binary), open Settings → Doctor → Provider Health, and confirm a repair action appears with a command preview and a working **Copy** button (label flips to "Copied"). Severity colour matches (info/warning/critical left-border).

---

### E1 — Checkpoint timeline UI (built + wired this turn)
Automated ✅ (component reads existing `session:list-snapshots` / `session:resume` IPC; 20 component tests; wired into instance-detail's inspector bar gated on a per-instance snapshot count). renderer tsc=0, ng-lint=0, 222 instance-detail+checkpoint tests green.
- 👁️ **HIGH-PRIORITY visual check (most intricate wiring this session):** open an instance that has session snapshots; confirm a **"Checkpoints" toggle with a count badge** appears in the inspector bar (Tasks/Review/Agents row); confirm it does NOT appear for an instance with zero snapshots (the bar must still only show when there's content); click it → the timeline panel renders entries with Restore buttons; click Restore → confirm dialog → list refreshes. Also switch between instances quickly and confirm the count updates (no stale count from the previous instance).

### E15 — Usage/cost analytics expansion (built this turn) — also fixed a real bug
Automated ✅ (extended `CostPageComponent` at route `/cost`; **fixed a pre-existing bug** where it called the unregistered `COST_GET_HISTORY` channel and used the wrong `CostSummary` shape; now uses `COST_GET_SUMMARY` + `COST_GET_ENTRIES`; 26 tests).
- 👁️ Navigate to `/#/cost`; confirm metric cards (cost/requests/sessions/avg; input/output/cache/total tokens; budget %s), per-model + per-session breakdown tables, recent-entries table, and budget form all render with real data.

### E13 — Session sharing UI (component built; REDUNDANT — see note)
A standalone `SessionShareComponent` was built (13 tests, file-bundle preview/save — the backend is file-bundle sharing, NOT URL/token links as the backlog implied). **However, `history-item.component.ts` already implements file-bundle sharing** (`btn-share` + `onShare` + `SessionShareIpcService`). So the new component is duplicative for the history case and was **not wired** to avoid duplicate UI.
- **Decision needed:** either adopt the new component for **live-instance** sharing (instance-detail has no share button yet) or drop it. Not wired pending that call.

### E4 — Multi-provider compare / "Ask Council" (built this turn)
Automated ✅ (new `AskCouncilPageComponent` over existing `COMPARE_RUN`/`COMPARE_LIST_PROVIDERS` IPC; **routed at `/ask-council`** — reachable; 29 tests).
- 👁️ Navigate to `/#/ask-council`; confirm providers list, enter a prompt, click "Ask Council", confirm per-provider response cards render with ok/error + duration.

### E3 — MCP preset catalog (built this turn; "marketplace" corrected)
Automated ✅ — **honest scope correction:** there is no remote MCP marketplace backend (only 7 hardcoded presets + management, which already existed). Built a **preset catalog** panel surfacing the presets with one-click Add + "Added" state, wired into the existing `/mcp` page; 11 tests.
- 👁️ Open the MCP page; confirm a "Preset Servers" panel with 7 cards; click Add on one → it joins the server list + shows "Added".
- **A true marketplace (remote catalog/search/versioning) needs a new backend** — documented below.

### E2 — Diff hunk grouping (built this turn; accept/reject NOT backable)
Automated ✅ — **honest scope correction:** there is **no hunk-apply backend** (`VCS_APPLY_HUNK` does not exist), so per-hunk accept/reject would be UI with no effect and was NOT built. Instead added presentational **per-hunk grouping** (visual separation) to the source-control diff viewer; 6 tests.
- 👁️ Open a file diff in source control; confirm hunks are visually separated with `@@` headers as distinct blocks.

### Final batch (built + verified this campaign)
All build/test/lint/ng-build verified. Manual checks:
- **E5 Right-docked PanelZone** (reusable shell, `src/renderer/app/shared/components/panel-zone`, 28 tests) — 👁️ drop it into a view per its doc-comment usage example; confirm activity strip toggles panels with width transition.
- **E6 Fleet dashboard** (`/fleet`, 29 tests) — 👁️ open `/#/fleet`; confirm instances grouped into Needs-you / Working / Idle zones with counts; click selects.
- **E8 Composer toolbar** (per-message picker + context ring + effort, 19 tests) — 👁️ open an instance; confirm the ring shows context %, the model picker + low/med/high effort work (model change uses per-instance `changeModel` — per-message override isn't a backend concept; documented).
- **E9 Split-session compare** (`/compare/split`, 10 tests) — 👁️ open `/#/compare/split`; pick two instances; confirm side-by-side output streams.
- **E14 Repo-map injection** (backend, setting `injectRepoMap` default **true**, 17 tests) — 👁️ start a fresh session in an indexed repo; confirm `Injected repo map into system prompt` in the main log.
- **E7 Theme families + status tokens + color-lint** (`high-contrast` theme, `npm run lint:colors`, 19 tests) — 👁️ set `data-theme="high-contrast"`; confirm status colours adapt.
- **E11 Renderer perf conventions doc + render-count harness** (11 tests) — automated only.
- **E12 Observer agent role** (Piece A — declarative role, 6 tests) — 👁️ confirm "observer" appears in the agent picker. (Piece B auto-routing of attachments = separate orchestration feature, documented below.)
- **A3 Degraded-output detection** (OFF by default, `detectDegradedAdapterOutput`, 47 classifier tests incl. 12 false-positive guards) — 🔌 enable in staging + observe real degraded streams to tune thresholds before production. **UPDATE 2026-06-04 (iter 6): NOW WIRED end-to-end (was an orphan — classifier+hook+`CliResponse.degradedReason` existed but no adapter called the hook and the normalized event couldn't carry the reason).** Base `completeResponse()` seam tags 6 production adapters (claude/codex/copilot/cursor/gemini/acp); all 5 reasons reachable (added per-turn duplicate/`computeBoundedTrigramSimilarity` tracking; per-turn first-activity timing so persistent-session adapters — ACP/codex app-server — don't false-fire `delayed` on short late turns); `degradedReason` propagated on `ProviderCompleteEvent` via BOTH the runtime-event bridge and `instance-communication.toProviderCompleteEvent`; `DegradedReason` made canonical in contracts + Zod schema (survives RPC); observable warn-log consumer in the instance complete handler. +21 tests (16 base-adapter tagging, 2 bridge, 2 instance, 1 contract schema). Zero behavior change when the flag is off. **Remaining (deferred):** hooking the tag into coordinator retry/re-issue — mutates the safety-critical completion flow (same gate as the A4 auto-reschedule tail).
- **A4 Evidence persistence** (migration 035, `EvidenceStore`, fixed/verified/reviewed distinct, 16 tests; `resolveCompletion` byte-identical) — automated. **UPDATE 2026-06-04:** coordinator hot-path `record()` wiring NOW DONE — `LoopCoordinator.recordCompletionEvidence()` persists `verified` (verify passed) and `reviewed` (clean fresh-eyes) distinctly at the completion seam; lazy fail-soft RLM bind via `resolveEvidenceStore()`; `deleteForLoop` on terminal keeps the table compact; contradiction detection raises a "verify regressed after a prior pass" convergence note when verify fails after a persisted `verified`. 7 new tests (`loop-coordinator-evidence-journal.spec.ts`), full loop-coordinator suite green (89 tests). **Remaining (deferred — touches safety-critical reviewer):** full auto-*reschedule* of a fresh-eyes review on contradiction (vs the note added now); reviewer model/node diversity. `fixed` state is intentionally NOT written by the coordinator: the only operator-accept site (`acceptCompletion`) is terminal and `terminate()` immediately `deleteForLoop`s, so a write there would be instantly wiped — `fixed` stays a valid queryable store state for a future accept-while-paused flow.
- **A4 review-quality (dedup + severity ranking)** — **DONE 2026-06-04 (iter 5).** The fresh-eyes gate already did diff-scoping/clean-context (reviews the git diff + goal, never the agent transcript — see `loop-fresh-eyes-reviewer.ts`) and runs multiple cross-model reviewers (prompt/model diversity). Gap was in finding *consumption*: blocking findings were listed raw (cross-reviewer duplicates shown twice) in arbitrary order. Added a pure `dedupeAndRankFindings()` in `review-thread-fingerprint.ts` — collapses findings sharing a `fingerprintReviewThread` (keeping the highest-confidence representative + a corroboration count) and orders survivors critical→low then by descending confidence, fully deterministic. Wired into `loop-coordinator-completion-gates.ts`: the intervention message + `blockingFindings` UI event now show each distinct blocker once, worst-first, with a `[flagged N times]` marker when corroborated. **Presentation-only — the block/no-block decision (severity filter) and convergence/persistence semantics are byte-identical** (`computeReviewThreadSet` already deduped by the same fingerprint). 5 new unit tests + 1 coordinator integration test; full orchestration suite green (80 files / 1041 tests). The remaining "auto-reschedule on contradiction" + "reviewer model/node diversity" items stay deferred (they mutate the safety-critical completion flow / need a live multi-node reviewer).
- **A2 Provider auto-update** — **DONE 2026-06-04 (iter 1).** Ph2 (`cliUpdatePolicy` setting, `cli-auto-update-service.ts` policy-aware apply-on-detect, safe-strategy filter, instance-gating, 6h cooldown, per-package-manager locks) was ALREADY implemented (stale backlog). Ph3-B built this iter: `scripts/sync-model-catalog.ts` (`npm run sync:model-catalog`, `--check` drift, fail-soft offline, NOT in prebuild) regenerates the committed offline snapshot `src/main/providers/models-dev-snapshot.generated.ts` (100 supported-provider models). `ModelsDevService.loadOfflineSnapshot()` seeds pricing overlay + entries + context windows (idempotent, won't clobber live data), wired at both startup seams before catalog construction. 5 tests; tsc x3 + lint + verify chain green; architecture-inventory regenerated. ⚠️ To refresh pricing periodically, a maintainer runs `npm run sync:model-catalog` and commits the result (deliberately not auto-run at build — models.dev changes daily).
- **A6 Deterministic test harness** — **CORE DONE 2026-06-04 (iter 2).** `src/main/cli/__tests__/scripted-cli-adapter.ts` (`ScriptedCliAdapter`: in-process `BaseCliAdapter` replaying scripted lifecycle events) + `runtime-receipts.ts` (`ReceiptRecorder` + `awaitReceipt`/`drainRuntime` — kill `sleep()` in adapter tests). 9 tests incl. an integration test driving the real `adapter-runtime-event-bridge` consumer. Test-only (under `__tests__/`, not in the production factory), zero production change. **OUT-OF-PROCESS TAIL DONE 2026-06-04 (iter 4):** `src/main/cli/__tests__/fixtures/cli-fixture-runner.mjs` (dependency-free, scenario-JSON-driven fake CLI) + `out-of-process-fixture-adapter.ts` (`OutOfProcessFixtureAdapter`: a minimal REAL `BaseCliAdapter` subclass that actually forks the fixture via the production `spawnProcess()` and runs the real stdout-stream → `close` flush → `parseOutput` → `complete`/`exit` pipeline). This is the first test to drive the base class's real subprocess machinery (chunk-boundary line buffering, exit codes, stderr→error, idle-watchdog wiring, `getSafeEnvForTrustedProcess`/`buildCliSpawnOptions`) and to push those real-subprocess events through `observeAdapterRuntimeEvents`. 8 tests (incremental streaming, split-line reassembly, stderr surfacing, non-zero-exit-with-partial vs reject-on-empty, stream API, bridge normalization w/ tokensUsed+cost). Still test-only. **Remaining (deferred):** Playwright web-build E2E (🔌 needs browser/web-build runtime — Needs Human), mock↔real parity fixtures (low value/speculative).
- **A5 Token calibrate** (gated OFF — no clean estimate/actual pairing site exists; 2 safe `chars/4` replaced, 36 tests) — needs per-turn paired-data plumbing before enabling; documented.
- **A5 Live usage → cost recording** — **DONE 2026-06-04 (iter 3).** Found a real missing-wiring defect: `CostTracker.recordUsage()` had **zero runtime callers** (renderer `costRecordUsage` IPC also had zero callers), so live spend never reached budget alerts, the cost analytics page, or the action/cost **circuit breaker** (which keys off the `cost-recorded` event) — `maxCostUsd` enforcement was effectively dead. Wired the authoritative per-turn seam: `InstanceCommunicationManager.recordCompletionCost()` runs on every adapter `complete`, routes `CliResponse.usage` through the shared `normalizeUsage` entry point (A5's "single entry point" ask), and records one cost entry per turn — **fail-soft** (never breaks turn completion). Trusts a provider-supplied cost when present (`CostTracker.recordUsage` gained an optional `providerCostUsd` override; Claude's `total_cost_usd` / ACP's `costUsd` are used verbatim, already baking in cache pricing). Cache tokens are now accounted: `CliUsage` gained `cacheReadTokens`/`cacheWriteTokens` and the Claude adapter surfaces them from `result.usage` (previously discarded). **No regression:** the circuit breaker defaults to `DISABLED` (`maxCostUsd: 0` → `enabled === false`, `recordCost` early-returns), so cost only acts on explicit operator opt-in; budget alerts gated behind `budget.enabled` (default false). Tests: `cost-tracker.spec.ts` (6, new — none existed) + 6 new integration tests in `instance-communication.spec.ts`. tsc x3 + ng lint + oxlint(0 err) + verify:exports/check:contracts/verify:architecture green; cost-tracker/instance-communication/cli-adapters/security/ipc-handlers suites all pass. **Remaining A5 (still deferred):** `TokenCounter.calibrate()` wiring (the complete handler has actual provider tokens but not the *paired* pre-send estimate for the same text, so a clean pairing site still doesn't exist); the remaining `chars/4` sites are legitimate pre-send string estimates, correctly left alone.
- **B5 modify approval UI** (editor in `user-action-request`; `tool_input` surfaced from claude adapter; end-to-end code-complete) — 🔌 **needs live Claude CLI validation** that `updatedInput` is honored in the PreToolUse hook reply.

---

## Remaining-work catalog — genuinely NOT buildable headlessly

### §B5-UI — modify approval UI 🔌 + cross-cutting
**Blocker:** (1) the renderer permission request (`UserActionRequest.permissionMetadata`) does NOT carry the tool's current `tool_input`, so there's nothing to pre-fill an editor with; surfacing it requires threading `tool_input` out of the **hot, per-provider CLI adapter** path (`claude-cli-adapter.ts` `toolUseContexts`, plus codex/gemini/cursor) — sensitive code. (2) Even built, `modify` only works if the installed CLI honours `updatedInput` (unvalidated). 
**Next step:** add `tool_input` to the deferred-permission request metadata at each adapter's defer-emit site → add an "Approve with changes" JSON editor to `user-action-request.component.ts` → pass `decisionAction:'modify'` + `updatedInput` to `respondToInputRequired` (preload already accepts it). Then validate against a live Claude CLI build. Deliberately deferred to avoid a speculative edit to hot adapter code.

### §A1-renderer — picker consumption of the unified catalog 👁️ + refactor
**DONE (push half):** `dynamic-model-catalog.service.ts` now calls `pushCliDiscoveredModels(provider, merged)` after each successful CLI discovery, so the backend unified catalog receives live Copilot/Cursor models (data layer complete: static + models.dev-only + CLI-discovered). Verified: renderer tsc=0, ng-lint=0.
- 👁️ After opening the model picker for Copilot/Cursor (which triggers discovery), call the `MODELS_UNIFIED_CATALOG` IPC from devtools and confirm the discovered models now appear with `source: 'cli-discovered'`.

**REMAINING (consume half):** no UI reads `MODELS_UNIFIED_CATALOG` yet; the picker still uses its own `dynamic-model-catalog.service`. Switching it is a refactor of a working picker whose only gain is consolidation + a live-refresh pill.
**Next step:** introduce a `UnifiedCatalogStore` reading the IPC; switch the picker source; add the live-refresh pill. Visual verification of the picker required.

**UPDATE (2026-06-03 later session) — DATA LAYER DONE (headless, verified):**
- Added `MODELS_CATALOG_UPDATED` push channel (contracts + regenerated preload channels; `verify:ipc` 960/960 synced).
- `provider-handlers` now forwards `UnifiedModelCatalogService` `catalog-updated` → renderer.
- `preload.onModelsCatalogUpdated` + `ProviderIpcService.getUnifiedModelCatalog()` / `onModelsCatalogUpdated()`.
- New `src/renderer/app/features/models/unified-catalog.store.ts` (`UnifiedCatalogStore`): fetches the catalog, live-refreshes on push, exposes `models()/status()/lastBuiltAt()/modelsForProvider()/displayModelsForProvider()`. 6 unit tests.
- Verified: tsc x3 clean, `verify:ipc`/`verify:exports`/`check:contracts` pass, oxlint 0/0, `ng lint` passes.
- 👁️ STILL NEEDS A HUMAN: wire the store into `CompactModelPickerComponent` (replace/augment `DynamicModelCatalogService`) + add the live-refresh pill, then click-test. Deferred because it surfaces models.dev-only entries into static-provider pickers and swaps curated names for ids — a UX change that must be eyeballed.

### §E1–E15 — UX/renderer features 👁️ (each a real feature)
Backends largely exist; each needs a new component + placement/navigation + visual design + click-test. Not headlessly *finishable* (no visual verification). Catalog:
| # | Feature | Backend state |
|---|---|---|
| ~~E1~~ | ~~Checkpoint timeline UI~~ | **DONE this turn** (built + wired + tested; visual check pending) |
| ~~E13~~ | ~~Session sharing UI~~ | **Built but redundant** with existing history-item sharing (see above) |
| ~~E15~~ | ~~Usage/cost analytics~~ | **DONE this turn** (extended `/cost`, fixed a real bug; tested) |
| ~~E2~~ | hunk grouping DONE; **accept/reject needs a new `VCS_APPLY_HUNK` backend** (git apply on `DiffHunk.content`) | partial |
| ~~E3~~ | preset catalog DONE; **true marketplace needs a remote catalog/search/install backend** (none exists) | partial |
| ~~E4~~ | ~~Multi-provider compare / "Ask council" UI~~ | **DONE this turn** (routed `/ask-council`, tested) |
| E5 | Right-docked PanelZone | — |
| E6 | Attention-zone fleet dashboard | — |
| E7 | Theme families + status tokens + colour lint | — |
| E8 | Per-message model picker + context ring + effort | — |
| E9 | Split-screen dual-session compare | — |
| E10 | Setup Center broadening | base component exists |
| E11 | Renderer state/perf conventions + render-count tests | — |
| E12 | Visual/attachment observer role | — |
| E13 | Session sharing links UI | `SessionShareService` + SSE exist |
| E14 | Repo-map injection (@-mention) | codemem + BM25 exist (backend-heavy) |
| E15 | Usage/cost analytics expansion | UI + pricing exist |
**Next step:** pick per-item; build component + wire IPC + place in nav; click-test in the running app.

### §C1–C3 — Remote terminal / node-pty 🔌 hardware
**Blocker:** node-pty cannot be built/verified in this environment; needs a live worker node. Not buildable headlessly.

### §D1–D5 — Architectural rocks (operator decision)
Thin-client event API, schema-first RPC codegen (~775 channels), adapter unification, utilityProcess CLI offload, plugin sandboxing. Multi-week; tagged "do NOT start autonomously"; need a design pass + operator sign-off.

### §A3 / §A4 / §A5-rest — hot-path correctness (need a real harness)
Adapter degraded-output detection (false-positive risk on healthy streams), evidence-resolver persistence (loop hot path), token-accounting `calibrate()` wiring (corrupts heuristics if fed mismatched pairs). Each needs a real degraded/usage harness to validate; unsafe to land unvalidated.

### §B14 — permission verbs modify/synthesize
`modify` ≈ B5 (needs a concrete policy use-case); `synthesize` needs the D5 sandbox as a real consumer + live-CLI validation. Build when D5 lands.

### Deferred as redundant / dead-data
- **B1** ProviderRuntimeRegistry — would duplicate FailoverManager + CapabilityProbe + Doctor; high-value half is renderer-gated.
- **B13** Session goals/handovers — backend plumbing is headless but nothing populates goal/handover without renderer UI.
- **A7#17** 37-role prompt library — `delegation-policy.ts` intentionally scopes it out; would create dead assets.
