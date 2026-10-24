# REPORT-recall: Phase D round 2 (Step 5 recall kit and migration gate, Step 11.2 Claude daily cost check, Step 11.3)

Helper: recall. Worktree `.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`, base 542f1f690, checkpoint 0861b3027.
No commits, stashes, branches, worktrees, full-suite runs, GUI or browser. No private transcript text, question, answer, path or credential appears
anywhere in this report, the receipts or the evidence files (counts, sizes, hashes, costs and exit codes only).

## Verdict

| Item | Status |
| --- | --- |
| 11.2 Claude daily cost check | **Done and really wired**: starts at app start-up, stops on shutdown, shows on the Costs page, refreshes every minute while open. Real-data run: 170 sessions, stored $2,158.06 vs Claude $2,411.06, drift -10.49%, **flagged**. |
| 5 recall kit (library, driver, runbook, tests) | **Done.** |
| 5 real recall check, 3 real chats, near 300K | **Done. Result: recall is clearly worse after summarising.** Pooled over 3 real chats and 40 questions, recall fell from 83.8% to 47.5% (a 36.3-point drop; worst chat lost 53 points). The plan's rule says no cap ships, so none does. |
| 5 own-chat 300,000 cap / migration | **Not activated; the guarded rollout path is wired as a proven no-op.** `migrateOwnChatContextCeiling` is now called by `runSettingsMigrations`. Evidence constant is `null`, so it reads one marker and writes nothing (no cap, no marker); `ownChatContextCeilingTokens` and `machineContextCeilingTokens` stay 0. Proven through the real seam, with synthetic evidence only in isolated fixtures. |
| Decision status | **Nothing is pending.** The plan already says no cap ships if recall is clearly worse, and the check was clearly worse, so the automatic cap is rejected by that existing instruction. James is not asked to choose. |
| 11.3 helper own-model | **Confirmed sufficient, no change.** 5 spec files / 18 tests pass; chain traced below. |

## Real recall results (observed; counts only)

Method: a read-only copy of each real chat, cut at the last finished answer at or just below 300K tokens; 10-15 questions about the earliest ~40% of the conversation,
each with a verbatim supporting quote; answered **with the full chat** in one fork, and **after `/compact`** in a separate fork (so the earlier answers cannot reach the summary);
tools, settings, hooks and MCP servers off; blind A/B judge. Model: `sonnet[1m]` (Sonnet 5.5, 1M window), helper `sonnet`. CLI 2.1.304.
Scoring: correct = 1, partial = 0.5, wrong/unknown = 0. "unknown" means the model said it did not remember. After the summary it never answered wrongly (0 wrong in all three chats); the 4 wrong answers in chat 7618c3b8's full-context set were not investigated (they may be questions about early facts that were changed later in the same chat).

**Run 2 (the record, written to `_scratch/oct2-phaseD-round2/recall-evidence.json`, receipts and seal beside it; 20 calls, all exit 0, spend $5.40 of a $7.50 cap):**

| chat (hash of path) | typed prompts | questions | context at cut -> after summary | recall before | recall after | drop (points) | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 85f27b9a | 46 | 15 | 298K -> 3.3K (1.1%) | 100% (15 c, 0 p, 0 w, 0 u) | 47% (6 c, 2 p, 0 w, 7 u) | 53 | $1.68 |
| 7618c3b8 | 36 | 15 | 275K -> 4.5K (1.6%) | 57% (8 c, 1 p, 4 w, 2 u) | 47% (6 c, 2 p, 0 w, 7 u) | 10 | $1.61 |
| d7a06912 | 34 | 10 | 296K -> 5.9K (2.0%) | 100% (10 c, 0 p, 0 w, 0 u) | 50% (5 c, 0 p, 0 w, 5 u) | 50 | $1.78 |
| **pooled** | | **40** | | **83.8%** (33 c, 1 p, 4 w, 2 u) | **47.5%** (17 c, 4 p, 0 w, 19 u) | **36.3** | $5.06 + $0.34 question writing |

c = correct, p = partial, w = wrong, u = said it did not remember. Three different conversations from three different projects (conversation keys all distinct), each idle for 30+ minutes, no earlier compaction, 34-46 typed prompts. Model reported by the CLI: `claude-sonnet-5-5[1m]`.
Sources: the three original transcripts were hashed (SHA-256) before and after and are byte-identical; chat d7a06912's transcript carried an earlier $99.26 CLI cost that the kit now nets out. About 7.6 MB of copies and forks were created and then removed (9 files); no marker or throwaway folder remains.

Run 1 (same code, aborted at chat 3 by a cost-accounting bug, see below) measured the same first two chats independently, with freshly written questions:

| chat | questions | context -> after summary | before | after |
| --- | --- | --- | --- | --- |
| 85f27b9a (run 1) | 15 | 298K -> 4K | 100% (15 c) | 43% (6 c, 1 p, 0 w, 8 u) |
| 7618c3b8 (run 1) | 14 | 275K -> 4K | 86% (11 c, 2 p, 0 w, 1 u) | 43% (6 c, 0 p, 0 w, 8 u) |

The two measurements of chat 85f27b9a agree to within 4 points (43% and 47% after), so the loss is not noise.

**Rule (modelled thresholds, `recall-evidence.ts`):** pooled drop at most 10 points, no chat more than 25 points, "before" at least 50%, 3 distinct conversations, 10-15 questions each, summarised from near 300K, under 120 days old.
**Run 2 against the rule:** pooled drop 36.3 points (limit 10) **fails**; worst chat 53 points (limit 25) **fails**; recall before 83.8% (needs 50%) ok; 3 distinct conversations ok; 10/15/15 questions ok; each proven summarised from near 300K ok; dated today ok.
Verdict printed by the kit: `RULE: does not pass: recall-worse - Recall fell from 84% to 48% (worst chat lost 53 points).` `write-evidence` refused (exit 2); the source constant is still `null`.

Reading: the summary keeps about 1-2% of the tokens (298K -> 3-6K; one real compaction I inspected in James's own transcripts went 967K -> 18K, the same order), and a memory-only test of specific early facts
falls from 83.8% to 47.5% pooled (100% -> 47-50% on the two chats whose full-context score was perfect). After the summary the assistant does not guess wrongly, it says it does not remember. These tests disable tools, so they do not measure
"could it look the detail up again"; that is the limit of what was measured.

## Decision status (no approval is pending)

The plan's own rule decides this: no cap ships if recall is clearly worse, and Decision 4(a) was conditional on the check. The check was clearly worse, so the automatic 300,000 cap is rejected by that existing instruction.
It is not waiting on anyone; I earlier described it as a choice for James, which was wrong and is withdrawn. Accepting the loss, or changing what the summary keeps, would be separate scope and is recorded below as information only.

**Exploratory single-chat check (information only; not evidence, cannot pass the gate; `--compact-instructions`, method `cli-replay-custom-compact`):** on chat 85f27b9a, asking `/compact` to "keep every exact detail that was stated early in the conversation: file names and paths, numbers and settings, commands, error messages, names of things, and each decision together with the reason for it; prefer a longer, complete summary over a short one" gave before 93% (13 c, 0 p, 1 w, 0 u) -> after **61%** (8 c, 1 p, 1 w, 4 u); summary 4.0K tokens; 7 calls, spend $1.87. That is better than the default wording's 43-47% for the same chat, but still a 32-point drop, so wording alone would not clear the 25-point limit (one chat, so roughly +/-10 points).

## Review findings (review-notes-recall.md) and what changed

Every fix has a regression that was seen failing first (red) and then passing.

1. **Threshold.** The $0.50 minimum is gone; every settled comparison is judged. Zero Claude spend against booked spend is clear drift (own wording in the panel). The 5% test is done in whole millionths of a dollar so float sums cannot tip exactly 5% over (`exceedsDriftThreshold`; tests include ten 0.105 against ten 0.1 whose float drift is 5.0000000000000382%, and 1.05 vs 1.0, 1.050002 vs 1.0, 0.95 / 0.949998).
2. **Partial tails.** Anything unreadable after the last `cost-state` (half-written assistant, user, request or cost-state line, garbage) makes the total *unsettled*; blank lines are fine; unreadable lines before it are ignored. The old test that treated a partial cost-state as safe was replaced.
3. **Stale runs.** `configure`, `stop` and the new `shutdown` bump a generation; a run started earlier can no longer save, report an error, clear its successor's in-progress marker, or reschedule. Timers stay bounded (wait clamped to one day even if the saved time is in the future; found and fixed while here).
4. **Real registration.** Handlers are registered inside `IpcMainHandler.registerHandlers()` (reached from `initialization-steps.ts`), which starts the schedule and registers `registerCleanup(() => service.shutdown())`. `claude-cost-reconcile-wiring.spec.ts` fails if any link is removed (handler registration, start-up construction, cleanup, channels, preload, generated channels, Costs page element and import). Panel placed on the Costs page.
5. **Evidence gate.** Rejects (as `malformed`) missing/fractional boundaries, missing/NaN/negative sizes, a pre-compaction size unrelated to the cut, fewer than 20 typed prompts, fractional or negative tallies, negative cost, empty or repeated chat keys, **repeated conversations** (new `conversationKey` = hash of the API message id at the cut, identical for copies and forks), wrong method, empty model, future dates, non-finite target. 22 malformed shapes are tested.
6. **Ground truth.** An answer must be supported by its own cited quote: every number (digits or words), path, file name or identifier in it must appear in the quote; prose answers need most words from the quote. A wrong number that appears elsewhere in the excerpt is now rejected (tests). The question writer and the judge are told the text is untrusted data, fenced in delimiters, tools off.
7. **Sandbox ownership.** The throwaway project folder is created by this run (`claimSandbox` refuses an existing folder), carries a token marker, and is removed only if the marker token matches, the path is the claimed one inside the projects root, and it is a plain directory (not a link). A transcript copy is written with `wx` (never overwrites). Sources are hashed before and after (the run fails if they change). Redacted per-call receipts, an evidence file and a seal (hashes of receipts, evidence, script and library) are written **before** anything generated is deleted; a cleanup receipt follows. CLI isolation: `--setting-sources ''`, `--strict-mcp-config` with an empty `--mcp-config`, `--tools ''`, `--` before the prompt. The child gets the access token only (never the refresh token); nothing else of the parent environment.
8. **Separate forks kept**: full-chat answers and `/compact` each run in their own `--fork-session` of the original; the after-summary answers continue only the compaction fork.

## Wiring the gated migration (this round)

- **Wired.** `src/main/core/config/settings-migrations.ts` gained exactly 4 lines: the import of `migrateOwnChatContextCeiling` and one call at the end of `runSettingsMigrations` (`git diff --stat`: 4 insertions). `SettingsManager` reaches it through that function at construction.
- **Gate-order bug found and fixed while wiring.** With no evidence and a cap the user had set, the gate wrote its marker (a persistent write) before looking at the evidence. It now judges the evidence first, so every non-passing case (none, worse, stale, too few chats, repeated conversation, variant method, smoke size, impossible numbers, garbage) returns before any write, for every stored state. Seen failing first, then passing. The not-eligible log line is now `debug` (it would otherwise print on every launch).
- **Proof the shipped state is a no-op, through the real seam** (`__tests__/settings-migrations.own-chat-ceiling.shipped.spec.ts`, 8 tests): evidence constant is `null`; both ceilings default to 0; `runSettingsMigrations` calls the gate exactly once and it answers `not-eligible / no-evidence`; for five stored states (default 0, nothing stored, a user cap for chats, a user cap for chats plus one for helpers, helper cap only) three consecutive runs write none of the three settings (own cap, machine cap, marker) and leave their values as they were; the other migrations still run (their markers appear).
- **Strict gate with synthetic evidence only, through the same seam** (`__tests__/settings-migrations.own-chat-ceiling.gate.spec.ts`, 15 tests; the evidence module is replaced inside that file only): passing synthetic evidence sets 300,000 once, writes the marker, never writes the machine cap, and later runs add nothing; applies when nothing was stored; keeps a user's own cap (and a helper cap) and writes only the marker; the cap reaches an ordinary chat and none of the 13 machine reasons, nor a child, queue, automation or node-run session; 11 kinds of unusable evidence write nothing for any of three stored states.
- **Mutation check:** with the gate temporarily made to ignore the verdict, 17 of 23 seam tests failed; the file was restored byte for byte (SHA-256 compared) and the tests pass again.
- **Truthful text, no figures:** `settings-defaults.ts` comment (was "Replay evidence is unavailable", now untrue) now says it is off unless a passing check is compiled in; the own-chat ceiling's description gained "A summary keeps far less early detail than the full chat, so this is off unless you choose a value." No benchmark number appears in product source. I removed the "Results log" I had put in the runbook and changed a test constant that happened to equal a real cost ($99.26 -> $99); scores live in this report only.

## Bugs the real runs found (and fixed, each with a regression)

- **Window placement.** At a small cut the early question windows fell inside the ~50K tokens of fixed overhead every chat starts with and produced no questions. Windows are now placed by the conversation's own growth.
- **Cost accounting (run 1 stopped at chat 3).** The CLI's `total_cost_usd` continues the total a resumed session already carried: chat 3's copied transcript carried a $99.26 `cost-state`, so one call reported $100.36 although it added about $1.10 (the per-call cap held, the CLI measures what a call added). The kit had charged the cumulative figure and tripped its own $9 limit ("$105.17 of $9.00"). **No overspend happened**: true spend of run 1 was about $4.77. The kit now charges only what each call added (carried baseline taken from the copied transcript; the after-summary answers net out the summarising call's total). Same bug had double-counted the summarising cost for chats 1-2.

## Real-data checks on the Claude cost check (read-only, numbers only)

Real modules over the real cost database and transcripts (3-day window): 644 sessions, 411 not Claude, 44 Claude with no transcript here, 19 unfinished or unreadable tail (left out), 0 the CLI could not price, **170 compared**.
Stored $2,158.06 vs Claude $2,411.06 = **-10.49%**. Sessions booked turn by turn (38): $72.58 vs $72.62 = **-0.05%**. Older "repaired" history (132): $2,085.48 vs $2,338.44 = **-10.82%** (the repair under-states older sessions by about $253; nothing was rewritten).

## Step 11.3 helper own-model: confirmed, no change

Chain read and executed, not just found: assistant frames tagged `parent_tool_use_id` -> `observeClaudeAssistantTelemetry` (`claude-assistant-telemetry.ts:9`) -> `ClaudeSubagentUsageTracker.observeAssistant` -> on the helper's final sample `enrich()` picks stream model, else transcript, else the requested model, with `modelSource`
-> adapter emits `subagent_usage` -> `instance-communication-provider-events.ts:56-60` records it with `...subagentAttributionDetails(sample)` (model, `helperModelSource`, agent type, fork, depth, mode) next to `finalContextTokens`. Local, proxy and remote paths use the same helpers. Specs: `claude-subagent-usage-enrichment`, `claude-assistant-message-helper-frames`, `instance-communication-helper-details`, `claude-subagent-meta`, `claude-subagent-details.integration`: 5 files / 18 tests pass.
Spend by model is not computed per helper: the helper's own record has `costSource: unknown`; the money is priced by the CLI per model inside the session total (`modelUsage`), which Phase 0 already stores per model. That meets "priced on the right model"; nothing further is needed.

## Worker import closure (measured, not assumed)

Measured with a verbatim copy of the guard's own parser and walker (kept as `_scratch/oct2-phaseD-round2/closure-measure.mjs`; the guard `context-worker-import-isolation.spec.ts` was not edited):

| | modules | edges | electron value-importers |
| --- | --- | --- | --- |
| before wiring | 156 | 290 | 0 |
| after wiring | 156 | 290 | 0 |

The module sets and the edge sets are **identical** (`diff` of the saved lists: `closure-before.modules.txt` / `closure-after.modules.txt` and the `.edges.txt` pair). Nothing is added, so no module or edge needs a ruling. The worker never reaches `settings-migrations.ts` (it value-imports `electron`, which the guard forbids in the closure), `settings-manager.ts`, or any file of mine.
The guard itself is red at 156 against a ceiling of 156 (`expected 156 to be less than 156`); it was exactly 156 before my first edit (`baseline-regressions.log`), so that is not caused by this work and I neither raised nor weakened it. Main decides placement and the ceiling.

## Files

New (all under the worktree):
- 11.2: `src/shared/types/claude-cost-reconcile.types.ts`; `src/main/core/system/claude-cost-state-reader.ts`, `claude-cost-reconcile.ts`, `claude-cost-reconcile-store.ts`, `claude-cost-reconcile-service.ts` (+ specs for each); `packages/contracts/src/channels/claude-cost-reconcile.channels.ts`; `src/preload/domains/claude-cost-reconcile.preload.ts`; `src/main/ipc/handlers/claude-cost-reconcile-handlers.ts` (+ `__tests__` spec); `src/main/ipc/claude-cost-reconcile-wiring.spec.ts`; `src/renderer/app/core/services/ipc/claude-cost-reconcile-ipc.service.ts`; `src/renderer/app/features/cost/claude-cost-drift.component.ts` (+ spec).
- 5: `src/main/context/recall-replay/` (`recall-types.ts`, `recall-transcript.ts`, `recall-questions.ts`, `recall-evidence.ts`, `recall-pipeline.ts`, `recall-cli-env.ts` + 5 specs); `scripts/audit/recall-replay.ts`; `docs/runbooks/recall-replay-quarterly.md`; `src/main/core/config/settings-migrations-own-chat-ceiling.ts` (+ spec); `src/main/core/config/own-chat-ceiling-recall-evidence.ts` (= `null`); `src/main/core/config/__tests__/settings-migrations.own-chat-ceiling.shipped.spec.ts` and `.gate.spec.ts`.
Edited (minimal, shared): `src/main/core/config/settings-migrations.ts` (+4 lines: import and one call), `src/shared/types/settings-defaults.ts` (one comment made truthful), `src/shared/types/settings-metadata-runtime.ts` (one sentence added to the own-chat ceiling's description), `packages/contracts/src/channels/index.ts` (import + 2 spreads), `src/preload/preload.ts` (import + 1 spread), `src/main/ipc/handlers/index.ts` (1 export), `src/main/ipc/ipc-main-handler.ts` (import + 1 call), `src/preload/generated/channels.ts` (regenerated), `src/renderer/app/features/cost/cost-page.component.html` (1 element) and `.ts` (1 import, 1 `imports` entry).
Not touched: Codex files, runtime compaction integration, root planning docs, the worker isolation guard, the ceiling helper's settings, and any real setting, database or user file (all tests use fake stores and temp folders).

## Commands and exits (logs in `_scratch/oct2-phaseD-round2/`)

| # | Command (run from the worktree root) | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| 1 | `npx tsx scripts/audit/recall-replay.ts candidates --min-mb 0.5 --max-mb 200` | 0 | zero cost: 163 transcripts with a clean cut near 300K, 13 usable (no earlier compaction, 20+ typed prompts), **8 distinct conversations** | recall-candidates-1.log, -2.log |
| 2 | `... run --target-tokens 60000 --min-prompts 3 --model sonnet --count 1 --total-budget 1.5` (smoke) | 0 | no calls: windows fell in the ~50K fixed overhead; fixed by placing windows on conversation growth (regression added) | recall-smoke.log, recall-smoke2.log |
| 3 | `... run --target-tokens 100000 --min-prompts 10 --model sonnet --count 1 --total-budget 2` (smoke) | 0 | whole pipeline works on the real CLI, $0.85, 7 calls; one chat at 99K went 96% -> 12%; its record is refused by the gate (smoke can never be evidence) | recall-smoke3.log |
| 4 | `... run --count 3 --model 'sonnet[1m]' --helper-model sonnet --total-budget 9 --per-call 3` (real run 1) | 1 | chats 1-2 measured (100% -> 43%, 86% -> 43%); stopped at chat 3 by the kit's cost-accounting bug; true spend about $4.77 | recall-run1-aborted.log + 3 receipts |
| 5 | `... run --count 3 --model 'sonnet[1m]' --helper-model sonnet --total-budget 7.5 --per-call 3 --out ...recall-evidence.json --receipts ...` (**real run 2, the record**) | 0 | 20 calls, all exit 0, $5.40; pooled 83.8% -> 47.5% | recall-real-run2.log, recall-run-receipt.json, recall-run-seal.json, recall-cleanup-receipt.json, recall-evidence.json |
| 6 | `... evaluate --in ...recall-evidence.json` | 0 | `RULE: does not pass: recall-worse` | (console) |
| 7 | `... write-evidence --in ...recall-evidence.json` | 2 (refused by design) | "only evidence that passes the rule can be recorded"; constant still `null` | (console) |
| 8 | `... run --chat 85f27b9a --count 1 --model 'sonnet[1m]' --helper-model sonnet --total-budget 3.5 --per-call 3 --compact-instructions "<generic text above>" --out ...variant/... --receipts ...variant` | 0 | exploratory: 93% -> 61%, $1.87, not eligible by design | recall-variant-run.log, variant/ |
| 9 | `npm run test:quiet -- <25 spec files and folders: all of mine plus cost-handlers, context-ceiling, instance-spawn-policy, the 11.3 specs>` | 0 | 25 files / 217 tests passed | recall-final-targeted.log |
| 10 | `npx tsc --noEmit` | 0 | No errors | recall-final-tsc.log |
| 11 | `npm run typecheck:spec` | 0 | no errors (8 GiB wrapper) | recall-final-typecheck-spec.log |
| 12 | `node_modules/.bin/oxlint --config .oxlintrc.json <19 of my files and folders>` | 0 | clean | recall-final-oxlint.log |
| 13 | `npx eslint <the cost panel, its spec, its IPC service, cost-page.component.ts>` | 0 | clean (one `Array<T>` style error found and fixed) | recall-final-eslint.log |
| 14 | `npm run generate:ipc` then `npm run verify:ipc` | 0 / 0 | 1204 channels when generated; 1205 now (another helper added one), all in sync | recall-generate-ipc.log, recall-verify-ipc-2.log |
| 15 | `npm run check:ts-max-loc` | 1 | 2 violations, **neither is mine**: `instance-orchestration.ts` 1161 lines (ceiling 1105) and `orchestration-handler.ts` 1362 (ceiling 1311); none of my files listed | recall-final-loc.log |
| 16 | `npm run test:quiet -- src/main/instance/__tests__/context-worker-import-isolation.spec.ts` | 1 | 156 modules vs ceiling 156, **identical to the baseline before my work**; red for reasons that are not mine | recall-closure-after.log |
| 17 | Real-data check of the Claude cost check (one-off read-only script over the real database and transcripts, since deleted) | 0 | 170 compared, -10.49% (see above) | (numbers above) |
| 18 | `npm run test:quiet -- <the five Step 11.3 spec files>` | 0 | 5 files / 18 tests | recall-helper-model-specs.log |
| 19 | `npm run test:quiet -- settings-migrations-own-chat-ceiling.spec.ts` (new "writes nothing without a passing check" test, before the fix) | 1 | red: with no evidence and a user cap the gate wrote its marker | recall-gate-order-red.log |
| 20 | same spec after the fix | 0 | 10 tests | recall-gate-order-green.log |
| 21 | `npm run test:quiet -- <shipped.spec.ts and gate.spec.ts>` before wiring | 1 | red for the right reason: gate called 0 times; 4 passing-evidence tests failed | recall-seam-red.log, recall-seam-red2.log |
| 22 | `npm run test:quiet -- <shipped.spec.ts, gate.spec.ts, the unit spec, settings-migrations.copilot.spec.ts>` after wiring | 0 | 4 files / 44 tests | recall-seam-green.log |
| 23 | mutation check (gate made to ignore the verdict), then restore | 1 then 0 | 17 of 23 seam tests failed while mutated; restored byte for byte; 33 tests pass | recall-mutation.log, recall-mutation-restored.log |
| 24 | `node closure-measure.mjs` before and after wiring (copy of the guard's parser) | 0 | 156 modules / 290 edges both times, identical sets, 0 electron importers | closure-before.*, closure-after.* |
| 25 | `npm run test:quiet -- src/main/core/config src/shared/types context-ceiling.spec.ts instance-spawn-policy.spec.ts src/main/context/recall-replay` | 0 | 90 files / 1,732 tests passed | recall-wired-focused.log |
| 26 | `npm run test:quiet -- src/main/instance/__tests__/context-worker-import-isolation.spec.ts` after wiring | 1 | 156 vs ceiling 156, same as before my work | recall-closure-after-wiring.log |
| 27 | `npx tsc --noEmit` after wiring | 2 | 2 errors, **both in another helper's in-progress compaction files** (`claude-cli-adapter.ts:335`, `claude-native-compaction-flow.ts:72`); none in my files (it was exit 0 before their edit, row 10) | recall-wired-tsc.log |
| 28 | `oxlint` on the migration, both seam specs, the unit spec, the evidence file, the recall library, and the two shared settings files | 0 | clean | recall-wired-oxlint.log |
| 29 | `npm run typecheck:spec` after wiring | 2 | 10 errors, **none in my files**: `native-compaction-bookkeeping.spec.ts` (8), `claude-cli-adapter.ts:335` (1), `instance-orchestration.model-routing.spec.ts:75` (1), all other helpers' in-progress work; my new specs compile (it was exit 0 before their edits, row 11) | recall-wired-typecheck-spec.log |
| 30 | `npm run test:quiet -- <every spec I own or rely on: cost check, recall kit, migration unit + seam specs, the whole `src/main/core/config/__tests__` folder, Costs page, cost handlers, ceiling, spawn policy, Step 11.3>` | 0 | **37 files / 329 tests passed** | recall-wired-final-targeted.log |
| 31 | seal and hash verification (SHA-256 of sealed files against disk, original transcripts before/after) | 0 | run 2 (the record): 9 sealed files, none changed since; exploratory variant: 9, none changed; all original transcripts byte-identical in both. Run 1's seal pins the pre-fix code and the receipt under its first name, so it intentionally no longer matches the fixed files, but its archived receipt (`recall-run1-aborted-receipt.json`) matches its sealed hash exactly | (console) |

Red-first runs (each regression was run and seen failing before the fix): `recall-review1-red.log`, `recall-review2-red.log`, `recall-review3-red.log`, `recall-review4-red.log`, `recall-review5-red.log`, `recall-windows-red.log`, `recall-clamp-red.log`, `recall-poll-red.log`, `recall-variant-red.log`, `recall-cost-red.log`.
Honest caveats: (a) for the first versions of the reader, reconcile maths and service the spec and code were written together and only the reader had a separate failing run; every later fix was red-first. (b) Two cosmetic edits to `scripts/audit/recall-replay.ts` (a type annotation and the exploratory-label branch) were made while run 2 was already running; the seal hashes the files as they were on disk when run 2 ended, not as loaded. (c) `check:ts-max-loc` and the closure test are red for other helpers' files.

## If a later run passes (nothing to do today)

The path is already wired, so a passing run needs no code change in the settings seam:
1. `npx tsx scripts/audit/recall-replay.ts run --count 3 --model 'sonnet[1m]' --total-budget 7.5`, then `write-evidence --in _scratch/oct2-phaseD-round2/recall-evidence.json` (it writes the constant only if the rule passes and refuses otherwise).
2. Change the shipped-state pin in `settings-migrations.own-chat-ceiling.shipped.spec.ts` (it asserts the constant is `null`) in the same change, and update the own-chat ceiling's description in words (no figures) to say what the check showed.
3. The closure does not need re-measuring unless the gate is moved into a file the worker imports (`_scratch/oct2-phaseD-round2/closure-measure.mjs` repeats the measurement in a second).
The gate (tested) keeps `machineContextCeilingTokens` 0, excludes helper children (a `parentId` makes the instance machine kind `child`, and `adapter-factory.ts:225` takes the machine key for any machine reason), keeps a user's non-zero own-chat value, and writes the marker only once a passing check has applied or recognised the setting.

## Remaining external checks (for the parent's livetest list; I cannot edit the root plan docs)

- Rebuilt app: the Costs page shows "Claude cost check" and, after a restart, the first check runs about 2 minutes later (then daily, retry hourly after a failure); "Check now" works; panel text matches the numbers above.
- Quit the app while a check is running: no state is written after shutdown (unit-tested, not observed live).
- Combined gates left to the main implementer: `ng lint` over the whole renderer, `npm run build:main`, `npm run build:renderer` (AOT of the new component), `check:ts-max-loc`, the full focused list and generators.
- No decision is pending. Separate scope, only if someone later wants it: a different bar for recall (for example allowing the assistant to re-read files), or an own-chat instruction on the compaction hook, each followed by a re-run of this kit.
- `npx tsc --noEmit` currently reports 2 errors in another helper's compaction files; they are not from this work and the main implementer should expect them until that work settles.
