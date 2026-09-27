# Outstanding plans sweep (2026-09-23)

**Status:** COMPLETE (2026-09-23). James asked for every outstanding (non-`_completed`) plan in the
AIO folders to be made 100% code complete. Every agent-buildable item below is implemented and
verified; the canonical gates are green and the fresh-eyes completion review passed on round 5
(`VERDICT: PASS`, no findings). Deferred live checks are in
[2026-09-23-outstanding-plans-sweep_livetest.md](2026-09-23-outstanding-plans-sweep_livetest.md) and
[PINGPONG_IMPLEMENTATION_STATUS_livetest.md](PINGPONG_IMPLEMENTATION_STATUS_livetest.md). Items that need
a decision or external access are listed at the end, not built.

## Scope

Every plan-shaped document without a closed suffix in `docs/plans/`, `docs/superpowers/plans/`,
`docs/superpowers/specs/` and `../ai-orchestrator-plans/`. Out of scope: `_livetest.md` documents
(live checks only, no code), `_prompt.md`/`PROMPT_*` documents (instructions, not plans), and
`2026-09-23-browser-login-recipe-persistence_plan.md` (created and being worked by a concurrent
session at 02:11 today).

## Audit method

Nine read-only audits, then an Opus re-verification of every claimed gap. The first-pass audits
over-reported gaps (hibernation manager, cleanup registry, file locks, the concurrency classifier and
the Codex output cap were all called "missing" but exist), so every "missing" claim below was
re-checked against the executing code before it was accepted.

## Findings: closed as done or superseded (rename only, reconciliation note added)

| Document | Verdict | Key evidence |
|---|---|---|
| `2026-03-04-file-explorer-multiselect-plan.md` | Done | `file-explorer.component.ts` selection + multi-drag, `drop-zone` `filePathsDropped` |
| `2026-03-07-workspace-benchmarks.md` | Done | Stress fixtures, perf instrumentation, bench harness, 2026-03-07 baseline |
| `2026-02-02-improved-memory-design.md`, `2026-02-03-orchestrator-benchmark-design.md` | Done / superseded | Token stats, benchmark harness; masking lives in `smart-compaction.ts` |
| `2026-03-11-f11/f12/f4-f5/f9` | Done (F5 CDK spike replaced by `TranscriptVirtualizerController`) | Resource governor, hibernation, pool, load balancer, continuity wiring, display-item processor, theme tokens |
| `2026-03-14-instance-startup-optimization.md` | Done | `readyPromise` split, hibernate/wake IPC, warm start |
| `2026-03-14-session-recovery-features.md`, `2026-03-15-session-rehydration-fixes.md`, `2026-03-15-session-resume-improvements.md`, `specs/2026-03-14-session-diff-stats-design.md` | Done | session-repair, fork UI, SessionMutex, fallback history, stuck detector, diff tracker |
| `2026-03-21-edit-last-message.md` | Done | Input-panel edit mode + fork-send |
| `2026-04-01-claude-code-hardening.md` | Done after W5 | Cleanup registry wired into all nine singletons, sync-first shutdown, sibling abort, file lock, classifier |
| `2026-04-02-phase-a` … `phase-e` | Done; BufferedWriter, sequential/mutex helpers, feature gates and compiled permission matchers were built then deliberately removed in `9a204d7a` (dead code audit) | `branded-ids.ts`, output persistence, graceful shutdown, `getAppStore` wiring, EPIPE handling |
| `2026-04-06-remote-nodes-ux.md`, `2026-04-07-remote-folder-browsing.md`, `2026-04-09-remote-session-latency.md`, `2026-04-16-worker-agent-autostart-service.md`, `specs/2026-04-09-codex-reliability-hardening-design.md` | Done | Node picker, remote FS RPC, output batching, service managers, `detached: true` + stdin guard |
| `2026-04-17-wave1/wave2`, `2026-04-21-cursor-cli-provider.md`, `2026-04-26-mode-picker-relocation.md` | Done | Contract subpaths, runtime events, Cursor adapter, draft-composer mode pill |
| `specs/2026-04-18-click-to-preview-revive-on-typing-design.md` | Done under other names | `onPreviewHistory`, `ensureHistoryPreviewRestored`, `HistoryPreviewSessionService` |
| `mobile-timestamps-model-picker-plan.md` | Done | `transcript-items.ts` stamps, `GET /api/models`, `model-sheet.component.ts` |

## Work items

| # | Item | Source | Status |
|---|---|---|---|
| W1 | LT-022: hidden-window heartbeat misreported as a UI freeze | remediation plan | Fixed + regression-tested (revert check: 2 tests fail without the fix) |
| W2 | LT-105: an errored resident Claude turn never completes | remediation plan | Fixed + regression-tested (4 adapter tests + 1 communication test fail without the fix); live check deferred |
| W3 | LT-028: hardened Codex spawns an unusable session | remediation plan | Fixed (refused up front in `adapter-factory.ts`) + regression-tested |
| W4 | LT-189: fallback-notification banner deleted by `1ad92f5e` | open-decisions doc | At this sweep snapshot, not restored: the same commit replaced the banner tests with one asserting the notices do not render, alongside a deliberate paid-fallback policy change. Register corrected; reported for James's decision. James then chose restoration in follow-up D2; `be5cce3b` restored the banner and tests. The rebuilt-app check remains pending. |
| W5 | Hardening Tasks 5–6: `classify()` never receives the raw error | 2026-04-01 hardening | Fixed: error output messages keep the classifier identity (`errorIdentityOf`, abort/inaccessible-path only) and `buildAnnouncement` rebuilds it; tested |
| W6 | Codex containment follow-ups (app-server usage reaches the policy mid-turn; idle ≥80% compacts; recovery cap per send; manual-compaction busy guard) | `ai-orchestrator-plans/2026-07-13-codex-context-pressure-containment.md` | Done: all four gaps confirmed and fixed with revert-proven tests (`stateless-exec-provider.ts`; idle 80% → native compaction; max 3 recoveries per user send with a per-send id; steer-race is a skip; `compactInstance` returns busy mid-turn and emits `compaction-refused`, which the compaction runtime posts as a system message, so Compact now, a composer `/compact` and `/compact` through `sendInput` all tell the user). Policy default stays `off`. Side effects accepted, since they bring Codex app-server in line with the other occupancy-reporting providers: its context updates now feed the epoch tracker's per-update turn count, the legacy `context:warning` at 75/80/95%, and the LT-034 remaining-context guard. After the fresh-eyes review the per-send id is minted at the user-send entry, so the input-cap retry no longer resets the recovery allowance, and a refused manual compaction no longer leaves a checkpoint. Source plan closed `_superseded` with residuals listed |
| W7 | Token/memory Tasks 6–9: early consensus (retargeted to the live `CliVerificationCoordinator`), debate defense skip, decision log for restart-with-summary compaction | 2026-02-22 token/memory plan | Done, all opt-in and off by default: `verification-early-consensus.ts` wired into `cli-verification-extension.ts` (config `earlyTermination`); `skipDefenseOnLowSeverityCritiques` in the debate coordinator; decision log (`observation-extractor.ts`, `compaction-decision-log.ts`, RLM migration 066, setting `compactionDecisionLogEnabled`) wired into `restartCompact` with revert-proven tests. Not built: renderer toggles for the verification/debate options (config and IPC only), and a distinct "dropped" card state (the renderer shows a dropped agent as an error, and `verification:early-consensus` is not forwarded to the renderer) |
| W8 | Architectural remediation leftovers: Zod for remaining payload handlers, literal channel strings, trusted-sender on file/security handlers, path-validator spec | 2026-03-02 arch remediation | Done: Zod validation on auxiliary-LLM (SAVE_SETTINGS validates every value before writing), debug, cost, mobile-gateway REVOKE_DEVICE, circuit-breaker, LSP feedback (a string `"false"` used to switch it on), state-resync, `cli:check`, `cli:scan-all-installs`; literal channel strings replaced (7 missing constants added: five verification channels and the two cost budget alert channels; preload channels regenerated); file and security handlers now answer only the main window (`createTrustedIpcRegistrar`); path validator now follows symlinks (a symlink inside an allowed root pointing outside it used to pass). MODELS_LOCAL_REVIEWER_QUALIFY and the memory channels were already validated |
| W9 | Ping-pong: live check for Skip/Arbitrate into a livetest doc; refresh stale status doc | `PINGPONG_IMPLEMENTATION_STATUS.md` | Done: reconciled, renamed `_completed`, live check in `PINGPONG_IMPLEMENTATION_STATUS_livetest.md` |
| W10 | Register/plan corrections (LT-014/100/196/208/533/534 stale text, LT-189 regression, new fixes) | register | Done for LT-022/028/105/189/208 and the remediation plan's status note |
| W12 | Skill-injection threshold: measure all builtin skills, then set the threshold from data | `2026-08-19-open-decisions-resolved.md` | Done: measured all 36 loaded skills on the runtime backend (`local-tfidf`, because Ollama `nomic-embed-text` is not installed). No threshold separates on-topic from off-topic (24/36 overlap; the right skill ranks first 16/36), so 0.65 stays (similarity injection effectively off) with a comment citing the data; result section appended to the decisions doc; raw data in `_scratch/skill-threshold/` |
| W11 | Rename every closed document; reconciliation notes | all | Done: 32 plans and designs `_completed` (27 in the first pass plus the token/memory, architectural-remediation and improved-memory documents), 18 specs `_completed`, worktree-safety `_superseded`, Ping-pong status `_completed`, external Codex containment plan `_superseded` |

## Verification

- Gates on 2026-09-23: `tsc --noEmit` and the spec typecheck clean; `npm run lint` clean;
  `build:main` and `build:renderer` pass; full suite 26,172 tests, one failure (the context-worker
  import-closure ceiling, raised by one after a HEAD-vs-tree closure diff showed the new migration
  batch as the only addition). `check:ts-max-loc` fails only on `input-panel.component.ts`, which is
  1910 lines as committed on `main` (unrelated to this sweep).
- Fresh-eyes review round 1: FAIL on one major (a dropped blocking-provider agent in early
  consensus was reported as an agent error with zero spend) and minors (LT-105 guard vs a CLI
  self-resumed turn; input-cap retry minting a new send id; stale doc claims; refused compaction
  checkpoint; undocumented W6 side effects). All fixed with revert-proven tests.
- Gates rerun after the round-1 fixes: both typechecks, lint, `check:ts-max-loc` (the `input-panel`
  violation has since cleared), `build:main`, `build:renderer` and the full suite (2198 files,
  26,174 tests) all pass.
- Fresh-eyes review round 2: FAIL on one major (the busy refusal was only surfaced for `/compact`
  through `sendInput`; Compact now and a composer `/compact` refused silently), one minor (an agent
  dropped while still initializing was reported as an agent error) and a doc count nit. Fixed: the
  refusal now comes from the coordinator as `compaction-refused` and is posted once by the runtime
  (the `sendInput`-only emission was removed); `initialize()` and the drop-path `terminate()` treat
  a drop-caused rejection as the drop. Both revert-proven.
- Fresh-eyes review round 3: PASS, with three minors, all fixed and revert-proven: the compaction
  preview dialog now treats a refused compaction as a failure (it showed "Compaction complete.");
  decision-log event ids are now a hash of instance, type, content and timestamp, so re-extracting
  the same transcript at the next compaction does not duplicate rows; an agent dropped during
  `initialize()` now emits `verification:agent-complete`. Recorded, not changed: the policy's
  `rebuild-working-set` action would also meet the busy refusal mid-turn, but no adapter declares
  `transcriptControl: 'rebuild'`, so it is unreachable; and the busy guard only knows about turns for
  adapters that report `turnPhase` (Codex app-server), so a manual compaction during a live Claude
  turn still restarts with a summary, as it did before this sweep.
- Fresh-eyes review round 4: FAIL on one gate: the round-3 no-duplicate spec passed a number where
  `listObservationEvents` takes an options object, so `npm run typecheck:spec` failed. Fixed. Its
  optional nit was also taken: the extractor now skips the restart continuity package (which quotes
  recent turns raw), so a decision is not recorded again once its original message is trimmed;
  revert-proven after correcting a first fixture that could not fail.
- Gates after the round-4 fixes: `tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `check:ts-max-loc`, `build:main`, `build:renderer` and the full suite (2198 files, 26,184 tests)
  all pass.
- Fresh-eyes review round 5: PASS, no findings (the first attempt was cut off by a provider session
  limit and was rerun in full).

## Decision and external items at the sweep snapshot

This list records what remained at the time of the sweep. James subsequently answered the six
decisions in [the follow-up plan](2026-09-23-sweep-decisions-followup_plan_completed.md): among
other outcomes, the passive LT-189 banner was restored, the unreachable parallel-worktree
coordinator and old RLM compaction path were removed, and Codex context protection was enabled.
The LT-029 and LT-441 checks still require the linked live validation.

- The RLM `checkAndCompact` path (and with it `maskStaleToolOutputs`, token/memory Task 1) has no
  production caller. Wiring RLM compaction into the live path is an architecture decision.

- The GitHub Actions remediation Task 3 needed four `mytrademail` production credentials at the
  sweep snapshot. This was resolved on 2026-09-23: all four GitHub production secret names exist,
  the dedicated Sentry/Firebase resources and deployed values were verified, and production deploy
  run `35842040642` passed. Synthetic Sentry delivery, alert acknowledgement, and inherited
  Firebase IAM remain in [its live-test document](../superpowers/plans/2026-08-03-github-actions-remediation_livetest.md).
- LT-029 (hardened keychain refresh): needs a security trade-off decision.
- LT-441 (hardened `CLAUDE_CONFIG_DIR` writes): root cause needs `fs_usage`/DTrace with sudo.
- Worktree-safety Chunk 1 is obsolete (children never run in worktrees; loop harvest owns it). The
  parallel-worktree coordinator is unreachable and cannot merge: delete-or-build is a product decision.
- Found in passing, not covered by any plan: a campaign with `policy.isolation: 'worktree'` creates a
  worktree per node (`campaign-coordinator.ts` `worktreePreparer`) and hands it to the node's loop as
  `workspaceCwd`. The loop harvests into that worktree, but nothing in the campaign code ever merges,
  abandons or cleans it up, so the node's work stays on an unmerged branch. Whether campaign results
  should merge automatically or be presented for review (as repo jobs do) is a product decision.
- LT-189 at the sweep snapshot: the passive fallback-notification banner had been removed in
  `1ad92f5e` (see W4), and James had to choose restoration or retirement. He chose restoration
  in follow-up D2; the banner is back in `be5cce3b`, with a rebuilt-app check still pending.
