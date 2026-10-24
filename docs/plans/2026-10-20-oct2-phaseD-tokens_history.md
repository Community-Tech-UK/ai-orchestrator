# Phase D execution evidence

Plan: `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-20-oct2-phaseD-tokens_plan.md`.
Implementation checkout: `.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`.

## Scope and rulings

- Supplied AIO checkout used as-is. No commits, branch changes, stashes or integration.
- No separate spec is linked. The numbered plan and completed decisions are the acceptance source.
- The worker instruction reserves full-suite execution and completion renames for the coordinator/verifier.
- Preflight: current source has no `stopped-by-harness` contract and no `HARNESS_GUIDE`. Phase B history independently records its work and Phase 1 as not integrated. Dependent steps must not be represented as landed or activated.
- Recall evidence is a release condition for the own-chat 300K migration, not a routine approval gate. Keep the current 0 default until the three-chat comparison exists.
- Runtime, dependency installs and caches created by this worker will be removed after receipts; existing shared dependencies will be preserved.

## Task ledger and as-built status

**3 of 14 steps fully implemented in this checkout; the plan is incomplete.** Eight steps are partial, two are dependency-blocked and one remains open.
An absent prerequisite does not make unrelated missing implementation a human boundary. Nothing in the open-code column is deferred as a live check.

| Step | Status | Implemented / verified | Remaining acceptance work |
| --- | --- | --- | --- |
| 1 | Blocked by missing Phase B contract | Investigated real usage path and queue park enum; no ceiling activated. | Four settings surfaces, root/helper turn accounting, one-shot steer/interrupt, non-retry `stopped-by-harness` integration and Costs top ten. Current contract has no such park reason. AIO owns prerequisite integration. |
| 2 | Partial | Deterministic candidate chat arm supplies verified clean-helper hint; machine ultra clamps to max; real picker exposes the allowance explanation. | Store root/helper per-turn shares in the session-policy log and evaluate the trial with provider units. |
| 3 | Partial | Non-chat skills catalog cap 1500, including ordinary children; unsupported-key start/resume fallback. | Checker `skills.include_instructions:false` trial and required-skill discovery/retention. Verified upstream v0.163.0: enabling a skill does not give it priority in the catalog budget. Do not claim an enabled override alone solves omissions. |
| 4 | Partial | Native queue/loop/automation limits preserve caller overrides; helper own model, source, fork, depth and mode flow through local/proxy/remote paths and size audit. Unknown fork stays unknown. | Phase 1 A18 trial integration; Sonnet/high scout spawn defaults, Opus/max lead/synthesis guidance, live fan-out cost in header. |
| 5 | Open | Existing own-chat and machine ceiling values left unchanged. | Three real-chat recall comparisons (10-15 questions each), scores and quarterly replay kit; only then own-chat migration/text to 300K. No recall score was invented. |
| 6 | Blocked by absent Phase 1 integration | Searched actual source and Phase B evidence; no landing asserted. | AIO lands Phase 1, then verify standing notes after compaction and run its trial report on the integrated source. |
| 7 | Implemented; focused-verified | Bounded read/click result receipts; verifier/triage MCP filtering; conservative bounded worker-roster probe; schema ratchets; thin searches/full describe; `plan_queue_status` content versions; annotations. | Full verifier suite and deployed validation below. Static server filtering recognises the managed `imap` entry, not arbitrary user-defined aliases. |
| 8 | Partial | 31 production-rendered prompt surfaces share a pinned budget table; eight tool-schema surfaces have measured ratchets; budgeted composition logs surface/chars/session; seven house rules. | Integrate Phase 1's short guide and lower the current old-guide budgets; ensure every prompt injection path logs once. The current queue worker autonomy rule is emitted once; no duplicated literal was removed on guesswork. |
| 9 | Partial | Cache-write TTL telemetry across local/proxy/remote; machine precompute disabled; role-specific PreCompact hook wired without replacing permission hooks; direct CLI compaction probe passed. | Consume measured TTL in survival decisions; known-sleep compact/recycle and idle hint with quiet guards; use the proven separate-call recipe in Compact now after safely retiring resident process. Successful probe is not that integration. |
| 10 | Implemented; focused-verified | Claude lifetime write pricing and fallback estimate; native per-request Sol/Astra long-prompt premium; reported dollars retain precedence; mixed/aggregate regressions. | Full verifier suite; no historical cost rewrite or cap increase. |
| 11 | Partial | Actual Claude helper model and provenance accompany size telemetry and audits, including remote paths. | Codex thread-end credit readings/trial units; daily Claude `cost-state` reconciliation and >5% Costs drift flag after Phase A integration. |
| 12 | Implemented; focused-verified | Global Claude user source becomes safety digest only for Google adapters; first-turn advisory memory markers; governing/project rules and RTK remain; success/argument-preparation regressions. | Full verifier suite and deployed provider validation below. |
| 13 | Partial | Real SQL counts `rtk bypass` and `rtk proxy` as full output with existing filters. | Phase 1 A13 queued trial integration and harm-check naming. Awareness note unchanged under Decision 10(a). |
| 14 | Partial | Removed unconditional full-preservation claims from runtime-change notices; regression and delivery tests pass. | Runtime-change cost descriptions before picker/toggle commits, large-replay confirmation and target-window carryover preview. Phase 1 A8.3 is not integrated here. |

## Verification receipts

Canonical command receipts are in `2026-10-20-oct2-phaseD-tokens_commands.jsonl`; full logs remain in the worktree's `_scratch/oct2-phaseD/` and referenced `_scratch/test-run.pid-*.log` files.

| Final command / gate | Result |
| --- | --- |
| Explicit 57-file focused list, `test:quiet -- <files>` | 0; 729 tests passed. List: `_scratch/oct2-phaseD/final-focused-specs.txt`; receipt `final-focused`. |
| `npx tsc --noEmit` | 0; `sealed-types`. |
| `npm run typecheck:spec` | 0 using 8GiB wrapper; `sealed-spec-types`. |
| `npm run lint` | 0; `sealed-lint`. |
| `npm run check:ts-max-loc` | 0; `sealed-loc`. Existing allowlist tolerances remain. |
| `npm run build:main` | 0; `stable-build-main`, includes sync-dist and preload build. |
| `npm run build:renderer` | 0; `stable-build-renderer`. Existing initial-bundle warning: 1.35 MB against 1 MB. |
| `generate:aliases`, `generate:ipc`, `generate:codex-protocol` | 0. Only the expected installed-version Codex manifest changed. |
| `verify:ipc`, `verify:exports`, `check:contracts`, `verify:codex-protocol` | 0. IPC has 1202 synced channels; 39 contract schema aliases verified. |
| Full suite | Not run, as required by the queue-worker instruction. Verifier owns it. |
| Fresh independent task-completion-gate | Pending coordinator; no independent PASS and no completion rename. |

The implementer's own fresh diff review found and repaired malformed worker-roster handling and its RPC timeout leak, unknown fork metadata reported as false, a prototype-name hook crash, missing hook startup wiring, and oversized click echoes reporting an already-executed action as failed. Red exits and green reruns are retained, not hidden. A broader provisional run found a fixture assuming absent fork meant false; it now supplies explicit `isFork:false`, while separate coverage asserts unknown stays absent.

## Implementer evidence so far

- Codex installed version `0.163.0`; matching official `rust-v0.163.0/codex-rs/core/config.schema.json` confirms `skills.max_context_tokens`, `skills.include_instructions`, `features.multi_agent_v2.multi_agent_mode_hint_text`, and `agents.default_subagent_model`. Snapshot retained with command receipts. No live settings were edited.
- Skills caps include ordinary child helpers as well as queue, loop, automation and review; chats retain Codex's native catalog budget. Ultra clamp excludes personal chats and ordinary helper children, applying to loop, queue, automation and review kinds. Related sessions keep the existing deterministic trial assignment.
- Real SQLite RTK regression proves both `proxy` and `bypass` count as raw, respects time/project filters and does not classify `proxying` as proxy. Focused group: 4 files / 33 tests passed.
- Pricing regressions: 6 files / 92 tests passed. Sol/Astra multipliers verified against [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) official pages, fetched 20 October 2026: above 272K input, 2x input/cache and 1.5x output for the whole request. Explicit request-sized observations enter the premium bucket; a large turn aggregate cannot prove a large request. Missing/coalesced request information remains estimated. Sol's cache read discount is 95%.
- Claude writes: exact 5m/1h counts use 1.25x/2x; the unclassified remainder uses 1.6x. At Sonnet's current $2/M input, one million writes changes $2 to $2.50 (5m), $4 (1h), or $3.20 (unknown). Provider-reported dollars still take precedence. The $2/day reservation mechanism is unchanged; the estimate changes only where cache-write counts or an explicit long request are present, not for small uncached helper estimates. Historical stored rows are not rewritten.
- Google prompt regressions: 7 files / 53 tests passed. The native instruction resolver replaces only user-scope global Claude material with an explicit safety digest; project rules remain. Advisory blocks receive reserved transport markers and are omitted only after a successful first reply; ordinary governing instructions and RTK remain on every fresh process. Argument preparation alone never consumes memory.
- Claude helper env names verified from installed 2.1.304 changelog: depth 2.1.219, concurrency 2.1.217, session spawn cap 2.1.212, noninteractive fork 2.1.121. Only queue/loop/automation reasons receive limits; caller/inherited values remain authoritative; ordinary children and reviewers are excluded.
- Tool search returns names and one-line descriptions in both deferred/stable modes; full schemas remain in describe. Every advertised tool receives explicit read/destructive/idempotent/open-world hints. Large read/click responses use 8K-character receipt pages tied to the original tool+arguments and this forwarder, with bounded memory and expiry. Paging never executes the operation again. Focused group: 5 files / 20 tests passed.
- Self-review found and reproduced two further defects: marker escaping could expand advisory text beyond its reservation; lifetime-only Claude cache creation could stay unpriced. Both repaired; edge group 5 files / 45 tests passed.
- Initial `npx tsc --noEmit`, lint and LOC ratchet exited 0. Spec typecheck initially found a new test's missing source-type annotation; repaired. These are provisional snapshots while other scoped implementation agents work; final gates must run after their edits settle.
- Process metadata inspection via `ps` was denied (`Operation not permitted`). No bypass attempted; subprocess sessions remain monitored through their execution handles. Three local Sonnet implementation agents have non-overlapping scopes and no commit/branch/full-suite authority; their results require parent review.
- Codex protocol generator refreshed the committed manifest from 0.162.1 to installed 0.163.0. The only method changes are `thread/readState/update`, `thread/items/read`, and `thread/readState/changed`; thread/turn request shapes are unchanged. `verify:codex-protocol` exited 0; protocol snapshot/start/resume focused regressions passed 3 files / 30 tests.
- Spec typecheck rerun after the source-type annotation repair exited 0. Command receipts preserve the original red exit as well as the green rerun.
- Cheap Claude startup diagnostic reached the provider, completed one tools-disabled turn, then exited 1 with `error_max_budget_usd` at $0.0691049. It is **not** the `/compact` probe or a recall check. Only sanitized event types/cost/exit are retained in `claude-startup-receipt.json`; temporary debug and stream output were deleted.
- Numerical premium example covered by regression: one Astra 200K-input/1K-output request plus one 300K/1K request changes the turn estimate from $5.10 to $8.125. Three 200K/1K requests remain $6.15; the 600K turn aggregate does not trigger a premium. Sol's 95% cached-input discount also corrects the old 90% fallback; request-level premiums are applied after that correction. Audits importing shared pricing see the new estimates; no retrospective cost-store rewrite or daily cap increase is performed.


## Final implementation evidence and limitations

- Role filtering is runtime-wired through lifecycle, interrupt/respawn, permission resume and reconciliation callers. The roster probe has a real per-RPC deadline as well as a Promise deadline; unknown/failing rosters keep tools visible. Full/deferred/stable schema measurements include actual advertised annotations and pagination fields. The status version is computed from current content, so a matching previous version suppresses payload only while the scoped status really matches.
- Result receipts are scoped to one forwarder, bound to tool + original arguments, expire after ten minutes and retain at most sixteen results / 16 MiB. Pagination never re-executes a click. A result too large to retain returns a bounded echo explicitly saying the tool already ran, rather than failing after a mutation.
- Prompt budget fixtures cover the actual renderer outputs, not copied strings: old Unix/Windows orchestration guide, reminders, child prompts, loop first/continuation/reanchor and review-driven variants, queue worker/fix/conflict/resume/verifier/triage surfaces, review/repair, RTK, helper and title prompts. Baseline JSON is retained. Old guide budgets deliberately remain large until Phase 1 lands; this is not evidence that the promised 1515-character guide is integrated.
- PreCompact role script and overlay are both wired into launch. The installed Claude 2.1.304 executable's hook implementation joins successful non-blocked outputs into `newCustomInstructions`; its settings schema and reader recognise `precomputeCompactionEnabled`. Executable hash and public-source URLs/hashes are retained in `_scratch/oct2-phaseD/source-provenance.json`. The hook prints only fixed role instructions; no task text, transcript or secrets are copied into hook output.
- The direct CLI compaction experiment used a new throwaway Haiku session, disabled all tools/MCP, disabled setting-source loading and capped spend at $0.20. Seed exit 0 (one turn, reported $0.0019638); after that process exited, `--resume <new-id> -p /compact` exit 0 (zero model turns, reported $0.00540358), with one real transcript `compact_boundary`. Only hashes/event kinds/costs/exit metadata were retained in `claude-compact-probe-receipt.json`. This proves the recipe, not resident-process retirement or the Compact now runtime integration.
- Helper `.meta.json` parsing retains only small scalar allowlisted metadata, uses bounded file/tail reads and ignores model-written descriptions. Stream evidence takes precedence over transcript evidence, which takes precedence over an explicitly labelled requested-model fallback. Local and worker-owned helper frames do not overwrite root context occupancy.
- Ultra explanation is carried through the real picker controller, component and panel. It is available before selecting Ultra as a select tooltip and `aria-description`, with option tooltip metadata. Angular DOM tests and production AOT build pass; no Mac GUI was used.
- Claude compaction/cache/idle consumers, provider reconciliation, ceilings and cost previews are unfinished source work. They are not recorded as live-test deferrals. Recall remains unperformed; no settings migration was added, and no user database/settings was changed by a script.

## Delegation and cleanup record

The three original local Claude implementation contexts reached their turn budgets. Two ended normally with budget errors; the telemetry context was retired by SIGTERM of its exact task-owned shell child after late writes were discovered, and its handle ended 143. Parent review and tests, not agent claims, establish the delivered behavior. The retirement receipt is retained.

Five replacement native Codex helper contexts could not execute inside their nested macOS sandbox (`sandbox-exec: sandbox_apply: Operation not permitted`). Automatic approval review rejected their alternate shell/file-write attempts under the `never` approval policy. Their outer CLI exit 0 did not mean task success; final messages and event logs show no implementation or successful checks. No disabled-sandbox bypass was attempted. The primary session's already-authorised tools completed the changes above, but no fresh independent verifier PASS is claimed.

Task-owned build/cache/probe runtimes and copied upstream source will be removed only after this report, the acceptance-incomplete seal and command receipts are written. Existing shared `node_modules`, unrelated worktrees and user sessions are preserved. The cleanup receipt will enumerate actual removals and checks; the active plan is deliberately not renamed.

Cleanup completed after report/seal/receipts were written: removed the task-owned dist and Angular caches, disposable probe runtime/transcript/debug/session-env files where present, helper scripts/prompts and downloaded upstream source. Existing shared dependencies remain. All 94 source hashes and HEAD match the pre-cleanup seal. Shared CLI indexes/databases were not edited by cleanup. Exact removals: `_scratch/oct2-phaseD/cleanup-receipt.json`. Logs, baseline/provenance metadata, command receipts and reports remain.

## Verification round 2 remediation (in progress)

- Reproduced both verifier test failures before edits: audit fixture 10.664958 versus 5.492638 and worker closure 156 versus ceiling `<156`. Receipt: worktree `_scratch/oct2-phaseD-round2/baseline-regressions.log`; exit 1.
- Added a failing authoritative-window regression and assertions forbidding personal host/platform/branch policy in Google product safety text (exit 1, `premium-digest-red.log`).
- Codex long-request premium now requires a request-sized sample within that thread's reported window on active and idle paths. Oversized or unproven large samples retain base estimated pricing; no fixture expectation or rate multiplier was changed.
- The verifier's suspected worker import cause was checked rather than assumed: the exact closure comparison against 542f1f690 found 155 -> 156 solely from `shared/util/cache-creation-usage.ts`, through `model-call-recorder.ts`. Its parser now lives in the already-loaded usage-normalization module; the isolation guard/ceiling are unchanged. The preliminary transport relocation was discarded when evidence disproved it.
- Replaced the personal global-instruction paraphrase with generic product safety text. Google providers continue to load their own native instructions; no Windows host or personal plan/branch rules are hard-coded.
- Current targeted regression group: 12 files / 139 tests passed (`regression-green2.log`), including the original multicall audit, isolation guard, pricing, prompt transport and cache normalization. This is not the final combined gate.
- Four scoped native Claude implementation helpers are investigating/implementing the remaining ceiling/queue/cost, runtime/compaction, guidance/trials, and recall/reconcile requirements. They have no commit/branch/full-suite/GUI authority. Their claims will be reviewed against source and combined checks before final status.
- Previous 3/14 implementation status remains historical; unfinished source is not a live-test deferral. The queue coordinator still owns the final full suite and independent verifier.

### Active round-2 checkpoint (2026-10-20T22:33:59.105328+00:00)

All four initial native implementation sessions reached their 100-turn caps and were continued with their retained contexts; no result from those capped invocations is treated as completion. Current session receipts and resumable native IDs are in worktree `_scratch/oct2-phaseD-round2/` (`*-session.txt`, `*-continuation.jsonl`, `REPORT-*.md`). No full suite, commits or branch lifecycle actions are authorised to those helpers.

New in-progress source now includes the Codex ceiling/controller and nonretry stop plumbing, settings surfaces, daily Claude reconciliation reader/service/IPC/Costs component, a read-only recall replay kit and gated evidence module, measured cache-lifetime survival and native Compact-now/idle code, short-guide/prompt logging and helper/skills trial work. Source wiring, tests and remaining Step14/trial/credit requirements are still being completed. The current dirty tree has NOT yet passed the combined final static/build/focused gates. The earlier 139-test run is a timestamped provisional regression receipt, not proof of the later helper edits.

Parent review notes that must be resolved before handoff: `_scratch/oct2-phaseD-round2/review-notes-ceiling.md`, `review-notes-recall.md`, `review-notes-runtime.md`, and `review-notes-guidance.md`. These include generation-safe async wrap-up, accurate late receipts and process telemetry; strict real recall evidence/owned cleanup and settled cost comparisons; native compaction result/deadline/cancellation/cost guarantees; and lifetime-stable A18 cohorts on resume. The ceiling and recall helpers received their notes in their continuations; the runtime/guidance notes require their final follow-up review.

The first real recall full-context answer is underway/reported successful on sonnet[1m] near298K; this alone is NOT a recall result. Require all three distinct chats, actual compaction facts and before/after scores, with original-source hashes unchanged. No own-chat cap activation has been accepted.

### Step 5 as built: recall release condition failed; cap remains off

The parent independently re-ran `npx tsx scripts/audit/recall-replay.ts evaluate --in _scratch/oct2-phaseD-round2/recall-evidence.json` (exit0; `parent-recall-evaluation.log`). Three distinct real chats, 40 questions, native CLI2.1.304 and Sonnet5.5[1m]: pooled recall **83.8% before ->47.5% after** (36.3 percentage-point loss). The worst chat lost53 points. Every original transcript's before/after SHA-256 is identical; 20 model calls exited0, and generated copies/forks were removed after the model-run report/seal/receipts were written.

| Chat hash | Questions | Native context before ->after | Recall before ->after |
| --- | --- | --- | --- |
| 85f27b9a | 15 | 298,446 ->3,347 tokens | 100% ->46.7% |
| 7618c3b8 | 15 | 278,330 ->4,454 tokens | 56.7% ->46.7% |
| d7a06912 | 10 | 296,587 ->5,927 tokens | 100% ->50% |

Ruling: the existing instruction, "No cap ships if recall is clearly worse", decides this outcome. Keep own-chat and machine ceilings at0; no new approval question or acceptance of lost recall is inferred. The guarded migration is nevertheless wired through `runSettingsMigrations` with the shipped evidence constantNULL, and isolated seam tests prove it writes neither cap nor marker. Future qualifying evidence is required before that path may activate300K; no real settings or user database was written by a script. Explicit nonzero user caps and helper exclusion remain protected.

The implemented quality criterion is <=10 percentage points pooled loss, <=25 points lost in any chat, baseline>=50%, >=3 distinct conversations, 10-15 grounded questions per chat, actual near300K compaction sizes, and evidence no older than120days. This run fails both loss limits by a wide margin. The quarterly replay kit is implemented; negative evidence is a tested rollout rejection, not an unrun live check.

Persistent, private-text-free report/evidence/receipts/seal: [`2026-10-20-oct2-phaseD-tokens_evidence/round2/recall/`](2026-10-20-oct2-phaseD-tokens_evidence/round2/recall/). These are reports and metadata only, not copied source or runtime. The initial replay attempt exposed a cumulative-cost baseline bug; it was fixed before the complete recorded run. A separate one-chat custom-summary experiment remained below the quality threshold and cannot qualify as rollout evidence.

### Worker graph retained after prompt logging

New Step8 instrumentation had reintroduced a 156th worker module, `context/prompt-injection-log.ts` through `rlm/llm-service.ts` (exact155->156 base-to-current walk retained as `worker-closure-progress.json`). Reproduced the unchanged isolation guard failing again (`worker-logging-red`, exit1). The worker now shares only the erased `PromptSurface` type and logs the same metadata with its already-loaded logger. Prompts, surface names and fields are unchanged. No guard/ceiling was raised. `worker-logging-green`:6files/61tests pass, including the isolation guard, RLM dispatch/cost paths, logging and budget table. The original cache normalizer relocation and this worker-local instrumentation both preserve the155-module baseline.

### Additional integration blocker found during parent review

Remote Codex spawn did not carry session kind, trial identity, queue role or the controller's token policy. The worker would default to a chat policy, defeating the machine hard stop and related economy controls. A focused remote-policy bridge repair is now in progress, following the existing strict/versioned Claude spawn-policy pattern. The source must transfer only public policy metadata, reject unsupported worker versions rather than silently drop it, and prove the policy through controller RPC ->worker factory ->Codex decision paths. No current app/worker deployment or security-mode relaxation is authorised.

### Round 2 implementation checkpoint (21 October; combined gates still pending)

The source work missing from round1 is now present: Codex live root/helper ceilings and durable queue parking, Costs top-ten/credits, required-skill and standing-note delivery, Claude/scout settings and metadata, recall kit plus gated migration, known-sleep/idle/native compaction, daily reconciliation, restart-cost previews including both permission-card YOLO paths, and RTK harm-check plumbing. This checkpoint does not close the plan: final review found premature remote Claude reviewer-rule proof and missing remote arm rows. A fresh implementation context is fixing the actual execution acknowledgment/telemetry boundary; it must pass before final combined verification.

- Remote Codex now carries a strict version1 public policy snapshot from controller to actual worker factory/policy/controller, with exact capability fence; worker-local settings are never consulted. Start/resume/reopen policy metadata now reaches the actual main writer through strict bounded telemetry, with once-only cohort hashing. Final helper selection:16files/195tests plus3files/23tests pass. Its earlier type failures were in concurrently changing Claude code, so they are not global green evidence.
- Runtime/UI helper:27files/356tests, Claude family43files/509tests, actual invoker/automation/queue wiring6files/308tests, production renderer build, changed-file lint and LOC pass. Seven negative controls fail as expected and all last-touched source files are restored byte-for-byte. Both permission-card paths now show cost before the click and hold large changes for confirmation, with stale request/session checks.
- A18/RTK cohort settings are in all seven surfaces; durable related-root identity survives native UUID changes, app recovery, compaction and worker restart. Known Opus only; caller model env wins; legacy resumes without proof remain excluded. The final remote execution-proof issue above supersedes any helper statement treating spawn acknowledgment alone as proof.
- Real RTK0.51.0 tests reproduced ignored denies and an explicit hook allow that could bypass native checks. Both modes now deny explicit RTK denials, and successful rewrite-only output supplies updatedInput without an allow decision. Real binary/hook checks cover exits, pipefail/counts, deny precedence and gain. The native Claude consumption probe is genuinely external-service blocked by the actual account monthly-spend limit, so the rollout remains OFF. Its future reproducible recipe is retained as product-side diagnostic source at scripts/audit/rtk-native-hook-probe.mjs (syntax checked and installed CLI flag checked; no provider invocation).
- After the latest settings/cohort changes, the four primary regression files pass36tests, including the unchanged155-module worker closure and unchanged audit cost expectation. The existing RTK awareness body is unchanged; its diff adds metadata logging only.
- Regenerated aliases,1205IPC channels and Codex protocol; IPC/export/contracts/protocol checks pass. Full renderer lint passes. Final combined static/build/targeted receipts will be added after source ownership is released; no full suite is run by this worker.
- Claude implementation helpers ended on the provider account limit; their exit0 wrapper results are not completion evidence. Codex helpers continued from their exact source. The nested workspace-write helper sandbox failed before shell startup (exit71); helpers ran with the same authorized unrestricted execution profile as this task, without disabling exec rules or changing approval policy.

## Round 2 as-built handoff (21 October 2026)

This supersedes the historical round1 ledger of 3/14 implemented. All fourteen steps now have their required source paths and targeted coverage. “Implemented” below means implementation/worker evidence, not an independent `VERDICT: PASS`. The queue coordinator owns the full suite, fresh completion gate, commit and document renames. Genuine installed-app/provider/future-usage checks are separated in the [live campaign](2026-10-20-oct2-phaseD-tokens_livetest.md).

| Step | Actual source/check status | As-built behavior and limits |
| --- | --- | --- |
| 1 | Implemented | Root-turn processed tokens include helpers; configurable150M wrap/300M machine stop, chat stop0. Generation-safe steering/interruption; typed deliberate stop parks queues durably without retry/replacement/recovery respawn. Costs top ten is wired. Command/hardened execution explicitly reports its unavailable mid-turn feed. |
| 2 | Implemented | Related-root chat-helper trial, Ultra allowance explanation/Harness clamp, actual root/helper shares and bounded late corrections retained under their original turn identity. |
| 3 | Implemented |1500-token machine skill cap and independent checker catalog trial; required installed skills remain named selections. Actual applied override names/catalog/arm are logged without config values. |
| 4 | Implemented | Durable known-Opus A18 cohort, explicit reviewer parent-model protection only with actual execution proof, caller precedence/legacy exclusions; native machine helper limits; balanced Sonnet/high scouts; own helper model/fork/depth metadata and truthful aggregate header costs. |
| 5 | Implemented;300K rollout rejected | Three real inactive chats/40 grounded questions ran through native compaction.83.8% baseline ->47.5% compacted (36.3pp loss); gates fail. Compiled qualifying evidence stays null: migration writes neither cap nor marker. Passing synthetic evidence tests cover the future conditional migration; quarterly kit/runbook exists. Originals unchanged; copies/forks removed. |
| 6 | Implemented | Durable-only standing notes bounded6K, developer-role delivery after native compaction with retry; actual related-root trial reports use provider credits and return NOT ENOUGH DATA when appropriate. |
| 7 | Implemented | Approx8K paged tool results preserve single execution; role tool profiles, remote visibility/search/describe, schema-byte ratchets, versioned status and annotations. |
| 8 | Implemented |31 core prompt budgets, injection metadata, authoring rules, shorter intent/worker guidance and duplicate-autonomy removal. Context worker remains155 modules with no Electron value import; unchanged guard remains<156. |
| 9 | Implemented | Measured cache lifetime; known-sleep recycle/compact; idle75m/100K hint suppressed by pending work; role-preserving PreCompact/precompute:false; bounded/cancellable native Compact-now retire/compact/resume with no dual writers, exactly-once pending sends/spend and unknown occupancy until measured reply. Worker bundle embeds canonical hook bytes; SEA hook commands retain existing external-Node prerequisite. |
| 10 | Implemented | Cache writes1.25x/2x, unknown1.6x; request-sized long-prompt premiums require authoritative finite window. Existing audit remains5.492638; provider dollars win, historical rows/caps unchanged. |
| 11 | Implemented | Bounded root Codex account/usage/read credits at reopen/end, including final remote billing tail; daily read-only Claude reconciliation scheduler/store/IPC/UI with coverage/legacy split and>5% flag. Real170-session reconcile ran without rewrites. |
| 12 | Implemented | Gemini/Antigravity advisory memory once; governing instructions/RTK retained. Generic product safety contains no James-specific host or platform routing. |
| 13 | Implemented;RTK remains OFF | Bypass counting, durable related-root queued harm-check setting in all seven surfaces, pinned0.51.0 real-binary/Node-hook tests. Explicit denies honored; rewrite-only success has updatedInput without allow. Native consumption genuinely blocked by actual monthly account limit; canonical bounded future probe retained, syntax checked only. |
| 14 | Implemented | All seven runtime diff flags have real previews before action; bounded replay/target share, large-change confirmation, both permission-card YOLO paths, stale request/session guards, account confirmation sentence and truthful restart notices. No invented live Copilot account control. |

### Additional runtime repairs found during review

The strict/versioned remote Codex spawn snapshot now reaches the actual worker adapter factory and ceiling/policy decisions; it does not read worker-local settings. Exact capability fences refuse old workers. Start/resume/reopen telemetry reaches the main session-policy writer with allowlisted key names only and once-only cohort hashing.

Remote Claude A18 evidence now comes from actual native system/init execution, buffered until successful spawn acknowledgement. Construction, an RPC acknowledgement alone, old CLIs, failed acknowledgements and absent proof cannot enroll legacy resumes. Strict bounded telemetry reaches the main arm writer, and the durable paired reviewer rule survives app/worker/native session changes.

Graceful remote Codex termination previously removed both worker and main listeners before final billing events. Scoped tails now retain only final share/credit accounting through termination, with lifecycle/proof detached immediately, identity/dedupe guards, bounded RPC and finally/force/rejection cleanup. The dispatcher ->manager ->notifier ->router ->actual writer regression proves both final records once.

The PreCompact worker route previously lost the hook when no Electron app metadata/assets existed. The worker build now embeds the canonical MJS bytes, with a lazy asset-free Node fallback. All three roles match canonical stdout byte-for-byte, drain malformed stdin, and have bounded quoted Windows commands. The built worker contains the exact2023 canonical bytes and passes isolated `--self-check`. Native Windows cmd.exe and SEA packaging were not run; SEA retains external Node on PATH. No duplicate role guidance or hook-runtime subsystem was introduced.

### Review integrity

The own-review pass checked implementation/runtime wiring, remote identity/lifecycle boundaries, conditional rollout decisions, targeted negative controls and added suppressions. No added test skip/only/todo, TypeScript suppression, coverage exclusion or changed isolation/LOC guard was found. Four narrow no-require-import lint exceptions are lazy runtime dependency boundaries (three Electron main-only directory lookups and one controller-only settings lookup); they do not suppress test/assertion behavior. The independent coordinator gate remains outstanding.

Final command outcomes and source/evidence hashes are recorded in `2026-10-20-oct2-phaseD-tokens_evidence/round2/remediation-report.md`, command receipts and seal; the source stays uncommitted in the supplied worktree. Historical red/partial helper receipts are retained as history and are superseded only by explicit final receipts, never by a wrapper exit0 after provider refusal.

### Final combined selection and timing correction

The no-cache final selection ran385 named impacted spec files (not the full repository suite):384 files passed; one real RTK binary/deny case exceeded its5-second case timeout, with6850 assertions passing, one timing failure and three existing platform-gated skips. It performed ten outer process launches plus nested RTK starts in one case. The same original file passed in isolation (3tests/7.2s), confirming a grouped integration-test budget problem under concurrent build/typecheck load, not a mismatched denial assertion.

The binary fixture now runs in Node, separates the three deny scenarios and gain check, and bounds every direct child process to5seconds. Each native integration case has a20-second budget; production hook timeout remains2seconds. All original deny/stored-allow/pipeline/count/exit assertions remain, with added explicit subprocess-error checks. No skip, suppression, production-code change or general timeout increase was introduced. The final affected-hook subset and spec typecheck are rerun after this test-only correction; their exact receipts are in the report. The385-file selection is not rerun again after this isolated fixture change, and is not falsely reported as a globally green run.

### Final worker verification receipts

After the isolated binary-test correction:12files/107tests pass (`final3-hooks`,22.3s), spec TypeScript passes (`final3-spec-types`,32.3s), main lint passes (`final3-lint-fast`). The final main typecheck, production main/renderer/worker builds, worker self-check, renderer lint, LOC, generators and wiring gates passed before that test-only change; none of their production inputs changed afterward. The new built worker has the exact canonical hook bytes and no deployed worker was altered.

The385-file run's384passed/one-timeout result is retained, with6850passed/one timing failure/three existing platform skips; the separate12-file green run verifies the correction and all three original source regressions. Full-suite execution is explicitly reserved for the independent verifier. The extra renderer-event audit still fails identically at base:three uncovered channels/two dynamic sends; comparison metadata and the unchanged checker's logs are retained, with no suppression or unrelated repair.

Root plan/history/live documents remain untracked at their original absolute paths. Final [report](2026-10-20-oct2-phaseD-tokens_evidence/round2/remediation-report.md), command receipts, source/check seal and cleanup receipt retain the actual evidence. The cleanup removes owned runtime/compile outputs/copied schemas and source fixtures after sealing, while checking every changed source/root-document hash. No dependency installation, database cluster, browser binary, GUI action, production settings/database rewrite, commit or branch/worktree lifecycle operation was performed. The coordinator owns the next independent completion-gate pass; this handoff is not self-certification.
