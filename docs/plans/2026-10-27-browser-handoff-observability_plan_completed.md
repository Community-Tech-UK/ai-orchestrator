# Browser handoff observability follow-up

Status: round 1 verifier findings repaired 2026-10-31 in the assigned queue checkout;
focused checks passed, full-suite recheck in progress. Active and untracked.
The formal queue verdict and rebuilt-coordinator live campaign remain open.

Owner: browser command delivery and Gateway audit pipeline.
Source: [LT-712](livetest-remediation-register.md#lt-712), a follow-up to LT-616, and
[AR-003](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-003--lt-371-live-browser-command-socket-handoff-correlation).

## Implementation status

- [x] Register the observed missing dispatch-to-audit join and queue-position evidence.
- [x] Recheck retained runtime receipts and the current store → read query → result recorder →
  audit path. Distinguish the unidentified installed binary from the identified reviewed source.
- [x] Carry content-free read dispatch identity through the existing delivery/audit path.
  Preserve approval request IDs. Add a migration if durable audit storage needs a new field.
- [x] Record actual FIFO-head reinsertion and enough dispatch/receipt/result identity to prove
  one execution. Preserve the original deadline and refuse replay after an ambiguous receipt.
- [ ] Verify the executing path, then add focused correlation and queue-order regressions;
  run all canonical gates and fresh independent implementation review.
  - [x] Worker focused checks, typechecks, lint, contracts/UI/file-size checks, both builds,
    and final fresh independent source review passed.
  - [ ] Queue verifier runs the full suite and returns its independent queue verdict.
- [ ] Run the deferred rebuilt-coordinator campaign in
  [the owning live check](2026-10-27-browser-handoff-observability_livetest.md).

The 2026-10-27 correction registers this technical prerequisite; it does not authorize replacing
the installed coordinator, changing production routing or using mutations to obtain a journal ID.
The completed historical remediation plan stays unchanged; this active plan owns the additional
scope. The queue coordinator owns integration, independent verification and any completion rename.

## As-built notes — 2026-10-31

Implementation checkout: `.worktrees/queue/2026-10-27-browser-handoff-obs-741fc8`.
No separate spec is linked; AR-003's read-only `query_elements` acceptance is the implementation
contract. Other browser read methods are outside this correlation follow-up.

1. `BrowserExtensionCommandStore.sendCommand` reports its generated UUID once through a
   main-process-only `onQueued` callback, before timers or polling. Existing-tab dispatch passes
   it to a query-local variable, so overlapping reads cannot share identity. The result recorder
   writes optional `commandId` for successful, failed and undelivered element queries. No ID is
   assigned to a denied read or a channel refusal before queueing. This is separate from approval
   `requestId`; no new agent approval or wire command field was introduced.
2. Migration `081_browser_audit_command_id` adds nullable `browser_audit_entries.command_id`
   and its lookup index. Existing rows remain NULL and approval IDs survive. Both contract
   representations, persistence mapping and the agent-safe audit read path retain the field.
3. Content-free info logs record queueing, dispatch attempts, confirmed handoff, every recognized
   receipt/result (including duplicates/late replies), and safe requeue/refusal. The reinsertion
   log measures the queue position after `unshift` and records its next command ID, depth,
   original deadline and remaining wait before replacement pollers run. Dispatch attempts are
   explicitly not execution counts. Page payloads, selectors, URLs, results and errors are absent;
   unknown peer reply IDs must match the coordinator's generated UUID form before logging.
   The RPC ingress records receipt/result arrivals before auth, schema and rate-limit guards;
   incompatible-runtime receipt rejection is also explicit. Thus a guard cannot silently hide
   a duplicate receipt from the live execution count.
4. Safe redelivery still uses the same command object and original absolute delivery deadline.
   Receipt-observed commands cannot be replayed; duplicate receipts do not restart execution
   timers. A delayed receipt for a requeued command removes its queued copy and restores in-flight
   bookkeeping, so a replacement poll cannot execute an acknowledged original again. The
   existing defensive receipt-before-first-dispatch behavior is preserved and regression-tested.
   Delivery request interfaces moved into the existing delivery helper to keep the store
   below the repository's file-size limit; store type exports and runtime wire shapes are unchanged.

### Worker evidence and remaining gates

- Baseline focused tests passed before editing. The new correlation suite then failed on the
  missing IDs/log evidence before implementation. The initial focused run passed, with final
  expanded verification recorded below after fresh-review fixes. Coverage includes
  including the real service → command queue → SQLite result recorder → agent-safe audit readback,
  concurrent out-of-order replies, FIFO redelivery, original budget, receipt replay refusal,
  repeated/late receipts, privacy, approval separation and migration upgrade/rollback, and
  replies discarded by runtime/auth/schema/rate-limit guards.
- Worker command receipts and source-review evidence will be retained in
  `2026-10-27-browser-handoff-observability-evidence/` beside this plan. The full suite is reserved
  for the queue verifier by the current worker instructions, not deferred as a live check.
- Browser Gateway health read at `1793427222317` reported `windows-pc` fresh/ready, registration
  OK, commands deliverable, no queued/in-flight work and two waiting pollers. This is installed
  coordinator health only, not evidence that this checkout ran in production. No reset, routing
  change, local Mac browser or installed-coordinator replacement was performed.
- The plan and AR-003 reference LT-712, but neither the root nor queue checkout's tracked
  remediation register contains an LT-712 entry. Acceptance was recovered from AR-003 and this
  plan; no completed historical document was changed to compensate for that source mismatch.
- Keep the canonical full-suite / independent queue verdict item open until the coordinator's
  verifier passes. Keep every live assertion open in the linked live-test document.

### Final worker handoff

- Final focused gate: **11 files / 211 tests passed**, exit 0, full log
  `_scratch/test-run.pid-26205.log` in the assigned checkout. No existing test was changed.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run lint:fast`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run check:contracts`,
  `npm run build:main` and `npm run build:renderer`: **all exit 0**. The normal fast-lint
  warnings are in unchanged files; no changed-file warnings remain. Build generation produced
  no additional tracked-file changes. No IPC channel or alias was added, so no manual generated
  contract/preload update was required.
- Final independent source review: **VERDICT: PASS**, no unresolved actionable findings.
  The reviewed full diff, including untracked source/tests, hashes to
  `2273be9973c0392297e29c22402f7e8f7a8cc5114ae19040d01556fad0847451`.
  The prior rejection finding was reproduced and fixed at RPC ingress and the bridge; the
  delayed-original-receipt replay case was separately reproduced and fixed. A first guard
  exposed the existing early-receipt test; the implementation was narrowed and that untouched
  test passes. Command receipts retain failures as well as final passes.
- Evidence report, final source review, command/test receipts, source/build hash seal and cleanup
  receipt: [worker evidence](2026-10-27-browser-handoff-observability-evidence/report.md).
  Built runtime output is disposable after sealing; dependencies stay in the queue checkout.
- Full-suite execution and the queue's formal independent verifier remain pending by the worker
  contract. The separate rebuilt-coordinator campaign remains deferred in the linked live check.
  No commit, staging, branch/worktree lifecycle action or completion rename was performed.


### Verifier round 1 remediation — 2026-10-31

The round 1 queue verifier rejected the earlier handoff. The earlier worker evidence above is
historical; the following recheck supersedes its full-suite handoff assumptions.

1. Reproduced all three failing assertions before repair: the context-worker closure-size
   assertion and the two dependency-compatibility assertions. Receipt: exit 1, three failures
   out of nine tests; full log `_scratch/test-run.pid-95260.log` in the assigned checkout.
2. Audited the worker graph against merge-base `551bbc2a8` using the test's exact parser,
   without copying a checkout. The closure grew from 155 to 156 modules, with exactly
   `src/main/persistence/rlm/rlm-migrations-081-085.ts` added, no removals and zero Electron
   value-importers in either graph. That SQL-only batch has only the erased `Migration`
   type import; `rlm-schema.ts` adds the sole new edge. Updated the documented exclusive
   ceiling from 156 to 157, preserving the existing one-module margin and both Electron/
   compaction isolation assertions. No production module or migration was moved or changed.
3. Confirmed this checkout's dependency links resolved to the root checkout's stale glob
   13.0.6, although the byte-identical manifests lock glob 14.0.3 and its nested minimatch
   11.0.3. Ran a private lockfile-exact `npm ci --ignore-scripts --no-audit --no-fund` in this
   checkout, with its download cache under `_scratch/revision-1/`. The install marker,
   glob and nested minimatch are now local real entries. Neither manifest nor the shared
   root install was changed. Scripts were skipped to avoid unrelated global hook writes.
4. First expanded focused run reached 16 passing tests but exited 1 because parallel imports
   raced Electron 42's lazy binary extraction. Electron was then confirmed materialized
   serially within this checkout's dependency install, per the native-module runbook;
   the retry passed: five files / 24 tests, exit 0. This includes the unchanged dependency
   checks, import isolation, migration upgrade/rollback and both browser handoff suites.
   Full logs: `_scratch/test-run.revision-1-focused.log` (failed setup) and
   `_scratch/test-run.revision-1-focused-retry.log` (passing retry).
5. Both typechecks, lint, file-size/UI-hint checks and both production builds passed, exit 0.
   The unsharded full suite is running; its final result and fresh review are pending.
   Receipts are under `_scratch/revision-1/`. The formal queue verifier remains the authority
   for the next queue verdict; no live assertion is claimed by this repair.

No commit, staging, branch change or completion rename is authorized or performed.
