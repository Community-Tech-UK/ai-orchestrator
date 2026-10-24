# Phase D: deployed validation and provider checks

Status: pending. Run this campaign only after the coordinator's source verification and independent gate pass. Implementation/agent-run evidence belongs in [history](2026-10-20-oct2-phaseD-tokens_history.md), not in the unchecked boxes below. The 300K recall experiment already ran and failed its quality gate; it is not a deferred live test.

Plan: [Phase D](2026-10-20-oct2-phaseD-tokens_plan.md). Prerequisites: safely rebuild/restart the intended Harness instance, update the execution worker to the matching protocol, and use disposable sessions with ordinary signed-in provider accounts. Keep the original settings for restoration. RTK auto-approve scope remains OFF until section8 passes; no 1.x binary upgrade is authorized by this plan. Claude account service must resume before provider-backed Claude checks: the worker received the actual monthly-spend-limit refusal and did not raise limits or switch credentials.

Remediation flow: read the [live-test campaign runbook](livetest-campaign-runbook.md) first. Record each reproduced defect in the [remediation register](livetest-remediation-register.md), with a matching implementation-status section in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here. Rename this document `_livetest_completed.md` only when every check has evidence.

Browser work must preflight and explicitly target `windows-pc` through the Browser Gateway. Never fall back to the Mac without James's task-specific authorization. The Harness desktop is a hard-denied automation target: James performs installed-app UI steps unless an authorized renderer is exposed as a Windows browser page. CLI and ordinary headless project checks need no GUI. Never record credentials, raw environment dumps, private prompts or conversation text in evidence.

## 1. Codex ceiling, deliberate stop and Costs list (Steps1/2/11)

- [ ] In a disposable app-server Codex queue job, use the configured150M wrap/300M stop limits, or temporarily lower `codexTurnCeilingHarnessWorkWrapUpTokens` and `codexTurnCeilingHarnessWorkStopTokens` through normal settings in a test profile. Include a helper. Expect root and helper processed tokens to contribute, one delivered developer-role wrap-up, then one deliberate interruption. Do not deliberately spend300M merely to test the mechanism. Restore original settings afterwards.
- [ ] The job parks immediately as `stopped-by-harness`, with the plain Harness notice; retries, worker replacement, triage and recovery do not restart it. Test a normal app restart after parking. An explicit user Resume is separate from automatic retry.
- [ ] A disposable chat/ordinary child uses its chat-group thresholds: default wrap150M, stop0. It is not interrupted. Inspect the four separate threshold controls and zero/off behavior. A command-mode/hardened session visibly states that its ceiling cannot act mid-turn; do not relax hardened permissions to get a live feed.
- [ ] Finish/close a native root thread locally and on the updated worker. Where Codex supplies account/usage/read billing data, the main session-policy log receives its final thread-credit row and final helper-share correction exactly once, under the controller session identity. Unsupported/API-key/forced-kill paths show unavailable data rather than invented zero credits. Ordinary lifecycle messages must not revive an ended session.
- [ ] Costs shows at most ten biggest turns for the last seven days, session and kind, processed tokens and available helper share/stopped marker. Credits are a provider unit; dollars appear only where reported. Compare with metadata receipts, not a guessed token-to-credit exchange rate.

Why deferred: real provider notifications, graceful child-process/worker transport shutdown and deployed queue recovery need rebuilt running instances. Counter/adapter/RPC/writer fixtures and queue recovery tests run in-loop.

## 2. Codex helper/catalog trials and standing notes (Steps2/3/6)

- [ ] Start a new chat in each chat-helper arm and a queue worker/checker in each relevant arm. The policy row records the actual override key names, catalog and checker arm. Checkers in the omission arm load the named governing skill despite having no automatic catalog; rejected override sets record applied:false, empty keys and native catalog. Required installed skills remain selectable by name. Logs must not contain config values or prompt text.
- [ ] Related queue rounds/checkers and child sessions retain their root/task trial identity across resume. Repeat through the updated worker; old workers are refused with an update-worker error rather than silently running an unlimited chat policy.
- [ ] In a disposable long Codex session, let native compaction happen and send another turn. Expect one standing-notes developer item, bounded to6K characters, containing durable notes only. Repeat idle Compact now. A failed injection is retried on a later send; transient reminders and tool output are not accumulated as standing notes.
- [ ] Ultra explains allowance use before selection. Harness work clamps it to max; an ordinary chat retains its explicit Ultra choice.

Why deferred: the installed provider must accept/render the overrides, skill selection and injected developer item. Real adapter/thread retry/standing-note tests already cover local delivery logic and strict remote transport.

## 3. Claude native helpers, A18 and scouts (Step4)

- [ ] With a supported Claude CLI and known Opus parent, create fresh roots in both A18 arms using `claudeHelperAgentModel=trial`. A candidate general-purpose helper uses Sonnet; a reviewer/checker/fresh-eyes helper explicitly uses the parent's model, and a caller/agent explicit model remains authoritative. Forks retain their requested model. Unknown/default/Sonnet/Haiku parents are not silently enrolled.
- [ ] Resume, Compact now and restart the app/worker. The cohort and paired reviewer protection survive. A legacy session without actual reviewer-rule proof remains un-enrolled. An old CLI cannot grant proof merely because an RPC acknowledged its spawn; upgrading and resuming it must preserve that exclusion. Inspect only bounded decision metadata/native model identifiers.
- [ ] Queue/loop/automation overlays contain the verified native depth/spawn/concurrency/fork limits and role-specific PreCompact preservation block alongside the existing permission hook. On a built Node worker the canonical block is embedded; SEA hook commands retain the existing external Node-on-PATH prerequisite. Ordinary children are excluded from those machine limits. `precomputeCompactionEnabled:false` remains in the machine overlay.
- [ ] Spawn research scouts: balanced/Sonnet with high effort unless explicitly overridden, lead performs synthesis on its chosen model. The header counts descendants and shows known aggregate helper cost; unknown costs stay visibly incomplete. Helper audit metadata carries the helper's own model and available fork/depth/foreground-background values without changing root occupancy.

Why deferred: actual native helper/fork/reviewer model behavior and installed app/worker adoption need provider service and rebuilt sessions. Durable fresh-process, worker hibernate/wake, old-version, factory, compaction and telemetry boundaries are tested in-loop.

## 4. Known sleep, idle hint and Compact now (Step9)

- [ ] A disposable local Claude chat with measured occupancy>=200K and a scheduled wake beyond its measured cache lifetime compacts while quiet. A busy one waits for idle; live background/self-wakeup work inhibits it. A persistent loop instead recycles with its hand-off on its next iteration; borrowed chats use the local pre-sleep route. Quota parks make no paid compaction call. A parked queue worker has already retired and resumes in a new worker.
- [ ] Cache-creation metadata showing5m or1h changes the cache-lifetime decision; helper frames do not replace the root reading. Missing evidence uses the documented one-hour assumption. These thresholds have fake-clock tests; no manual75-minute wait is required for source acceptance.
- [ ] In a quiet local Claude session on CLI>=2.1.304, Compact now retires the resident process, performs the separate native /compact call, then resumes the same native session. A message arriving during the operation is sent once. Closing during preparation/compaction never respawns it. Real background/deferred/permission work is refused without a destructive fallback.
- [ ] Occupancy is unknown until a measured reply, not the old reading or a claimed zero. Failed compaction spend, when reported, is booked once. A remote/worker Claude session advertises no native compaction capability and uses the existing summary restart route.
- [ ] On an eligible idle Claude chat, the fresh-session hint says how many tokens a fresh session avoids. It stays quiet for pending wake-ups, background work, attached active loops and dialogs; controls do not move focus.

Why deferred: scheduler/provider timing, actual native process retirement/billing and deployed visual state need the rebuilt running app. The CLI recipe itself was proved in-loop, and bounded retirement/cancellation/spend/unknown-occupancy behavior has unit/runtime/component coverage.

## 5. Costs, reconciliation and price visibility (Steps10/11)

- [ ] After the two-minute startup delay, Costs has a read-only daily Claude reconciliation summary, coverage and the separate legacy/per-turn groups. Check now refreshes it. More than5% aggregate drift flags; missing/unsettled/unknown-model transcripts remain excluded and visible in coverage. Do not modify the live ledger to manufacture drift.
- [ ] A supported native helper reports its own model through local and updated-worker transport. Compare exact cache-write lifetime estimates and authoritative request-sized long-prompt estimates with source receipts; provider-reported dollars retain precedence. The existing large aggregate audit example is not reclassified as one oversized request.

Why deferred: locally read-only real-data reconciliation already ran, and threshold/parser/store/scheduler/IPC/UI tests pass in-loop. Adoption in the restarted app, its saved daily report and actual provider figures need the deployed process and service. No cost-store rewrite or daily cap increase is part of this campaign.

## 6. MCP budgets/discovery and Google delivery (Steps7/8/12)

- [ ] Fresh checker/triage sessions omit managed browser, desktop, imap and codemem servers; ordinary chats/workers retain their profile. With no workers, remote-worker tools are absent from the visible core but discoverable by search; an unavailable roster does not pretend no workers exist. Search returns names/descriptions and describe returns schemas.
- [ ] On an authorized disposable Windows browser page, large snapshot/click and orchestrator list/read results are bounded near8K characters with a usable continuation. Following the receipt must not repeat the click. Status sinceVersion returns unchanged:true only before a real content change. Built-in tools expose their read-only/destructive annotations.
- [ ] Disposable Gemini and Antigravity sessions receive advisory memory only on the first provider call. Governing project instructions and RTK remain; generic product safety contains no hard-coded personal host/platform policy. Inspect metadata rather than logging private memory/instructions.
- [ ] A new session requesting scheduling/consensus gets the corresponding short intent section. Prompt-injection diagnostics show surface, character count and session only. No repeated autonomy paragraph or full guide expansion appears.

Why deferred: deployed CLI tool profiles, browser transport and native Google calls require rebuilt instances and external sessions. Schema-byte ratchets, paging/single-execution, status versions, annotations, prompt budgets and adapter delivery are tested locally.

## 7. Cost before restarting changes (Step14)

- [ ] In header/composer model pickers, inspect provider/model/effort/local-target choices before committing. Replay notes state the bounded carried summary and target-window share where known; native re-read notes state full-price tokens only when true. Large changes require yes; cancel preserves the session.
- [ ] Header auto-approve and both permission-card YOLO branches show cost before action and hold a large change. A replaced request/session or closed component invalidates a pending preview/yes callback. Declining leaves the original permission request intact.
- [ ] Account-chip switching includes the sentence in its existing confirmation; cancelling never switches. There is no live Copilot-account control to invent: pure runtime-diff support exists. Post-switch notices describe replay truthfully and never promise full context preservation.

Why deferred: actual process identity changes and installed app visual/accessibility behavior require a rebuilt instance. Real Angular component/template flows, all seven diff flags, stale-state handling, target sizing and production AOT build run in-loop.

## 8. RTK native consumption and subsequent measurement (Step13)

- [ ] When the ordinary Claude account service resumes, run once from the checkout:
  `rtk proxy node scripts/audit/rtk-native-hook-probe.mjs`
  It uses the pinned bundled0.51.0, normal dontAsk permissions with explicit harmless grants plus project-local denies, existing authentication, no session persistence, and at most8turns/$0.50 per OFF/ON arm. It prints its exact owned runtime under `_scratch/rtk-native-hook-probe/` and retains raw stdout/stderr and receipts there. Any provider refusal/limit/transport failure stops it immediately. Do not raise limits, switch credentials or use a permission-bypass flag to get a result.
- [ ] Inspect receipts and raw tool results: exactly the four intended unique calls per arm; failing show remains an error, pipeline count is2, diff remains denied, and ON metadata rows show the rewrites/denial without duplicate tool calls. Native CLI must consume updatedInput while retaining its permission checks. A zero script exit alone is not this acceptance decision.
- [ ] Run the ordinary installed `rtk gain` afterwards and verify the existing binary still works. Preserve report/seal/receipts, then delete only the script's printed owned runtime. No global hook/user settings change is part of the probe.
- [ ] Only after the native check passes, use normal app settings to enable the queued harm-check trial for fresh eligible roots. Existing roots retain their frozen scope. Keep the awareness body and0.51.0 binary until Decision10 changes them. No extra Savings/RTK product surface is added.

Why deferred now: all local real-binary/Node-hook exit, pipeline, deny-precedence, counting and gain checks ran. Native Claude hook consumption genuinely needs the provider account, which rejected execution with the monthly-spend-limit response. The future script is syntax/flag checked only; it has not run against that provider. Account ownership is required to authorize any paid-limit increase; waiting for normal service does not require one.

## 9. Effectiveness after enough ordinary usage

- [ ] After a real week of updated-build usage, run `npm run audit:codex-helpers -- --since <YYYY-MM-DD>` and `npm run audit:rtk-trial -- --since <YYYY-MM-DD>` read-only. Use Codex's recorded credits as the provider unit and related-root cohorts for RTK Bash calls/session. Respect NOT ENOUGH DATA and confidence bounds; a harm check is not proof of savings.
- [ ] Re-run the three-chat recall kit quarterly using `docs/runbooks/recall-replay-quarterly.md`. This run's40-question score fell83.8%->47.5%; the compiled evidence remains null and the300K migration changes neither values nor marker. No cap rollout is awaiting an inferred approval. A future genuinely passing measurement is a new evidence update, not permission to ignore this failure.

Why deferred: future usage/time and available provider resources are intrinsic to effectiveness measurement. Real baseline reports already ran read-only; source, schema, cohort grouping and scorer/gate behavior have local evidence.

## Evidence

Pending deployed/provider confirmation. The root round2 evidence folder retains the recall report, source/check seals, command receipts and implementation reports. Keep private transcript text and credentials out of this document. Each checkbox needs its own observed result before completion.
