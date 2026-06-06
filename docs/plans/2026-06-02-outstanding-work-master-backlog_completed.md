# Outstanding Work — Master Backlog (consolidated)

> ## ⚠️ RECONCILIATION 2026-06-03 — THIS DOC IS LARGELY SUPERSEDED
> The 2026-06-03 session implemented and committed (~6 "working through master
> list" commits) the large majority of §A/§B/§E. See
> `docs/2026-06-03-manual-verification-checklist.md` for the authoritative
> per-item state. Verified DONE in code: A2, A5, A7#15,
> A7#18, A8a, B1, B5, B10. DEFERRED-as-redundant: B13, B14.
> A7 primitives all exist; #17 intentionally scoped out. UX §E1–E15 mostly built
> (visual checks pending). **C4 (intent routing Ph1+2) — DONE 2026-06-03 (later
> session):** `src/main/routing/route-task.ts` shared helper + Loop-Mode opt-in
> `routingIntent`; only live `npm run dev` Loop confirmation deferred.
> **A6 (scripted mock adapter) — DONE/SUPERSEDED 2026-06-05:** typed `ScriptedCliAdapter`, `ReceiptBus`, `awaitReceipt`/
> `drainRuntime`, in-process and out-of-process parity fixtures exist; the old
> "web-build E2E" ask is superseded/deferred because this repo still has no
> Playwright web E2E harness. **B1 (ProviderRuntimeRegistry) — DONE 2026-06-05:**
> runtime registry, lifecycle snapshots/events, Doctor diagnosis ingestion,
> adapter-create status recording, and shadow-report preservation are implemented
> and tested. **C3 Ph0/Ph1 — DONE 2026-06-05:** `launchMode`
> contract + Claude draft selector + orchestration guards are implemented; Ph2+
> remains blocked on the terminal runtime. **B3 (ContextEngine boundary) — DONE 2026-06-05:** `ContextEngine`
> now owns context ingestion, input-context assembly, per-turn context updates,
> after-turn reconciliation, manual compaction, status, and safe quarantine/fallback.
> **F2 (project-memory brief offload) — DONE 2026-06-05:** context-worker RPC,
> worker-safe source-backed brief builder, startup invocation, main-process fallback,
> import-isolation guard, and focused lifecycle/client tests are implemented.
> **A3 (degraded output coordinator retry) — DONE 2026-06-06:**
> `degradedReason` threaded from `base-cli-adapter` → `CliResponse` →
> `invokeCliTextResponse` → `LoopChildResult`; `classifyDegradedIteration` returns
> `'adapter-degraded'` when set. All four affected files typecheck clean.
> **A4 (evidence persistence/convergence) — DONE 2026-06-06:** `EvidenceStore` persists
> verified/reviewed states (done earlier); `recordCompletionEvidence` now sets
> `state.freshEyesForcedByContradiction = true` on contradiction; `runFreshEyesReviewGate`
> consumes the one-shot flag and forces a fresh-eyes pass via `defaultCrossModelReviewConfig()`
> even when `crossModelReview` is disabled. `A4(core)` was already correct — "reviewer
> clean-context" uses diff+goal only (not parent transcript) and dedup/severity-ranking
> are wired via `dedupeAndRankFindings`.
> **B4 (Doctor: redacted runtime-log bundles) — DONE 2026-06-06:** `RuntimeLogBundle`
> type in `provider-doctor.types.ts`; `buildRuntimeLogBundle(probes)` scrubs API-key,
> JWT, Bearer, password, token, apikey, secret patterns and attaches to `DiagnosisResult.logBundle`;
> 38 tests including full redaction coverage, all passing.
> **F1 Ph3 (enricher offload) — DONE 2026-06-06 (verified):** `context-worker-main.ts`
> already handles both `build-observation-context` (line 193) and
> `build-project-memory-brief` (line 209) — enricher offload was already complete.
> Ph5/6 remain blocked on packaged rebuild.
> **Genuinely still open + headless-buildable:** A1 live visual verification (UX),
> A7#20 claim-matrix (needs clear spec), B2 (L), B6–B12 (M–L each — new features,
> need design), F1 Ph5/6 (blocked: packaged rebuild).
> **Orphaned by design (do NOT wire autonomously):** A7#14 (fuseHybrid),
> A7#21 (lease/mailbox), A7#32 (policy-engine migration).
> Everything else is blocked
> (node-pty/live-CLI/visual), a rock (§D — do NOT start autonomously), or
> operator/deferred (§G).
>
> **Date:** 2026-06-02
> **Status:** Untracked working backlog (do not commit per AGENTS.md).
> **Purpose:** ONE source of truth for everything still outstanding. Built from a
> full code-verified read (file:line) of every untracked doc, **deduplicated** —
> the source docs overlapped heavily (evidence resolver, models.dev, degraded
> detection, transport replay, sandbox, channels, toolsets all appeared in 2–3
> docs each). Each entry notes its source docs so they can be retired.
> **Verification basis:** per-item agent audits against the actual tree, 2026-06-02.

## How to read this
- **State** = what already exists in code (so nobody rebuilds it).
- **Remaining** = the genuinely open slice.
- **Tags:** `[unblocked]` do now · `[blocked]` needs live worker/node-pty/packaged
  rebuild (headless-impossible) · `[rock]` multi-week, design-pass + operator
  decision, do NOT start autonomously · `[ux]` needs Angular build to verify ·
  `[operator]` security/cost-gated · `[deferred]` not now.
- Effort: S / M / L / XL.

---

## Source-doc disposition (what this replaces)

| Source doc | Disposition |
|-----------|-------------|
| `claude2_todo.md` | Consolidated here → can archive |
| `copilot_todo.md` | Consolidated here → can archive |
| `tokens_todo.md` | Consolidated here (§A5) → can archive |
| `claude1_todo.md` | **Keep** — progress *record* (DONE w/ file:line), not a backlog. Its open items are all carried here: §A1 (#9), §A6 (#20), §A8 (#4), §B2 (#10), §B14 (#28 residual), §C4 (#26), §D1–D5 (#1/#2/#3/#16/#23), §E1–E4/E13/E14 (#15/#29/#30/#11/#14/#27), §G (#24 ship-readiness). |
| `claude1_progress.md` | **Keep** — progress record (no open items beyond claude1_todo) |
| `2026-05-28-first-class-remote-orchestration-plan.md` | Open slices here (§C); can archive after |
| `2026-05-28-thin-client-replatform-followup.md` | `[deferred]` → archive |
| `2026-05-29-backlog-deconfliction-and-sequencing.md` | Stale index → archive (this doc replaces it) |
| `2026-05-29-provider-model-auto-update-plan.md` | Open slices here (§A1/A2); can archive after |
| `2026-05-30-loop-adapter-degraded-output-detection.md` | §A3; can archive after |
| `2026-05-31-project-memory-brief-offload-spec.md` | §F2; keep as the detailed spec, summarised here |
| `bigchange_claude_launch_modes.md` | §C3; keep as detailed plan |
| `bigchange_intent_routing_plan.md` | §C4; keep as detailed plan |
| `mobile-control-app-plan.md` | ✅ DONE Ph0–3 + Ph4 (`_completed` 2026-06-03; verified on iPhone 17) — §H |
| chrome-devtools / browser-gateway / remote-node-tool-discovery | DONE → already `_completed` / archived |

---

## A. Unblocked, high-leverage (do next)

### A1. models.dev → unified catalog + picker integration `[unblocked]` (S–M)
*Sources: provider-auto-update Ph3-A · claude1 #9 · copilot P0 #1*
- **State:** `models-dev-service.ts` + `model-pricing.ts` fetch + cache built;
  `UnifiedModelCatalogService` merges static + models.dev + CLI-discovered rows,
  emits `catalog-updated`, and is exposed through IPC/preload; `UnifiedCatalogStore`
  live-refreshes renderer consumers and overlays curated picker labels; the compact
  model picker and legacy instance-header dropdown both consume the unified catalog
  first, with static/dynamic fallback before initial load; Copilot/Cursor CLI
  discovery pushes live rows back into the main-process catalog; compact picker has
  a live-refresh pill.
- **Remaining:** live visual verification in the running app for the compact picker
  and legacy header dropdown after the catalog loads/refreshes.

### A2. Provider auto-update Phase 2 + 3-B `[unblocked]` (M) ✅ DONE 2026-06-04 / verified 2026-06-05
*Sources: provider-auto-update plan*
- **State:** Ph2 is built: `cliUpdatePolicy` is in settings metadata/types,
  `cli-auto-update-service.ts` applies safe updates under policy, and tests cover
  auto policy behavior. Ph3-B is built: `scripts/sync-model-catalog.ts`,
  `npm run sync:model-catalog`, and `src/main/providers/models-dev-snapshot.generated.ts`
  seed the offline models.dev snapshot.
- **Remaining:** none headless-buildable. Periodic pricing refresh is operator work:
  run `npm run sync:model-catalog` and commit the generated snapshot.

### A3. Adapter-layer degraded-output detection `[unblocked]` (M)
*Sources: loop-adapter-degraded-output-detection plan · copilot P0 #5*
- **State:** coordinator backstops live (`classifyDegradedIteration` loop-coordinator.ts:2114,
  degraded-iteration retry :1089-1127). Adapter layer = greenfield.
- **Remaining:** at `base-cli-adapter`, classify delayed/synthetic/cancelled/duplicate-stale/
  partial-replay tool results; tag `CliResponse` / `ProviderRuntimeEventEnvelope` with a
  degraded reason; re-issue or annotate for coordinator retry.

### A4. Evidence resolver — persistence + convergence completeness `[unblocked]` (M)
*Sources: first-class-remote Piece B residual · copilot P0 #6 · claude2 #1 (spine DONE)*
- **State:** `evidence-resolver.ts` ladder shipped + wired into `loop-coordinator`;
  fix→verify→review cycle wired (`rejectCompletionAttempt`, fresh-eyes gate).
- **Remaining:** persist evidence records; treat fixed/verified/reviewed as distinct
  states; auto-schedule fresh-eyes on contradiction; **reviewer clean-context** (diff+goal
  only, not full parent transcript) + reviewer model/node diversity; review quality
  (prompt diversity, dedup, severity ranking, diff-scoping).

### A5. Token-accounting workstream `[unblocked]` (M) ✅ DONE 2026-06-05
*Sources: tokens_todo #1–12*
- **State:** complete headless-buildable slice. `normalizeUsage()` is wired through
  completed-turn cost recording and provider runtime normalization; provider-reported
  cost/totals remain authoritative where present; cache and reasoning tokens are
  normalized, priced, persisted, summarized, and surfaced through contracts/UI types;
  completed-turn output samples feed estimate-vs-actual telemetry and guarded
  calibration; shared estimates cover CJK, JSON, and fixed image fallback costs;
  Anthropic API provider uses `messages.countTokens()` before send with heuristic
  fallback; remaining production token estimates use centralized helpers rather than
  ad-hoc `/4` call sites.
- **Remaining:** none headless-buildable. Broader usage analytics UI polish remains
  covered by §E8/E15.

### A6. Scripted mock adapter + web-build E2E `[unblocked]` (M–L) ✅ DONE / partly SUPERSEDED 2026-06-05
*Sources: claude2 #31 · copilot P0 #7*
- **State:** deterministic adapter testing exists in both the production adapter
  test helper path and the older test-only path. Evidence: `src/main/cli/adapters/scripted-cli-adapter.ts`,
  `src/main/cli/adapters/receipt-bus.ts`,
  `src/main/cli/adapters/scripted-cli-adapter.test-helpers.ts`,
  `src/main/cli/adapters/scripted-cli-adapter.spec.ts`,
  `src/main/cli/__tests__/out-of-process-fixture-adapter.ts`,
  `src/main/cli/__tests__/fixtures/cli-fixture-runner.mjs`, and
  `src/main/providers/adapter-runtime-event-bridge.scripted-parity.spec.ts`.
  `awaitReceipt`/`drainRuntime` are built and used by adapter/runtime parity tests.
- **Remaining:** no headless adapter work. The old Playwright web-build E2E item is
  superseded/deferred: this repo still has no Playwright app E2E harness, while the
  deterministic runtime coverage this item was meant to unlock is now adapter-level.

### A7. claude2 "done-with-a-tail" finishing slices `[unblocked]` (S each)
*Source: claude2_todo — primitives shipped, only the final slice remains*
- **#14** verbatim-memory drawer tier + codemem wiring (`hybrid-recall-fusion.ts` done).
- **#15** `.story/` fs persistence + session-start lesson injection (`lesson-store.ts` done).
- **#17** 37-role prompt library (`prompts/roles/*.md`) + fan-out enforcement (`delegation-policy.ts` done).
- **#18** toolset intersection + per-role allowlists (`subagent-spawn-guard.ts` + `maxSpawnDepth` done).
- **#20** bounded 3-cycle debate + claim-matrix (`safety-critic.ts` + `loop-safety-advisor.ts` done).
- **#21** lease+mailbox integration into the supervisor (`authority-lease.ts` + `dispatch-log.ts` primitives done).
- **#29** user `.md` output-style loader + full-prompt-swap + statusLine renderer (built-ins done).
- **#30** magic-recipes layer + native-history session-picker adoption (`magic-prompts/` + `native-claude-importer.ts` done).
- **#32** migrate existing loop/merge branches onto `policy-engine.ts` (engine done).

### A8. Per-instance routing/model memory `[unblocked]` (S–M) — *claude1 #4*
- **State:** `instanceId` is threaded everywhere; provider/model memory exists at the
  draft/global-provider layer via `defaultModelByProvider`; canonical retained
  per-instance lifecycle event log exists in `src/main/instance/instance-event-aggregator.ts`
  and is covered by `instance-event-aggregator.spec.ts`.
- **Remaining:** true per-instance model memory, if still wanted. This may be superseded
  by current per-provider draft memory plus per-instance `currentModel`; do not add a
  second model-memory system without a concrete UX requirement.

---

## B. Open net-new subsystems (M–L)

### B1. ProviderRuntimeRegistry + shadow snapshots (M) — *copilot P0 #2* ✅ DONE 2026-06-05
- **State:** `ProviderRuntimeRegistry` is implemented with canonical per-provider
  runtime snapshots, typed lifecycle events (`available`/`degraded`/`unavailable`/
  `refreshed`), runtime descriptors for local/remote spawns, Doctor diagnosis
  ingestion, adapter-create availability/failure recording, runtime capabilities,
  model tracking, and shadow-report preservation across later misconfig diagnoses.
  Covered by `provider-runtime-registry.spec.ts` and adjacent `provider-doctor.spec.ts`.
- **Remaining:** none headless-buildable.

### B2. Transport hardening: sequence replay + idempotency + durable sessions (L) — *copilot P0 #3, P1 #16; claude2 #4, #7; claude1 #10*
- **State:** mobile gateway broadcasts live + 300-msg HTTP replay (`mobile-gateway-server.ts:39`);
  RPC has Zod schemas + seq guards.
- **Remaining:** per-client `lastSeq` resume; unify rolling buffers (terminal/instance/mobile);
  "attached from seq N" diagnostic; idempotency keys for input/respond/interrupt/terminate;
  server-authoritative durable sessions (disconnect ≠ stop) — `ProviderSessionReaper`,
  `lastSeenAt` teardown, detached tail-on-relaunch. (Subsumes claude1 #10 durable streams.)

### B3. Pluggable ContextEngine boundary (M) — *copilot P1 #8* ✅ DONE 2026-06-05
- **State:** `ContextEngine` now covers `ingest`, `assemble`, `onContextUpdate`,
  `afterTurn`, `compactInstance`, `getStatus`, and cleanup. `LegacyContextEngine`
  delegates to the existing `InstanceContextPort`/`CompactionCoordinator` behavior;
  `SafeContextEngine` quarantines failing engines and returns an empty retrieved-context
  fallback for send-path assembly. Production wiring routes input-context assembly
  through `getContextEngine().assemble`, output ingestion through
  `getContextEngine().ingest`, batch context usage through `onContextUpdate`, idle
  transitions through `afterTurn`, and `/compact`/IPC compaction through
  `compactInstance`.
- **Remaining:** none headless-buildable.

### B4. Doctor: probes → repairable incidents (M) — *copilot P1 #9*
`ProviderDoctor`/`DoctorService` have probes today. Add provider error taxonomy, repair
actions with command previews, redacted runtime-log bundles.

### B5. Executable hook runtime — finish the sync slice (S–M) — *claude2 #3*
- **State (premise was STALE):** executor dir already exists — `hook-engine.ts`,
  `executor/{hook-command,hook-prompt,hook-script}.ts`, `enhanced-hook-executor.ts`,
  `webhooks/webhook-server.ts`. Command/prompt/script/http execution is built.
- **Remaining:** synchronous PreToolUse allow/deny/**modify** with `updatedInput`
  interception. Scope against the existing executor — do **not** rebuild.

### B6. Channel-plugin SDK (M) — *claude2 #35 · copilot P1 #11*
`BaseChannelAdapter` exists (Discord/WhatsApp). Add ack/watermark, attachment IR, safe
per-platform offset semantics, deterministic routing, MCP-compat harness.

### B7. Codex v2 thread/turn protocol (M) — *claude2 #9*
Adapter parses v1 exec surface. Add v2 thread/start/fork + turn/steer/interrupt.

### B8. ACP provider family breadth (S–M) — *claude2 #11*
`acp-cli-adapter.ts` exists. Add OpenCode + capability-normalization matrix.

### B9. Native SDK / provider-server preference order (M) — *copilot P2 #20*
Prefer SDK/app-server mode, CLI terminal fallback; Doctor shows which mode is active.

### B10. Automation scheduling resilience (S–M) — *copilot P1 #10*
`AutomationScheduler`/`-runner` exist. Add retry/backoff, deterministic jitter,
max-failure auto-disable, per-automation failure summary, cross-process lock.

### B11. Plugin lifecycle hardening (M) — *copilot P1 #17*
Lifecycle states (discovered/validated/active/degraded/quarantined); hot reload for safe
surfaces (commands/skills/output-styles); Doctor surfacing. (Related to rock D5.)

### B12. Workflow state authority (M) — *copilot P1 #13*
One canonical state contract across loop/automation/remote/instance.

### B13. Session goals + handovers (S–M) — *copilot P1 #15 (overlaps claude2 #15)*
Optional goal/handover records; inherit goal as context (never auto-run); latest-handover
in recovery flows.

### B14. Permission verbs: modify/synthesize + per-capability matrix (S–M) — *claude1 #28 residual*
- **State:** action/cost circuit breaker DONE (`action-circuit-breaker.ts`, wired into the
  tool-execution gate); evaluator does allow/deny/ask.
- **Remaining:** `modify`/`synthesize` permission verbs as evaluator decisions + a
  per-capability matrix at the instance-manager apply-site + settings. (The `self-permission-granter`
  action classifier is separate — don't conflate.)

---

## C. Remote / terminal / routing (mostly blocked)

### C1. Remote Piece A — live E2E verification `[blocked: live worker]` (S)
Code complete (node-targeted spawn, prompt surfacing, capability-tag resolution). Needs
`report_result` round-trip + a `windows-pc` demo. Not headless.

### C2. Remote Piece C — remote terminal `[blocked: node-pty + live]` (L) — *first-class-remote*
Protocol vocabulary exists. Remaining: Zod schemas, node-pty host on worker, router, IPC,
preload, native delivery, E2E. Gates C3 Phase 2.

### C3. Launch modes (interactive vs orchestrated Claude) (M) — *bigchange_claude_launch_modes*
- **State:** Ph0/Ph1 complete 2026-06-05. `launchMode: 'orchestrated' | 'interactive'`
  is in shared/IPC contracts and instance records with legacy default
  `orchestrated`; the draft composer shows a Claude-only launch-mode segmented
  selector with per-provider memory; creation payloads carry the mode; Loop Mode
  and workflow launches reject interactive sessions before routing/orchestration;
  adapter creation fails loudly rather than silently running interactive sessions
  as orchestrated while the terminal runtime is absent.
- **Remaining:** Ph2+ interactive terminal runtime (`local-loopback` node, xterm.js,
  PTY/router/native delivery) is still `[blocked]` on C2. Ph3/Ph4 polish remains
  deferred until the terminal runtime exists.

### C4. Intent routing Phase 1 + 2 `[unblocked]` (S–M) — *bigchange_intent_routing_plan* ✅ DONE 2026-06-03 / verified 2026-06-05
- **State:** `model-router.ts` enabled + wired into child spawn. `src/main/routing/route-task.ts`
  provides the shared helper; Loop Mode has `routingIntent` opt-in. Verified with
  `src/main/routing/route-task.spec.ts`.
- **Remaining:** live `npm run dev` Loop confirmation only; Ph2b–4 remain optional.

---

## D. Architectural rocks `[rock]` (multi-week, operator decision)

### D1. Thin-client event API (XL) — *claude1 #1*
SSE/event-bus exist as a secondary path; main UI still on IPC.

### D2. Schema-first typed RPC codegen (L) — *claude1 #2 · claude2 #5*
`packages/contracts` exists; no codegen of preload bridge/renderer client from one spec
(~775 hand-maintained channels).

### D3. Adapter unification (L) — *claude1 #3*
`BaseProvider` + event bridge normalize, but adapters still ~7.2k LOC hand-rolling framing;
official SDKs not adopted. **Highest-leverage seam — unlocks A6 mock+E2E.**

### D4. utilityProcess CLI spawn+parse offload (L) — *claude1 #16*
Distinct from main-thread offload (§F): this moves CLI subprocess spawn + stdout JSONL
parse off-main. `KeyedCoalescingWorker` exists but unused for it.

### D5. Plugin sandboxing (L) — *claude1 #23*
Plugins run in-process via dynamic `import()`. (Related to B11.)

---

## E. UX / renderer features `[ux]`

| # | Feature | State / source |
|---|---------|----------------|
| E1 | Checkpoint timeline UI | backend `git-checkpoint-store` solid — claude1 #15 |
| E2 | Per-hunk diff accept/reject + steering + Mermaid plan | `diff-viewer` per-line exists — claude1 #29 |
| E3 | MCP marketplace UI | `shared-mcp-coordinator` halfway — claude1 #30 |
| E4 | Multi-provider compare / "Ask council" UI | backends done (`multi-provider-compare-service`, `cross-model-review-service`) — claude1 #11 · claude2 #19 · copilot P2 #19 |
| E5 | Right-docked PanelZone | claude2 #23 |
| E6 | Attention-zone fleet dashboard | claude2 #24 |
| E7 | Theme families + status tokens + color lint | claude2 #26 |
| E8 | Per-message model picker + context ring + effort selector | claude2 #27 |
| E9 | Split-screen dual-session compare | claude2 #28 |
| E10 | Setup Center broadening (MCP/browser/remote/mobile/channels/sandbox) | base `setup-center.component` exists (claude2 #25 done) — copilot P2 #22 |
| E11 | Renderer state/perf conventions doc + render-count tests | copilot P1 #14 |
| E12 | Visual/attachment observer role | copilot P2 #23 |
| E13 | Session sharing links (gen + access control + web replay) | `SessionShareService` + SSE exist — claude1 #14 |
| E14 | Repo-map injection (ranked token-budgeted map + @-mention) | codemem + BM25 exist — claude1 #27 (M–L, backend-heavy) |
| E15 | Usage/cost analytics expansion (per-session persistence + report) | UI + pricing exist — copilot P1 #18 (overlaps A5) |

---

## F. Main-thread offload (partly `[blocked: packaged rebuild]`)

### F1. Offload Phases 3/5/6 + CI guard (M) — *copilot P0 #4 · offload memory*
Ph1/2/3/4 done (ledger worker, code-search, enricher offload, bounded reads). Ph3 was
already present in `context-worker-main.ts` (`build-observation-context` + `build-project-memory-brief`).
Remaining: startup learning loads (Ph5), session save (Ph6); CI guard blocking sync `better-sqlite3`
in hot paths; extend `event-loop-lag-monitor` to startup/spawn paths.

### F2. Project-memory brief offload (M) — *project-memory-brief-offload-spec* ✅ DONE 2026-06-05
- **State:** startup project-memory brief assembly is worker-first via
  `build-project-memory-brief` context-worker RPC. The worker uses a worker-safe,
  source-backed builder over the project-knowledge read model, returns clone-safe
  brief snapshots, records startup brief diagnostics when possible, preserves a
  main-process fallback when the worker is degraded or returns no result, and keeps
  context-worker import isolation intact.
- **Remaining:** none headless-buildable. The worker builder intentionally avoids
  importing the full main-process `project-memory-brief` service because that path
  pulls Electron/main-process-only history and recall dependencies.

---

## G. Deferred / won't-do-now `[deferred]`

- **Thin-client replatform** — trigger condition unmet (needs Pieces A/B/C shipped + a
  measured Mac resource complaint).
- **SCM idempotency journal** (claude2 #33) — premature; depends on SCM write primitives
  that don't exist yet.
- **CDP reverse-proxy** (chrome-devtools) — only if multi-profile / live-switching needed.
- **Architectural misfits, dropped:** claude2 #13 stdout compression, #16 LSP mid-turn
  inject, #34a post-compaction health canary (subprocess executor makes them wrong-fit).
- **Auto-update ship-readiness** `[operator]` (claude1 #24) — feature is BUILT
  (`updates/auto-update-service.ts` + spec + `electron-builder.json` publish block);
  only ships when you supply a real feed URL + code-signing/notarization certs
  (`notarize` still false). Operator action, not dev work.

---

## H. Done — listed only so they're not re-opened

Mobile app Ph0–3 + Ph4 (`_completed` 2026-06-03; verified running on iPhone 17 — wss TLS, camera
attachments, Face ID, push, history all shipped; 2026-06-03 changes uncommitted) · browser-gateway timeout
cascade (`_completed`) · remote-node tool discovery (`_completed`) · chrome-devtools
managed-profile attach (core + both polish items shipped; only free-text→dropdown nicety +
deferred proxy remain) · Remote Piece A code · evidence-resolver spine · loopfixex LF-1…8 ·
provider auto-update Ph1 · claude1 fast-wins (#5/#6/#7/#8/#11/#12/#13/#17/#18/#19/#21/#22/
#24/#25/#28/#31) · claude2 shipped primitives (#8/#10/#12/#19/#25/#34b + the §A7 cores).
