# Codex compaction lifecycle follow-up

Status: implementation ready for queue verification, 2026-10-31. Current-build live acceptance and the verifier's full gate remain open. No commits or completed renames.

Current checkout correction (2026-10-31): the historical final PASS below belongs to checkpoint `91310da8a`, which is not an ancestor of the assigned branch. Its source snapshot does not match this checkout, and several repaired helpers/regressions are absent. Historical evidence remains valid for its recorded source only. Port the scoped repair delta from `7e5222cfe..91310da8a`, preserving newer code, then obtain current focused/static/build evidence. Full-suite execution and final independent acceptance remain the queue verifier's responsibility for this run. Separate LT-716/717/718 follow-ups are not new requirements of the original six items.

## Current as-built handoff — 2026-10-31

Code changes exist only in the assigned worktree. This document and the new
[current-build live checklist](2026-10-27-codex-compaction-lifecycle-followup_livetest.md)
remain untracked in the root checkout. No separate spec is linked by this plan.

| Original item | Current result |
| --- | --- |
| 1. Investigate retained stuck-busy | Reproduced in the real adapter/runtime test harness: the capture's own `turn/started` was retained as a provider follow-up and replayed after raw compaction. Both notification/reply orderings fail before the repair and pass afterwards. The startup migration race also reproduces a native SQLite UNIQUE failure before its lock-order repair. |
| 2. Fix stale replay | Restored the current-turn identity filter, preserving actual later provider turns and expected Compact-turn ownership. Current provider/runtime regressions pass. |
| 3. Fix inline completion | Restored the armed-timer guard and inference rescheduling at genuine inline completion. Observed compaction has a finite 40-minute silence budget; ordinary 15-minute and shorter explicit limits remain covered. Restored retained-busy handoff, explicit original admission identity, dispatch CAS, five-minute unclaimed recovery, null-CAS refusal, local consumption settlement and Pause/provider-limit ownership. Current focused checks pass. |
| 4. Rebuild and repeat all seven live checks | Both production builds pass. The seven current-build UI/provider checks, including the real 35-minute watch, are **deferred**, with exact prerequisites/actions/expected results in the linked live checklist. Earlier source-scoped provider/lifecycle evidence remains historical; no new seven-check live pass is claimed. |
| 5. Durable evidence and status | Current baseline, failing regressions, repaired runs, final focused results, command exits, complete review diff and source hashes are retained in [worker evidence](2026-10-27-codex-compaction-lifecycle-followup_evidence/2026-10-31-worker/). Report/seals and cleanup receipts accompany this handoff. No historical failures or missing scenarios were erased. |
| 6. Verification, review, cleanup | Current focused run: 29 files / 626 tests pass. Application/spec typechecks, lint, size/UI guards, main/renderer builds, alias/IPC generators, IPC contract/usage checks, export and contract-alias checks pass. The full suite was **not run**, as instructed for this worker. Self-review found and repaired an additional thin-client forwarding omission. A fresh read-only reviewer timed out without a verdict; full independent acceptance remains the queue verifier's job. Owned output cleanup is recorded in the evidence receipt. |

Implementation decisions and limits:

- Ported the reviewed repair delta rather than replacing whole files. The existing
  transport additions and the newer durability-flag array replacement remain intact.
  The older LT-716 observation is not a claim about this checkout's current DOM.
- The thin-client route validates the same send-input schema as Electron IPC, so it
  must also forward `queuedAdmissionId` and `automatedInput`. A new boundary regression
  failed with both fields missing and passes after the forwarding repair. This is
  part of carrying the changed internal contract through every executing caller.
- The pre-existing dependency links resolved to a shared install with glob 13 despite
  this branch requiring glob 14. Installed the unchanged lockfile locally in this
  worktree, prepared native dependencies, and passed the unchanged compatibility guard.
  No manifest, lockfile, test/CI configuration, assertion threshold or shared install
  was modified. Keep the local `node_modules` for the verifier.
- Delegated implementers were denied writes/commands and made no changes. The parent
  performed the actual port and all recorded checks. The later independent review
  tool timed out after 300 seconds; it supplied no PASS or FAIL verdict. Neither is
  misrepresented as completed independent verification.
- Browser Gateway reports `windows-pc` healthy, with no matching isolated app target
  selected. No Mac UI, provider session or server was launched. The new live checklist
  states the authorized-runtime prerequisite; this is not an infrastructure-outage
  diagnosis or a request to reconnect the browser.

The coordinator owns full verification, current-build live acceptance, integration
and document completion. The implementation is reviewable; the plan is not declared
fully accepted or renamed.

Owning acceptance/evidence: [compaction turn visibility live test](2026-09-24-codex-compaction-turn-visibility_livetest.md).

1. Investigate and reproduce the retained stuck-busy observation; record its actual cause or the remaining uncertainty. Do not dismiss a reproduced observation because it used a raw provider request.
2. Fix stale replay of a completed Harness turn if reproduced, preserving capture of genuinely new provider turns.
3. Fix inferred completion during a genuine inline compaction if reproduced, preserving inline steering and actual turn completion.
4. Rebuild the isolated app and rerun all seven checks clause by clause, including the full 35-minute watch, meter DOM and next native usage, action diagnostics, and conditional renderer backoff. Retain missing and superseded scenarios explicitly; never substitute those for passes.
5. Keep durable command receipts, provider/lifecycle slices and a hash seal outside scratch. Correct contradictory current status without rewriting historical evidence.
6. Run focused and canonical verification; obtain fresh independent review; preserve any unresolved criterion as open. Stop app and remove only owned runtime output, preserving pre-existing dependencies.

Prior round2 implementation status (2026-10-27, before the second coordinator checkpoint)

- LT-710: exact stale completed-turn replay reproduced, patched in the turn adapter and live raw-request control returned idle with no old capture.
- LT-711: inferred-completion race reproduced, patched in the notification adapter; genuine inline compaction stayed busy through the armed-timer boundary. The distinct 15-minute capture watchdog remains LT-714, not a claimed long-duration fix.
- Check 1: failed exact single-idle requirement, LT-713 open. Queue/delivery itself succeeded once.
- Check 2: passed actual configured recovery at 386,038/475,000 (81.271%), native compaction and real same-thread continuation, one final idle. Deliberate configured-action trigger, not automatic occupancy selection.
- Check 3: supplemented with a genuinely new manual native Compact turn on fresh instance x2yg13iv7 (already-observed flag false), estimate ~29,942 then real 31,284 DOM. The earlier manual command reused the previously observed boundary. Passed real DOM, manual non-zero estimate, subsequent native usage replacement, inline copy and enabled Recover context. LT-681 status reconciled in register.
- Check 4: failed/open. Genuine inline provider process group held; 900-second notification watchdog produced an error and released capture. Watcher resumed provider safely; lifecycle completed at 907,539ms. Full 35 minutes and normal 30-minute positive sweep control were not achieved. LT-714 open; no timers extended or fake notifications emitted.
- Check 5: passed actual policy diagnostics, configured action completion proof/skip and durable direct requested/acknowledged/observed ledger rows; no provider-capture join needed.
- Check 6: passed real queue scenario and controlled live IPC rejections, six ~15.1s gaps then one real delivery. Configured bound 12 retained; all 12 exhaustion not repeated live. Fault injection explicitly identified and restored.
- Check 7: passed actual developer-role policy injection, Harness-authored system notice, completed original task and subsequent handoff that did not attribute a stop/scope change to James.
- LT-712: fresh-profile startup duplicate migration insertion observed; same-profile restart worked without database/source edits. Open separately.
- Static gates/builds passed; full suite failed 4/35,384. Three unrelated Claude timing assertions passed in isolated rerun; dependency mismatch remains because pre-existing links use a different-manifest root install. No manifest, dependency or verification config changed.
- Fresh independent task-completion-gate: overall FAIL due non-green full verification; scoped patch review PASS, independent 45+66 tests pass, no actionable code findings. No completion claim or completed-name rename.
- Durable evidence/report/seal/receipts are in the owning livetest's round2 evidence directory. Cleanup result is recorded there after restoring isolated settings, terminating owned instances, stopping app/server, and removing owned profile/build/cache/scratch runtime only. Pre-existing linked dependencies and shared caches stay untouched.

Current resumed implementation/acceptance (2026-10-27)

- The second coordinator checkpoint already contains a retained-busy queue handoff, a finite 40-minute observed-compaction budget, and concurrent startup migration/WAL fixes. This resumed worker rebuilt and tested that committed source; it made no product-source or test changes. Current durable evidence is under the owning live-test's `2026-10-27-resume/` directory.
- LT-713's single-idle clause passes live at 374,195/475,000 (78.78%): one real composer queue, one actual provider delivery, continuous main busy and one final idle. Check 1 still fails because LT-715 reproduced an exactly-once recovery defect: enriched dispatch creates a different delivered admission while the original stays promoting; reloading only the dev renderer sends it again.
- LT-715 remains open. Follow-up must retain authoritative admission ownership through enrichment and dispatch, settle its original durable row, and reject a null CAS without breaking genuine unsent restoration, cancellation or Pause races. The observed saved-queue warning is recorded separately as an observation, without an unverified UI root-cause claim.
- LT-714's old 900-second failure is historical. The current finite 40-minute compaction budget passes focused regressions and the genuine inline-compaction watch passes check 4: 2,101,016ms controlled hold, 2,105,742ms actual lifecycle, continuous busy/active capture, normal 30-minute idle control hibernated during the hold at 1793076396761. Genuine completion restored idle at 1793076766982; the next actual normal sweep at 1793076774577 considered the target with its newly reset idle clock and no inhibitors. This proves controlled guard/eligibility behavior; natural 35-minute backend computation and a further 30-minute target hibernation were not claimed.
- LT-712 has a source patch and focused concurrency/WAL verification in the checkpoint. The resumed app successfully reused the assigned profile; it did not run a fresh-profile UI migration campaign, so that separate live acceptance is not newly closed here.
- Checks 2, 3, 5, 6 and 7 retain their scoped round2 live evidence, not new resume pass claims. The qualified queue run additionally rechecked the inline meter/boundary and real usage replacement.
- Both builds, application/spec typechecks, lint, size/UI-hint checks, native archive smoke and focused seven-file verification pass. Full suite exits 1 (2 failures of 35,408), both reproduced in focused rerun. No tests, thresholds, manifests or verification configuration were changed.
- Full-gate investigation: the real pre-existing install contains MCP SDK and related packages absent from this branch's lockfile, created before this worker began; this is not the earlier linked-install failure. The context-worker closure is 155 at base and 156 at HEAD, with only rlm-wal.ts added, no removals and no Electron value-importers. The strict <156 guard still fails. Repair the install and resolve the module-budget issue through normal reviewed implementation before claiming a green gate.
- Independent acceptance remains the queue coordinator's job. No overall completion, independent PASS or completed-name rename is claimed. This active plan stays untracked and uncommitted; the historical completed remediation plan was not extended. Cleanup and final seal will be recorded after the watch.

Resumed cleanup verified: the owned app, providers and server stopped; assigned profile/build/cache/scratch runtime was removed, pre-existing dependencies preserved. See the owning live test’s cleanup receipt and final seal. The plan remains active because LT-715 and both full-gate failures are unresolved.

Verifier repair in progress (2026-10-27)

- Keep explicit queued-admission identity through queue promotion, IPC, prompt enrichment and dispatch; reject null CAS without losing an unsent Pause-race message. Preserve provider payload and ordinary send receipts.
- Move the unchanged WAL startup helper into the existing schema module rather than increase the worker graph budget.
- Repair only the confirmed extraneous local install directories; preserve manifests and lockfile. Broad npm prune dry run proposed unrelated upgrades and is not applied.
- Rebuild and live-recheck delivered admission state, renderer reload, and subsequent independent queue delivery; run canonical gates and a fresh independent review. Queue coordinator owns completion rename.

Verifier repair as-built/live evidence (2026-10-27)

- Explicit queue identity, dispatch CAS, null promotion refusal, local unsent Pause ownership and non-retryable invalid claim are implemented. Two native inline compactions above 75% each delivered once on their original admission and ended idle once. Subsequent renderer reloads restored no queue and did not send again. The second independent queue handoff also showed the normal compaction banner/hint.
- WAL helper moved unchanged into existing schema, restoring closure 155 with strict <156 unchanged. Dependency compatibility passes after removal of only 12 confirmed extraneous local package directories absent from the lockfile; manifests unchanged.
- Full canonical suite and independent gate remain in progress. No completed rename or overall acceptance is claimed yet.
- LT-716 (stale not-saved label despite a durable row) and LT-717 (reload during compaction loses presentation) are separately filed display follow-ups. They are not fixed by the delivery patch; exact causes are not independently isolated. The historical completed remediation plan remains unchanged.
- Live runtime shutdown: disposable instance terminated, no automations, original settings restored, observers removed, provider PID absent, app quit and static-server supervisor exited 0. Final filesystem cleanup follows the final report/seal.

Final ownership correction and verification status (2026-10-27)

- Fresh gate 1 found genuinely unsent promotions stranded after renderer-only loss. The actual promotion CAS now renews a stale unclaimed user row after the existing five-minute window. A real five-minute same-main watch, with no sweep or manual retry, recovered the original row once. Fresh gate 2 found locally consumed replies/commands that bypassed the provider receipt. They now claim before acting and settle the same row; delayed replies cannot fall through into provider text.
- The complete return-path audit also preserves queued text under provider-limit/account-switch holds, fences late global Pause, and terminalizes unsupported attachment-only consumption honestly as failed. Focused regressions and latest typechecks/lint/size checks pass. Compact retains its existing immediate acceptance behavior.
- Frozen-build native compaction passed again at 79.57%: one enriched provider delivery, original receipt delivered, one final idle, reload empty. A controlled mode request plus real paused composer reply was consumed once; its row stayed delivered with no raw-reply replay beyond eight minutes after reload. All owned app/provider/renderer/utility/server PIDs are now gone and ports closed.
- Third fresh review has no actionable code finding and independently passed canonical static/build/focused gates. Its first full run failed in SEA test reporting because the shell's Homebrew Node lacks the required fuse; unchanged standalone and focused cases expose and confirm that cause. The pre-existing .nvmrc-pinned Node passes both unchanged cases. Current canonical/full rerun uses that existing runtime through child-only PATH, with no install or source/test/config modification. Final verdict/full result pending.
- LT-716/717 remain separate pre-existing display follow-ups. The diagnostic source-map parser's false match of a literal tsx generator string is separately retained as an external tooling limitation, not a claimed code fix. No completed document is extended or renamed.

- LT-718 now records that reproduced external test-formatting limitation and the exact standalone/pinned-runtime evidence. It remains a tooling follow-up; the immediate SEA runtime prerequisite is resolved by selecting the already installed project pin. No vendor/test/dependency modification is part of this repair.

Final canonical acceptance (2026-10-27)

- All eight canonical gates independently pass under the existing pinned Node 24.22.1. The final unfiltered normal suite exits 0 with 2,796 files / 35,435 passed tests, zero failed files/tests and both SEA cases passed. Existing conditional skips are unchanged. No test filters, cache override, diagnostic preload or installation were used for that passing full run.
- Latest frozen-source native compaction and controlled local-reply live proofs pass; genuine unsent five-minute recovery and retained earlier checks are scoped in the owning live test. All owned processes and ports are stopped. Original requested repairs are verified; the final written fresh verdict follows status reconciliation, and filesystem cleanup follows report/seal.
- This working plan stays active/untracked because separate display/tooling follow-ups remain open. The queue coordinator alone owns the live-test document's completed-name lifecycle. No commits, stash, branch/worktree changes or document renames were made.

Final fresh gate: VERDICT: PASS (third independent context), no unresolved actionable finding within the original repairs. All required code/live/canonical items are verified within the owning live-test's explicit scope; separate display/tooling follow-ups remain open. Report/receipts and seals are retained with that document. Owned filesystem cleanup follows the pre-cleanup seal; no project commits or document renames are made.

Cleanup verified after report/retention/pre-cleanup seal: removal exited 0 and owned profile, dist/.angular outputs, runner scratch and verifier helpers are absent. All recorded app/provider/renderer/utility/server PIDs are gone and ports closed. Existing dependency install/caches, prior evidence and AIO checkout/branch remain. Final source/Git/readback receipts and final seal are in the owning evidence directory. This active plan stays untracked for its separate follow-ups; the live-test filename is unchanged.
