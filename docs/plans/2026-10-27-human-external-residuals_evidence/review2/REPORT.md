# Review round 2 evidence, 27 October 2026

Status: **PARTIAL / NOT READY FOR CAMPAIGN CLOSURE**. No independent PASS is claimed.
Owner: root checkout's `docs/plans/2026-09-27-livetest-human-external-residuals_livetest.md`,
section `evidence-run--2026-10-27-review2`. This worker edited the owner only in the root checkout;
it did not create or update a worktree copy.

## Six verifier findings

| Finding | Actual status |
| --- | --- |
| 1. Deleted tracked follow-up blocks overlap landing | Repaired. Restored exact main version as an untracked file for the coordinator checkpoint; newer root edits untouched. See `restoration-validation.receipt.json`. Include this restoration in the checkpoint. |
| 2. Campaign mostly open | Still incomplete. Fresh tally: 20 Open, 7 Partial, 1 Failed, 0 Closed, plus 1 retired duplicate. Dispositions are not passing acceptance. |
| 3. Agent-runnable checks and defects | Partly repaired. Real deferred adjudication, denial breaker, outage, full isolated enrolment and cross-profile resume were run. LT-780/LT-781 fixed. LT-991 reproduced/fixed in source but packaged live rerun pending. LT-890 remains unproved/unfixed; other technical branches remain explicit. |
| 4. Two synthetic production CAPTCHA notices | Unresolved. Exact read-only pending status retained. Normal packaged-app Skip is not exposed through this worker's available controls. No direct production DB modification or fabricated human solve. |
| 5. Unsupported RES-020 pass | Corrected to Partial. Historical elapsed-time evidence retained; disposable signed-in profile and outgoing cancel-RPC proof remain absent. No strict PASS. |
| 6. Stale tally | Corrected with `Status — 2026-10-27` in the root owner. All 28 active groups still have unmet acceptance. |

## As-built code and executing paths

- `src/main/mcp/copilot-account-cli.ts:133`: pass the method payload directly to the
  existing RPC client; the client constructs the transport envelope. Strict parent dispatch
  previously rejected the double wrapper. Real packaged-parent list/rules/doctor/route now
  return parsed exit-zero results (`cli-live.receipt.json`).
- `src/main/mcp/aio-mcp-dispatcher.ts:109`: assign `process.exitCode` after command completion
  so stdout drains before process termination. Actual settings JSON matches between pipe and
  file, 115,377 bytes and 224 settings. Only counts/hashes were retained. Spawned CLI tests
  cover four strict operations, 450,316-byte backpressure and nonzero parent refusal.
- `src/main/browser-gateway/browser-target-persistence-sentinel.ts:244`: decode the actual
  extension evaluate `{type,json}` envelope, including a possible outer `result`; malformed
  or truncated scan input remains unknown. The existing `browser-app-write-guard.ts:48`/`:67`
  consumes the scan before/after writes; `browser-reliability-operations.ts:71` supplies it to
  `runAssertPersisted`, whose failure-signal check is at `browser-assert-persisted-operation.ts:92`.
  Actual packaged Gateway live output reproduced false success with a retained stale banner,
  filed as **LT-991**. Scanner and reconnect/write/persistence integration regressions pass.
  This branch was not deployed into the packaged coordinator, so no repaired packaged live
  pass is claimed. Fixture-level save disconnection substituted for a whole-machine outage.
- Shared register records LT-780/LT-781's implementation, LT-991 and the unrepaired LT-992. The root active
  `2026-10-27-human-external-review2_plan.md` holds the matching implementation record.
  LT-890's earlier intermittent RLM startup lock remains open; the new first launch succeeded.
  Existing default SQLite busy timeout already equals 5 seconds; no unproved lock-owner fix.

## Additional live evidence and limits

- **RES-017:** actual native permission request, real local-model auto-allow and durable audit
  (`guardian-audit-final.receipt.json`, `guardian-ready*.log.txt`). Controlled fixture denials
  then produced three denied rows, one pause notification and a waiting fourth request.
  The fourth was rejected once through the ordinary isolated UI API. A subsequent request
  lost its owned endpoint in flight and waited for permission without automatic approval.
  Denial/outage responses are explicitly synthetic, not model inference. Loop cancellation
  errors remain visible; graceful whole-loop completion and the human-only category branch
  remain unverified. No shared model service was stopped.
- **RES-018:** `enrol-matrix.receipt.json` proves initially empty isolated parent, required
  two-model/eleven-role configuration, model discovery, main-model inference canary, list,
  duplicate refusal and one final target. `matrix-ui*.log.txt` verifies the real renderer form
  matches. Secondary-model inference and production routing mutation/retain choice are not
  claimed. The target was retired and settings restored.
- **RES-029:** `native-profile-resume.receipt.json` proves the exact native session resumed
  across two authenticated Claude profiles. No-tool single turns recalled a harmless marker.
  App-level switch notice, exhausted limits, worker binding and billed input remain unverified.
- **RES-013/014/028:** receipts retain bounded Apple-device tooling plus independent USB
  enumeration, browser observation limits and exact-resource history search. Empty discovery
  is not proof of no wireless phone. No guessed business resource or credential value retained.
  Later `xcdevice` discovery positively identifies the requested physical iPhone available over
  the network on iOS 27.0.1 (`independent-xcdevice.receipt.json`). Named and exact-identifier
  `devicectl` lock-state controls still time out at 25 seconds; control recovery remains technical
  work. No lock state, installed build or physical interaction is inferred, and no phone setting,
  pairing or app was changed. Identifiers are hashed in the retained discovery/control evidence.
  A fresh Windows current inventory and non-mutating closed-registry preview returned no
  eTendersNI resource. The worker tool rejected the file-only history query before spawning,
  through its shared-browser placement guard; no history, cookies or passwords were read.
  See `cft-extra-recovery.receipt.json`. The exact original resource remains unknown.
- **RES-019:** the initial case-sensitive project filter missed `My Trade Mail`. Listing all
  visible projects and matching locally without case found `gen-lang-client-0643087399`,
  confirmed by read-only project metadata from the saved production FCM file reference.
  `firebase-iam-read.receipt.json` records successful project, service-account, policy and
  ancestor reads. The dedicated sender has only `roles/firebasecloudmessaging.admin` directly;
  there are no group/public bindings and the ancestor chain contains only the project, so no
  organisation/folder role applies. `firebase-role-permissions.receipt.json` records nine
  permissions including topic-subscription and delivery-data operations. The deployed FCM
  adapter sends HTTP-v1 messages; strict send-only privilege is not claimed. No IAM or key
  change occurred. `sentry-alerts-read.receipt.json` records Windows preflight, existing
  remembered credential approval, secure fill and subsequent verified login. The payment
  (1291185), provisioning (1291195) and all-project error (1291216) rules are enabled (Disable
  controls visible), have the expected filters and notify James. Immediate submit verification
  reported no URL change; a later snapshot verified success, without a repeat submit. No
  event, rule mutation or new pending approval was created. The owned tab was closed.
  Controlled production errors, notification delivery and owner acknowledgement remain unrun.
- **RES-023 cleanup:** pending IDs are
  `8f3f77ab-c6bd-40fa-adf4-97d4af804734` and
  `c3725ca0-abab-49c5-9330-7766adc6ef02`.
  Their latest read-only status check at 07:23:58 UTC still reports both pending
  (`prior-escalation-final-state.receipt.json`). Only their ordinary packaged-app Skip remains.
  This is an unavailable supported control,
  not a new cleanup-approval requirement. The new Windows fixture tab/server were removed.

## Verification

Baseline focused checks, red-before/green-after spawned CLI checks and scanner envelope
regressions are retained with their actual command statuses. Invalid early fixture attempts
are retained and do not count as defect reproductions. `transport-red-final` is the corrected
pre-fix CLI reproduction; `transport-final` verifies the final bounded-child-cleanup test.

Current successful gates: main build, renderer production build, main typecheck, spec
typecheck, lint, TypeScript size and UI-hint checks, focused CLI/adjudicator/document-merge
checks, sentinel/write-guard/persistence integration checks.

Full suite: **PASS on Node 24; Node-26 collection defect remains**. Initial attempt stopped with exit 130 after starting above the
campaign host-load limit. Replacement waited until all three averages were below 30, then was
also stopped with exit 130 when shared host load surged to 114/60/41. That run had one observed
dependency-compatibility failure: twelve extraneous packages absent from the lockfile. The
failure was observed before the load surge and is not attributed to load. Offline, no-save,
ignore-scripts npm prune removed exactly those twelve, with no additions, version or manifest
changes; `dependency-tree-clean.receipt.json` records the subsequent tree inspection. The
normal test was not weakened. All seven non-suite canonical gates and the dependency check
then passed again. The post-prune Node-26 full run completed with exit 1: three failed assertions
in two unchanged files plus an unhandled source-map/collection error for the packaging spec.
The two assertion-failure files pass separately unchanged. The packaging error reproduces under
Node v26.12.1; both packaging cases execute and pass under supported Node v24.22.1. This is
**LT-992**, not repaired; the default quiet summary omitted its collection error while other
assertion failures were present. Full default-reporter output and complete assertion messages
are retained. The complete normal Node-24 suite with two forks **passed, exit 0**, completed
at 07:17:53 UTC (`full-suite-supported-runtime.receipt.json`). This verifies the current source
under a supported runtime; it does not repair LT-992's Node-26 collection failure or establish
the missing packaged, physical or human acceptance. The Electron in-memory native-driver control
also passes; raw Node ABI mismatch is expected because the installed native addon targets Electron
and the existing Vitest setup explicitly uses SQLite WASM. No native rebuild was performed.
The final transport-test cleanup edit passed fresh spec typecheck and lint.
No changed slow-tier path was identified, so the optional slow suite was not run. Signed
release, packaged-coordinator retest, physical interaction and human acceptance limits are
listed in the owning document. `verification.receipt.json` lists every selected gate and its
actual exit, the nine pre-existing pending cases in the normal suite, and the missing independent
verdict. Full command output is retained in `test-run-full-logs.tar.gz`, indexed and hashed by
`test-log-retention.receipt.json`.

Fresh self-review checked the complete diff, parent transport shape, write-guard/persistence
wiring, child process lifetime and existing assertions. This is not the independent queue gate.
The changes delete no tests, add no skips and weaken no assertions; the wrong wrapper expectation was corrected
only after reproducing the runtime failure. Queue independent verification remains pending.

Three fresh helper attempts did not return a verdict. The first exited 1 without a retained
failure subtype; the second explicitly reached its 40-turn limit; the third received the full
relevant source/skill directly with no tools but timed out after 180 seconds with no structured
output. All children stopped and were reaped (`independent-review-status.receipt.json`). None
counts as a completed review or PASS. The queue's fresh independent gate is still required.
The helper cost estimates are not provider billing evidence.

## Cleanup and authority

The isolated runtime used `/tmp/aio-lt-queue-af185985`, CDP 9554 and renderer 9654. Focus
emulation preceded DOM assertions. UI cleanup retired the target, restored/read back all nine
saved settings identically, disabled adjudication, dismissed the owned breaker notice and
terminated all three dev instances (`ui-cleanup.*`). Owned Electron and renderer processes
stopped and were reaped (`runtime-stop.receipt.json`); owned denial endpoints and Windows
fixture helpers stopped. No zero-provider-cost claim: helper/title fallbacks occurred.

The pre-cleanup seal records source/owner/evidence hashes before deleting runtime. The cleanup
receipt records actual deletion of owned profile, build outputs, compile caches, scratch tools,
loop state and exact owned native transcripts. Existing locked dependencies and managed checkout
are retained; only the twelve obsolete unrecorded packages were pruned. Final seal binds the
retained report, owner, command receipts and cleanup result.
The two old production CAPTCHA notices are the explicit unresolved cleanup exception.

No commit, staging, stash, branch change, deployment, external push/PR or completed rename.
