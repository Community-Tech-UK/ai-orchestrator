# Dead Code / Unwired Code / Over-Engineering — Audit & Fix Plan (2026-07-06)

**Status: IMPLEMENTED + VERIFIED — completed plan kept for audit traceability.**

## How this audit was done

- 20 parallel audit agents covered **every source directory** (2,129 non-spec TS files + templates/styles/configs). Each verified every claim with repo-wide reference greps, checking all alternate reachability roots (SEA builds, worker entry points, scripts, git hooks, dynamic/string-based IPC wiring, Angular templates/routes).
- Mechanical passes: ts-prune over both tsconfigs (~3,890 raw candidates, all agent-verified — heavy false positives from barrels/generated code), jscpd duplication scan, LOC outliers, TODO census.
- Per-slice evidence reports: `_scratch/audit-2026-07-06/findings-*.md` (20 files). IPC lifecycle scan data: `_scratch/audit-2026-07-06/ipc-lifecycle-*.{js,json}` + `scan-output2.txt`.
- Six of the largest claims independently re-verified by the orchestrator.
- By-design orphans (fuseHybrid, policy-engine, lease-dispatch/authority-lease+dispatch-log, lesson-store) confirmed and **excluded** per project memory.

## Pass 2 — fresh-eyes verification (2026-07-06, complete)

A full second pass re-verified every pass-1 finding adversarially (17 verifiers, reversed file order, shifted slice boundaries) plus a mechanical re-check of all 108 whole-file deletion candidates. Full verdict log: `_scratch/audit-2026-07-06/pass2-verdicts.md`.

**Tally: ~130 findings re-verified → 1 refuted, 1 partially refuted, 8 amended (scope only), ~35 new findings.** All corrections are folded into the phases below. The two refutations:

1. **REFUTED — "draft composer branch unreachable" (was Phase 2h):** `instance-welcome.component.ts:147-148` passes `instanceId="new"` to `<app-input-panel>` from an **inline TS template**. The branch is the live new-session welcome flow. Do NOT delete. Only `onProviderSelected`/`onModelSelected` (~15 LOC) are dead.
2. **PARTIALLY REFUTED — the ~49 dead-channel list:** `VERIFY_START`, `VERIFY_GET_RESULT`, `VERIFY_GET_ACTIVE`, `VERIFY_CANCEL`, `VERIFY_GET_PERSONALITIES`, `VERIFY_CONFIGURE` are **live** `ipcMain.handle` registrations (verification-ipc-handler.ts). Only `VERIFY_STARTED/AGENT_RESPONDED/COMPLETED` are dead. The remaining ~43 were spot-re-verified dead.

**Verification traps confirmed by pass 2 — mandatory checks before ANY deletion:**
- Grep inline `template:` strings inside `.ts` files, not just `.html` (caused refutation #1).
- Check every export in a "dead" file individually — live constants/types hide in dead component files (provider-menu, unified-model-menu, unified-cli-response, artifact-cleanup.types).
- CSS classes applied via dynamic `[class]="'status-' + x"` bindings defeat static grep (`.status-*` in `_base.scss` is live).
- Never batch-delete wildcard-named groups (VERIFY_* mixed live+dead).
- This sandbox's `rg`/`grep` are wrapper functions that fail silently in scripts — validate every automated sweep against a known-live symbol first.

## Headline numbers (post pass 2)

| Category | Est. LOC |
|---|---|
| Confirmed dead, safe to delete (certain, twice-verified) | ~32,000–35,000 (incl. orphaned specs; +~2.6k new, −~150 refuted) |
| Unwired features needing a wire-or-delete decision | ~7,400 (+ ConflictDetector 395, webhook blast radius ↑) |
| Collapsible duplication/boilerplate | ~4,400 (of which ~3,400 is IPC handler try/catch boilerplate) |
| **Real runtime bugs found by the audit** | **8 clusters** (all re-verified end-to-end in pass 2) |

⚠️ **Concurrent-writer caution:** a loop agent was editing this repo during the audit. Every deletion batch below must re-grep its symbols at fix time before deleting (cheap; the findings files list the exact symbols/lines).

---

## Phase 1 — Fix real bugs first (these are broken today)

1. **Six renderer pages call IPC channels with no backend handler** → Electron `No handler registered` rejections at runtime. Channels: `DEBUG_EXECUTE/GET_COMMANDS/GET_INFO/RUN_DIAGNOSTICS`, `LOG_GET_LOGS`, `STATS_GET_STATS`, `COST_GET_HISTORY`, `LEARNING_GET_PATTERNS/SUGGESTIONS`, `ARCHIVE_SEARCH`, `REMOTE_CONFIG_SET_SOURCE/STATUS`. Callers: logs-page, stats-page, training-page, archive-page (search box), remote-config-page. Root cause: old/new API naming drift — old handlers exist under different names with no preload exposure. **Decision per channel: implement handler (delegate to existing managers) or repoint renderer at the old canonical channel and delete the orphan.** (findings-ipc-preload F1, findings-contracts-sdk F1/F2)
2. **Reflection read-back query bug**: `observation-store.ts:166` uses `getReflections({limit:1})` + `.find(id)` — cross-restart reflection recall silently broken. Fix: add `getReflectionById()` to `rlm-observations.ts`, use it in the cache-miss branch. (findings-security-misc F7)
3. **`ElectronIpcService` name collision**: deprecated 630-line `IpcFacadeService` is exported as `ElectronIpcService` (`core/services/ipc/index.ts:640`); 30 files get the facade, 45 get the real class under the same identifier. Immediate fix: rename the alias. Full fix: migrate the 30 barrel importers to domain IPC services, delete the facade (~530 LOC). (findings-renderer-core F3)
4. **Unicode prompt-injection sanitizer unwired** (`security/unicode-sanitizer.ts`, defends HackerOne #3086545; sibling surrogate-sanitizer's comment claims it's wired — it isn't). **Recommend wiring into the provider-text cleanup path, not deleting.** (findings-security-misc F3)
5. **Hooks UI offers 11 of 13 events that never fire** (only PreToolUse/PostToolUse are triggered). Users configuring SessionStart/BeforeCommit/Stop hooks get silent no-ops. Pair with the EnhancedHookExecutor decision in Phase 5. (findings-mcp-ext F1)
6. **Verification real-time UI frozen**: the live `verification.store` subscribes to `VERIFICATION_AGENT_ERROR/ROUND_PROGRESS/CONSENSUS_UPDATE` — never emitted. **Recommend wiring the emits** (the per-agent stream pattern already exists at cli-verification-ipc-handler.ts:596) so the live dashboard updates in real time; the second subscriber (`agent-stream.service`) is in the dead subtree and gets deleted in Phase 2a regardless. (findings-ipc-preload F2)
7. **Contracts packaging blind spot**: add `"./schemas/loop"` and `"./schemas/quota"` to `packages/contracts/package.json` exports so `check-contracts-aliases.ts` covers them (they're runtime-live via register-aliases; currently unguarded — AGENTS.md Gotcha #1 class). (findings-contracts-sdk F11)
8. **`tsconfig.worker.json` rootDir bug**: `rootDir: "src"` fails `tsc -p` with ~30 TS6059 (esbuild-only today). Set `rootDir: "."` to match tsconfig.electron.json. (findings-peripheral F3)

Verification gate: `npx tsc --noEmit` + spec config, `npm run lint`, targeted specs, then manually exercise the six previously-broken pages.

## Phase 2 — Renderer dead-code deletion (~24k LOC, all "certain")

Batch by feature; after each batch: both typechecks, `npm run lint`, `npm run check:ts-max-loc`, targeted `test:quiet`.

- **2a. verification/ launcher subtree** (~6,036 LOC, 15 files + `verification/index.ts` barrel + orphaned specs). Keep the live dashboard/results/settings set — exact keep-list in findings-renderer-features-b F1.
- **2b. training/ EnhancedGrpoDashboard tree** (~4,295 LOC: dashboard + all 7 chart components + training-export.service + barrel).
- **2c. debate/ EnhancedDebateVisualization tree** (~3,305 LOC: component + 4 sub-components + 2 services + 2 barrels).
- **2d. rlm/ ab-testing + rlm-analytics pages** (~2,537 LOC, never routed).
- **2e. Orphan feature dirs** (~2,450 LOC): thinking/, context/ (active-files + compaction-indicator), routing/routing-explanation, coming-soon/. *Confirm thinking/context aren't paused-but-planned first.*
- **2f. Superseded components** (~2,390 LOC), with pass-2 corrected extraction steps:
  - channels-page (537), copilot-model-selector (540 — zero refs incl. its exported `CopilotModel`/`DEFAULT_COPILOT_MODELS`), session-share component+spec (831), chat-sidebar (236 — rewrite only the dead `it()` block of chat-components.spec.ts, the other two blocks test live code), chat-runtime-state (114).
  - provider-selector (~395): **extract only `ProviderType`** (4 importers) — `ProviderOption` is internal-only, no extraction. ⚠️ Three distinct `ProviderType` types exist (this one, provider-state.service.ts:28, shared/types/provider.types.ts:23); make sure input-panel keeps importing the right one.
  - model-menu trio (corrected): `model-menu.component.ts` + spec fully deletable (incl. `versionDescending`). `provider-menu.component.ts`: **extract 4 live consts** (`DEFAULT_CHAT_PROVIDERS`, `DEFAULT_INSTANCE_PROVIDERS`, `PROVIDER_MENU_LABELS`, `PROVIDER_MENU_COLORS` — 5 consumer files) and preserve the spec's value-assertions on them; `PROVIDER_MENU_ORDER` is also dead. `unified-model-menu.component.ts`: **extract `UnifiedSelection` + `UnifiedReasoningOption` types**, then delete class + spec (346).
- **2g. Shared/core cleanup** (~2,600 LOC): 5 dead shared components (1,015), panel-zone+search-panel (582), AgentStore+spec (906), GitProbeService (43), render-count-harness (484 — or adopt it), dead barrels (`app/shared/index.ts`, `components/index.ts` → direct-import PageHeaderComponent, 4 feature barrels, rlm/context-browser barrel), small helpers per findings.
- **2h. instance-detail/settings**: TranscriptScrollStrategy (139 + stale comment in instance-output.store.ts:140), ~~draft-composer branch~~ **REFUTED in pass 2 — the draft branch is live (new-session welcome flow); delete only `onProviderSelected`/`onModelSelected` (input-panel.component.ts:1556,1564, ~15 LOC)**, dead SCSS utilities (+ pass 2: all 6 `.animate-*` classes + `scaleIn`/`glow` keyframes in `_animations.scss:83-123`, ~40 LOC), misc small items per findings-renderer-features-a. New small dup: `getSystemFileManagerLabel` reimplemented in instance-list.component.ts:1264 — import from output-stream.utils.ts instead.

## Phase 3 — Main-process dead-code deletion (~7k LOC "certain")

- **3a. core-infra sweep** (~2,180 LOC): retry-manager.ts (484 — delete + bootstrap registration; `retryWithBackoff`/ErrorRecoveryManager is the live path), claude-quota-probe.ts (243), buffered-writer.ts (191), keyed-coalescing ×2 (270), sequential.ts (118), feature-gates.ts + feature-flag-evaluator.ts (147), migration-manager + startup-optimizer (134), config-layers.ts (95), platform.ts (76), provider-env.ts (60), otel dead trace helpers (46), + small items (findings-core-infra F14–F17). *singleton-reset.ts (300) is plan-tracked (2026-03-02 remediation plan Tasks 3/28) — decide in Phase 5.*
- **3b. cli/** (~590): 5 dead barrels/shims (215), cli-error-handler dead tail (360 — keep `CliError` + `classifyError`), createCliAdapterAuto (9).
- **3c. mcp/tools/hooks** (~770): tools/ barrel cluster (651: StreamingToolExecutor, ToolUseSummarizer, classifyToolError, FileWatcherCache + specs), McpToolBridge (77), FsWatcherManager (37), createOrchestratorTools + small exports. Also delete the now-dead `STREAMING_TOOLS`/`FILE_WATCHER_CACHE` (+4 more) flags in `shared/constants/feature-flags.ts` (cross-confirmed orchestration F8 ↔ mcp-ext F3).
- **3d. data-layer** (~840): ast-chunker.ts (765 + LOC-ratchet entry), duplicate `Migration` type (rlm-database.types.ts:184), listCompactionMarkers, 3 dead read fns, small getters/wrappers.
- **3e. indexing/codemem** (~850): reranker.ts (291) + search-analytics.ts (446) + 4 dead config exports; getMerkleNode + `merkle_nodes` writes (add a drop-table migration or leave table, but stop writing); wrapIndexingService, shutdownCodemem, get-stats RPC type, isLspFeedbackEnabled.
- **3f. instance/session/state** (~450): state/selectors.ts + observers.ts (100 — and decide on the write-only `AppState.instances` slice), OrphanedMessageCleaner (107 — or wire into failover, decision), getReviewAgentsByFocus, InvalidTransitionError alias collapse, RecoveryPlanKind, SessionRecoveryHandler alias collapse.
- **3g. security small deletions** (~210): permission-rule-compiler + matcherCache + getCompiledMatcher (72), bash-validator shim + BASH_GET_CONFIG handler + renderer plumbing (54+), env-filter/secret-redaction dead helpers (35), ToolPermissionChecker dead surface (25), ReactionEngine session.* stubs (~20 — or wire, decision).
- **3h. workspace/operator/orchestration** (~700): JitterScheduler (266 — or actually migrate the 5 setInterval sites; decision), OperatorRunStore 7 dead methods (110), planProjectVerification (153), WorkerThreadLaneGateway (50), lazy-getter block in orchestration/index.ts (58), permission-evaluator.ts (98 — or finish migration; decision), orchestration-hud-builder shim, workflow-transition dead fns, misc.
- **3i. peripheral** (~200): orchestrator-benchmark index.ts, buildContextMessages ×2, worker-agent small exports, readPatch; + pass 2: benchmark reporting/query surface (`evaluateSingleResponse` 77, `formatScore`/`formatNiahScore`, `loadTasksByCategory/Complexity`, `getSetupScriptPath`, `getRunsForTask`/`listSessions`), mobile `needsAttention()`.
- **3j. NEW from pass 2 — orchestration "instantiate-and-abandon" trio** (~1,601 LOC): `voting.ts` (776 — whole VotingSystem), `synthesis-agent.ts` (491), `restart-policy.ts` (334 — upgraded from pass-1 F7 "duplicate": it's fully unwired; supervisor.ts owns the live backoff). Delete all three + their `orchestration-bootstrap.ts:19-29` instantiations + specs + singleton-reset entries.
- **3k. NEW from pass 2 — misc main-process dead files/members**: `mcp/permission-ipc-server.ts` (202, dead TCP bridge behind never-imported `mcp/index.ts` barrel — delete both), `util/uuid-v7.ts` (76 + spec), `CliDetectionService` 6 dead methods + 2 standalone wrappers (cli-detection.ts, ~55), `shared/types/unified-cli-response.ts` (**~490 of 502 LOC dead — MUST preserve the line-502 `CliType`/`CliInfo` re-export**, move it to the index barrel), 9 dead type exports in orchestrator-tools.ts (:69-264), `queryRelevantObservations` (observation-store.ts:198-247 — dead AND buggy; delete or fix with Phase 1.2), 2 inert `vi.mock('../../cli/claude-cli-adapter')` lines in instance-manager specs, orchestrator-tools/getSharedMcpRepository + mcp-record-storage alias cleanup, `TodoManagerEvents`, `defaultOperatorRunBudget`, `PauseCoordinatorEvent`, 3 unused `export default` in memory/*, `TREE_SITTER_SUPPORTED_LANGUAGES` cluster (indexing/config.ts:296-313), `isBrowserGatewayMcpBridgeAvailable`, state-module deepening (AppState.global `creationPaused`/`activeTaskCount`/`shutdownRequested` + `Store<T>.subscribe` half — bundle with 3f).
- **3l. NEW from pass 2 — systemic dead `_reset*ForTesting` + convenience-getter sweep** (~17 helpers, ~90 LOC): identified across cli (3), browser-gateway/ipc (7), workspace/updates/voice/automations (4), storage/history/rlm (3+). Do as ONE scripted pass: find `_reset\w+ForTesting`/`getXxx(): X { return X.getInstance() }` exports with zero callers, delete or wire into specs (each is also a test-isolation gap).

## Phase 4 — Types & contracts cleanup (~1.4k LOC)

- **4a.** Delete the orphaned IPC channel constants — **CORRECTED list: ~43, not 49.** Pass 2 proved 6 `VERIFY_*` request channels are LIVE handlers (`VERIFY_START/GET_RESULT/GET_ACTIVE/CANCEL/GET_PERSONALITIES/CONFIGURE` — do NOT touch); only the `VERIFY_STARTED/AGENT_RESPONDED/COMPLETED` event trio is dead. **Verify each remaining constant by name AND literal string at fix time** (sampled error rate was 2/15). Note the `VERIFICATION_VERIFY_MULTI/GET_ACTIVE/GET_RESULT/AGENT_ERROR/ROUND_PROGRESS/CONSENSUS_UPDATE` group's cleanup is 3-4× the channel-file LOC: live-but-uncalled preload wrappers (orchestration.preload.ts ~:679-778) + verification-ipc.service.ts + ipc/index.ts:611-615 must go with them. Plus 7 dead CAMPAIGN_* constants, WATCHER_* vertical, WORKTREE_DELETE vertical. Regenerate preload channels; run `verify:ipc`.
- **4b.** `src/shared/types` dead clusters (~1,100 LOC post-pass-2): per-file lists in findings-shared F2–F20. Corrections/additions: branded-ids is **16 of 22** factory/type pairs dead (not 6 — live set: toInstanceId, toSessionId, toDebateId, toVerificationId, toConsensusId, toWorktreeId, toChatId); + `WORKFLOW_TERMINAL_STATES`/`isTerminalPhase`/`isActivePhase` (workflow-lifecycle.types.ts:59-71), `MemoryToolType`/`MemoryToolAction` (unified-memory.types.ts:61-70 — but ShortTermState etc. are structurally live, keep), `RerankerConfig`/`RerankResult` + SearchConfig rerank fields (codebase.types.ts:297-325, dead with the reranker), artifact-cleanup.types: **only** `ArtifactCleanupCandidate`/`ArtifactCleanupResult` (the other 2 exports are live via artifact-attribution-store). title-derivation.ts exports are internally-used — NOT dead. Re-grep each symbol at fix time.
- **4c.** Consolidate duplicate types across shared↔contracts — now **7 known pairs**, not 1: `InstanceStatus` (original), plus pass 2's `ImageResolveKind`/`ImageResolveFailureReason`, `PluginCapability`/`PluginIsolation`/`PluginSlot`/`PluginHookEvent` (plugin-manager imports from BOTH trees), `VerificationVerdictReadyPayload`. Contracts canonical; shared re-exports.
- **4d.** Contracts small items: 4 dead browser-interaction type aliases, InstanceEventKind, ~85 unused `z.infer` payload aliases (per-file re-check), 6 dead Zod schemas, instance.schemas re-export block.
- **4e.** Decide `WORKFLOW_STARTED/COMPLETED` + `HOOKS_TRIGGERED`: forward to renderer (loop-handlers pattern) or delete the 3 constants.

## Phase 5 — Wire-or-delete decisions — **RESOLVED by James 2026-07-06: WIRE all 13 user-facing/reliability items**

**Decisions:** wire = permission memory (batch + learned patterns), lifecycle hooks (fully featured), artifact cleanup, webhooks, permission audit log, reset-all settings, operator project list, remote file watching, orderly shutdown (GracefulShutdownManager), timer staggering (JitterScheduler), index drift repair (PeriodicScan), memory contradiction check (ConflictDetector), agent network/file allowlist enforcement. SandboxManager stays DELETE. Engineering-hygiene rows (metrics, typed events, singleton-reset, sdk barrel, write-only state) handled per plan without product input: instrument metrics minimally or delete wrappers, delete unenforced typed-event interfaces, finish Task 28 singleton-reset wiring (preferred over delete given ~17 dead reset helpers), keep sdk barrel as external surface + ban internal `@sdk` barrel imports, drop write-only state.

**New scope requested with the wire-ins (design each briefly before building):**
1. **Hooks**: full lifecycle coverage + in-UI guidance — a reference panel listing every available hook event, when it fires, payload/env vars, and examples (BeforeCommit lint gate, SessionEnd summary, etc.). Trim nothing; make all 13 events real.
2. **Webhook suggestion learning**: detect repeated manual prompt patterns correlated with external events (e.g. "fix this broken pipeline" repeatedly after pushes) and proactively suggest creating the corresponding webhook automation. Likely home: observation/reflection pipeline (which Phase 1.2 fixes) feeding a suggestion surface.
3. **Settings export/import**: alongside reset-all, add "save current settings" — export settings to a file and import on another machine. Respect secret hygiene: exclude/encrypt credentials and machine-specific paths.

Original decision table follows for reference:

| Item | LOC | Recommendation |
|---|---|---|
| SandboxManager (Seatbelt/Bubblewrap, zero enforcement call sites) | 618 | **Delete** — an inert "safeguard" is worse than none; real gating exists (PermissionManager/BashValidation). Rebuild deliberately if OS sandboxing is wanted. |
| EnhancedHookExecutor + executor/* (parallel unreachable hook engine) | 1,627 | Wire into HookManager **or** delete + trim Hooks UI event picker (pairs with Phase 1.5). Half-finished migration — pick a direction. |
| permission-manager-extensions (batch + pattern learning) | 362+ | **UPGRADED by pass 2: wire it.** The permissions settings tab already has the full UI (loadLearnedPatterns/approve/reject, defensively no-oping) and the backend exists — only the contracts channel + preload + IPC handler middle layer was never built. Both ends exist; build the middle (~3 channels) and a real feature lights up. Delete only if permission-learning is explicitly unwanted. |
| ConflictDetector (memory contradiction detection, NEW pass 2) | 395 | Wire into the memory-write/observation-ingest path (stale/contradictory memories are a real problem for the memory system) or delete. Needs the LLM-fallback path designed before wiring. |
| GracefulShutdownManager | 223 | Wire into `index.ts` shutdown (it's better than the ad-hoc path) **or** delete + fix stale resume-hint comment. |
| OperatorProjectStore + ProjectRegistry (+ planProjectVerification) | ~780 | Delete or add the IPC/MCP surface; relates to whether "operator projects" ships. |
| Webhook subsystem (server/store/IPC, tested, unreachable — no preload/UI; blast radius incl. 'webhook' automation-trigger type, role-capability category, 2 DB tables) | ~550 | Wire (build preload domain + small routes UI) if event-driven automations from outside the app are wanted (CI webhook → automation); else delete the full footprint. |
| Remote file-watch `fs.event` RPC (defined both ends, never sent — worker watch() body is a stub) | ~40 | Wire (emit from worker watch loop + handle in rpc-event-router) if remote-node file watching matters; else delete message type + schema. |
| sdk/index.ts barrel (+ ./tools, ./providers subpaths) | 325 | Keep as external plugin API **if intentional**: add `@sdk` to verify-package-exports ban list + docblock note. Else stub like contracts. |
| testing/singleton-reset.ts | 300 | Finish remediation-plan Task 28 wiring or formally abandon (update the plan doc). |
| FilesystemPolicy/NetworkPolicy scope | — | Wire into real agent network/file surface or document as preflight-advisory-only. |
| JitterScheduler | 266 | Delete (migration never happened) unless resume-jitter still wanted. |
| ArtifactCleanupService | 145 | Delete or schedule as maintenance task. |
| PeriodicScan (codemem drift re-index) | 72 | Wire from index-worker idle loop or delete. |
| *CliAdapterEvents typed-emitter interfaces | 90 | Delete (unenforced) or adopt a typed EventEmitter base (real work). |
| OTel METRICS/withMetrics | 75 | Instrument the named call sites or delete wrappers (keep initMetrics/tracer). |
| PermissionDecisionStore.getByInstance / ToolPermissionChecker denial history | ~50 | Build a permission-audit UI panel or delete the read surfaces. |
| resetAll settings / SettingsStore.reset | ~10 | Add a "Reset all settings" button or delete both. |
| AppState.instances write-only slice | ~30 | Drop the writes or add the intended consumer. |

## Phase 6 — Deduplication & boilerplate (~4.3k LOC)

- `checkStatus()` ×6 CLI adapters → shared `probeVersionStatus()` helper (~180 LOC).
- `normalizeElementCandidates` ×2 (browser-gateway) → single module (~100).
- TOML/Windows-wrapper helpers ×3 (browser MCP configs) → `mcp-config-toml-helpers.ts` (~60; optional generic 4-provider builder).
- hook-command.ts 98-line self-dup; hook-executor.ts 69-line self-dup (jscpd-confirmed).
- node-filesystem-handler ↔ filesystem-service 83-line dup; MCP forwarder boilerplate ~200 across 3 files.
- `sleep`/`delay` ×3 (orchestration) → one util; `findGitRoot` ×3 → consolidate on vcs-manager's git-command version; `shortHash` ×2 → one util. Backoff duplication resolved by pass 2: restart-policy.ts is dead (Phase 3j), leaving supervisor.ts as the only impl — no reconciliation needed.
- Pass-2 additions: `pathCompareKey`/`isInsideOrEqual`/`sleep` block duplicated byte-for-byte (workspace/git/worktree-cleanup.ts:6-20 ↔ orchestration/loop-worktree-reconcile.ts:46-58 — import instead); ignore-pattern lists drifted across 4 locations (canonical `DEFAULT_CODE_INDEX_IGNORES` in code-index-watcher.ts vs 3 lists in indexing/config.ts vs auto-defaults — `.aio-loop-*` exclusions only exist in the canonical one, so preflight estimates diverge from the real watcher; consolidate or document).
- **validatedHandler migration** (~3,400 LOC of hand-rolled IPC try/catch across ~73 handler files): incremental, per-domain, lowest priority — do opportunistically or as a scripted codemod with full-suite gate.

## Phase 7 — Guardrails so it doesn't regrow

1. Add **knip** (or ts-prune) with a tuned config (entry points: main/renderer/worker/SEA builds/scripts; ignore generated + barrels) as `npm run check:dead` — warn-level first, ratchet later.
2. Extend the IPC lifecycle scan (`_scratch/audit-2026-07-06/ipc-lifecycle-scan.js`) into `scripts/verify-ipc-usage.js`: every contracts channel must have handler+preload+caller (or an explicit allowlist) — this would have caught all of Phase 1.1 and Phase 4a. Wire into `verify`.
3. Ban new same-name aliasing of deprecated classes (the ElectronIpcService lesson) — lint rule or review checklist.
4. Convention: a feature merged "built but not wired" must carry an `// UNWIRED-BY-DESIGN(<reason>)` marker or it's fair game for deletion (formalizes the fuseHybrid precedent).
5. Add two scripted sweeps (pass-2 systemic patterns): dead `_reset*ForTesting` helpers and dead `getXxx() → getInstance()` convenience getters — both recur across ≥6 slices; one script beats one-off fixes and doubles as a regression check.
6. Also wire `flushLifecycleTraces()` into the shutdown path (one line, prevents dropped diagnostic traces) and add `MagicPromptService` to singleton-reset registry (convention gap).
7. Follow-ups parked: Zod schema-vs-payload drift audit (ipc-preload F8), ~98 unresolved count=2 shared-type candidates (shared F23), ~100 preload-exposed-no-caller channels (scan-output2.txt), vcs/remotes + summarization-worker spec coverage gaps, mobile-gateway unused request types vs deferred mobile phases, `.status-waiting` CSS reachability (couldn't be proven either way — left alone).

## Execution & verification protocol

- Order: Phase 1 (bugs) → 2 (renderer deletions) → 3 (main deletions) → 4 (types/contracts) → 6 (dedup), then Phase 5 wire-ins as feature work (decisions resolved 2026-07-06 — all wire). Phase 5 items that overlap deletions are now EXCLUDED from deletion batches: keep JitterScheduler, ArtifactCleanupService, PeriodicScan, GracefulShutdownManager, ConflictDetector, permission-manager-extensions, webhook subsystem (incl. its trigger type/capability/tables), operator project registry + planProjectVerification, fs.event protocol, OperatorRunStore stalled-node/instance-link methods (re-evaluate once operator projects wire up), PermissionDecisionStore.getByInstance, ToolPermissionChecker denial surface, resetAll/SettingsStore.reset. Suggested wire-in order: quick wins first (reset-all + export/import, PeriodicScan, verification events, flushLifecycleTraces, JitterScheduler, ArtifactCleanupService), then permission memory (~3 channels), permission audit log, GracefulShutdownManager, hooks (biggest), webhooks (+ suggestion learning last, after the reflection fix proves out).
- Every batch: re-grep symbols → delete → `npx tsc --noEmit` + `-p tsconfig.spec.json` → `npm run lint` → `npm run check:ts-max-loc` (update ratchet entries for deleted files) → targeted `npm run test:quiet -- <specs>`.
- After each phase: full `npm run test:quiet` + `npm run verify:ipc && npm run verify:exports && npm run check:contracts`.
- Final gate: `npm run verify` (includes architecture check + electron smoke) + manual pass over the six Phase-1 pages and one page per deleted-adjacent feature (verification, training, debate, rlm, chats, models).
- Do not delete or edit past DB migrations; to retire `search_events`/`merkle_nodes`, add a new forward migration (or leave tables, stop writing).
- Keep by-design orphans untouched: fuseHybrid (+overFetchCount), policy-engine, authority-lease/dispatch-log, lesson-store, appendToStoryFile (likely), loop-test-commands fixture.
