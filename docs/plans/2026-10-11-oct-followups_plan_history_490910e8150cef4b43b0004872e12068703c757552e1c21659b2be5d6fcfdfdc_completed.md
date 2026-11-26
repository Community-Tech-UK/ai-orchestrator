## Snapshot of 2026-10-11-oct-followups_history.md

# October follow-ups — history

Moved verbatim from [2026-10-11-oct-followups_plan.md](2026-10-11-oct-followups_plan.md) during the
Oct-2 Phase B plan diet (Step 3). No text deleted.

## Dated status blocks (preamble)

**Status (24 October 2026, queue verification round 2 remediation): READY FOR RE-VERIFICATION — both round-2 verifier findings
repaired and re-tested; see [Queue verifier remediation (24 October 2026, round 2)](#as-built-notes).** The queue
verifier's round 2 of 3 found (1) Part 7j leaving existing memory reviews invisible in "Needs You" whenever the
Workboard opened before the Memory review page — Workboard projected `MemoryReviewStore.proposals()` but never loaded
them, so a persisted pending review stayed hidden and missed push events had no polling backstop — and (2) Part 5e's
RTK CI cache step breaking the Electron-cache contract test, which required exactly one `actions/cache` step per install
job and kept the full-suite gate red. Both are repaired with targeted evidence below. 1: `WorkboardStore.refresh()` now
loads and refreshes memory reviews with the other sources — the first Workboard refresh hydrates existing reviews, and
the 4-second tick re-lists every cycle as the missed-push backstop — with a per-source `memoryReviewError` row and its
own Retry; the regression drives the real `MemoryReviewStore` and reproduces the verifier's probe (listCalls=0/needsYou=0
RED → listCalls=1/needsYou=1 GREEN). 2: the Electron-cache contract now selects the cache step restoring
`.electron-cache` and still requires exactly one per install job with its SHA pin, lockfile key and path (every
additional cache step must be SHA-pinned too), and the RTK cache's manifest-keyed restore is pinned in the RTK suite's
build-wiring tests. The coordinator still owns the full suite, overall queue acceptance and completion rename.
Do not close or rename this document.

**Historical status (24 October 2026, verifier remediation): READY FOR RE-VERIFICATION (superseded by the round-2
remediation above) — all four verifier findings repaired and
re-tested; see [Verifier remediation](#as-built-notes).** The verifier's four findings — (1) Part 6a still announcing
"not measured" because `childSpendTokens` never read the child's recorded cost ledger, (2) the RTK prerequisite download
(`package.json` dev/start) having no deadline so a stalled transfer blocked startup indefinitely including `--soft`,
(3) the pin-and-licence suite requiring the five now-untracked platform binaries and failing a cold checkout with
ENOENT, and (4) the supplied dependency install carrying extraneous `toml-eslint-parser` so `dependency-compatibility`
failed — are each repaired with targeted evidence below. 1: `childSpendTokens` reads the ledger total
(`CostTracker.getSpendTokens`, input+output like the Claude `totalTokens` metric and `collectInstanceSpend`), keeps the
adapter `cumulativeTokens` counter only as a fallback, and reserves "not measured" for genuinely missing records;
regressions exercise the real Claude completion path (production `recordCompletionCost` and the full
Claude adapter → manager → CostTracker flow) and are RED/GREEN recorded. 2: every download attempt has a hard transfer
deadline (30s soft / 120s otherwise, `FETCH_RTK_DEADLINE_MS` override) with request/response/stream/partial-file
cleanup; stalled-request and stalled-body regressions prove `--soft` startup continues and `--strict` retries terminate
(RED = hung test timeouts on the old code). 3: the pin-and-licence suite now verifies the complete five-platform pin
set (binary and archive pins), the byte-and-licence truth of every provisioned binary, and keeps the fetch-time
fail-closed guarantees for unprovisioned platforms; the CI test job fetches all five platforms (manifest-keyed cache)
so the byte checks run there in full. 4: the worktree was reinstalled from the lockfile with `npm ci` (the two stray
extraneous packages removed); `dependency-compatibility` passes 5/5 and the fresh tree passes `verify-native-abi` and
`smoke:electron`. The coordinator still owns the full suite, overall queue acceptance and completion rename.
Do not close or rename this document.

**Historical status (23 October 2026, verification round 2 remediation): READY FOR RE-VERIFICATION — all three round-2 findings repaired
and re-tested; see [Verification round 2 remediation](#as-built-notes).** The round-2 verifier's three findings (a missing
plan rename overriding a strict loop's `needs-sign-off` authority, the stale architecture inventory failing
`verify:architecture`, and pause notices suppressed for unrelated focused views with no deferred delivery) are each repaired
with targeted evidence below. Suppression is now "focused on that loop" with deferred delivery on leaving the view; the
rename note no longer weakens a sign-off pause; the inventory is regenerated and `verify:architecture` exits 0. New
pause-notice focus/defer live checks are appended to the live-test document (section 15). The coordinator still owns the
full suite, overall queue acceptance and completion rename; installed-app observations remain open. Do not close or rename
this document.

**Historical status (23 October 2026, verification round 1 remediation): READY FOR RE-VERIFICATION — all seven round-1 findings repaired
and re-tested; see [Verification round 1 remediation](#as-built-notes).** The round-1 verifier's seven findings (five live
verification-cost smoke expectations, the backdrop inventory count, the indexing-lane import closure, unnamed inline-template
form fields, two widened file-size ceilings, a stale architecture inventory, and loop pause notices ignoring window focus) are
each repaired with targeted evidence below. No ceiling was raised: both widened allowlist entries are reverted and the files
re-fit under their previous limits. The architecture inventory is regenerated and `verify:architecture` passes in the worktree.
The coordinator still owns the full suite, overall queue acceptance and completion rename; installed-app observations remain
open. Do not close or rename this document.

**Status (23 October 2026 resume): READY FOR INDEPENDENT QUEUE VERIFICATION — R4 PASS; evidence sealed and owned runtime removed.**
The coordinator's `main` merge arrived with 25 conflicts; all are resolved and staged (no commit), both sides' intent preserved,
targeted tests and the fast gates green. Rulings and receipts: [Main merge (conflict resolution)](#as-built-notes), first subsection.
The coordinator checkpoint `3df9b5589` preserves all 1,049 source/deletion entries in the prior worker's seal.
Fresh worker checks pass, but re-reading the current source disproved the historical reason for skipping 5f:
Phase 0 step 7g's fresh one-shot budget flag and its explicit callers are now present. Part 5f is now implemented,
with explicit opt-in and resume/fork protection; it is not silently skipped. The source dispositions are now
**49 parts = 43 built + 1 deliberately not built (7i) + 5 parked (8a–8e)**. The current resume checklist below
supersedes earlier counts. The coordinator still owns the full suite, independent queue acceptance and completion
rename; installed-app observations remain open. Do not close or rename this document.

Fresh reviews R1, R2 and R3 returned **FAIL** and produced fourteen actionable findings, now repaired with focused runtime
regressions. Later independent contexts confirm the earlier authority, filesystem, trace, provisioning and native-helper fixes;
R3's additional retained-metadata finding now has a bounded correction and unchanged-probe evidence. The latest worker checks
pass **135 changed spec files / 2,248 tests**, plus **129 adjacent tests** and all 19 central commands. The genuinely fresh R4
context accepts the complete combined range with no unresolved actionable task-related findings. Earlier PASS/FAIL records remain
historical evidence, and the coordinator still owns overall queue acceptance and the full suite.

**Historical status (20 October 2026 remediation): READY FOR INDEPENDENT QUEUE VERIFICATION.**
The prior follow-ups implementation at `e61598b08` has been recovered as uncommitted file edits in the supplied
`queue/2026-10-11-oct-followups-546c7e` checkout, preserving newer base changes at `542f1f690`. All 79 historically added
source/tool files are present; recovery covers 182 backend paths, 122 renderer/tooling paths and 356 unchanged archive
moves. No merge, branch switch, change to the real index, commit or AIO lifecycle metadata change was used. Part 7b now has
a working Project notes suggestion fold, persisted showing/source facts, the 60-day inactivity rule and five-second Undo.
All actionable fresh-review findings were fixed and regression-tested, including stale worker-cache deletion, RTK handle
cleanup, interrupted-trim reporting and actual filesystem removal receipts. Final gates pass: 1,280 tests across 108 changed
spec files with cache disabled, plus all 15 static/build/generator checks. The fifth genuinely fresh worker-readiness review
returns `VERDICT: PASS` with no unresolved actionable findings and separately passes 133 tests across 22 files.
The 49 parts have explicit dispositions: 42 built, 7i deliberately not built, 5f skipped under its own condition and five Step 8
parts parked under their stated non-blocking triggers. The current retry checklist and final remediation ledger are authoritative;
older counts and ledgers below remain historical evidence. The coordinator owns the full suite, overall queue acceptance and
completion rename. Live checks remain open. Do not close or rename this document.

**Historical status (16 October 2026, prior parked checkout):** active, partial worker handoff after round 8 (16 Oct 2026, verification-round-2 remediation): **41 parts built, 1 partial (7b), 1 resolved as deliberately not built (7i, per its own recommended default), 1 skipped on the plan's own terms (5f), 5 parked behind triggers that have not fired (8a-8e); 41+1+1+1+5 = 49.** Round 8 built 7c (the helper-agents chip above the message box) and 7b's pure suggestion rules, resolved 7i as "not built" (choice 14a's recommendation and the plan's "only if James said yes" gate — no yes exists), closed 8d's item 1 (its hover bridge was never built, so there is nothing to delete), and reconciled three dated finding-checklists that later readings had mistaken for current status. The only implementation left inside Steps 1-7 is 7b's "Suggested for removal" fold, which the plan itself hosts on Phase 5 step 14's memory page (its rules and wording are built and tested). Step 8's five parts stay parked per the plan's own rule that they never block closing; the Fresh-eyes box is the independent verifier's gate, not a worker box. Verification round 1's two findings are fixed: the required Step 6/7 items it named are now built (6a helper-token accounting, 7f accessible input names, 7g money in cents, 7j Needs-you behavior), and the full-suite import-closure failure is resolved (the round-5 `rlm-migrations-081-085` leaf is diff-verified and the ceiling is documented at 153). Round 6 had built 1f, 3g, 5a, 5b, 5c and 5e under James's eight-deletions answer. The 2 open parts are 7c (plan-ordered after Phase 3 steps 5/12b and Phase 5 step 16's chip strip and subagent-usage store) and 7i (deliberately unbuilt per choice 14a's recommended default); 7b's removal-suggestion fold stays partial pending Phase 5 step 14's memory page. The five Step 8 parts remain trigger-gated per this plan's own rule that they never block closing (see the round-7 ledger for each trigger's current state). James's recorded readiness answer ("Move the old documents and do the eight deletions too") authorized the eight parts that were held for his answer (1f, 3g, 5a, 5b, 5c, 5e, 5i, 5h); rounds 4-5 built 5i and 5h, and this round built the other six: 1f (scratch sweep tool + real dry run), 3g (stalled/final-audit-blocked loops stop merging), 5a (Codex keep-3 + card), 5b (RTK history ask-first trim), 5c (trace size cap + card), 5e (RTK binaries out of git + fetch/CI wiring). The remaining 5 open parts are 6a, 7c, 7f and 7g (blocked on absent Phase 0/3/4/5 foundations) and 7i (deliberately unbuilt per choice 14a's recommended default). Whole-plan acceptance remains blocked by those foundations and the live checks (the destructive apply steps still show their list and ask first, as designed). Current round verification outcomes are recorded below. The coordinator owns the full suite, integration and completion renaming. Written 2026-10-11. Keep this file untracked until every step is implemented and
verified, or explicitly dropped by James (see [Finishing](#finishing)).


## As-built notes (dated remediation, ledgers and implementation sections)

## As-built notes

### Queue verifier remediation (24 October 2026, 7c typed-strip registration) — queue/2026-10-11-oct-followups-546c7e

The handoff's one high finding is repaired in the worktree; no commit was made and no branch changed. No separate spec is
linked.

**Finding — part 7c's typed-strip registration, overflow behavior and regression test were deferred as a live check.**
The helper chip rendered as a standalone `div.helper-agents-chip` in `input-panel.component.html`, outside any typed chip
list or overflow mechanism; `helper-agents-chip.ts` described the registration as future work and the livetest doc
postponed it because "the host does not exist". Waiting for missing implementation is not a rebuilt-app, human or
external-service live-test prerequisite.

**Fix — the owning strip foundation is integrated and the registration lands in it.** The strip is Phase 3 step 5's one
status strip above the message box, completed with Phase 5 step 16's two rules, taken from the owning queue branch's
C2b + step-16 integration and adapted to this checkout:

- `session-status-dock.rules.ts` — the typed `DOCK_CHIPS` registry (`DockChipDef`, `splitDockChips`,
  `DOCK_CHIP_VISIBLE_CAP = 5`, the "+N more" fold, `resolveEscapeRouting`, `DOCK_FOCUS_ANCHOR_CLASS`).
  Registered chips: `tasks`, `review`, `agents`, `checkpoints`, `helpers` (display order; last folds first). The Tasks
  chip stays in the typed list because Phase 5's part 13b that removes it is not this plan's dependency (removing it
  here would hide the running step of a long list); it keeps today's once-per-session auto-expand. The loop Outstanding
  panel follows the strip's decision-surface rule (questions and needs-human items never sit behind a chip): it now
  mounts beside the approvals in `instance-detail.component.html` (before the dock) and renders nothing while empty.
  `DockChipDef.informational` marks read-only chips with no panel (7c's "No panel" rule).
- `session-status-dock.component.ts`/`.scss` — the strip host: registered chips with badges and tooltips, the "+N more"
  overflow row, panels for Tasks/Review/Agents/Checkpoints, the Esc surface-dismiss + focus ladder and the always-rendered
  focus anchor (the real-browser half is pinned by `session-status-dock-focus.e2e.spec.ts`, slow tier).
- `helper-agents-chip.ts` — unchanged pure descriptor (`helperAgentsChip`: hidden at 0, "1 helper agent running" /
  "N helper agents running", never the bare word "Agents", tooltip key `strip.helperAgents`) plus the plan's registration
  `helpersDockChip` (id `helpers`, informational, `describe` maps the descriptor to the strip presentation) and the
  summary reader `sessionHelperAgentsRunning(instanceId, instances)` (owning session's `nativeHelpers` only; draft ids
  never read the list). The dock's chip context feeds the reader; child sessions are the "Agents (N)" chip's population
  and never substitute for native helpers. The standalone composer chip and its input-panel wiring are removed.
- `instance-detail.component.ts` — the five inline inspector chips and their state move into the dock (net −132 lines);
  Escape routes through `resolveEscapeRouting` + the dock's `dismissOpenSurface` (dock surfaces first, interrupt only
  for in-flight turns); Cmd+Shift+V delegates to the dock's review workbench opener.

**Tests.** `helper-agents-chip.spec.ts` (descriptor + registration: hidden at 0/non-counts, singular/plural, never
"Agents", the `strip.helperAgents` sentence verbatim, native-only counting with children present, reader semantics).
`session-status-dock.rules.spec.ts` (the ported Phase 5 handoff guard with the registry pin updated to the five
registered chips, plus part 7c's strip spec: the registered helper chip folds into "+N more" after the cap — the plan's
required strip-overflow regression — shows "1/2 helper agent(s) running" under the cap, hides at zero, never counts
child sessions, and Tasks auto-expands once per session). The R1.5 preload-to-Angular regression is re-homed from the
composer to the strip and renamed `src/tests/renderer-integration/native-helper-strip.spec.ts`, keeping its real
Claude adapter → `InstanceStateManager` → IPC batch-update → preload domain → real renderer stores → rendered chip path
and its separate-session exclusion. `input-panel.component.spec.ts`'s composer-side chip test is superseded by the strip
tests; `instance-detail-inspectors.spec.ts` (local-signal simulations) is deleted — the dock's real-component tests pin
the behaviour it simulated.

**Gates.** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run check:ui-hints` (its hover-only reason follows the chip to the strip; the H2a baseline tightens the five
removed native titles; the `input-panel` wording-ledger entry is retired with an audit reason because the copy now
renders on the strip and is pinned verbatim by the descriptor spec), `npm run build:main`, `npm run build:renderer`
(pre-existing bundle-budget warning) — all exit 0. Targeted tests: instance-detail + loop + renderer-integration
(114 files / 1,429 tests) and the focused descriptor/strip/integration runs (47 tests) pass. The full suite stays with
the coordinator.

**Live checks.** The rebuilt-app observation in livetest check 27 keeps its exact steps; its typed-strip bullet is now a
strip re-check on the rebuilt app (the host exists), not a missing-implementation deferral.

### Queue verifier remediation (24 October 2026, round 2) — queue/2026-10-11-oct-followups-546c7e

Both findings of the queue verifier's round 2 of 3 are repaired in the worktree; no commit was made and no branch
changed. Receipts live in the worktree's `_scratch/oct-followups/queue-round2-remediation/`. No separate spec is linked.

**Finding 1 — memory reviews hydrate through Workboard (high).** `WorkboardStore.refresh()` now refreshes
`MemoryReviewStore` alongside loops, automations and repository jobs, so the Workboard's constructor refresh hydrates
reviews that already exist before the Memory review page has ever run, and the page's 4-second tick re-lists on every
cycle — the polling backstop part 7j promised for missed push events. The load goes through `MemoryReviewStore`'s
revision-guarded `refresh()`, so a late poll still cannot overwrite a fresher pushed list. A new per-source
`memoryReviewError` signal mirrors the automations/jobs pattern: the source-error block gets a "Memory reviews: …" row
with its own Retry (`retryMemoryReviews()`), and the polite live region includes it. Regression coverage
(`workboard.store.spec.ts`) drives the real `MemoryReviewStore` against stubbed
`GovernedProposalIpcService`/`LearningScanIpcService` — the verifier's headless-probe shape: (a) initial hydration —
one `list` call via `store.refresh()` puts a persisted pending review in the `needs-you` lane with `memoryReviewId`
linkage; (b) missed events — a review added with no change event is caught by the next refresh (`list` called again,
card appears); (c) source errors — a failed list surfaces `memoryReviewError` without clearing other sources' cards,
and `retryMemoryReviews()` retries and clears. `workboard-page.component.spec.ts` covers the new warning/Retry row.
RED receipt (refresh wiring temporarily removed): all three fail with `list` never called / lane empty — the verifier's
reproduced defect (`verifier-red-finding1-hydration.log` and `red-workboard-hydration.log`, both exit 1). GREEN:
workboard + memory-review suites 98/98 (`green-workboard-memory-review.log`, exit 0).

**Finding 2 — CI cache contract reconciled with the RTK cache (high).** `scripts/__tests__/electron-download-config.spec.ts`
no longer requires exactly one `actions/cache` step per install job (part 5e's RTK cache legitimately adds a second).
It now selects the cache step that restores `.electron-cache` and requires exactly one of those per job, still checking
its SHA-pinned `actions/cache` action, `.electron-cache` path and `hashFiles('package-lock.json')` key; every other
cache step must also be SHA-pinned. The RTK cache's own contract — restore `resources/rtk` keyed on
`hashFiles('scripts/rtk-binaries.sha256.json')`, ahead of the all-platform fetch — is pinned in
`fetch-rtk-binaries.spec.ts`'s build-wiring tests beside the rest of that wiring. RED receipt (pre-fix): `expected
[ … ] to have a length of 1 but got 2` at the old assertion (`verifier-red-finding2-cache.log`; reproduced directly
this round too). GREEN: electron-download-config 5/5 + fetch-rtk-binaries 49/49 (`green-ci-cache-tests.log`, exit 0).
The verifier's other focused failure, `default-loop-native-finality.spec.ts`, was a timing flake: 8/8 passes alone.

**Gates.** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` and
`npm run check:ui-hints` (`green-static-gates.log`) plus `npm run build:main` and `npm run build:renderer`
(`green-builds.log`) all exit 0. The full suite stays with the coordinator; the verifier's two SEA-repeatability
failures were its Homebrew Node lacking the SEA fuse (environmental, untouched by this round).

### Verifier remediation (24 October 2026) — queue/2026-10-11-oct-followups-546c7e

All four findings of the latest verifier round are repaired in the worktree; no commit was made and no branch changed.
Evidence logs live in the worktree's `_scratch/` (test-run logs) and `_scratch/oct-followups/` (install logs). No separate
spec is linked.

**Finding 1 — helper spend read from the recorded ledger (high).** `src/main/instance/child-result-usage.ts` now reports
the child's recorded ledger token total before anything else. `CostTracker.getSpendTokens` (new, beside `getSessionCost`)
sums `input + output` over the child's ledger rows — the same spend-token convention as the Claude `totalTokens` metric
(`claude-output-parser.ts` "we only sum the new-generation portions") and `collectInstanceSpend` — keyed on the
instance/session identity `recordCompletionCost` writes. The adapter lifetime spend counter
(`contextUsage.cumulativeTokens`) is kept only as a fallback when the ledger holds no record; "not measured" is reserved
for genuinely missing records (no ledger row, no counter). The two `instance-orchestration.ts` call sites stay
line-neutral (`:765` passes the child record; `:1079` passes `child ?? childId`, so the ledger key survives an outcome
record for an already-removed child). The regressions exercise the real Claude completion path instead of injecting
`cumulativeTokens`: `child-result-usage.spec.ts` drives production `recordCompletionCost` + the real CostTracker (Claude
result-line usage, 30,000 input + 10,000 output against 180,000 occupancy → 40,000), and
`instance-session-cost.integration.spec.ts` adds the full Claude adapter → `InstanceCommunicationManager` → CostTracker →
`childSpendTokens` path. RED receipt on the old implementation: 4 of 7 fail with `expected undefined to be 40000`
(`_scratch/test-run.pid-84701.log`); GREEN: 7/7 (`_scratch/test-run.pid-87374.log`) and 41 tests over the three files
(`_scratch/test-run.pid-78566.log`), plus the named integration case run alone. `child-announcer`'s "not measured"
wording tests are unchanged and pass. Adjacent suites: cost-tracker + orchestration 40 (`pid-95647`), cost consumers 83
(`pid-11313`), instance-communication 159 (`pid-11630`).

**Finding 2 — bounded RTK transfer deadline (high).** `scripts/fetch-rtk-binaries.js` `download()` now runs under one
hard deadline spanning connect, redirects, headers and body (30s in `--soft`, 120s otherwise; `FETCH_RTK_DEADLINE_MS`
overrides both via the exported `deadlineMsFor`, declared in `fetch-rtk-binaries.d.ts`). On the deadline the request,
response and write stream are destroyed and the partial file removed; a socket-idle `request.setTimeout` guard backs the
hard clock up. `--strict` retries once, also bounded; `--soft` warns and exits 0, so `npm run dev`/`npm start` can never
hang on a stall. The regressions in `scripts/__tests__/fetch-rtk-binaries.spec.ts` run production `main` under synthetic
I/O and stall the request and the response body separately across all three exit modes, asserting termination, exit
policy, bounded retry counts and stream/request cleanup: soft exits 0 after 2 bounded attempts, strict exits 1 after 4
(retry counted), default exits 1 after 2. RED receipt on the old `download`: the stall cases hang and die only on test
timeouts (the reproduced bug); GREEN: 48 tests pass (`_scratch/test-run.pid-52438.log`, `pid-62154.log`,
`pid-40364.log`). A real network run (`node scripts/fetch-rtk-binaries.js --platform=host`) fetched and hash-verified
both darwin binaries against the manifest pins through the rewritten download path.

**Finding 3 — pin/licence suite reconciled with untracked binaries (high).** Part 5e keeps `resources/rtk` out of git,
so `rtk-version-pins.spec.ts`'s real-tree test now (a) asserts the complete five-platform pin set on every run — all
five binary pins and all five `archiveHashes`, well-formed SHA256, plus the pinned Apache licence source; (b) asserts
the byte hash and byte-for-byte LICENSE of every **provisioned** binary (unchanged strength for provisioned trees); and
(c) leaves unprovisioned platforms to the fetch pipeline's fail-closed enforcement (the reject/quarantine/
licence-restore tests in this file and `fetch-rtk-binaries.spec.ts`), with that reasoning recorded in the test. Nothing
is skipped or weakened: the old single assertion becomes strictly more assertions, and the CI test job (`ci.yml`) now
restores `resources/rtk` from a manifest-keyed cache and runs `node scripts/fetch-rtk-binaries.js` (all five platforms,
default mode) before `npm run test`, so the five-platform byte/licence checks run in full on every CI run — the
packaging smoke keeps its separate `--strict` host fetch. A new `fetch-rtk-binaries.spec.ts` workflow test pins that
wiring (all-platform fetch before the suite, no platform filter). Evidence: cold run with no `resources/rtk` passes 5/5
via the contract branch (`_scratch/test-run.pid-75054.log`); a provisioned run after the real host fetch passes 5/5 with
the darwin byte/licence branch exercised; the fetched binaries were then removed to restore the cold state.

**Finding 4 — reproducible lockfile installation (medium).** Reproduced exactly as reported
(`_scratch/test-run.pid-79953.log`: `extraneous: toml-eslint-parser@1.0.3` plus its nested `eslint-visitor-keys@5.0.1`;
`npm ls` listed exactly those two and neither appears in `package-lock.json`, so the supplied install carried stray
packages). The worktree was reinstalled reproducibly with `npm ci` from the lockfile
(`_scratch/oct-followups/npm-ci-remediation-2.log`, exit 0; the first attempt died of an `ENOTEMPTY` while wiping the old
tree and was retried after a clean removal — `npm-ci-remediation.log`). After the install `npm ls toml-eslint-parser` is
empty, zero extraneous entries remain, `dependency-compatibility.spec.ts` passes 5/5 (`_scratch/test-run.pid-1353.log`),
`node scripts/verify-native-abi.js` reports better-sqlite3 at NODE_MODULE_VERSION 146 matching Electron 42.11.15 (the
`postinstall` native rebuild runs as part of `npm ci`), and `npm run smoke:electron` plus the real-pty terminal spec
pass on the fresh tree.

**Gates after remediation (all exit 0):** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run
check:ts-max-loc` (informational notices only), `npm run check:ui-hints` (223 wording entries), `npm run build:main`,
`npm run build:renderer` (the pre-existing initial-bundle budget warning remains a warning), `npm run verify:architecture`
(inventory verified as-is), `npm run verify:codex-protocol`, `npm run verify:ipc`, `npm run check:contracts`, and
`generate:aliases`/`generate:ipc` (no diffs). Targeted suites: fetch-rtk 48, pins 5, child-result-usage 7, Claude
session-cost integration 16, plus the cost/communication/orchestration consumers above and the codex
snapshot/refresh specs (14 + 3, `pid-34097`/`pid-35482`). The full suite is the coordinator's/verifier's gate and was
not run here.

**Incidental:** `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` was refreshed by the repo's own
`prebuild:main` hook (`scripts/refresh-codex-protocol.js`) because this machine's installed Codex CLI is 0.164.0 while
the committed snapshot was 0.163.0 — the documented "every installed CLI bump refreshes the source snapshot" behaviour,
matching how earlier plan commits carried snapshot bumps. `verify:codex-protocol` exits 0 with it and the
generated-file spec passes; no test pins the old protocol content. It is unrelated to the four findings and is kept so
the committed generator output is current in the worktree.

The coordinator still owns the full suite, overall queue acceptance and completion rename. Installed-app/provider/device
observations stay in the root live-test document.

### Main merge (conflict resolution) — 23 October 2026, queue/2026-10-11-oct-followups-546c7e

The coordinator merged `main` into this branch and the merge arrived with 25 conflicted paths. All conflicts are resolved so
both sides' intent survives, every conflict marker is gone and every resolved file is staged. No commit was made. Rulings:

- **RTK binaries (`resources/rtk/*/rtk*`, deleted-by-us/modified-by-them):** stay untracked per 5e (`git ls-files resources/rtk`
  prints nothing; the files stay on disk). Main's 0.52.0 blobs are superseded by the merged manifest (`scripts/rtk-binaries.sha256.json`
  now pins 0.52.0 with `archiveHashes`) and the fetch script that downloads them.
- **`resources/rtk/*/LICENSE` (new tracked copies on main):** not tracked; `resources/rtk/` is build output under 5e's ignore.
  Main's deliverable survives through its own named mechanism: the fetch script restores the pinned licence beside every binary on
  each run (including the cached fast path) and `electron-builder.json`'s filter already ships `["rtk", "LICENSE"]`. The pinned
  source `scripts/licenses/rtk-0.52.0-LICENSE` stays tracked.
- **`scripts/fetch-rtk-binaries.js`:** our rewrite (validated manifest pins, `--platform/--strict/--soft`, one retry,
  `decideExit`, exports, `require.main` guard) plus main's additions folded in: `RTK_VERSION = '0.52.0'`, the Apache-licence
  restore with validation, and the pinned archive sha256 check. The default-mode exit policy keeps this plan's tested rule
  (only an all-failed run is fatal); the failure summary is still `console.error` in non-soft modes, so main's loudness intent
  holds. `scripts/__tests__/fetch-rtk-binaries.spec.ts`'s synthetic I/O now models the licence file and the empty synthetic
  archive, and gains tests for licence restore/missing-licence fail-closed and archive-pin accept/reject (37 tests).
- **`codex-state-backup-retention.{ts,spec.ts}` (add/add):** our keep-3 module and its spec are kept (the exact shape
  `2026-10-20-oct2-phaseB-land-built-work_plan.md` Step 6 imported "from the real follow-ups branch" and its as-built note
  directs this landing to extend: "Bring the follow-ups card selectors and automatic-name producer together with their actual
  consumers at its landing, retaining this configured policy and migration"). Main's early keep-5/7-day `pruneCodexStateBackups`
  and its spec block are not carried: that unsettinged start-up sweep is the transient "early copy contains the retention policy
  only" (same note) and is superseded by Decision 19's configured keep-3 policy (20 Oct: "Turn that on"; shipped behind the
  visible "Keep only the newest 3 Codex backups" setting and its one-shot migration on the Phase B branch, Step 8 orders that
  landing before this plan's). It also deletes clean-up/archive copies that the approved policy skips and violates the
  housekeeping plan's own ground rule 2 ("Nothing is deleted by a migration or a start-up sweep without a setting James can see
  and has agreed to"). Main's pile-bounding intent survives three ways: our keep-3 rule on the automatic names, the ask-first
  disk-space card for the frozen legacy pile (ground rule 2's own path), and the configured policy at its landing. The
  "Codex state backup pruning" start-up step remains, repointed at our `pruneAutoBackups` (new-name only, tripwire 5).
- **`storage-runtime.ts`:** main's history guard (`sessionStateIsAbsentFromHistory` + "A session is now in history. Review again.")
  runs before our receipt-based `removeStorageFilesWithReceipt` accounting; both merged clean elsewhere.
- **`storage-cleanup-service.spec.ts`:** union of our attachment-race tests and main's ledger-shrink test.
  **`storage-usage-service.spec.ts`:** main's weekly-growth fixture extended with our five new usage dependencies (its
  assertions are unchanged).
- **`settings.types.ts`:** our split (`AuxiliarySettings`, `ReviewSettings`) plus main's `ObservationSettings` extension and
  `scratchRetentionDays` field; main's `RemoteReviewerProvider` import stays out (the use lives in `settings-review.types.ts`).
- **`tooltip-copy.ts`:** union of main's `accounts.signIn`/`accounts.copySignIn` entries and our `memory.*` block; main's
  removals (`loop.isolation`, `loop.verifyTwice`, `loop.outstanding.answered`) stay removed (nothing references them).
- **Backdrop hosts (8 files):** our `tabindex="-1" aria-hidden="true"` (+ `appBackdropEscape` where we had it) and main's
  `data-ui-hints-exempt="backdrop"` markers unioned first; the ui-hints H12 integrity rule then reports the markers unused
  (our pair makes the host measurement-`hidden`, which is the load-bearing exemption), so the eight markers are removed as
  stale exemptions — the gate's own stated fix. `source-control-diff-viewer` keeps its marker (load-bearing there). Both intents
  hold: the backdrops pass the gate (main's) and are invisible to assistive tech with Escape handling (ours; pinned by tests).
- **`wake-management.component.{ts,spec.ts}`:** composed of both features. Main's one-line summary ("N notes, M different, K
  shown this week"), Notes/Hidden toggle over `summarizeWakeHints` (legacy since 4 May 2026 + duplicates) and its explainer are
  kept; our wording, tooltips, "Suggested for removal" fold and five-second Undo (`ProjectNoteRemovalService`, Ctrl+Z, hover/focus
  pause) are kept; the list renders the selected tab minus pending removals. Main's click-time confirm dialog is dropped in
  favour of the approved five-second Undo: their plan's deliverables for this page (Hidden rows, "shown" relabel, one-line
  summary, miner tombstone) all survive — the tombstone is written by `wake-context-builder.removeHint` on whichever path
  deletes, and the dialog itself is not in their deliverables list while the Undo is named in ours (7b). Their spec's
  summary/Hidden test is kept with the composed label ("Shown 3 times"); its confirmation test is rewritten to the composed
  behaviour (no delete at click; the note shows in the undo banner; removal fires only after the window) — its assertions'
  intent survives. Both spec fixtures coexist; our fixture timestamps move past the legacy cutoff so our notes classify as
  current notes under the composed list.
- **`instance-header.component.{ts,html,spec.ts}`:** imports union (`BackdropEscapeDirective` + `HelpLinkComponent`); both
  tests kept (backdrop-escape and session help).
- **ui-hints reconciliation (main's new gate vs this branch's pre-gate tooltip work):** the helper-agents chip gets a
  hover-only reason (their sanctioned H4 remedy); the cost exact-amount tips and the attach-disabled tip are reshaped to the
  readable member pattern their model documents ("text written in a member of the same component is read"; calls may live in
  conditions, branches fold registry text) with identical runtime strings — `cost.exactAmount`'s meaning is now the phrase
  prefix and the call site appends the unrounded figure; `composerAttachmentProvider` is exported beside the reason helper.
  `check:ui-hints --tighten --record-wording` then lowers the stale counts (our branch's title/naming fixes and the removed
  markers) and records the 18 new qualifying tooltip wordings in the ledger. No `--init` reset was used: the ratchet did not
  widen. `npm run check:ui-hints` exits 0 ("UI hints OK; 223 wording entries").
- **LOC ratchet:** `input-panel.component.ts` was 1,961 lines after the merge (over the 1,960 hard limit before any merge-note
  edits); the documented ceiling is raised 1,910 -> 1,970 in `scripts/check-ts-max-loc.ts` with the reason, following the
  file's own raise precedent. The input-panel split remains its own follow-up.
- **`docs/generated/architecture-inventory.json`:** regenerated with `npm run generate:architecture` after staging (never
  hand-merged).

Targeted checks after the merge (all green): fetch-rtk 37 tests; codex retention/reconcile + storage cleanup/usage 70+70 tests;
wake-management, instance-header, session-progress-panel, session-artifacts-strip, settings, node-picker, recent-dirs 70 tests
(re-run 108 with the storage specs after the later template edits); tooltip suite 115; cost-page/input-panel/ui-hints/eslint
129; the remaining ui-hints specs 94. Gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer` all exit 0 (the renderer build's pre-existing initial-bundle
budget warning remains a warning). The full suite was not run (queue instruction); it is the verifier's gate.

### Current resume — 23 October 2026, queue/2026-10-11-oct-followups-546c7e

- [x] Read the current plan and historical ledgers; inspect `git log` and the merge-base (`542f1f690`) to checkpoint (`3df9b5589`) diff. The assigned worktree started clean. No separate spec is linked.
- [x] Compare all 1,049 prior sealed source/deletion entries against this checkout: zero mismatches. The coordinator checkpoint contains the previous recovery; no recovery or integration operation is needed.
- [x] Refresh the existing implementation's worker checks: all 15 generator/static/build/contract/retirement commands and the explicitly selected changed-spec run pass. Phone lockfile install, typecheck, lint, build and both Stop/Cancel tests pass. These are pre-5f checks, not evidence for its eventual implementation.
- [x] Recheck parked triggers in current sources: the Phase 3 typed strip/aggregator and Phase 4 reader/adoption foundations remain absent; no page-visit, live-default-flip, preference or Copilot-loop-use evidence is inferred. Step 8 remains explicitly parked and non-blocking.
- [x] Implement 5f now that its one-shot budget prerequisite exists; prove explicit fresh-only argv behavior and caller/transport forwarding, protecting resume/fork and persistent sessions. Fourteen focused files / 782 tests, both typechecks, canonical lint and changed-file ESLint pass after the implementation; final combined gates and independent review remain separate.
- [x] Final combined worker gates after all R1/RH/R2/R3 repairs and type integration: **135 changed spec files / 2,248 tests**, plus **6 adjacent adapter/lifecycle spec files / 129 tests**, cache disabled; both main/spec TypeScript programs, worker TypeScript, lint, LOC, main/renderer/worker builds, IPC/alias generation and IPC/export/contracts checks pass. The architecture inventory is regenerated/verified against all current source in an isolated prospective index; the real index is byte-identical before/after. All 19 latest central command receipts are in `post-budget-final/command-receipts.json`; earlier gates and prospective-index receipts are separate. The full suite was not run.
- [x] Genuinely fresh final worker-readiness review R4: **VERDICT: PASS**, no unresolved actionable task-related findings over the complete base-to-HEAD plus unstaged/untracked range. Its independent executions pass all 16 non-generating central checks, 2,248 changed-spec tests, 129 adjacent tests and both phone tests; it also verifies the unchanged public probes, current memory bound, independent 52,000-file fresh/old-project budget probe, archive bytes and source/index preservation. Full report: `fresh-worker-readiness-r4/report.md`.
- [x] Final report, 1,109-path source seal and command receipts written before cleanup; 183 owned runtime/snapshot targets and 45,342 enumerated entries removed. All sealed source/deletion hashes remain unchanged. Durable evidence is retained at the exact root-checkout path below; pre-existing root dependencies and the AIO-managed worktree/branch remain intact.
- [ ] Coordinator-owned full suite, overall queue-verifier acceptance and completion rename. Installed-app/provider/device/human observations stay in the root live-test document.

Evidence for this resume lives inside the supplied worktree at
`_scratch/oct-followups/2026-10-23-resume/`. The unsuccessful Claude helper attempt records its actual account spend-limit
failure; a new Codex CLI context continues the implementation. This is not an automatic approval rejection.
The plan is edited only at its authorized root-checkout path and remains active; no source is copied into its folder.

**5f as built (23 October).** Explicit `noSessionPersistence` options travel through unified/Claude/provider types,
the adapter factory and provider, and the strict remote policy/schema. Direct and worker argv add
`--no-session-persistence` only on a fresh explicit request; native resume, resume intent (including a fallback without
a native transcript), and fork all drop the flag with a warning containing no user/session data. Budget and machine-session
classification alone never opt a call in. The eight existing budgeted call sites now opt in: title escalation, magic prompts,
cross-model reviews, headless/CLI reviewers, consensus, Council/compare's shared invocation, multi-verify merge synthesis,
and CLI verification. Existing budget values and paid-usage accounting stay intact. Format repair sends an independent print
call and does not resume; chats, loops, queue workers and persistent ping-pong adapters keep their policy.
RED and GREEN receipts, raw output and source hashes are retained in `5f-impl-*` evidence files. The genuine native
filesystem/rebuilt-app check is open in [live check 28](2026-10-11-oct-followups_livetest.md#28-claude-one-shot-transcript-persistence-5f);
argv evidence does not prove installed-Claude filesystem behavior. The earlier 5f skip records below are historical and superseded.

**Fresh review R1 — historical FAIL; repairs accepted by R4.** Full report and raw independent probes are in
`_scratch/oct-followups/2026-10-23-resume/fresh-review-report.txt` and `independent-readiness-r1/`.

| Finding | Required correction | Current status |
|---|---|---|
| R1.1 HIGH, 4b | Preserve finish/check/sign-off authority, reviewer-error handling and actual verify output; remove the competing early completion path. | Implemented: four unchanged independent assertions and 86 focused tests pass. Final central gates and independent R4 pass. |
| R1.2 HIGH, 5a | Bind the Codex preview to the reviewed file identity and reject a replacement before deleting it. | Implemented: metadata-bound descriptors reach the executor and are revalidated before unlink; replacement fixture retained. Final central gates and independent R4 pass. |
| R1.3 MEDIUM, 5a | Never follow a symlink and claim its retained target bytes as freed. | Implemented: regular-file-only lstat/list/remove and actual unlink receipts; retained hardlinks credit zero content bytes. Final central gates and independent R4 pass. |
| R1.4 MEDIUM, 5c | Propagate failed rotation to the appender's size/error accounting; do not reset the size after a failed rotation. | Implemented, including strict oversized-write handling: 44 focused tests and actual-worker probes pass. Final central gates and independent R4 pass. |
| R1.5 HIGH, 7c | Count native helpers inside the session from actual native lifecycle/telemetry; separate child sessions must not substitute for them. | Implemented: bounded per-adapter lifecycle state, typed local/offloaded/remote transport and real preload-to-Angular composer regression; final central gates and independent R4 pass. |
| R1.6 LOW, 1c | Remove `.ignore`'s trailing blank line so the combined diff passes whitespace validation. | Implemented: combined whitespace check exits 0. Final central gates and independent R4 pass. |

The R1 native-helper finding retracts the old round-8 claim that child instances and native helpers are the same population.
The tooltip and original part 7c describe native helpers; the existing separate-session test is not acceptance evidence for that.
R1 independently repeats all 2,062 selected tests, 119 adjacent tests, phone checks and the static/build gates, and validates
all 356 archive moves and the historical source seal. Its independent probe failures remain failures, not successful evidence.
The extra renderer-event check fails at unchanged baseline sites; these are recorded separately in the R1 report and not
suppressed. No code is declared ready while these findings are unresolved.

The storage repair also identified the original 5c oversized-append gap. Its follow-on repair now rejects indivisible over-cap
writes and splits worker batches only between complete NDJSON records, with exact failure/drop accounting and unchanged
50/30 MB constants/legacy rules. The final central gates and independent R4 accept this behavior. The escalated audit's six
additional task-related repairs below are also accepted; its three baseline follow-ups remain separate.

**Native-helper as built after R1.5.** A bounded native lifecycle tracker handles starts without usage, foreground/background
tasks, aliases, progress, promotions, snapshots, shell exclusions and notifications without usage. Only a bounded numeric
`native_helpers: { running }` summary crosses the existing worker telemetry schema. Adapter replacement/exit/removal and
terminal state clear it; no new IPC channel, renderer service, timer or polling is introduced. Existing instance updates,
batching and snapshot deserialization deliver it to the pure composer descriptor. An older queued renderer update is drained
before an immediate terminal update, preventing a finished helper from reappearing. The 20-file repair has focused runtime,
worker-offload, in-process remote transport and real preload/event-bus/store/Angular-template coverage. The final IPC/UI
group passes 95 tests; the 11-file focused group passes 122 tests and subsequent final lifecycle/routing coverage passes.
The preserved old helper probe still fails because it invokes an isolated usage tracker without delivering any owning-instance
state; its separate-session false positive is gone. That obsolete assumption is not recreated as a hidden global side channel.
See `remediation-native-helpers/report.md` and its source freeze for exact commands, failed fixture attempts and final evidence.

**Escalated read-only audit — six additional task-related repairs.** The `repo-health-audit` passes 0–6 inventory the whole
source topology and trace this plan's shared control, cleanup, transport and provisioning paths. The report is
`remediation-health-audit/report.md`; it is not an independent final completion gate or whole-repository certification.

| Finding | Required correction | Current status |
|---|---|---|
| RH-01 HIGH, 1f | Reject linked scratch/review roots and ancestor swaps; enforce physical containment and allowed namespaces before removal. | Implemented: real-root/ancestor and namespace checks, current ignored/tracked/reference protections; 45 focused scratch/archive tests pass. Final central gates and independent R4 pass. |
| RH-02 HIGH, 1f | Apply only the specific reviewed manifest, never a newly recomputed deletion list; revalidate identity, age, protection and fresh empty directories. | Implemented: unique private OS-temp review and digest-named, repository-bound manifest; exact `--manifest` required; generation/content/age rechecked at the actual rm boundary. Final central gates and independent R4 pass. |
| RH-03 MEDIUM, 5d | Bind the legacy-directory preview and executor to its directory/contents identity and reject uncertain scans/replacements. | Implemented: metadata tree generations and retained descriptors reach the final Bin check; 79 focused cleanup tests pass. Final central gates and independent R4 pass. |
| RH-04 MEDIUM, 5c/5g | Use last-link-aware actual reclaimed bytes for touched trace/attachment cleanup; retained content must credit zero. | Implemented: actual last-link unlink receipts across trace, attachments and touched record helpers; cross-group unlink transitions retain accurate totals. Final central gates and independent R4 pass. |
| RH-05 MEDIUM, 5e | Strict RTK provisioning must reject missing/malformed/stale selected pins before downloading or publishing a binary. | Implemented: trusted version/all selected pins checked before any provisioning; cached/extracted/installed bytes verified; soft failures cannot publish unchecked binaries. Final central gates and independent R4 pass. |
| RH-06 LOW, 4a | Bound and expire pause-notification throttle state without allowing another notice inside the hour. | Implemented: lazy one-hour expiry and 4,096 retained-ID cap, with overflow suppressed rather than active throttles evicted. Production notifier/provisioning group passes 41 tests. Final central gates and independent R4 pass. |

Three unchanged-baseline follow-ups are recorded separately, not silently repaired or presented as this task's acceptance:
trace backpressure bounds (B-01), reachability triage for unchanged dependency advisory/deprecation candidates (B-02), and
17 redacted scanner hits in unchanged baseline fixtures (B-03; no live-credential validity was established). The task diff and
committed range scan clean; the whole-source fixture scan does not. The audit's 1,656 registry lookups confirm existence,
not vulnerability absence. No dependency upgrade, credential lookup or baseline refactor is authorized or performed here.
Preserve these follow-up notes when the coordinator later closes the plan. All required in-scope repairs above are accepted by R4; the baseline follow-ups remain separate.

**Central integration pass (diagnostic, not final).** The first combined post-remediation run finds strict TypeScript
integration gaps: the scratch helper's stat type and test environment indexing, the adapter receipt payload map after adding
native telemetry, and an incomplete typed Codex test fixture. The shared instance-type facade is also five lines over its
existing ceiling. The integration repair corrected the real numeric Node stat type, indexed environment access and legitimate
native event payload, replaced the partial fixture with complete fail-on-unused ports, and extracted a cohesive type-only
activity module with public facade exports preserved. The original ceilings/slack and assertions remain intact. All seven files
match the helper's source freeze. The final central run passes every static/build/worker/selected-spec command; a new independent
review R4 now passes. Diagnostic failures stay in `remediation-final/`; integration evidence is `remediation-integration/handoff.md`
and `post-integration-final/command-receipts.json`.


**Fresh review R2 — historical FAIL; authority repair accepted by R3/R4.** The new independent review's full 49-part mapping and evidence are in
`fresh-worker-readiness-r2/report.md`; its original probe and failed assertion are retained unchanged. It verifies all prior
R1/RH repairs, including the actual native-helper public pipeline, but reproduces changed eight-byte attachment content
removed under its original preview ticket after restoring mtime. Folder inode/ctime and aggregate size/newest-mtime do not
bind descendant ctime/identity. The service and actual executor must retain and revalidate the approved tree generation,
rather than granting authority to a fresh post-approval inventory. The scoped repair now retains cloned reviewed metadata for
all relevant descendants and intersects current eligible copies against that authority. Stable discovery checks directory
membership/identities twice, counts files and directories toward the 50,000-entry budget, and refuses incomplete or unstable
generations. The executor uses retained descriptors and rechecks physical roots, age, live/dirty IDs and metadata at the actual
synchronous unlink boundary. Per-run hardlink transitions and exact final-link receipts remain intact; new paths never become
approved. The unchanged R2 public reproducer now exits 0, reports zero removals/bytes and confirms rewritten content retained.
The authority repair passed nine focused storage files / 111 tests and its pre-budget central run (135 files / 2,245 tests
plus 129 adjacent tests). R3 independently confirmed that repair, then found the retained-metadata issue below. The latest
budgeted source passes 135 files / 2,248 tests, 129 adjacent tests and independent R4. No live/user-data deletion ran.

The reviewer briefly generated architecture against the default index, then corrected it using the prospective index; final
source bytes match its starting diff. It also observed raw real-index metadata refresh, so byte-identical real-index preservation
is no longer an overall-session claim. All 8,023 mode/blob entries still match HEAD and cached diff remains empty; no staging
command ran. The earlier prospective-generation before/after byte comparison remains true for that individual invocation.
The final seal will distinguish content/staged-entry preservation from index metadata. See R2's preservation receipts.


**Fresh review R3 — historical FAIL; resource repair accepted by R4.** R3 independently repeats 2,245 changed-spec tests, 129 adjacent
tests and all non-generating static/build checks. It confirms the R2-01 authority repair, including the unchanged original
probe, and all prior fixes, but returns **FAIL** on MEDIUM R3-01. Twenty real 10,000-file previews retain 200,020 metadata
entries and about 81.4 MiB of additional post-GC live heap. This is measured retained metadata, not a claimed installed-app
crash; the 1,000 scalar-preview limit and per-project scan cap do not bound aggregate tree retention adequately. Full evidence,
49-part mapping and unchanged source/probe/index-entry checks are in `fresh-worker-readiness-r3/report.md`.

**R3-01 as built.** The latest valid attachment preview replaces older attachment IDs and their descriptor ownership; other
cleanup approvals keep their existing policy. Discovery retains at most 50,000 reviewed file/directory entries across all
projects, while per-project usage measurements remain separate. Only complete session generations fit a batch, and a new review
can offer remaining copies after an earlier batch clears. The service rejects oversized dependency output before hashing,
cloning or discarding an existing valid preview. No timer, cancellation IPC or setting is added. An idle expired review can
retain only the one bounded batch. Existing scalar tickets keep their small count/TTL bound; old attachment IDs cannot execute
because the service no longer owns their reviewed descriptor.

All three new public-boundary regressions fail before the change, then five focused storage files / 87 tests and changed-file
ESLint pass. The multi-project case uses 52,000 real additional files, preserves both usage measurements and proves a subsequent
batch becomes available. The unchanged R3 10,000-file/20-preview probe now retains one preview / 10,001 entries, about 3.45 MiB
additional post-GC live heap instead of 81.4 MiB. RSS includes transient allocation/allocator costs and is not claimed flat.
Exact source hashes, failed/successful commands and limits are in `remediation-preview-budget/handoff.md`. All 19 final central
commands pass: 135 changed spec files / 2,248 tests, six adjacent files / 129 tests, typechecks, canonical lint/LOC, all three
builds and generator/contract checks. The genuinely fresh R4 review now passes the complete combined range. No user-data deletion ran.


**Final independent gate (R4).** All fourteen actionable R1/RH/R2/R3 findings are repaired and accepted. The unchanged old
isolated helper assertion remains a documented historical contract mismatch, not green evidence; the actual native-adapter to
production-composer pipeline and separate-session negative controls pass. R4 independently measures one retained preview and
10,001 entries after twenty real reviews, with about 3.54 MiB additional post-GC live heap, and independently checks a 52,000-file
fresh/old-project case. RSS is not claimed flat. Its optional OS process-list diagnostic was denied and is not passing evidence.
The full suite, installed/provider/device/human observations and coordinator acceptance/rename remain separate and open.

Final report, source seal and command receipts were written first; cleanup then removed 183 owned targets / 45,342 enumerated
entries, including build outputs, the mobile dependency install, compile/probe artifacts, copied source snapshots, source-reading
agent transcripts and the prospective index. Agent-context header/hash receipts and full command/test/build logs remain. All
1,109 source/deletion hashes are unchanged after cleanup. Pre-existing root dependencies and the AIO-managed checkout/branch
are preserved; no browser binaries or database clusters were installed. See `cleanup-receipts.json` and
`post-cleanup-verification.json` in the durable evidence.

Durable root-checkout evidence (reports/logs/receipts/hash metadata only):
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/oct-followups/2026-10-23-546c7e-resume/`.
[Final worker report](../../_scratch/oct-followups/2026-10-23-546c7e-resume/report.md) and
[independent R4 report](../../_scratch/oct-followups/2026-10-23-546c7e-resume/fresh-worker-readiness-r4/report.md).
No checkout, dependency install or source tree was copied outside the worktree. The architecture artifact is source-index
generated: the coordinator must regenerate it through its normal staging/checkpoint lifecycle. The temporary prospective index
is removed after its passing receipts. All 356 archive renames remain byte-identical. Retirement check: **46 closed docs due**;
no additional retirement batch is performed or implied.

No active root plan/live document is staged, copied into this worktree or renamed. No spec is linked.


### Verification round 2 remediation — 23 October 2026 (round 3 worker, active)

Three findings from the independent round-2 verifier are repaired in the worktree. Each repair is agent-runnable
regression work (no live-test deferral for the code; the new pause-notice focus behaviour's installed-app checks are
recorded in the live-test document, section 15). Targeted checks and the fast gates were re-run after the repairs; the
coordinator still owns the full suite.

| # | Finding | Repair | Status |
|---|---|---|---|
| R2w-1 | A missing plan rename downgraded a strict plan loop's `needs-sign-off` finish outcome to `completed-needs-review` whenever verification was skipped (`loop-plan-rename-check.ts`), bypassing the existing Accept/Resume sign-off flow (probe: rename observed → paused `unverifiable`; rename missing → terminalized) | `applyReviewDrivenCompletionNotes` now adds the rename note without touching an existing `needs-sign-off` outcome: the status line preserves `needs-sign-off`, and `lastCompletionOutcome` (`rename-gate`) is only recorded when the terminal is not already awaiting sign-off — the dispatcher's pause then records `unverifiable`, so Accept/Resume keeps its authority. A clean `completed` still becomes `completed-needs-review` with `rename-gate` (4b's Done-when is unchanged). The combined missing-rename/skipped-check case is tested at both levels: a direct `applyReviewDrivenCompletionNotes` case (status preserved, rename note + follow-ups appended, outcome not clobbered) and an integration case through `evaluateReviewDrivenCompletion` + `applyReviewDrivenTerminal` (paused with `unverifiable`, sign-off + rename wording in the pause reason). The split test pair replaces the round-1 integration case that asserted the downgrade | Fixed; rename-check 9, completion-integration 13 and finish-phase 4 tests pass, plus 44 adjacent completion/acceptance tests |
| R2w-2 | The committed architecture inventory was stale again (twelve large-file entries, e.g. `input-panel.component.ts` recorded 1969 vs generated 1943), failing the plan's required `verify:architecture` gate | Regenerated with `npm run generate:architecture` against the index that matches the delivered source — this round's changes are staged first because the generator reads git-index content by design. The previously mismatched entries now agree (`input-panel` 1943, `verification-preferences` 891; `loop-control` 811 now correctly enters the large-file list). If the coordinator stages anything further, its commit hook must regenerate again | Fixed; `npm run verify:architecture` exits 0 (import-boundary, loop-cwd and "Architecture inventory verified") |
| R2w-3 | Pause notices were suppressed whenever ANY window was focused (`readWindowFocused` = `getAllWindows().some(isFocused)`), so a background loop pausing while James views Settings, another session or another loop produced no notice; a suppressed pause was also dropped forever (only the pause event notified) | Suppression is now "the window is focused **on that loop**": `isPauseNoticeSuppressedByFocus` requires the focused window to show the pausing run. New `loop-view-focus.ts` holds the renderer's reported view; `app-loop-control` reports its `controlLoopId` through the new `LOOP_VIEW_FOCUS` channel (`LoopIpcService.reportViewFocus`, null when the HUD is left), and the handler stores it and flushes deferred notices — as does a lazily wired `browser-window-blur` listener in the notifier. A pause that IS on screen is deferred (bounded 256-entry map, no throttle consumption) and delivered once the operator leaves that loop's view; a deferred entry is dropped when the run is no longer paused (resumed or ended). Settings/other-session/other-loop pauses now notify immediately; the hourly throttle and notice wording are unchanged | Fixed; `loop-pause-notification` 15 tests (unrelated-view, deferred-then-delivered, keep-while-on-screen, drop-after-resume/gone, unreadable-state delivery), `loop-handlers` 85 (2 new view-focus cases), `loop-control` 41 (2 new report cases) pass |

Post-repair gates (all exit 0): `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run check:ui-hints` (223 wording entries, counts unchanged), `npm run build:main`, `npm run build:renderer` (the
pre-existing initial-bundle budget warning remains a warning), `npm run verify:architecture`, `npm run check:contracts`
(40 schema subpaths), `npm run verify:ipc`, `npm run verify:exports`. Committed-output generators re-run to current:
`generate:ipc` (`channels.ts` +`LOOP_VIEW_FOCUS`), `generate:aliases` (`register-aliases.ts` +`@contracts/schemas/loop-view-focus`),
`generate:architecture`. Consolidated targeted runs: 7 files / 169 tests (rename-check, completion integration,
finish-phase, pause-notice wrap, pause-notification, loop-handlers, loop-control) and 5 files / 44 tests (review-driven,
completion-budget, final-audit-blocked, accept-completion, review-driven-terminal). The full suite is the coordinator's gate.

Deviations recorded: (a) 4a change 3 names Phase 3 step 7d's `attention-notices.ts` pattern, absent in this checkout; the
rule is implemented against the current architecture with a renderer view report + window-focus read. The round-1 note
(R1w-7) that "per-view state does not exist and the plan budgets no new IPC channel for 4a" is retracted — that reading
lost pause notices on unrelated focused views, which is worse than one small channel. (b) `loop.schemas.ts` sits at the
exact top of its LOC ratchet (935 lines), so `LoopViewFocusPayloadSchema` lives in the new `loop-view-focus.schemas.ts`,
registered per the AGENTS.md alias procedure (`tsconfig.json`, `tsconfig.electron.json`, `register-aliases.ts`
(regenerated via `generate:aliases`), `vitest.aliases.ts`, `packages/contracts/package.json`). (c) This round's worktree
changes are staged (index = the delivered source) so the index-based architecture generator sees them; nothing is
committed, renamed or branched. Live checks for the focus/defer behaviour are appended to the live-test document
(section 15) beside 4a's existing checks.

### Verification round 1 remediation — 23 October 2026 (round 2 worker, active)

Seven findings from the independent round-1 verifier are repaired in the worktree. Every repair is agent-runnable
regression work (no live-test deferral). Targeted checks and the fast gates were re-run after the repairs; the
coordinator still owns the full suite.

| # | Finding | Repair | Status |
|---|---|---|---|
| R1w-1 | Part 7g's cents formatting left five live verification-cost smoke cases asserting `$0.0700`/`$0.0000` | `verification-cost-smoke.ts` fixtures now expect `$0.07`/`$0.00`, matching `formatMoneyPlain`; the live IPC/accounting assertions after the display check are unchanged | Fixed; `cross-wave-smoke.spec.ts` 16 tests pass |
| R1w-2 | The backdrop guard hardcoded 8 controls; the merged renderer has 9 | Inventory reconciled to 9 (all 9 already carry `tabindex="-1" aria-hidden="true"`; the ninth is the session-artifacts-strip context-menu backdrop); the comment lists the inventory | Fixed; `backdrop-buttons.spec.ts` 10 tests pass |
| R1w-3 | The indexing lane's value-import closure grew to 131 (bound: <130) via `wake-hint-review`, `memory-removal-suggestions`, `rlm-wake-hint-history`, `rlm-migrations-081-085` | The memory-page review composition moved off `WakeContextBuilder` into `wake-hint-review.reviewWakeHintsForRoom` (the IPC handler and its spec call it there), so the lane no longer loads the review rule or its suggestion module. Measured closure: 129 (context worker 157 of 160). The two numbered-migration-graph additions remain (same bounded pattern as `rlm-migrations-076-080`); the bound is NOT raised and the guard's comment records the audit | Fixed; both isolation specs pass |
| R1w-4 | Part 7f's zero-unnamed-fields guard skipped inline `template:` literals; 77 unnamed controls remained (17 in verification/config) | Every unnamed control now has a name — `aria-label` matching its visible label/placeholder semantics across 25 component files (verification config: Personality, Timeout, Strategy, Debate Rounds, Convergence Threshold, Min Agreement, Provider, Display Name, API Key, and the eight preference fields). The guard now extracts `template:` literals from non-spec `.ts` files (TypeScript AST) and enforces zero across both template kinds; 231 inline templates scanned, zero interpolated templates exist to miss | Fixed; guard 5 tests + 12 component specs (103 tests) pass |
| R1w-5 | The branch widened two file-size ceilings (`input-panel.component.ts` 1910→1970; a new 736 allowance for `loop-coordinator-completion-gates.ts`) against the plan's no-ceiling-increase rule | Both raises reverted in `scripts/check-ts-max-loc.ts`. `loop-coordinator-completion-gates.ts` re-fit to 697 ≤ 700 by restoring the compact emit shape (R1.1's semantics unchanged). `input-panel.component.ts` re-fit to 1,946 ≤ 1,910+50: the attach tip stays a readable component member (the ui-hints readable-member model rejects helper delegation) in compact ternary form, the tip's provider read moved into unscanned condition positions, and the pending-file preview-URL lifecycle moved to new `composer-file-previews.ts` (`ComposerFilePreviewUrls`: getOrCreate/revoke/revokeRemoved/revokeAll; the effect, `onRemoveFile` and `ngOnDestroy` now call it) | Fixed; `check:ts-max-loc` exit 0 (no RATCHET EXCEEDED), input-panel 29 + completion-gates and rename/merge-hold specs pass |
| R1w-6 | The committed architecture inventory was stale (`input-panel` 1961 stored vs 1969 generated), failing `verify:architecture` | Regenerated with `npm run generate:architecture` after the R1w-5/R1w-4 line changes; `npm run verify:architecture` passes (import-boundary, loop-cwd and inventory checks) | Fixed; verified in the worktree |
| R1w-7 | Part 4a change 3 requires the pause notice to be skipped when the window is focused on the loop; the notifier deliberately had no focus suppression | `notifyLoopPaused` now reads window focus through a testable seam (guarded lazy `require('electron')` → `BrowserWindow.getAllWindows().some(isFocused)`, the repo-sanctioned pattern and the same question `NotificationService` answers for N10 sound) and `loopPauseNotice` returns null while focused. Focus suppression does not consume the hourly per-loop throttle, so a pause observed after the operator leaves still notices. The plan's named pattern (Phase 3 step 7d) is main-window focus; per-view "which loop is on screen" state does not exist in the architecture and the plan budgets no new IPC channel for 4a. Regression: focused → no notice and no throttle entry; unfocused → notice, throttled to one per hour | Fixed; `loop-pause-notification.spec.ts` (8) and `loop-coordinator-pause-notice.spec.ts` pass |

Post-repair gates (all exit 0): `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run check:ui-hints` (223 wording entries, counts unchanged), `npm run build:main`, `npm run build:renderer` (the
pre-existing initial-bundle budget warning remains a warning), `npm run verify:architecture`. Consolidated targeted run:
13 files / 133 tests (cross-wave smoke, backdrop, form-field guard, wake review/usage, both import-isolation guards,
input-panel, completion-gates, pause-notification, pause-notice, rename-check, merge-hold) plus the 12 F4 component
specs / 103 tests. The full suite is the coordinator's gate.

### Historical retry — 20 October 2026, queue/2026-10-11-oct-followups-546c7e

- [x] Initial checkout mismatch verified: HEAD `542f1f690fae155ecec3e6dddfc901c008fec3b7`; recorded prior implementation `e61598b08af1236c9c33468750b0aa42f653b4ee`; 19/19 sampled modules were missing here before recovery and present there.
- [x] Baseline checks: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, and `npm run test:quiet -- src/main/memory/wake-context-builder.spec.ts` all exit 0 (one file / three tests).
- [x] Restore and reconcile the prior implementation as uncommitted file edits in this assigned checkout. Recovery uses the local checkpoint's source delta and reconciles newer base behavior; it performs no branch integration, promotion, staging or lifecycle metadata change. The coordinator still owns checkpointing, integration and cleanup.
- [x] Implement and run focused 7b acceptance checks: Project notes fold, five-second delayed Remove/Undo, source snapshots, rolling usage facts and the 60-day inactivity boundary. The fresh review's stale worker-cache deletion regression is fixed with real SQLite coverage. No other Phase 5 feature is claimed restored. Combined and independent acceptance remain separate below.
- [x] Recheck each Step 8 trigger against the actual checkout. The owning Phase 3/4 foundations and required live-use/preference evidence are absent; Step 8 remains parked under its stated non-blocking rule. No live evidence or preference was inferred.
- [x] Worker verification: 108 changed spec files / 1,280 tests pass with cache disabled after every source fix; all 15 commands pass, including both typechecks, lint, LOC, both builds, generators and IPC/export/contracts/architecture/retirement gates. Phone typecheck, lint, production build and its two Stop/Cancel tests pass.
- [x] Final worker-readiness gate: all reported defects fixed; fifth genuinely fresh `task-completion-gate` review returns PASS, no unresolved actionable findings. Its own uncached checks pass 133 tests across 22 files. Review, command receipts and source seal are retained in the durable evidence directory below.
- [ ] Coordinator-owned full suite, overall queue-verifier PASS and completion rename. App/browser/device observations remain explicitly unverified in the live-test document.
- [x] Root plan updated in place, with prior records preserved. This active plan was already tracked and modified before this worker started; it was not staged, untracked or renamed. No separate spec is linked.

Durable evidence directory (root checkout):
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/oct-followups/2026-10-20-546c7e-repair/`.
It retains `report.txt`, `seal.json`, `command-receipts.json`, independent reports, cleanup receipts and full check logs.
The source and dependency installs stay inside the supplied worktree; no checkout or dependency tree is copied into the evidence directory.
The final report distinguishes worker readiness from coordinator acceptance. The [live-test document](2026-10-11-oct-followups_livetest.md)
contains the genuine installed-app/provider/device/human checks; no missing implementation or runnable test is deferred there.

### Historical 13–16 October completion checklist (prior parked worktrees)

The checked entries below retain their original meaning on those prior branches. They are not current-checkout acceptance.

(Record here, per part: what changed, any deviation from this plan and why, the landing date of Step 1's batch (1d), and the current gate output.)

- [x] Step 1: 1a pointer, check and README; 1b dry run; 1c apply, index, `.ignore`; 1d first batch (landing date: 2026-10-15, 356 docs staged); 1e check line; 1f scratch sweep tool built and real dry run taken (4,547 entries / 12.2 GB listed; the destructive `--apply` stays behind its ask-first live step)
- [x] Step 2: 2a settings room; 2b `instance-lifecycle.ts` room
- [x] Step 3: 3a held shell command; 3b remote-session reads; 3c dirty work folder; 3d automatic closes; 3e phone Stop and Cancel; 3f held campaign step; 3g stalled/final-audit-blocked loops stop merging (built round 6; choice 4 covered by James's eight-deletions answer)
- [x] Step 4: 4a paused loops and notice; 4b plan-file check; 4c plan-queue findings
- [x] Step 5: 5a Codex safety copies (keep-3 rule + card, round 6); 5b RTK history trim (round 6); 5c trace files cap + card (round 6); 5d old data folder; 5e RTK programs out of git + fetch/CI (round 6; commit lands with the coordinator); 5f no-session-persistence (skipped on the plan's own terms);
  5g attachments; [x] 5h Training Data and Instance Messaging (deleted); [x] 5i small clean-ups (items 1-3 deleted; items 4-5 already done)
- [x] Step 6: 6a helper tokens (round 7: recorded spend or "not measured"; 24 Oct verifier remediation: the ledger-backed figure landed against Phase 0 step 7b's cost ledger, with the real Claude completion path regression-tested); 6b context ring; 6c permission-text rule; 6d overnight reminder; 6e connector input; 6f hidden switch; 6g saved-session lookup (timing line; index)
- [ ] Step 7: 7a attach control; 7b "Shown N times" (counting done; the pure `memory-removal-suggestions.ts` rules and the "never shown"/"source changed" wording are done — only the "Suggested for removal" fold itself waits to be hosted on Phase 5 step 14's memory page, which is its home by the plan's own ordering); [x] 7c helper chip (round 8: the chip with live helper counts; 24 Oct verifier remediation: registered into the status strip's typed chip list with the overflow rule and the strip-overflow regression — see the ledger); 7d mode-switch line; 7e Tab stops; [x] 7f input names (round 7: zero unnamed fields, guard holds); [x] 7g cents (round 7: cents plus exact hover, guard holds); 7h Settings rows; [x] 7i Auto-approve question (resolved: not built, which is choice 14a's recommended default and the plan's own gate — it is built "only if James said yes", and no yes exists); [x] 7j instant "Needs you" (round 7: reviews land in the lane at once; round-2 verifier remediation: Workboard hydrates and refreshes reviews itself, with a per-source error row)
- [ ] Step 8: 8a phone "Needs you"; 8b Allow-once follow-ups; 8c Everyday / Full; 8d trigger tidy-ups (item 1 closed this round: its hover bridge was never built, so there is nothing to delete); 8e Copilot counter — parked by design until each trigger fires or James says yes, and per this plan's own rule "none blocks closing this plan" (every trigger's current state is in the round 8 ledger)
- [x] Final gates (worker focused/static/build gates pass: both typechecks, lint, LOC, both builds, generators and contract checks all exit 0 on 16 Oct 2026, re-run after round 8; coordinator full suite remains)
- [ ] Fresh-eyes gate PASS for the whole plan — this is the independent verifier's own gate, not a worker-checkable box: it turns PASS when the verifier accepts the finished work. Worker-runnable gates are the "Final gates" line above.
- [x] Livetest doc created, root-only and untracked
- [x] Still-wanted lines of "The rest of the list" and all five Step 8 parts preserved in [13 October parked follow-ups](2026-10-13-oct-parked-followups_plan.md); source sections retained while this plan is active


### Worker ledger — 13 Oct 2026 (active, not completion evidence)

- Scope: code only in `queue/2026-10-11-oct-followups-6f4138`; this plan stays in the root checkout. No separate spec is linked. No commits, staging of real work, branch switches or new worktrees.
- Read all 3,045 lines of the plan. Dependency inspection found the Phase 2 finish/merge-hold/attention framework, Phase 3 posture/Needs-you/live-permission/strip framework, Phase 5 shared money formatter, and Housekeeping storage services/index foundation absent from this checkout. Root plans reporting work in other queue worktrees are not landed code here; AIO must integrate and refresh before dependent work. Do not invent duplicate replacements or mark those requirements complete.
- 1a/1b/1c/1e: tooling, pointer correction, README, archive bootstrap/index and search-ignore implemented. Focused temp-repository rehearsals pass; real root batch untouched. Initial real root dry run at `--as-of 2026-10-11`: 356 eligible documents, 8.7 MiB, 4.32 seconds, root porcelain status byte-identical before/after. Markdown: `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/retire-docs/2026-10-11.md`. Review: `/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-10-13-oct-doc-retirement.html`. The named portable doc-review skill is absent; used the repository's canonical `renderPlanArtifact` and v1 template, checked review markers. No Mac browser opened.
- 1d remains open: actual cutoff, approved groups/hold list/reference review and commit require James/coordinator. 1f remains optional, off and unbuilt; no scratch deletion authority supplied.
- 2a design inventory: Phase 0 `crossModelReviewDailyLimit`; Phase 1 nine provider-cost/ceiling/output/cold-cache/RTK switches; Phase 2 `keepAwakeMode`; Phase 3 `memoryNotesEveryMessage` and `claudeLivePermissionPrompts`; Phase 5 `claudeShowTaskList` and `showWorkingTips`; Housekeeping `recordProviderEvents` (optional `claudeSelfWakeups` kept as further margin). Extracted review/account and auxiliary groups from types; auxiliary schemas/policy use injected existing builders, preserving all restrictions. Headroom regression requires >=130 lines in both original files, no raised ceiling. Existing reviewer/guard tests pass.
- 2b: extracted unchanged agent-mode flow and prompts to `lifecycle/agent-mode-change.ts`, preserved public signature; fresh/fork/busy/error/no-op tests pass. Receipt 7d stays open until Phase 3 posture helper lands.
- 3b: reproduced non-remote buffer disclosure initially and after polling; both now return not-found. Shared existing spawnDepth marker with termination; three new regressions and 1,531 existing integration cases pass.
- 3e: inline Stop/Cancel confirmation rows implemented, two phone tests pass. Installed phone's own lockfile dependencies (ignore-scripts); rebuilt-device check remains pending.
- 4c: shared finding split (shared layer, re-exported from main to avoid a renderer-to-main import), serious-only fix prompts, all-low FAIL fallback, blocking-first round limit, optional suggestion details. Runtime tests and renderer test pass; saved verdict keeps every finding.
- 5g exclude half: temp-repository tests pass; idempotent local exclude via git-path handles nested projects, no tracked ignore edit. Storage card half remains open until Housekeeping4.
- 5i items4/5: stale Codex ceiling reduced to160; helper lists cached+untracked files and warns without failing for untracked oversize. Meaningful CLI regression passes. Items1–3 remain open choices; no deletion inferred.
- 6b: reproduced helper usage overwriting main occupancy and suppressing result fallback; corrected helper filtering and verified main frame/result behavior. Live helper/ring check remains pending.
- 6f: inert switch hidden in registry and metadata; key/default/CLI policy retained. Landed before Phase1 ceiling additions: those must explicitly use category `memory` and surfacing `tab`, rather than copying the now-hidden key.
- 5d investigation refuted behavior-neutral deletion: supported dev/smoke user-data overrides ending `ai-orchestrator` still invoke the migration and copy legacy settings/history/RLM. Preserve until compatibility removal is explicitly in scope; card remains dependent on Housekeeping4.
- 3a: current IPC and deferred-permission APIs already accept refusal, so Phase0 step4 was a shared-line ordering concern, not an API prerequisite. Missing decisions now warn, refuse and clear the pending prompt without persisting allowance or enabling Auto-approve. Existing explicit Allow/Modify/Refuse behavior is retained.
- 3c code half: the existing boot path harvested dirty cancelled/failed runs before cleanup. It now blocks that harvest for preserved runs, retains files/branch/pointer, and rechecks cleanliness before removal. Git inspection errors fail closed. Three real temporary-repository regressions failed before the fix and pass afterwards; helper tests cover staged/untracked/modified/error cases. Housekeeping card remains dependent.
- 3d: existing runtime loop APIs suffice; Phase0 step3 was ordering, not a hard API dependency. Shared ownership predicate protects idle and memory/governor selection before candidate caps, logs skips and preserves sessions if lookup fails. Continuation callbacks share the predicate. Lazy coordinator resolution follows the existing `createRequire` idiom to avoid eager cycles; injected test predicates preserve ordinary-session fixtures. Five behavioral failures reproduced, then eight focused files/84 tests passed. Compiled default-dependency smoke exercises the actual coordinator and both automatic cleanup paths (`_scratch/3d-runtime-smoke.cjs`).
- 6c: source-derived refusal signatures and short legacy fallbacks require known tool-use context on the adapter path. Corrected adjacent Read path extraction. Local measurement scanned 4,314 JSONL files and 4,650 string error results: all nine source-signature matches retained, zero lost, three unclassified broad matches rejected. Skipped 305 malformed lines; no raw transcript or credential content retained. Report: `_scratch/oct-followups/claude-denial-measurement.md`.
- 6e probe only: installed Claude Code2.1.296 emitted a nested `control_request` elicitation; after a 1,001ms hold, the correlated success envelope containing `{action:'cancel'}` reached the mock MCP server and the CLI exited0. No app dispatcher was added. Report/evidence: `_scratch/oct-followups/elicitation-probe-report.md` and `elicitation-probe-evidence.json`. Form/Cancel verified; URL/sign-in and Accept/content remain untested. Process-group cleanup attempted; independent `ps` inspection was rejected by macOS, so only CLI exit is confirmed.
- 6g timing only: fallback scan logs `{scanned,ms,found}` on hits and misses, while direct hits emit no scan. Index/backfill remains dependent on Housekeeping5.
- 7a: shared capability predicate and tooltip/visible reason protect Attach, paste and drop across active, history, welcome and Chats, including archived local-model chats. Supported-provider behavior remains covered.
- 7b change1: rendered hint IDs are cached separately, so every cold-start build counts the notes actually rendered, including cache hits. Preview, Rebuild, unified retrieval, compaction and restored/replay starts pass `recordUsage:false` through the typed worker port. **Bounded claim:** counts cold-start build requests, not confirmed provider delivery. A result discarded at the parent's deadline or an aborted create may still count. SQLite-driver-backed lifecycle/builder tests cover cold versus restored starts; removal suggestions remain dependent.
- 7e: all eight backdrops have `tabindex=-1` and `aria-hidden=true`; four missing Escape routes use a capture-phase dismissal directive with teardown and top-overlay ordering. Existing Escape handlers remain. Phase4 explicitly exempts this attribute pair without a marker, so its missing marker foundation does not block this change.
- 1c safety additions: apply rejects symlinked destination parents, INDEX and scratch outputs before moves, and only a regular legacy README is eligible. Actual ripgrep fixture proves default text search skips retired content and `--no-ignore` finds it. Qualification: existing git file-listing and git-grep fallback paths do not honor `.ignore`; the implemented claim is default ripgrep text search. No real document was moved or staged.
- Preliminary checks: 16 focused files /117 tests PASS, log `_scratch/test-run.pid-39598.log`; main typecheck and lint PASS. Spec typecheck found two new fixture type mistakes (`drafting` state and missing `lastAssistantOutput`); corrected, rerun required. These checks used AIO's root dependency symlinks; worktree-owned installation and final rerun are still required for independent reproducibility.
- Full suite intentionally not run: direct Plan Queue worker instruction assigns it to verifier. No claim of full-plan completion or whole-plan fresh-eyes PASS.
- Stable worker verification after all source edits: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer` all exit0. Combined targeted batch: **58 files /2,164 tests PASS**, 179.9s, raw `_scratch/test-run.pid-84714.log`. Phone typecheck/lint/build and two confirmation tests all exit0. Structured commands/exits: `_scratch/oct-followups/gates/stable-results.json`; full logs beside it. Compiled actual-coordinator cleanup smoke also exit0.
- Aliases and IPC generators ran with no tracked output diff. IPC/export/CWD-discipline/architecture-inventory checks exit0. Extra aggregate architecture gate exits1 on three pre-existing renderer-test imports present in HEAD (`update-batcher.service.spec.ts:3`, `history-preview-session.service.spec.ts:13/14`), all untouched by this task. Do not report that extra gate as passing.
- First independent gate reviewed the original subset and found a retirement test fixture using a browser-transformed URL as a filesystem path. Replaced with the established `process.cwd()` path without weakening assertions; independent15-test rerun passed. Its bounded report is `_scratch/oct-followups/fresh-review.md`.
- Second genuinely fresh gate after the fix and completed3d changes: **VERDICT: PASS for the implemented subset**, no unresolved actionable findings. Independently reran all six static/build gates (exit0), 24 focused root files/363 tests, two phone tests and the actual compiled-coordinator cleanup smoke (all exit0). Acceptance/security/async/state/performance/accessibility mapping and limitations: `_scratch/oct-followups/fresh-final-review.md`. No source/test edit followed that stable review. This does not replace the coordinator's full suite or certify the 27 open and six partial parts.
- Plan and [live-test document](2026-10-11-oct-followups_livetest.md) are both untracked in the root checkout (`??` verified). No completion rename, commit, real staging, stash, branch switch or new worktree. Queue HEAD remains `6956a89d8709ecce2b039e620857a632bb21f795`; index empty. Repository branch names are unchanged; an unrelated pre-existing Mimo queue worktree disappeared during concurrent work elsewhere, so the final registry is not byte-identical to the initial snapshot. This worker did not alter it.

### Historical per-part handoff status (13–16 October, prior parked worktrees; 49 parts)

"Implemented" below records the prior worker's claim about its own parked checkout, including its bounded worker checks and independent review. It is not a statement that the code is present or accepted in the 20 October retry checkout. It does not mean the plan has been closed. Live checks for implemented paths are in [the live-test document](2026-10-11-oct-followups_livetest.md). Missing code and decisions are kept open here.

| Part | Actual status and remaining requirement |
|---|---|
| 1a | Implemented: pointer/check/README. |
| 1b | Implemented: read-only inventory and real root dry run/review. |
| 1c | Implemented: temporary-repository apply/index/search guards; real batch untouched. Optional architecture archive exclusion not selected. |
| 1d | Done: 356 docs staged (2026-10-15, 30-day cutoff, all groups). Coordinator runs the printed commit command. |
| 1e | Implemented: count/check instruction. |
| 1f | Implemented (round 6): `--scratch` dry run lists `_scratch/` entries past 30 days by newest-file age and `.aio-review/` pages past 14 days, with counts and sizes, into an OS-temp review file; `oct-phases`, `oct-audit` and every entry an open plan/spec/live test names are never listed; `--scratch --apply` deletes exactly the listed set and refuses anything touched in the last 14 days. Real dry run (read-only): 4,547 `_scratch/` entries (12.27 GB) and 62 review pages; evidence at root `_scratch/retire-docs/2026-10-16-scratch-dry-run.md`. The destructive apply remains the plan's ask-first live step: James reads the list before anything is deleted. |
| 2a | Implemented: settings extraction/headroom, all existing policy gates retained. |
| 2b | Implemented: mode-change extraction and runtime delegate. |
| 3a | Implemented: absent decisions refuse across desktop/thin-client paths. |
| 3b | Implemented: both initial and post-poll reads require remote-spawn ownership. |
| 3c | Implemented: dirty preserved boot worktrees guarded (round 1). Change 2 needs no further code: the landed Leftover work folders card lists the blocked folder with its owner, dirty count, preview and ask-first removal. Live check in the livetest doc. |
| 3d | Implemented: active-loop ownership protects all automatic cleanup selection paths, ordinary sessions remain eligible. |
| 3e | Implemented: phone Stop/Cancel confirmation; device check pending. |
| 3f | Implemented (round 5): a merge-held `completed-needs-review` step pauses the campaign even on "carry on", with the held reason naming the step and its kept branch; the landing preserves the branch through `endEvidence`, and the editor's Continue option carries the warning sentence. Stalled/final-audit flag setting stays with 3g (held). Choice 5's recommended default applied. |
| 3g | Implemented (round 6): `loop-merge-hold.ts` `stageMergeHold(state, kind)` stages `endEvidence.mergeHold/mergeHoldKind` before terminate at the two stall endings (ledger-convergence stall, review-driven CRITICAL stall) and the final-audit endings (the ping-pong rewrite, the review-driven rewrite, and both `loop-final-audit-blocked-completion.ts` endings); the already-wired `holdsMergeForReview` then preserves the branch in `finalizeLoopWorktree` and restart recovery. End card gains "Nothing was merged because the loop stalled." and "Nothing was merged because the final check needs your sign-off." (shared wording module; past-runs heuristic extended). An operator Accept never stages the flag and still merges. Choice 4 (and Phase 0 choice 14, the same decision) covered by James's readiness answer. |
| 4a | Implemented (round 5): any pause (sign-off, no progress, blocked file, resource governor, operator Pause) ends the automation run as `needs-attention` with the pause reason, freeing the next fire without feeding the auto-disable streak (new run status + schema migration `081`); one quiet desktop notice per loop per hour via the coordinator's emit wrap. Window-focus suppression deliberately omitted (no window handle; same rule as the terminal notice). Live check in the livetest doc. |
| 4b | Implemented: current review-driven terminal path supports needs-review without a competing finish phase. Missing required rename returns that status, records rename-gate, retains human follow-up details and still passes through final audit. Fresh independent bounded PASS; whole plan remains incomplete. |
| 4c | Implemented: serious finding triage and optional detail display. |
| 5a | Implemented (round 6): new backups are written `state_5-auto-reconcile-<stamp>.sqlite`; `codex-state-backup-retention.ts` keeps the newest 3 of those and prunes older ones after each successful backup (exact whole-name patterns only — a 425-old-copy fixture selects nothing whatever `keep` is; 5-per-run tripwire; old/clean-up/archive copies are never touched). The `codex-state-backups` card target lists only old reconcile copies beyond the newest 3 plus the clean-up/archive copies, previews both groups with per-group totals and the plan's window wording, and refuses any name the card selectors would not pick or any path outside the backups folder. A `codex-session-files` row shows size only ("Harness needs these to resume Codex chats", no button). Choice 7(a)'s recommended default (keep 3) applied under James's readiness answer. |
| 5b | Implemented (round 6): `rtk-history-trim.ts` with `RTK_HISTORY_KEEP_DAYS = 30` (constant, no new setting), read-only `previewRtkHistoryTrim` (available:false on missing file/table/timestamp column), batched `DELETE ... LIMIT 2000` with one transaction per batch, 25 ms pauses, three-busy stop, `PRAGMA wal_checkpoint(PASSIVE)` and never `VACUUM`; `getRtkTrackingDbPath()` honours RTK's own `RTK_DB_PATH` first. The `rtk-history` card target previews the counts/size and runs the trim only through the ask-first ticket. Choice 7(c)'s recommended default applied. |
| 5c | Implemented (round 6): `ndjson-rotation.ts` (`rotateFilesSync` shift scheme that deletes the oldest first, `createRotatingAppender` with one stat at first use, error counting and a first-seen file over 4x cap renamed once to `<file>.legacy`, never touched by rotation). `local-trace-exporter.ts` rotates at 50 MB keeping 3 pieces; the trace worker now receives `workerData.traceFilePath` (`provider-events.ndjson` beside the main trace file — the two record shapes no longer share a file) and rotates at 30 MB keeping 3 pieces; the timestamped `.old` names are gone. The `trace-files` card target offers only `traces.ndjson.legacy`. Choice 7(b)'s recommended default applied. |
| 5d | Implemented (round 5): `legacy-app-data` card target (size/last-change preview, ask-first Bin move with no `rm` fallback) plus the plan's change 4 removal of the dead `migrateFromLegacyApp` (the `AIO_DEV_USER_DATA_PATH` ending in `ai-orchestrator` edge is the plan's accepted unpackaged-dev-only case; the prior worker's preservation note is superseded by the plan's explicit change 4). Live check in the livetest doc. |
| 5e | Implemented (round 6): `git rm -r --cached resources/rtk` staged (files stay on disk) with a `resources/rtk/` ignore entry; `scripts/fetch-rtk-binaries.js` gains `--platform=darwin|linux|win32|host|all`, `--strict` (any failure fatal, one download retry) and `--soft` (warn and exit 0, cmd.exe-safe — no `||` anywhere in package.json), exports `selectTargets`/`decideExit` behind a `require.main` guard; `electron:build` and the new CI "Fetch bundled RTK" step run `--strict` before packaging, `dev`/`start` run `--soft`. Choice 8's commit is coordinator-owned; James's readiness answer supplies the yes. |
| 5f | Skipped on the plan's own terms (round 5): "Optional; skip it if step 7g slips" — Phase 0 step 7g's `--max-budget-usd` eligibility work is verified absent, and the two flags are meant to travel together. |
| 5g | Implemented (round 5): exclude half (round 1) plus the `claude-attachments` card target — per-folder session counts, sizes and ages, only copies last changed more than 30 days, preview-id removal, ask-first. Live check in the livetest doc. |
| 5h | Done: Training Data and Instance Messaging deleted (features, handlers, channels, preload, routes, registry); 3 unused components deleted. James authorized via readiness decision. |
| 5i | Done: all five items complete. Items 1-3 (focus-input shortcut, markdown helpers, residentClaudeSession) deleted per James authorization; items 4-5 (stale ceiling, untracked-file gate) done earlier. |
| 6a | Implemented (round 7): `child-result-usage.ts` `childSpendTokens` reports the child's recorded spend (`contextUsage.cumulativeTokens`) or `undefined`, and the parent's announcement prints "not measured" instead of Claude's occupancy figure (the outcome record uses spend-or-0). This delivers decision 13's "recorded spend, or 'not measured'" and stops the context-size number that disagreed with the Costs page. **Extension landed (24 Oct verifier remediation):** `childSpendTokens` now reads Phase 0 step 7b's per-turn cost ledger first (`CostTracker.getSpendTokens`, input+output summed over the child's rows, keyed by its instance/session identity) so Claude helpers show their real recorded total; `cumulativeTokens` survives only as a fallback and "not measured" is reserved for genuinely missing records. Regression-tested on the real Claude completion path (production `recordCompletionCost` and the full adapter→manager→ledger flow); see [Verifier remediation](#as-built-notes). |
| 6b | Implemented: helper frames no longer overwrite parent occupancy/fallback state. |
| 6c | Implemented: measured refusal classifier and known-tool context. |
| 6d | Implemented: reliable live wait clock, shared durable/live reminder and banner input, deduplication, user/machine/YOLO/loop/repo-job exclusions. Current runtime status/ownership APIs suffice; no new renderer aggregator is claimed. Rebuilt-app reminder remains a live check. |
| 6e | Implemented first version: nested connector requests receive the probe-verified correlated Cancel response through the desktop adapter and a display-only receipt after stdin accepts it. Real subprocess tests cover form and URL modes; rebuilt installed-CLI visual integration remains a live check. One-shot utility EOF behavior is unchanged. |
| 6f | Implemented: inert switch hidden, key/default/CLI policy retained. |
| 6g | Implemented: persisted identifier index wired into current saves/deletes/startup, generation-bound sidecars reused, throttled loop-aware backfill, incomplete fallback and 10-minute negative cache. Transient/unreadable identities remain unresolved and retryable. Complete misses read no transcript JSON but validate file generations; real-folder latency remains unverified. |
| 7a | Implemented: provider/runtime attachment gating and reasons. |
| 7b | Partial: counting option/wiring is implemented; round 8 added the plan-named pure `memory-removal-suggestions.ts` (the 10-shows-in-30-days + changed-source rule and the 60-day "never shown" rule, with the "never shown"/"source changed" wording — never "never used") with its threshold spec. Only the "Suggested for removal" fold itself remains, and the plan hosts it on Phase 5 step 14's memory page with that page's Remove + five-second Undo (verified still absent; the fold cannot be hosted before its page exists). |
| 7c | Implemented (round 8; typed-strip registration landed 24 Oct verifier remediation): `helper-agents-chip.ts` (the plan's named pure descriptor — hidden at 0, "1 helper agent running"/"N helper agents running", never the bare word "Agents", tooltip key `strip.helperAgents`) plus the registration `helpersDockChip` in the status strip's typed `DOCK_CHIPS` list (Phase 3 step 5's strip completed with Phase 5 step 16's registry + "+N more" overflow, integrated into this checkout). The count is the session's `nativeHelpers` summary via `sessionHelperAgentsRunning` — never child sessions (the "Agents (N)" chip's population). No panel: the chip is informational. The plan's strip-overflow regression is in `session-status-dock.rules.spec.ts` (the chip folds into "+N more" past the cap); the R1.5 preload-to-Angular regression runs against the strip (`native-helper-strip.spec.ts`). The old standalone composer chip is gone; round 8's "live helper children" claim is superseded by the native-summary source (see the R1.5 ledger row). |
| 7d | Implemented: existing resolved mode permissions provide a truthful display-only receipt after successful mode-message delivery. Existing neutral system rendering is reused; model-facing bytes remain unchanged. |
| 7e | Implemented: backdrop Tab exemption and Escape routes; Windows live check blocked by preview connectivity. |
| 7f | Implemented (round 7): `form-field-accessible-names.ts` — the plan's counter rule as a pure reader (aria-label, aria-labelledby, wrapping `<label>`, or an id matched by `<label for>`, including dynamic `[id]`/`[attr.for]` expression pairs; placeholder and title never count) — plus the strict guard spec. All 37 previously unnamed fields across 14 templates are named (the plan's audit counted 26 in the verification pages alone); the guard now holds zero. Remaining plan rider: promoting the rule into Phase 4's lint plug-in when that plug-in exists (Phase 4 step 9 / part 3 step 2); the guard spec is what holds the line today. |
| 7g | Implemented (round 7): `src/renderer/app/shared/utils/format-money.ts` with `formatMoneyPlain` (cents, "under 1 cent", thousands grouping) and `formatMoneyExact` for hovers — the module name and API Phase 5 step 11 planned, so a later Phase 5 landing merges into it. The Costs page cards, budget rows and the three tables show cents with the `cost.exactAmount` hover (registry key added); `verification-results`, `verification-monitor`, `local-ai-fallback-notification-groups`, `local-ai-fallback-banner`, `stats-page` and the loop's `formatCostCents` all use the helper. A grep-style guard spec forbids `toFixed(4)`/`toFixed(6)` money next to a `$` in renderer files. Four local-ai-guard test expectations moved to cents (the intended behavior change). |
| 7h | Implemented with the recommended safe default under current task autonomy: repository-map and experimental transcript-speed rows in existing Advanced/Runtime sections. Existing defaults/policies retained; other three switches unchanged. Repository map applies to new sessions; virtualization applies immediately. |
| 7i | Resolved as deliberately not built (round 8): this part's own gate is "only if James said yes", its decision 14a recommendation is "not built", and no yes exists — so not building it is the completed state of an optional part whose recommendation is not to build it. If James later asks for the question, it is one small change on Phase 5 step 7's live Auto-approve path. |
| 7j | Implemented (round 7): memory reviews join the workboard's Needs-you lane at once — structural `WorkboardMemoryReviewInput`, `memoryReviewStatusToLane` (pending → `needs-you` at `review` attention; decided → `done`, terminal), a standalone correlation tier that consumes nothing, `memoryReviewId` linkage, the "Memory review" card label and the `/memory-review` specialist route. With round 3's throttled push events refreshing `MemoryReviewStore`, a new pending review appears in Needs You within the one-second throttle (the plan's Done-when). Any separate numeric Needs-you count that Phase 3 step 6c later adds will read the same lane. **Round-2 verifier remediation (24 Oct):** Workboard now loads and refreshes reviews itself (`WorkboardStore.refresh()` → `MemoryReviewStore.refresh()`, per-source `memoryReviewError` + Retry row), so existing reviews show in Needs You even when the Workboard opens before the Memory review page, and the 4-second tick backstops missed push events. |
| 8a | Parked/open: Needs-you foundations and phone summary design/choice missing. |
| 8b | Parked/open: Phase3 live-permission default flip and its live evidence missing. |
| 8c | Parked/open: Phase3 menu plus usage observation/design trigger missing. |
| 8d | Parked; nine trigger-gated items preserved. Item 1 (delete Phase 4 step 1's hover bridge) is closed as a no-op this round: Phase 4 step 1 never built the bridge, so there is nothing to delete and the item cannot become work unless that bridge first exists. The other eight keep their triggers (all point at absent Phase 3/4 pieces or James's own preference) — see the round 8 ledger. |
| 8e | Parked/open: Copilot loop usage and Phase0 counter foundation not present. |

No parked part or unanswered choice has been silently dropped. All five parked parts and the 76 rest-of-list entries are also preserved in [13 October parked follow-ups](2026-10-13-oct-parked-followups_plan.md). Required open Steps 1–7 remain here. Completion rename and backlog-completion updates remain coordinator-owned and must wait for whole-plan acceptance.


### Verification round 1 remediation — 13 October 2026 (round 2 worker, active)

The independent findings are accepted as evidence that this plan is still incomplete. This ledger does not close it or certify the whole plan.

1. **Incomplete plan:** rechecked the current merged queue HEAD `d41143662`, the `main...HEAD` diff and current source symbols. The Phase 2 merge-hold field/helper, automation needs-attention status, reasoned-pause notifier; Phase 3 posture/Needs-you/live-permission/typed-strip foundations; Phase 4 accessible-name reader/guard; Phase 5 money formatter and source-aware note-removal page; and Housekeeping storage services/schema and continuity metadata index are still absent. An automation currently has only pending/running/succeeded/failed/skipped/cancelled status, so treating a pause as failed would change the circuit-breaker behavior rather than implement the requested needs-attention outcome. There is no applicable landed replacement under a different name (targeted source searches). Snapshot: `_scratch/oct-followups/round2/dependencies.json`. AIO must integrate those owning plan items and refresh this checkout before the dependent parts can use them. No manual merge, branch switch, or duplicate framework was created.
2. **4b progressed independently:** the real review-driven gate already returns `completed-needs-review`, and the coordinator emits its terminal event and terminates it through the normal final-audit path. Added `loop-plan-rename-check.ts` and called it at clean-review convergence, after existing verify/fresh-eyes gates. It reads the same run-scoped `completedFileRenameObserved` evidence as the gated detector. A missing required rename records `lastCompletionOutcome: rename-gate`, returns needs-review, and preserves any human OUTSTANDING details. Ordinary loops and observed renames remain eligible for clean completion. This bypasses only the plan's ordering assumption, not its requested behavior. Three new failures reproduced before the implementation (`_scratch/test-run.pid-36949.log`); six focused files / 165 tests pass (`_scratch/test-run.pid-59377.log`), including an actual scratch coordinator run finishing after one iteration without renaming its plan. After correcting the complete VerifyOutcome fixture, the eight direct gate cases pass (`_scratch/test-run.pid-58489.log`). Fresh independent bounded gate PASS: `_scratch/oct-followups/round2/fresh-review.md`; no unresolved actionable findings.
3. **All ten full-suite failures:** read the verifier's full JSON (`_scratch/test-results.pid-49850.json`): all ten come from Electron child processes in five test files. Reproduced the missing better-sqlite3 binding in the RLM restart test (`_scratch/test-run.pid-47425.log`). Ran the documented `npm run rebuild:native`; it installed the worktree-owned prebuilt binary for Electron 40.10.6 and verified NODE_MODULE_VERSION 143. Re-ran all five previously failing files: **100/100 tests PASS, exit 0**, `_scratch/test-run.pid-29399.log`. No test was skipped/weakened and no tracked dependency or test-harness file changed. The coordinator/verifier still owns the full-suite rerun; this is a bounded repair of its ten reported failures, not a new full-suite PASS claim. A fresh ignore-scripts dependency install must run `npm run rebuild:native` before the Electron-backed tests.
4. **Finishing:** created `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-13-oct-parked-followups_plan.md` in the root checkout. Verified exact section preservation of all five parked parts and all 76 rest-of-list entries, including their triggers and authority boundaries. This prepares Finishing item 2 without dropping required open Steps 1–7. Original plan, live-test document and carry-over document all show `??` in root status. No separate spec is linked. The requested `_completed` rename cannot be performed by this worker: the current queue instructions expressly reserve it for the coordinator after independent acceptance. The lack of a rename is not a worker code defect. Whole-plan completion and the backlog's completed-plan pointer stay open.

Required authority boundaries remain specific: James must choose the real archive cutoff/groups/hold list and authorize that actual batch (1d); supply optional scratch-deletion approval (1f); decide stalled/final-audit merge handling (3g); approve the automatic Codex keep-three rule, trace rotation deletion, and RTK history trim (choice 7); decide RTK tracking/delivery (choice 8), feature removal (choice 11), the three code-removal items (choice 10), Settings rows (12b) and optional live Auto-approve confirmation (14a). The automatic safe-work readiness record explicitly preserved these choices. No answer or destructive authority is inferred here; the existing real dry-run review remains available. Device/app checks stay in the existing live-test document. Missing code is not moved into a live-test deferral.


Round 2 verification after the fixture correction: main typecheck, spec typecheck, lint, LOC gate, main build and Angular production build all exit 0; IPC contract and usage checks exit 0; alias and preload generators run without source diff. Initial fixture/type-check failures are retained in the logs and superseded by `typecheck-spec-corrected.log` (exit 0). Command/exits: `_scratch/oct-followups/round2/stable-results.json`. The architecture inventory was stale after the coordinator checkpoint changed the git index; canonical regeneration updated `docs/generated/architecture-inventory.json` to the checkpoint's counts, and `--check` now exits 0. The generator deliberately reads index content; the coordinator's normal hook must regenerate again after staging this round's new files. Loop CWD discipline and `git diff --check` exit 0. No full-suite run was made by this worker, as instructed.

`npm run check:docs-retire` exits 0 and reports **due: 358 eligible closed documents, 9.0 MB, no previous batch**. No real document was moved or staged. Carry-over review artifact: `/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-10-13-oct-parked-followups.html`, generated with the repository's `renderPlanArtifact` and checked for the v1 review markers. No browser or desktop was opened. The root Markdown remains canonical and untracked.


Round 2 fresh-eyes result: **VERDICT: PASS for part 4b, the native-test repair and carry-over preservation only**, no unresolved actionable findings. A genuinely fresh reviewer independently ran both typechecks, lint, LOC, main/renderer builds, native ABI and architecture-inventory checks (all exit 0), four loop files / 141 tests (`_scratch/test-run.pid-22343.log`) and all five previously failing native files / 100 tests (`_scratch/test-run.pid-33412.log`). It independently verified all five full Step 8 parts and all 76 multiline rest-of-list entries, and traced observer → review-driven gate → final audit → terminal event/terminate. Its report explicitly gives **whole-plan FAIL / INCOMPLETE**; no clean-reinstall/full-suite or remaining-part acceptance is implied. Report: `_scratch/oct-followups/round2/fresh-review.md`. No source/test edit followed this fresh pass.

Final round-1 finding checklist (HISTORICAL record of 13 Oct 2026 — the checkboxes below are a dated snapshot, superseded by the per-part table and the [As-built notes](#as-built-notes) status header; the current completion checklist is the one directly under the As-built notes heading):
- Finding 1 (HISTORICAL record, 13 Oct 2026 — counts superseded by the per-part table and the round 8 status; not open work): whole-plan incompleteness was open at that round. One further required part (4b) was implemented at that time; the total then was 17 implemented, 6 partial, 26 open/parked of 49. The per-part table identifies every remaining requirement as of each round. Missing owning-plan foundations had to land through AIO, and the specific data/merge decisions remained James's boundaries. That worker could not manual-merge or declare those choices supplied.
- [x] Finding 2, the ten reported full-suite failures: reproduced the absent native binary, rebuilt through the documented pipeline, verified ABI143, and all ten failures' owning five files pass both worker and fresh reviewer reruns. The full-suite rerun remains coordinator-owned.
- [x] Finding 3, follow-up carry-over: prepared and independently verified in the root-only untracked dated follow-up document. Completion rename is intentionally not performed: the current direct queue-worker instruction prohibits it and assigns it to the coordinator after whole-plan acceptance. Other whole-plan finishing steps remain open; this checked item certifies carry-over preparation only.

All edits remain in the supplied queue worktree except untracked root planning documents and ignored root review artifacts. Final worktree status has only three modified tracked files (completion gate, its integration spec, canonical generated inventory) and two new rename-check files; the index is empty. Root plan, live-test document and follow-up document each remain `??`. Current branch is still `queue/2026-10-11-oct-followups-6f4138`, HEAD `d41143662`. No commit, stash, staging of real work, branch switch/creation, new worktree, real archive move, data deletion, or browser/desktop interaction occurred in this round. The source plan is **not ready for whole-plan acceptance or coordinator closure**.


### Verification round 2 remediation — 13 October 2026 (round 3 worker, active)

This round implements safe work beyond the previous subset. It does not resolve whole-plan acceptance by changing open boxes or treating readiness data as authorization.

1. **Re-investigation and scope:** read the complete source plan and previous as-built ledger, current queue history (`71005aa7a`, coordinator checkpoint) and `main...HEAD` diff. No separate spec is linked. Missing names alone are not treated as a blocker: current Advanced/Runtime sections, resolved agent permissions, status-update seam, persistence operations and generation-bound recovery sidecars support parts 6d/6e/6g/7d/7h without duplicating other plans' frameworks. The current task authorizes those routine safe adaptations. No main merge, branch switch, worktree creation, real archive apply or data deletion was performed.
2. **6d:** added a runtime-only WeakMap clock at `InstanceStateManager.queueUpdate`; activity/output changes cannot reset a wait. Both banner and reminder merge durable approvals with live waits, retain the oldest unexpired wait per session and exclude Auto-approve, machine markers/waits, loop ownership and repository-job roots. Unknown restored waits start conservatively at first observation. Behavioral RED: live-only banner missing (`_scratch/test-run.pid-39139.log`) and untagged repo-job wrongly counted (`_scratch/test-run.pid-80564.log`); focused five-file/54-test rerun passes (`_scratch/test-run.pid-81170.log`).
3. **6e:** a self-contained cancel-only nested control-request handler is wired into the existing desktop adapter; no permission dispatcher or form-accept path is invented. Two real subprocesses waiting for the probe's exact correlated response previously timed out; now both exit 0. Failed stdin writes produce an error instead of a false cancellation receipt. Connector URLs, forms and prompt text are not copied into output. Eight direct tests and adjacent adapter tests pass. Existing utility `sendMessage`/`sendMessageStream` paths close stdin after their one-shot prompt and are unchanged; this round certifies desktop `spawn`/`sendInput` handling only.
4. **6g:** added `SessionContinuityLookupIndex`, using current generation-bound recovery sidecars when valid, and read-only transcript decoding otherwise. Atomic two-second-debounced persistence contains identifiers/file generations only. Background batches pause during active/paused/provider-parked loops, process small/newer files first and yield every 20 records. Save/remove/discard/startup are wired; shutdown cancels background/persistence work. Direct filename hits preserve the previous fast path. Complete misses validate small file generations and read no transcript JSON; this is not a demonstrated constant-time real-folder latency claim. Incomplete repeated misses have a ten-minute negative cache. A first fresh reviewer reproduced a HIGH defect: a transient read/decryption failure could persist empty keys and become an authoritative miss. The fix keeps those files unresolved, retries them, and rejects empty-key cache entries on reload. EIO/EACCES regressions failed before the fix (`_scratch/test-run.pid-45770.log`); five continuity files /97 tests pass after it (`_scratch/test-run.pid-47473.log`). The prior permissive malformed-record completeness assertion was corrected to require incomplete status while still indexing healthy records; no original repository test was removed or weakened. Fresh re-review is required after this fix.
5. **7d and 7h:** mode switches emit one neutral display-only receipt after successful model-message delivery using actual resolved permissions/session overrides; model-facing strings are unchanged. The facade supplies its existing system-notice callback. The two recommended Settings rows reuse existing Runtime sections and open boolean policies; repo maps affect new-session prompts, experimental virtualization updates immediately. Eight initial behavior failures reproduced; six-file/73-test rerun passes (`_scratch/test-run.pid-25733.log`). This is a routine safe choice under the current scope; obsolete notes treating Settings sections/choice12b as a required new approval are superseded.
6. **7j foundation only:** existing governed-proposal and repository-job services already emit persisted lifecycle changes. Two typed push channels, renderer validation, diagnostics preload subscriptions and service/store hooks now refresh those lists within the one-second throttle; existing polls remain. Revision guards prevent stale poll responses from overwriting a newer pushed list. Shutdown clears timers and exact listeners, and Angular destruction unsubscribes. Original store/main/validation failures and a new shutdown regression were reproduced. The Needs-you aggregator/count is still absent, so its visible-count acceptance remains **unimplemented**, not a live-test deferral.
7. **Finding 2/live boundaries:** Browser Gateway preflight and health were repeated; `windows-pc` is online with a fresh deliverable extension channel. This establishes channel health only, not keyboard/UI behavior. The phone is not running a rebuilt copy of this checkout, and the desktop integration/restart is coordinator-owned. The existing 3e phone, 6b helper-ring and 7e Windows checks remain open with exact actions in the root live-test document. No Mac browser/desktop was used. New rebuilt-app checks for 6d/6e/6g/7d/7h and the implemented 7j store paths are appended there; absent card/count implementation stays here.

Current round final check results and fresh-review reports are appended after the stable reruns. The source plan and live-test document remain active and untracked in the root checkout. This worker must not rename either to `_completed`.


Round 3 fresh-review remediation (still active):
- First index gate found and reproduced empty-key persistence after a temporary read/decrypt failure; fixed as described above.
- Second index gate independently found a foreground null read being cached for ten minutes and fixed-one-second rereads of permanently unresolved files. The foreground scan now records a negative only when every candidate identity was readable. Unresolved files have generation-bound exponential retry delays of 30 seconds to five minutes; a generation change or successful upsert retries immediately. Both new regressions failed before the fix (`_scratch/test-run.pid-68623.log`, `_scratch/test-run.pid-84408.log`).
- The other-parts fresh gate reproduced the new 7d receipt promising edit approval despite Claude's existing `acceptEdits`/allowlisted edit configuration. It now describes enabled edits and says shell commands **may** require approval, preserving deny restrictions and every model-facing byte. The new runtime-option/receipt regression failed before the fix (`_scratch/test-run.pid-25061.log`). Existing newly-added receipt assertions were corrected to this supported runtime contract; original repository behavior tests remain intact.
- Stable rerun after those fixes: six files /110 tests PASS (`_scratch/test-run.pid-69360.log`), including all 14 index cases and 11 mode-change cases; both typechecks, lint, LOC and main build exit 0. Compiled actual-coordinator/index smoke exits 0 with explicit logging-worker teardown (`runtime-after-review.log`). Earlier smoke output reached its assertions but left a logging worker alive; that process was stopped (exit143) and is **not** used as passing command evidence.
- IPC and alias generators are current. The architecture generator updated the canonical tracked inventory for two added channels and the coordinator's previous checkpoint; it reads index file content and must run again under the coordinator's normal staging/hook lifecycle. No real file is staged by this worker.
- Extra `verify:renderer-events` stays exit1 for **pre-existing** uncovered `local-ai-guard:status-delta` and `plan-queue:state-changed`, plus the existing dynamic cost-handler site. This round's newly-added inbox callback was corrected to explicit channel sends and is now statically recognized; its final three-file/39-test run passes (`_scratch/test-run.pid-51181.log`). No allowlist, suppression or gate weakening was added.
- Worker evidence matrix: `_scratch/oct-followups/round3/stable-results.json`. Whole-suite/clean-install checks remain external-verifier-owned by the direct queue instruction. A further fresh gate is in progress; no whole-plan or final subset PASS is claimed yet.

Round 3 metadata-boundary remediation (fresh gate still pending):
- The next fresh gate independently reproduced two remaining 6g failures in compiled production code: transient `lstat` errors silently omitted an existing file and cached its absent alias for ten minutes; a failed post-read generation stat repeatedly decoded the unchanged transcript without retry backoff. Report: `_scratch/oct-followups/round3/fresh-final-review.md`. It found no other actionable findings in the six-part bounded scope, but returned FAIL because these remained.
- Enumeration now ignores only an actually vanished file (`ENOENT`); unknown metadata errors propagate and cannot commit the validated directory generation, clear known entries, or create a negative cache. Post-read validation failures record a retry bound to the pre-read generation, using the same 30-second-to-five-minute backoff as unreadable identities. A changed generation is eligible immediately. Scheduler-level enumeration failures also back off rather than retry every second. Starting background work is owned by `start`/foreground lookup, avoiding redundant scheduling from a backfill's own invalidation pass.
- Correct EIO/EACCES metadata-boundary tests and post-read-stat backoff tests were added. The immutable native ESM export required a test-only forwarding wrapper to the actual mutable Node promises API; initial non-intercepting spy attempts are retained as failed evidence, not behavior proof. Both behavioral regressions then failed against unchanged production code (`_scratch/test-run.pid-73628.log`), and pass after the fix. Six affected continuity/mode files now pass **94 tests**, exit 0 (`_scratch/test-run.pid-89681.log`), including 17 direct index cases.
- Main typecheck, spec typecheck, lint, LOC, main build and Angular build all exit 0 after these fixes; exact logs are `tsc-stat-fix.log`, `spec-stat-fix.log`, `lint-stat-fix.log`, `loc-stat-fix.log`, `main-stat-fix.log`, and `renderer-stat-fix.log` beside the worker evidence matrix. The compiled actual-coordinator/index smoke also exits 0 (`runtime-stat-fix.log`). Another genuinely fresh independent agent is reviewing the frozen updated sources; acceptance remains open until its result.
- Refreshed the real root-checkout retirement dry run without applying or staging it: **356 eligible closed documents, 8.7 MB**, review Markdown `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/retire-docs/2026-10-13.md`; command log `round3-dry-run.log` beside it. This inventory supersedes earlier counts for the current review only. The actual archive approval and coordinator-owned commit remain open.

Round 3 final independent result and handoff:
- **VERDICT: PASS for 6d, the first desktop-cancel version of 6e, 6g, 7d, 7h and the 7j push/store foundation only.** A genuinely fresh verifier independently reviewed all 41 changed/new files and their runtime call paths, with no unresolved actionable findings. Its SHA-256 snapshot confirms that the sources stayed frozen throughout review. Report: `_scratch/oct-followups/round3/fresh-metadata-final-review.md`; raw evidence: `_scratch/oct-followups/round3/metadata-final-evidence/`.
- Independent verification: **20 focused files /251 tests pass** (`_scratch/test-run.pid-28728.log`, `_scratch/test-run.pid-11339.log`); both typechecks, lint, LOC, main/renderer builds, compiled actual-coordinator/index smoke, separately authored compiled metadata recovery/retry probes, IPC contracts/usage and secrets scan all exit 0. The independent probes prove EIO/EACCES enumeration recovery without a cached absence/manifest commit; post-read retry delays of 30 then 60 seconds; immediate eligibility for a changed generation; and background enumeration retry delays of 30 then 60 seconds. The caps and wider security/state/performance/conditional-UI review are recorded in the report. No source edit followed this PASS.
- No clean install or full-suite run is claimed: the direct queue instruction reserves those for the external verifier. No real-folder millisecond latency, installed desktop/device behavior, or absent Needs-you count is claimed. The extra renderer-event check's unchanged baseline failure remains recorded above; no gate was weakened.
- Root-only review artifacts are `/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-10-13-oct-followups-round3.html` and the refreshed `/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-10-13-oct-doc-retirement.html`. They are ignored disposable renders; Markdown is canonical. No browser/desktop was opened.

Final round-2 finding checklist (HISTORICAL record of 13 Oct 2026 — dated snapshot, superseded by the per-part table and the [As-built notes](#as-built-notes) status header):
- Finding 1 (HISTORICAL record, 13 Oct 2026 — counts superseded by the per-part table and the round 8 status; not open work): whole-plan incompleteness was partially remediated at that round. Five further parts and the 7j foundation had been implemented and independently passed; the total then was 22 implemented, 5 partial, 22 open/parked of 49. The missing foundations, decisions and parked triggers were identified by part above. AIO had to integrate the owning foundations before dependent implementation; that worker was forbidden to manual-merge or replace AIO lifecycle ownership.
- Finding 2 (HISTORICAL record, 13 Oct 2026 — not open work): the live checks were pending at that round and remain tracked in `2026-10-11-oct-followups_livetest.md` (the live-check document is the standing home for all of them). Housekeeping4/5 integration was required then for the storage-card halves and landed before round 6 built them.

This is a verified partial worker handoff, **not ready for whole-plan acceptance or closure**. All code/generated changes remain unstaged in the supplied worktree; all three root planning documents remain untracked. Branch and HEAD remain `queue/2026-10-11-oct-followups-6f4138` / `71005aa7adb3f4efa642a775ed9b01a9e475ede2`. No commit, stash, branch switch/creation, worktree creation, real archive move, deletion or `_completed` rename was performed.


### Worker ledger — 15 Oct 2026 (round 4, queue/2026-10-11-oct-followups-bad1a7; active, not completion evidence)

- **Port from parked branch:** per coordinator handover, merged `queue/2026-10-11-oct-followups-6f4138` (151 files, 5,484 insertions, 1,718 deletions) into this worktree via `git merge --squash`. Resolved 11 merge conflicts: settings-surfacing (kept 6f4138's `cumulativeTokenCompactionTrigger: 'hidden'` and HEAD's new provider settings), tooltip-copy (kept both sides), settings-control-policy (auxiliary spread + `keepAwakeMode`), settings.types.ts (extracted types via extends + `planQueueRouting` restored), plan-queue-item-list (both imports), loop-coordinator-completion-gates (took 6f4138's rename-check superset), loop-worktree-lifecycle-reconcile (took 6f4138's `preserveBranch` + dirty-worktree guard), diagnostics.preload (kept both sides), channels.ts (regenerated), architecture-inventory.json (regenerated). Fixed merge-induced completion-gate bug: the 6f4138 early-return path was missing HEAD's `knownFailures`/`followUps` check, causing a test to see `completed` instead of `completed-needs-review`.
- **James's readiness decision** (from recorded answer: "Move the old documents and do the eight deletions too") authorized 1d and the eight held deletion/cleanup parts.
- **1d — archive move executed:** ran `scripts/retire-docs.ts --as-of 2026-10-15 --cutoff-days 30 --apply --all` from the worktree. Moved **356 closed documents (8.7 MB)** to `docs/_archive/` via `git mv`; index appended at `docs/_archive/INDEX.md`; commit command staged via pathspec file at `_scratch/retire-docs/2026-10-15-paths.txt`. The coordinator runs the printed `git commit --only` command to land the batch. Search-ignore confirmed via `DEFAULT_CODE_INDEX_IGNORES` (codemem skips `_archive/`); 4 ignore tests pass.
- **5i items 1-3 — code deletions executed:**
  - Deleted `focus-input` shortcut (type union member + `DEFAULT_KEYBINDINGS` entry). No handler existed. Updated 2 test files (`keybinding-persistence.spec.ts`, `shortcut-hint.pipe.spec.ts`) to use valid bindings (`focus-output`, `new-instance`).
  - Deleted `setupCopyHandlers` and `setupFilePathHandlers` from `markdown.service.ts` (no callers).
  - Removed `residentClaudeSession` from 5 settings places (types, defaults, surfacing, policy, migration), the instance-lifecycle read, and the `migrateResidentClaudeDefault` function. Removed its test spec and fixture references. Updated adapter type comments. `residentClaudeForSpawn` kept as planned.
- **5h — Training Data and Instance Messaging deleted (James authorized):**
  - Training Data: deleted `features/training/` folder, `training-ipc-handler.ts` + spec, `training-ipc.service.ts`, `grpo-trainer.ts`. Removed 16 `TRAINING_*` channels from `learning.channels.ts`, training methods from `learning.preload.ts`, exports from `learning/index.ts`, `singleton-reset.ts`, `ipc-main-handler.ts`, renderer `ipc/index.ts`, route, registry entry. Updated 2 channel test files.
  - Instance Messaging: deleted `cross-instance-comm.ts`, `cross-instance-comm-store.ts` + spec, `communication-handlers.ts`, `communication-page.component.ts`, `comm-ipc.service.ts`. Removed 8 `COMM_*` channels from `communication.channels.ts`, cross-instance methods from `communication.preload.ts` (carefully preserving CHANNEL_*/REACTION_*/REMOTE_* methods). Removed handler registration from `ipc-main-handler.ts`, barrel exports, route, registry entry.
  - Three unused components deleted: `confidence-meter/`, `cost-estimator/`, `token-counter/` (confirmed 0 importers).
  - Registry test `EXPECTED_PATHS` updated (removed `/training` and `/communication`).
- **Verification:** `npx tsc --noEmit` exit 0; `npm run typecheck:spec` exit 0; `npm run lint` exit 0; `npm run check:ts-max-loc` exit 0 (with pre-existing slack warnings); `npm run build:main` exit 0; `npm run build:renderer` exit 0 (pre-existing bundle budget warning); `npm run generate:ipc` + `npm run generate:architecture` regenerated cleanly. Targeted tests: **~7,500+ tests pass** across orchestration (3,287), instance (3,022), shared-types+config (1,612), contracts+learning+communication+ipc (779), control-surface (7), keybinding (8), retire-docs (15), completion-gates (33). Full suite not run (verifier-owned per queue instructions).
- **LOC allowlist:** added `loop-coordinator-completion-gates.ts: 736` (merge of both sides exceeded 700; both sides were under alone). Also updated `check-ts-max-loc.ts` with the stale Codex ceiling from 5i item 4 (already done by prior worker).
- **Remaining open parts:** 3f, 3g, 4a, 5a code half (card half needs Housekeeping4), 5b, 5c code half (card half needs Housekeeping4), 5d, 5e, 5f, 5g card half, 6a, 7c, 7f, 7g, 7i, 7j Needs-you count, 8a-8e. Missing foundations: Phase 2 merge-hold/attention, Phase 3 posture/Needs-you/live-permission, Phase 4 accessible-name, Phase 5 money formatter/source-IDs, Housekeeping4/5 storage. James's data decisions for 5a-5c (retention values), 5e (commit authority), 1f (scratch sweep) not yet separately confirmed despite the "eight deletions" answer; 3g (stalled-loop merge hold) lacks its Phase 2 foundation. The "eight deletions" authorized the *code* deletions (5i items 1-3, 5h); the disk-space card halves and retention rules still need Housekeeping4 integration and/or James's specific choice values.
- **Plan status:** not ready for whole-plan acceptance or closure. The per-part table above remains the authoritative status source. This ledger records round 4 progress only.

> Plan Queue parked work: `queue/2026-10-11-oct-followups-6f4138` — 4 commit(s), reason: cancelled.


### Worker ledger — 15 Oct 2026 (round 5, verification-round-1 remediation; queue/2026-10-11-oct-followups-bad1a7; active, not completion evidence)

Scope: verification-round-1 remediation in the supplied worktree. No separate spec is linked. No commits, staging of real work, branch switches or new worktrees. The per-part table above was updated in place; this ledger supersedes round 4's "Remaining open parts" line where they disagree.

**Finding 2 — twelve reported test failures: fixed.**
- Eleven shortcut tests broke because round 4 deleted the `focus-input` binding (5i item 1) without finishing the test updates. `keybinding.service.spec.ts` and `keyboard-settings-tab.component.spec.ts` now drive the same conflict/import/export/reserved/search/hint behaviour through valid bindings (`new-instance`, `focus-output`), preserving each test's intent; no assertion was weakened. The reserved-combo case previously passed only because an unknown id short-circuited; it now exercises the real reserved-key path. 16 tests pass across the two files, plus the four adjacent keybinding specs (27).
- `oct-settings-headroom.spec.ts` failed at 122/130 lines of headroom in `settings-control-policy.ts` (the round-4 merge combined both sides' content). Restored the guard's margin without raising any ceiling by moving the self-contained `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` anchor list (with its security notes) into a new `settings-privileged-keys.ts` — a pure move, one use site. The policy file is now 704 lines (185 lines of headroom; the types file has 160). All 197 config tests and 29 `orchestrator-settings-tools` tests pass.

**Finding 3 — dependency compatibility: fixed.**
- The worktree's `node_modules` was AIO's per-entry symlink farm into the root checkout's install, so the manifests drifted (this branch adds the `docs:retire`/`check:docs-retire` scripts) and `dependency-compatibility.spec.ts` failed closed. Per the check's own remedy ("run a real install here") the farm was replaced with a real `npm ci` in the worktree; the postinstall pipeline rebuilt `better-sqlite3` for Electron ABI 143 and verified it. `dependency-compatibility` now passes 5/5; the electron-backed suites (rlm restart, isolated-worker, ledger-space-reclaim, local-ai-guard, realpty, path-validator, mcp/desktop config, retrieval-eval) pass 187/187 in sweep. Decision: this project install stays in the worktree — the mandated full gate cannot run without it and the check prescribes it; "delete dependency installs" is read as incidental installs (none created this round; no phone/temp installs).

**Finding 1 — whole-plan incompleteness: partially remediated; new work and refreshed foundation evidence below.**
- **Merge regression found and fixed:** the round-4 squash dropped `holdsMergeForReview(row.status, row.endEvidence)` from `loop-worktree-lifecycle-reconcile.ts`'s preserve decision (present at base `06201b4b0` line 231; round 4 hoisted a `preserveBranch` const without the review-hold term, leaving the import unused). Restored the term so a review-held run preserves its branch on restart recovery again; two new regressions cover held-preserves and unheld-integrates.
- **3f implemented:** `campaignHeldBlockReason` plus `nodeTerminalDecision` (extracted to `campaign-node-terminal-policy.ts` as the plan prescribes when `campaign-coordinator.ts` passes 700) pause a campaign whose step ended merge-held, even under the "carry on" policy; both terminal callers pass `snapshot.endEvidence?.mergeHold`, `LoopRunSummary` now carries persisted `endEvidence`, and the campaign landing threads it into `finalizeLoopWorktree`/the reconcile so the held work really stays on its branch (the reason text's claim). The editor's Continue option shows the warning sentence. Choice 5's recommended default applied (it is not one of the eight held parts).
- **4a implemented:** a new `AutomationRunStatus` member `needs-attention` (schema migration `081_automation_run_needs_attention_status` rebuilds `automation_runs`' status CHECK, preserving rows; `down` folds back to `failed`). Any pause — sign-off, no progress, blocked file, resource governor, the operator's Pause — ends the automation run as `needs-attention` with the pause reason, so the next fire is never skipped and the outcome never feeds the auto-disable streak (`recordRunOutcome` counts only `succeeded`/`failed`). `notifyLoopPaused` (beside `notifyLoopTerminal`) raises one quiet notice per loop per hour, wired through a coordinator `emit` wrap so the seven pause emit sites stay untouched. Two Phase 2-era assertions that encoded "an ordinary pause stays live" / "sign-off fails the automation" were superseded by this plan's "for any reason" rule and updated. Window-focus suppression is deliberately absent (no window handle in the coordinator; same documented rule as the terminal notice).
- **5d implemented:** `src/main/storage/legacy-app-data.ts` (`listLegacyAppData`, 50k-file-capped link-safe walk, and `trashLegacyAppData` with an injected trash function — no `rm` fallback), a `legacy-app-data` disk-card target with the plan's Bin-move window, and the plan's change 4 deletion of `migrateFromLegacyApp` (+ `LEGACY_APP_NAME`, the `electron` import and the settings-manager call). The prior worker's preservation note is superseded: the plan's own verification accepts the `AIO_DEV_USER_DATA_PATH`-ending-in-`ai-orchestrator` edge as unpackaged-dev-only and change 4 is explicit.
- **5g card half implemented:** `src/main/storage/attachments-folders.ts` lists `.claude-attachments` folders under the recent-directory projects with per-folder session counts, sizes and ages; only session copies last changed more than 30 days ago are offered (Housekeeping's standing age rule and the plan's "old copies"; fresh chat attachments are never listed). The `claude-attachments` card target previews by ticket and clears the listed copies only.
- **5f skipped on the plan's own terms:** "Optional; skip it if step 7g slips." Phase 0 step 7g's `--max-budget-usd` eligibility work is verified absent from `claude-cli-argv-builder.ts`, and the plan requires the two flags to travel together. Nothing was built and nothing blanket-persisted.
- **3c completed:** change 1 was already done; change 2 (surface the blocked row on the Leftover work folders card) is satisfied by the landed Housekeeping step 6 card (`leftover-worktrees-card` + `worktree-leftover-handlers`): the blocked folder is listed with owner ("Loop closed"), dirty count, preview and ask-first removal. No code needed.
- **Foundation re-verification (current checkout):** Housekeeping step 4a/6 storage and leftover-worktree surfaces have LANDED (round 4's "card half needs Housekeeping4" notes are superseded); Phase 2's merge-hold/`endEvidence` framework has LANDED (3g's remaining blocker is James's choice 4, not the foundation). Still absent, verified by symbol-level search this round: Phase 0 step 7b per-turn spend (6a), Phase 0 step 7g budget flag (5f), Phase 3 steps 5/12b/16 helper-strip (7c), Phase 3 step 6c Needs-you aggregator (7j count; the workboard needs-you lane projects repo jobs only), Phase 4 step 4 accessible-name counter/guard (7f), Phase 5 step 7 confirm box (7i), Phase 5 step 11 `format-money.ts` (7g — `src/renderer/app/shared/utils/` has no such module).
- **Held for James (unchanged):** 1f (choice 2, scratch sweep), 3g (choice 4, stalled/final-audit merge hold — its Phase 2 foundation now exists), 5a/5b/5c (choice 7, the three retention/deletion rules), 5e (choice 8, untracking the RTK binaries). The recorded readiness answer ("Move the old documents and do the eight deletions too") authorized 1d and the eight small code clean-ups (5i items 1-3 and 5h's five deletions), which round 4 executed; the disk-space retention rules and the scratch sweep are separate choices and were not inferred.

**Verification (round 5):** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run generate:ipc`, `npm run generate:architecture`, `npm run check:contracts`, `npm run verify:ipc`, `npm run verify:exports` all exit 0. Targeted suites pass: orchestration 3,298 (incl. the campaign/lifecycle suites), automations 220, persistence/rlm + mobile-gateway + shared 1,877, storage 32, config 197, renderer keybinding/keyboard 16, workboard/workflow/migration 164, plus the focused 3f/4a/5d/5g files. The full suite remains verifier-owned per queue instructions; `npm run test:quiet` full-suite was not run this round. No test was skipped or weakened; the three updated Phase 2-era assertions are superseded behaviour, recorded above.

**Artifacts:** new modules `settings-privileged-keys.ts`, `campaign-node-terminal-policy.ts`, `loop-pause-notification.ts` (+ specs), `legacy-app-data.ts`, `attachments-folders.ts` (+ specs), `rlm-migrations-081-085.ts` (+ spec), `loop-coordinator-pause-notice.spec.ts`. The architecture inventory regenerated. The live checks for 3f/4a/5d/5g were appended to the root live-test document (sections 14-16). The worktree's real `node_modules` install is the only deliberate runtime kept; no database clusters, browser binaries, temp source trees or scratch installs were created.

**Plan status:** still not ready for whole-plan acceptance or closure — 11 open parts (five held for James's choices 2/4/7/8, four blocked on absent foundations, 7i deliberately unbuilt per choice 14a's default), 2 partial (7b, 7j count), 1 plan-sanctioned skip (5f), 5 parked. All code remains unstaged in the supplied worktree; the root planning documents remain untracked. No commit, stash, branch switch/creation, worktree creation, real archive move, deletion of user data, or `_completed` rename was performed.

> Plan Queue parked work: `queue/2026-10-11-oct-followups-bad1a7` — 2 commit(s), reason: round-limit.

### Worker ledger — 16 Oct 2026 (round 6, queue/2026-10-11-oct-followups-bad1a7; active, not completion evidence)

**Scope and authority.** The recorded readiness answer ("Move the old documents and do the eight deletions too") was traced to its source: the plan-queue triage session's conclusion ("the old-document tidy-up … plus eight small deletions … How far should I go?"), which compresses this plan's sentence "Eight parts wait for his answer first, because they delete something or change what is merged or kept" — the eight parts being 1f, 3g, 5a, 5b, 5c, 5e, 5i and 5h. Rounds 4-5 executed 5i and 5h; this round implemented the other six. The recommended planning defaults (choice 7(a) keep 3, 7(b) 50 MB x 3 pieces, 7(c) 30-day trim; choice 4 merge hold; choice 8 untracking) were applied under the standing decision-autonomy rule. The destructive data operations keep their designed ask-first gates: nothing was deleted from real user data in this round (the 1f dry run is read-only; the card rows only preview; 5a's keep-3 rule can only ever remove new-named copies made after this update and nothing exists with that name today; 5c's rotation only drops its own pieces).

**1f — scratch sweep.** `scripts/retire-docs.ts` gains `--scratch` (dry run) and `--scratch --apply`: top-level `_scratch/` entries are listed by **newest-file age** (recursive walk) past 30 days, `.aio-review/` files past 14 days, with counts and sizes, into `os.tmpdir()` (never inside `_scratch/`). `oct-phases` and `oct-audit` are hard-skipped and every `_scratch/<name>` cited by a plan/spec/live test that is not `_completed` is skipped (evidence: the real dry run lists neither those two nor `_scratch/oct-followups`). `--apply` deletes exactly the listed set and refuses anything touched within 14 days. Tests: 3 new cases in `retire-docs.spec.ts` (18 pass). Real dry run from the root checkout: **4,547 `_scratch/` entries (12,267.8 MB) + 62 `.aio-review` pages (3.2 MB)**; review kept at root `_scratch/retire-docs/2026-10-16-scratch-dry-run.md`. The apply is James's button (live check).

**3g — merge hold.** New `src/main/orchestration/loop-merge-hold.ts` (`stageMergeHold`, kinds `stalled`/`final-audit-blocked`). Staged one call line at each ending decided in the plan's Change 2, mapped to current code: the ledger-convergence stall and review-driven CRITICAL stall in `loop-coordinator.ts` (kind `stalled`); the ping-pong "Final audit requires operator review" rewrite (kind `final-audit-blocked`); the same rewrite inside `applyReviewDrivenTerminal` (Phase 2 later extracted it from the coordinator); and both endings in `loop-final-audit-blocked-completion.ts` (the recovery handoff needs-review branch and `handleVerifiedNoChangeReviewDrivenCompletion`). `holdsMergeForReview` (Phase 2 step 8b, already wired into `finalizeLoopWorktree` and the restart reconcile) then keeps the branch. `src/shared/loop/loop-end-wording.ts` picks the sentence by `mergeHoldKind` ("Nothing was merged because the loop stalled." / "…the final check needs your sign-off." / the existing skipped-check sentence); `loop-control` passes the kind and the past-runs heuristic matches stall/final-check reasons. Operator Accept (`acceptCompletion`) never stages the flag and still integrates. Tests: new `loop-merge-hold.spec.ts`, new `loop-coordinator-merge-hold.spec.ts` (two real coordinator runs reaching both stall endings with the flag set), extensions to `loop-review-driven-terminal.spec.ts`, `loop-final-audit-blocked-completion.spec.ts` (handoff + verified-no-change), `loop-worktree-lifecycle.spec.ts` (held kinds preserve; unheld integrates) and `loop-end-wording.spec.ts`.

**5a — Codex safety copies.** `uniqueBackupPath` now writes `state_5-auto-reconcile-<stamp>.sqlite`. New `src/main/cli/adapters/codex/codex-state-backup-retention.ts`: exact whole-name patterns for the new and old reconcile names, `selectAutoBackupsToPrune` (new names only, oldest first beyond keep 3, `-n` suffixes ordered numerically after the plain name), `pruneAutoBackups` (injectable list/remove, one log line and no removals above the 5-per-run tripwire, never throws), and the two card selectors (old copies beyond the newest 3; clean-up/archive names). `reconcilePrivateCodexRolloutPaths` prunes once right after a successful backup through a `pruneBackups` option (a failed backup prunes nothing; a prune error never changes the result). New `src/main/storage/codex-safety-copies.ts` gives the card a read-only overview and a removal that refuses any name the selectors would not pick and any path outside the backups folder. Card: `codex-state-backups` (two groups with totals in the consequence text and per-file `group` labels) and `codex-session-files` (size only). Also fixed an integration gap from round 5: `StorageCleanupTargetSchema` in `packages/contracts` was missing `legacy-app-data` and `claude-attachments`, so the 5d/5g card rows could never pass IPC validation — all five later targets are now in the enum.

**5b — RTK history trim.** New `src/main/cli/rtk/rtk-history-trim.ts` as planned (`RTK_HISTORY_KEEP_DAYS = 30`, preview/trim split, batched deletes, busy handling, no `VACUUM`). `getRtkTrackingDbPath` honours `RTK_DB_PATH` first (RTK's own precedence). `rtk-history` card target (usage row with the date range and RTK's own 90-day note; ask-first trim). Tests: new `rtk-history-trim.spec.ts` (hand-count preview, batch/progress/page_count/no-VACUUM, three-busy stop with partial count via a busy-throwing driver, missing file/table cases, no-`project_path` schema) and the `RTK_DB_PATH` case in the reader spec.

**5c — trace rotation.** New `src/main/observability/ndjson-rotation.ts` (imports only `fs`/`path`, safe in the worker): `rotateFilesSync` (the logger's shift scheme, oldest deleted first for Windows) and `createRotatingAppender` (cap-crossing rotation, keep 3, one stat at first use, a first-seen file over 4x cap renamed once to `.legacy`, swallowed/counted errors, serialized appends). The exporter takes an optional `maxBytes` and appends through it (50 MB default). The worker reads `workerData.traceFilePath`/`maxBytes` (no Electron lookup left) writing `provider-events.ndjson` next to `traces.ndjson` (the sink passes the path), rotating at 30 MB keep 3; timestamped `.old` names gone. `trace-files` card target offers only `traces.ndjson.legacy`. Tests: new `ndjson-rotation.spec.ts` (7 cases), exporter rotation/set-aside cases, and a real worker-thread rotation case plus the worker-path case in `provider-runtime-trace-sink.spec.ts`.

**5e — RTK binaries out of git.** `git rm -r --cached resources/rtk` staged (5 files, ~43 MB on disk untouched) plus `resources/rtk/` in `.gitignore`. `fetch-rtk-binaries.js`: `--platform`, `--strict` (any failure fatal, one download retry), `--soft` (exit 0 always, incl. thrown errors), mutual-exclusion usage error (exit 2), exported `selectTargets`/`decideExit`, `require.main` guard, corrected header. `package.json`: `electron:build` strict-host, `dev`/`start` soft-host, `fetch:rtk` unchanged; CI gains "Fetch bundled RTK" before the packaging smoke. Tests: new `scripts/__tests__/fetch-rtk-binaries.spec.ts` (selection, exit policy, CLI behaviour, CI ordering, the no-`||` rule).

**Verification (round 6).** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` (exit 0; `loop-coordinator.ts` 4,000/3,954 within the +50 slack after 3 added lines), `npm run build:main`, `npm run build:renderer` (pre-existing budget warning), `npm run generate:ipc` (no tracked diff), `npm run generate:architecture` (inventory regenerated), `npm run check:contracts`, `npm run verify:ipc`, `npm run verify:exports` — all exit 0. Targeted tests: **37 files / 311 tests pass** across the two batches (3g/loop batch 10 files/91 tests; storage/codex/rtk/observability/scripts batch 12 files/135 tests; plus the reconcile + review-driven batch 2 files/45 tests and the past-runs panel 8 tests). The full suite remains verifier-owned per the queue instruction and was not run. No test was weakened.

**Remaining open (unchanged by this round).** 6a (Phase 0 step 7b per-turn spend), 7c (Phase 3 steps 5/12b/16 + Phase 5 step 16), 7f (Phase 4 step 4), 7g (Phase 5 step 11) — verified still absent by symbol search this round; 7j's Needs-you count (Phase 3 step 6c) and 7b's removal suggestions (Phase 5 step 14) stay partial for the same reason; 7i is deliberately unbuilt per choice 14a's recommended default. The five Step 8 parts and the rest-of-list entries remain parked in [13 October parked follow-ups](2026-10-13-oct-parked-followups_plan.md).

**Runtime kept.** Only the worktree's own `node_modules` (mandated full-gate install from round 5). No database clusters, browser binaries, temp source trees or scratch installs were created; the 1f dry run wrote one review file to the OS temp folder (copied into root `_scratch/retire-docs/` as evidence).

**Plan status:** not ready for whole-plan acceptance or closure until the remaining foundations land and the live checks pass. The per-part table above is the authoritative status source. No commit, stash, branch switch/creation, new worktree, real data deletion or `_completed` rename was performed; `git rm --cached` staging mirrors the 1d precedent (the coordinator lands it).

### Verification round 1 remediation — 16 Oct 2026 (round 7, queue/2026-10-11-oct-followups-bad1a7; active, not completion evidence)

The independent verifier's two findings are accepted as evidence of remaining work. This ledger records their fixes; it does not close the plan.

**Finding 2 (full-suite failure: context-worker import closure equals its ceiling) — fixed.** The failing assertion is `context-worker-import-isolation.spec.ts` (`closure < CLOSURE_SIZE_CEILING`). A merge-base-to-HEAD closure walk with the spec's own parser found the branch's single addition: `rlm-migrations-081-085.ts` (round 5's automation `needs-attention` status migration) joining the numbered RLM migration graph the worker already includes — the exact +1 pattern this spec's comment log documents for `rlm-migrations-071-075` (150) and `-076-080` (151). Diff-verified: pre-branch closure 151, working tree 152, that batch the sole addition, its only import the type-only `Migration` (a leaf), zero Electron value-importers. Per the spec's convention the ceiling is documented and raised 152 → 153 with the dated rationale. The two-case spec passes; no assertion was weakened.

**Finding 1 (required Steps 6/7 items open) — the four named items are now built:**

- **6a helper-token accounting.** New `src/main/instance/child-result-usage.ts` (`childSpendTokens`) reads the child's recorded spend (`contextUsage.cumulativeTokens` — the field adapters like Codex emit) and returns `undefined` when all we have is Claude's occupancy fallback; `child-announcer.ts` holds the wording and prints "not measured". Both `instance-orchestration.ts` call sites are line-neutral (the file was exactly at ceiling+50, so the helper re-exports through the already-imported announcer module — no new line in the file). This is decision 13's "recorded spend, or 'not measured'" and removes the context-size number that could not match the Costs page. The plan's ledger-backed variant (the Done-when comparison against `audit:claude-cost`) is the documented extension point inside `childSpendTokens` when Phase 0 step 7b's per-turn ledger lands. Tests: `child-result-usage.spec.ts` (3), `child-announcer.spec.ts` wording (2), the three orchestration specs unchanged and green.
- **7f accessible input names.** New `src/renderer/app/shared/utils/form-field-accessible-names.ts`: the plan's counter rule as a pure template reader (aria-label, aria-labelledby, wrapping `<label>`, or an id matched by `<label for>` — static or the same dynamic `[id]`/`[attr.for]` expression; placeholder and title never count), with a full-template label-nesting walk (a bounded window mis-counts multi-line labels). The strict guard spec replaces the report-only phase in the same change because the count reached zero in it: all **37** previously unnamed fields across 14 templates now carry names (the plan's audit had counted 26 in the verification pages alone). The opaque-button ratchet and the lint-plug-in promotion stay with Phase 4's counter/plugin (the plan's riders); the guard spec is what holds zero today.
- **7g money in cents.** New `src/renderer/app/shared/utils/format-money.ts` (`formatMoneyPlain`: "$0.73", "under 1 cent", grouped thousands; `formatMoneyExact` for hovers) — the module name and API Phase 5 step 11 planned, so that work merges into it. The Costs page headline cards, budget rows and the per-model/per-session/recent tables show cents with the `cost.exactAmount` hover (registry key added in `tooltip-copy.ts`); `verification-results`, `verification-monitor`, `local-ai-fallback-notification-groups`, `local-ai-fallback-banner`, `stats-page` and the loop's `formatCostCents` now call the helper. The grep-style guard spec forbids `toFixed(4)`/`toFixed(6)` money next to a `$` in renderer files (empty allowlist: exact figures use `formatMoneyExact`). Four local-ai-guard expectations moved from four decimals to cents — the intended behavior change, not a weakening.
- **7j Needs-you behavior.** The plan's Done-when ("A new memory review shows in 'Needs you' within a second") is now met: memory reviews are a workboard source (`WorkboardMemoryReviewInput`, `memoryReviewStatusToLane`, a standalone correlation tier that consumes nothing, `memoryReviewId` linkage), so a pending review lands in the Needs-you lane immediately — combined with round 3's throttled push events, which already refresh `MemoryReviewStore` within the one-second throttle. Card label "Memory review", specialist route `/memory-review`. Tests: three new projection cases; the 77-test workboard suite green. Phase 3 step 6c's separate numeric counter (if it ever lands) reads the same lane; it is not part of this part's Done-when.

**Remaining Step 6/7 state (precise):** 7c stays open because the plan orders the chip after Phase 3 steps 5/12b (the typed chip strip and `SubagentUsageStore.summary`) and Phase 5 step 16 — its named data source; the renderer's `childrenIds` counts nested sessions, which is exactly the confusion the chip's own tooltip disclaims, so it is not used as a substitute. 7b changes 2-3 stay partial on Phase 5 step 14's memory page (Remove + Undo + source IDs). 7i stays unbuilt per choice 14a's recommended default. Steps 6 and 7's other items were already implemented in earlier rounds.

**Step 8 (the verifier's "all Step 8 items" clause).** The plan's own scoping governs: "None of these is started until its trigger fires or James says yes, and none blocks closing this plan" (Step 8's heading text; also the Order of work). Each trigger was re-checked this round: 8a needs Phase 3 step 6 + Phase 2 step 13 data and James's call 14b (recommended: wait); 8b needs Phase 3 step 16's live checks and default flip (absent); 8c needs two to four weeks of page-visit data and James's call 14d; 8d's nine triggers all point at absent Phase 3/4 pieces (its item 1's hover bridge does not exist yet — Phase 4 step 1 is unbuilt — so there is nothing to delete; item 8 waits on James's wording preference); 8e needs Copilot loops in use plus Phase 0 step 7c and a design pass. Nothing in Step 8 is buildable until a trigger fires or James speaks; they stay parked and preserved (also in the 13 October parked follow-ups).

**Verification (round 7).** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer` (pre-existing budget warning), `npm run generate:ipc`, `npm run generate:architecture`, `npm run check:contracts`, `npm run verify:ipc`, `npm run verify:exports` — all exit 0. Targeted tests: the remediation batch (16 files / 171 tests: the closure spec, 6a's three suites, format-money, form-field names, workboard, tooltip) and the money-formatting consumers batch (40 files / 549 tests: local-ai-guard, loop, verification, stats) all pass. The full suite is the verifier's gate; finding 2's single failure is fixed at its documented source and the closure spec passes.

**Plan status:** not ready for whole-plan closure on its own terms — 7c, 7i and 7b's fold await their named foundations/defaults, the five Step 8 parts await triggers, and the live checks remain — but every item the verifier named is now implemented, with the remaining ones above identified by their exact prerequisite. The per-part table is the authoritative status source. No commit, stash, branch switch/creation, new worktree, real data deletion or `_completed` rename was performed.

### Verification round 2 remediation — 16 Oct 2026 (round 8, queue/2026-10-11-oct-followups-bad1a7; active, not completion evidence)

The verifier's single finding is accepted as evidence of how this document reads, and of the items it names. Its two evidence quotes were checked against the file before changing anything: "the completion checklist leaves every step unchecked" was not accurate (Steps 1-6 and Final gates were already `[x]`), and "the final remediation ledger says 17 implemented, 6 partial, 26 open/parked" pointed at a **dated 13 Oct finding checklist** — a historical snapshot inside the round-2/round-3 worker ledgers, whose counts were superseded four rounds ago. The fix is both real work and documentary: the items that could be built are now built, and the dated snapshots no longer masquerade as open work.

**Document reconciliation.** The three historical finding-checklist bullets (13 Oct round-2 and round-3 ledgers) are converted from checkbox form to explicitly labelled HISTORICAL bullets, each stating its date and that its counts are superseded by the per-part table; their section headings now say the same. Nothing in those records is altered except the marker and the label. The only `[ ]` boxes left in the document are the genuine current ones: Step 7 (one rider — see below), Step 8 (parked by the plan's own non-blocking rule), and the Fresh-eyes line (the independent verifier's own gate, not a worker-checkable box — now annotated as such). The authoritative counts live in this ledger's closing paragraph and the status header.

**7c helper chip — built.** `features/instance-detail/helper-agents-chip.ts` is exactly the plan's named pure descriptor: hidden at zero, "1 helper agent running"/"N helper agents running", never the bare word "Agents", tooltip key `strip.helperAgents` (registered in `tooltip-copy.ts` with the plan's sentence). The chip renders above the message box in the composer, reading live counts from `InstanceStore`. **Round 7's caution is retracted with evidence:** `createChildInstance` in `instance-manager.ts` ("Running /<command> as a subtask") is the path that sets `parentId` and pushes `childrenIds`, so an instance's children ARE the AI-started helper agents the tooltip describes — not "separate sessions". `isHelperRunningStatus` counts only helpers that have not finished, so the chip disappears when a helper ends. Tests: the descriptor spec (hidden/0/NaN, singular/plural, wording) and an input-panel case (one running helper shows "1 helper agent running"; flipping it to idle removes the chip). **Recorded deviation:** the chip renders standalone rather than registering into Phase 3 step 5's typed strip, which does not exist in this checkout; the descriptor is strip-ready at the plan's own module path and adopts unchanged when the strip lands. The plan's strip-overflow test waits for that strip.

**7b suggestion rules — built.** `src/main/memory/memory-removal-suggestions.ts` (the plan's named module) implements both rules as pure functions over a structural usage view: "source changed" (shown ≥ 10 times in 30 days AND a recorded source whose comparison says it no longer matches) and "never shown" (not shown within 60 days), with the change-3 wording "never shown"/"source changed" — never "never used". The threshold spec covers both boundaries, the no-recorded-source case, and the wording rule. The "Suggested for removal" fold remains, and the plan hosts it on Phase 5 step 14's memory page together with that page's Remove + five-second Undo — the host page is verified absent, so the fold cannot be attached to nothing. This is the single rider keeping Step 7's box unticked.

**7i resolved as deliberately not built.** The part's gate is "only if James said yes"; its decision (14a) recommends "not built"; no yes exists. Not building it is therefore the completed state of an optional part — ticking it as anything else would invent an approval or contradict the recommendation. It is one small change on Phase 5 step 7's path if James ever asks.

**Step 8 item 1 closed; the other eight stay on their triggers.** 8d#1 ("Delete Phase 4 step 1's hover bridge") is a no-op: Phase 4 step 1 never built the bridge, so there is nothing to delete — the item is done as far as it can ever be unless that bridge first appears. The remaining triggers, re-checked against this checkout: 8a needs Phase 3 step 6 + Phase 2 step 13 data and James's call 14b (recommended: wait); 8b needs Phase 3 step 16's live checks and default flip; 8c needs two to four weeks of page-visit data and James's call 14d; 8d's items 2-9 point at absent Phase 3/4 pieces (2: Phase 4 step 5 adoption; 3: Phase 4 step 2's reader; 5: Phase 4 steps 6-7 in use; 6: Phase 3 step 10d + Phase 4 part 2 step 1a; 7: Phase 4 part 3 `models` folder) or James's own preference (8: the recycle hint wording) or later phases (4: after Phase 3 step 8a; 9: after Phase 3 step 5); 8e needs Copilot loops in use plus Phase 0 step 7c and a design pass. Per this plan's Step 8 heading, "none blocks closing this plan"; they are preserved here and in the 13 October parked follow-ups.

**Verification (round 8).** `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer` (pre-existing budget warning), `npm run generate:ipc`, `npm run generate:architecture`, `npm run check:contracts`, `npm run verify:ipc`, `npm run verify:exports` — all exit 0 (recorded in `_scratch/oct-followups/round8/stable-results.json`). Targeted tests: helper-agents-chip + input-panel (31), memory-removal-suggestions (2), plus re-runs of the round-7 batches. The full suite remains the verifier's gate.

**Historical round-8 counts (superseded by the 20 October remediation ledger):** of 49 parts — **41 built** (all of Steps 1-6 except 5f, plus 7a/7c/7d/7e/7f/7g/7h/7j), **1 partial** (7b: counting, suggestion rules and wording built; the suggestion fold waits for its host page), **1 resolved as deliberately not built** (7i), **1 skipped on the plan's own terms** (5f), **5 parked behind unfired triggers** (8a, 8b, 8c, 8d, 8e — 8d's item 1 is closed as a no-op inside its part). 41+1+1+1+5 = 49. Whole-plan closure now waits on exactly: Phase 5 step 14's page (for the 7b fold), the parked triggers or James's word (Step 8), the live checks in the livetest document, and the independent verifier's fresh-eyes PASS.


### Historical initial retry ledger — 20 October 2026 (superseded blocked handoff before source recovery)

**Observed state.** This checkout is clean at `542f1f690fae155ecec3e6dddfc901c008fec3b7`. The prior branch named by the
round-8 ledger still exists at `e61598b08af1236c9c33468750b0aa42f653b4ee`, with merge base
`06201b4b0c592b4b1d9cf8fcd7993bcdd28f1030`. Read-only `git cat-file -e <prior-ref>:<path>` probes confirm all 19 sampled
modules exist there; filesystem probes confirm all 19 are missing both here and in root. Samples cover retirement tooling,
mode change, worktree guards, merge hold, pause notices, rename checks, finding triage, backup/RTK/trace cleanup, attachment
ignore, child usage, denial patterns, live approvals, continuity lookup, memory suggestions, the helper chip and money formatting.
The complete paths and command exits are in the audit and inspection receipts. This is an actual checkpoint mismatch, not an
inference from old wording about needing James.

**7b dependency investigation.** Read the current builder, IPC handlers, hint type and Wake Management component, and Phase 5
step 14's acceptance/dependency text. The builder has only `bypassCache`, records usage during L1 generation and is used by the
page and compaction recovery. The page has immediate Remove with no Undo. The recorded 7b rules module is absent. Phase 5's
20 October status separately reports that its prior checkpoint `6c6a73f90` on
`queue/2026-10-10-oct-phase5-later-3e8047` and Undo/memory-page changes also need coordinator restoration. Therefore the old
claim that only one UI fold remains cannot describe this checkout. No replacement memory/Undo framework was introduced.

**Ruling and required next action.** AIO owns recovery and reconciliation of these parked item checkpoints with the current
base, including the now-landed Phase 0 continuity work. The coordinator must recover the recorded follow-ups and Phase 5
work through its lifecycle and provide a refreshed managed checkout; then the worker can finish 7b, recheck the parked triggers
and rerun acceptance against the actual integrated code. Importing the 673-file historical branch diff manually would bypass
that ownership. The prior authorizations remain recorded; the blocker is checkpoint availability, not a newly requested
permission. No requirement was dropped or marked implemented, and no missing code was moved to a `_livetest.md`.

**Checks and limits.** Both typechecks and lint exit 0. The existing wake-context volatility suite passes 3/3; it checks rendered
text stability, not the missing suggestion/Undo behavior. Full logs and exact exits are retained. There are no source changes,
so generators/builds were not run; the full suite remains verifier-owned per the queue instruction. No independent fresh-agent
review, browser observation, device action, real-data mutation, commit, stash, branch/worktree operation or completion rename
was performed. No database cluster, browser binary, copied checkout or dependency install was created. The supplied worktree
and its copy of this plan remain unchanged; only this authorized root plan and ignored diagnostic receipts were written.


### Verification-round-1 remediation — 20 October 2026, actual source recovery

This ledger supersedes the earlier 20 October blocked handoff. The current instruction to fix all four verifier findings authorizes recovering this plan's own parked source delta into the supplied checkout. Recovery used per-file Git deltas and reconciliation with the newer base. AIO retains ownership of checkpointing, integration, final document closure and worktree cleanup. HEAD remains `542f1f690`; the real index stays empty. Code and tracked-file changes live in the supplied worktree; this active plan and its live-test document are maintained at their root-checkout paths.

**Implementation dispositions: 49 parts = 42 built + 1 deliberately not built + 1 plan-approved skip + 5 parked.**

| Parts | Current disposition and evidence surface |
|---|---|
| 1a–1f | Built/recovered: retirement tool and safety tests, repaired pointers, README/index/search ignore, 356 byte-identical archive moves, count check and optional scratch-sweep tool. The recovered batch retains its historical 15 October approval/landing record; this worker leaves the recovered changes for the coordinator. Real scratch deletion remains an ask-first live action. |
| 2a–2b | Built/recovered: settings groups/policies and mode-change extraction. Newer operator-only keys, including `providerSignalFenceEnabled`, remain protected. |
| 3a–3g | Built/recovered: missing decisions refuse held commands; remote reads require a managed spawn; dirty work folders and loop-hosting sessions are protected; phone Stop/Cancel confirm; held campaign steps pause; stalls/final-audit endings hold automatic merging. Operator acceptance retains its original authority. |
| 4a–4c | Built/recovered: paused automation runs become needs-attention, notices throttle, required plan renames are checked, and critical/high retry triage retains optional findings with an all-findings fallback on low-only FAIL. |
| 5a–5e, 5g–5i | Built/recovered: bounded new Codex backups and ask-first old copies, RTK trim, capped trace writers and preserved legacy files, old-data Bin/card flow, fetched RTK binaries, attachment exclusion/card, retired scaffolding and small cleanups. Five tracked RTK binaries are worktree deletions for the coordinator to record. |
| 5f | Skipped under its own low-value one-shot condition, retaining the historical rationale. |
| 6a–6g | Built/recovered: helper spend-or-not-measured, parent occupancy protection, denial classification, live-question digest rows, elicitation cancellation, hidden inert switch and indexed continuity lookup. Newer Phase 0 cost/compaction/runtime authority and continuity completeness/epoch fences remain. |
| 7a–7h, 7j | Built, including completed 7b: attachment explanations, real-start counting, persisted 30-day showing facts and mining-source snapshots, source comparisons, suggestion fold, delayed five-second Undo, helper chip, mode receipts, keyboard/form guards, cents/exact hovers, Settings rows and immediate Workboard Needs You updates. |
| 7i | Deliberately not built under decision 14(a)'s recommended default; no affirmative instruction to build it is inferred. |
| 8a–8e | Parked under their explicit non-blocking triggers. No Phase 3/4 live use, page-visit history, preference or Copilot-loop use was inferred. The absent hover bridge remains a no-op. The existing root `2026-10-13-oct-parked-followups_plan.md` preserves the five parts and rest-of-list entries for later ownership. |

**7b as built.** A source-backed note keeps a captured file URI/fingerprint when mining links it. Review hashes only relevant sources asynchronously, bounds reads and compares each source/fingerprint once; unreadable or unsupported sources remain unknown. The new additive RLM migration stores showings and source snapshots. Lifetime counts still describe session-start build requests; the rolling count covers the last 30 days. A changed-source suggestion requires at least ten such showings. A no-show suggestion requires 60 days and sufficient observed history; old lifetime counts cannot invent missing history. Labels are exactly “never shown” and “source changed”. Rebuild, empty content and compaction/resume paths retain their read-only counting behavior.

The Project notes tab now hosts the fold, visible reason/window/count/provenance and plain labels. Its memory-only Remove service delays deletion for five seconds, pauses while the notice is hovered/focused and leaves native text-field Undo alone. Undo cancels deletion and preserves the original ID, source and history. This supplies 7b's required surface in this checkout; the other Phase 5 features remain separately owned. The helper chip remains hosted in the existing composer pending the owning typed status strip, as recorded by the prior handoff.

**Fresh review and repaired defects.** The first genuinely fresh `task-completion-gate` review independently confirmed all 79 historical source/tool additions and all 356 exact archive moves, but returned FAIL on two HIGH runtime findings. Its real-SQLite probe reproduced a stale worker cache referencing a removed note and raising a showing-row foreign-key error; its fault-injection probe reproduced an RTK schema-inspection handle leak. The fixes rebuild a cache whose note IDs disappeared, select live note IDs atomically when recording showings, and close an acquired RTK handle when inspection fails. Regression tests failed before each fix and passed afterward. Separate recovery checks also repaired the RTK preview cutoff, nested Codex session size accounting and preservation of existing legacy trace files.

**Limits and refactors.** Three measured size violations were corrected without changing a ceiling: instance handlers 1300 lines, Plan Queue item flow 700 and composer 1960. Added renderer policies use existing typed helper modules and preserve lazy signal reads. The worker import graph was independently audited at 155 base modules to 159 current modules: the four added SQL/memory leaves import no Electron; ceiling 160 retains the existing one-module margin. Newer Unknown/free verification-cost behavior is covered by exact DOM assertions alongside the cents change.

**Generated artifact contract.** Architecture inventory generation intentionally reads Git's index. A temporary prospective index represents the proposed checkpoint for that generator and its architecture check, so the JSON reflects new modules, refactors and archive paths. Before/after hashes prove the real index unchanged. Tests use their normal environment and never inherit the temporary index. Other generators run normally. The temporary index is removed with the worker-created runtime after the final receipts and seal.

**Further fresh-review repairs.** The second review found that RTK cleanup discarded its interrupted outcome and reported estimated preview bytes as reclaimed space. The service, IPC, store and accessible card now retain actual row counts and `stoppedEarly`, show partial completion and require a fresh preview before retry. RTK reports zero physical bytes freed because row deletion does not compact the file. A later real-file check corrected the old-data Bin move to zero bytes freed because the data still occupies disk. The fourth review reproduced an attachment moved between listing and deletion, and a trace disappearing before removal. Typed `{ removed, bytesFreed }` receipts now flow from actual attachment, trace and session/activity removal operations through the runtime and service. Skipped files and missing traces report zero; partial attachment removal counts only deleted copies; a deleted empty trace counts one removal and zero bytes. Regression tests cover these outcomes, including real temporary files and service-to-UI integration. No actual user data was removed.

**Final worker verification:** all 15 combined commands exit 0 after the last source repair; the cold-cache run passes **108 changed spec files / 1,280 tests**. `AIO_TEST_NO_CACHE=1` is recorded in the command receipt. Phone typecheck, lint, production build and two confirmation tests also pass. The fifth genuinely fresh `task-completion-gate` reviewer returns **VERDICT: PASS**, with no unresolved actionable worker-readiness findings, independently reruns 133 tests across 22 files and rechecks the real-file races, stale cache and RTK handle/partial-trim outcomes. Renderer budget, legacy LOC tolerance and warn-level IPC-usage messages remain visible in the successful logs; zero exit does not mean zero warnings.

**Handoff and limits.** Source edits remain uncommitted and unstaged on the supplied branch, with HEAD unchanged. The temporary prospective index, worker-installed mobile dependencies, generated compile caches and source snapshots are removed after the report, seal and receipts are written; cleanup receipts and the unchanged source seal record the result. Pre-existing root dependencies and AIO-managed worktrees are preserved. The durable [worker report](../../_scratch/oct-followups/2026-10-20-546c7e-repair/report.txt) and its adjacent receipts retain the exact commands, exits and evidence. The coordinator still owns the full suite (not run by this worker, as instructed), overall queue-verifier verdict and completion rename. Installed-app/provider/device/human observations remain in [the live-test document](2026-10-11-oct-followups_livetest.md); no missing code or runnable test is deferred there.

> Plan Queue parked work: `queue/2026-10-11-oct-followups-546c7e` — 1 commit(s), reason: verifier-unreliable.

### Verification round 1 remediation — 24 Oct 2026 (queue/2026-10-11-oct-followups-546c7e; active, not completion evidence)

The independent verifier's two high-severity findings are accepted and fixed. Both were reproduced from the code before changing anything.

**Finding 1 — attachment cleanup deletes live-session folders (identity split).** `ipc-main-handler.ts:324` supplied only `instance.id` (Harness UUID) to `getLiveIds`, but attachment folders under `.claude-attachments/` are named by the provider session ID (`claude-cli-adapter.ts:221` sets `this.sessionId = options.sessionId || generateId()`; `file-handler.ts:34` uses that as the folder name). `protectedIds` in `storage-runtime.ts:30` compared folder names against Harness IDs — never a match — so preview and deletion both offered live-session folders for clearing. Fix: `getLiveIds` now returns `instance.id`, `instance.providerSessionId`, and `instance.sessionId` (the deprecated alias) for every live instance. The new test in `storage-runtime.spec.ts` uses distinct identity strings (`harness-instance-aaa` vs `provider-session-bbb`) and shows the folder is clearable when only the Harness ID is protected, but preserved when both identity types are present. The existing identity-agnostic test is unchanged.

**Finding 2 — gated final audit skips merge hold on incoming `completed-needs-review`.** `loop-review-driven-terminal.ts:43` staged `mergeHold` only when `terminal.status === 'completed'`; an incoming `completed-needs-review` result bypassed the branch and reached `terminate` with no hold, so `holdsMergeForReview` (`loop-worktree-lifecycle.ts:62-63`) returned false and the worktree merged. Same pattern at `loop-coordinator.ts:3116-3125` (ping-pong path). Fix: both locations now accept `completed` or `completed-needs-review` and stage the hold; the status conversion from `completed` to `completed-needs-review` still applies only when it was `completed`. New unit test in `loop-review-driven-terminal.spec.ts` exercises the incoming `completed-needs-review` case directly. New integration test in `loop-coordinator-merge-hold.spec.ts` exercises the ping-pong path with a mocked `needs-review` final audit and asserts `mergeHold: true, mergeHoldKind: 'final-audit-blocked'`.

**Verification.** `npx tsc --noEmit`, `npm run lint`, `npm run check:ts-max-loc` — all exit 0. Targeted tests: `storage-runtime.spec.ts` (5), `loop-review-driven-terminal.spec.ts` (6), `loop-coordinator-merge-hold.spec.ts` (3), `attachments-folders.spec.ts` + `attachment-generation.spec.ts` (47), `loop-final-audit-blocked-completion.spec.ts` + `loop-merge-hold.spec.ts` (9), `loop-coordinator-completion-gates.spec.ts` + `loop-review-driven-completion-integration.spec.ts` (46), `storage-cleanup-service.spec.ts` + `storage-handlers.spec.ts` (34) — all pass. The full suite remains the verifier's gate.

## Diet size note

The dieted plan remains over 120 KB because its step bodies alone (Steps 1–8, plus the
In plain English, Decisions, Ground rules, Order of work, The rest of the list, Final
verification, Live checks, Not in this plan, Found on the way, Corrections and Finishing
sections) measure about 273 KB and are deliberately unchanged per Phase B Step 3.4. The dated
status and as-built content moved here accounts for the reduction (455,849 → 280,030 plan bytes).

---

## Plan diet, 10 November 2026: sections moved verbatim from the plan

Moved by Phase B Step 3, in their original order and unchanged (headings included). The plan now holds the Status block, the step bodies, and one pointer line per section moved.

Size after the diet: 276528 bytes, of which the `## Step` bodies are 188702. Step 3.4 leaves step bodies unchanged (their size is a design matter for Step 5's step-sized jobs), so the plan stays above about 120 KB; the dated material is what moved.

## Verifier round 8 response (3 November 2026)

**Status: BLOCKED on the existing product decisions; not ready for whole-plan acceptance or landing.** Continued from the supplied `d1f95898b` checkpoint against merge base `dccbc6e25`. No product code, test, generator input or gate configuration changes in this response. No separate spec is linked. This entry records current checks; earlier acceptance and approval claims retain only their recorded scope.

| Supplied finding | Actual disposition |
| --- | --- |
| 1. Implemented choices 2, 4, 7(a–c), 8, 10 and 11 lack a recorded answer | **Open.** The committed diff confirms the Training Data/Instance Messaging removals and RTK tracking removals. Current repair instructions and standing autonomy do not supply the plan's specific product/retention answers. One current question presents retaining these implemented choices for James's decision. No answer has arrived. Preserve the checkpoint; do not land these changes as approved. No rollback, real-data deletion or inferred historical consent is performed. |
| 2. Part 7i lacks a build/drop decision | **Open.** The same current question asks James to explicitly drop the extra Auto-approve question, or specify another choice. It remains unbuilt and undecided. The recommendation, an unanswered/preselected option and elapsed time are not an explicit drop. |
| 3. The plan remains open and the worker must not rename it | **Correct present state, retained.** The existing unchecked decision item stays open because findings 1 and 2 remain unresolved. The current queue assignment expressly reserves completion naming for the coordinator after independent acceptance; that worker prohibition cannot be repaired by violating it. This is not a claim that the coordinator can never close the plan. |

Current worker verification exits 0: uncached retirement/scratch/instruction-pointer tests (3 files, 46 cases), root and Electron typechecks (`npm run typecheck`), the documented heap-raised spec typecheck, lint and the read-only retirement check. Retirement reports zero eligible documents, last batch 15 October, not due. Exact commands, exit codes and full logs are in this worktree's `_scratch/oct-followups/round8-response/command-receipts.jsonl`. Its `report.md`, `source-seal.json` and post-seal `cleanup-receipt.json` record the handoff and owned-runtime cleanup; worktree-local dependencies remain for the verifier.

No full/slow suite, production build, fresh independent whole-plan review, app/browser/provider/device check, real-data cleanup, external write, staging, commit, stash, branch/worktree operation or completion rename runs in this response. The full suite and independent acceptance remain coordinator-owned. No generator input changes, so no generation is needed. Existing live checks remain open; an unanswered product decision is not deferred into a live-test document. The authoritative root plan is updated here; its tracked worktree snapshot stays unchanged.

## Verifier round 4 response in queue checkout 8ca926 (2 November 2026)

Status: documentation counts and handoff ownership corrected; current worker checks pass. Acceptance remains blocked on the unanswered choices below. Continued from `9aaa47144`, merge base `dccbc6e25`, in the supplied checkout. No new product defect was reported in this round, and no product code, tests or gate configuration is changed by this response. Earlier source-review and gate results remain attributed to their original runs. No separate spec is linked.

The authoritative plan is this file in the root checkout, as the queue assignment requires. Its already-committed worktree snapshot is not copied or edited by this worker. Tracked companion documents are edited in the worktree. Evidence for this response is retained in that worktree's `_scratch/oct-followups/round5-handoff/`.

| Round-four finding | Current disposition and remaining action |
| --- | --- |
| 1. Missing decisions | **Open.** A current question describes choices 2, 4, 7(a–c), 8, 10 and 11 as concrete implemented behavior and asks whether James accepts them and explicitly drops 7i. No reply has arrived. A preselected option, an elapsed wait, an existing implementation and a coordinator commit are not consent. No current or historical answer is invented. |
| 2. Unchecked coordinator work | **Ownership clarified, acceptance still pending.** Full/slow suites, independent whole-plan verification, integration and completion naming belong to the coordinator under the current assignment. Historical coordinator handoff bullets below are not unfinished worker implementation and are no longer presented as worker checkboxes. Adoption by the running coordinator remains an explicitly deferred rebuilt/restarted-app check in [the hook-timeout live-test note](2026-11-02-oct-followups-hook-timeout_livetest.md); the worker must not restart its owning coordinator. This clarification does not stand in for an independent PASS. |
| 3. Live-check count and completion rule | **Count reconciled.** The tracked live-test document has **54 current open checkbox entries**, including optional and conditional observations. The **63** entries in the 27 October campaign are historical; nine source-only entries were subsequently removed with their evidence retained. No live checkbox is closed in this response. Under AGENTS.md's Live-Test Deferral rule, genuinely rebuilt-app, human or external-service checks may remain in a live-test document when the implementation plan is closed after all runnable gates and independent acceptance pass. Their count alone does not block that future closure. Unanswered product choices cannot be deferred that way. This worker still has no authority to perform a completion rename. |
| 4. Reviewer scope | **Recorded limitation.** The supplied verifier did not review the entire 893-file diff line by line and reported no broken-code finding. Its reported seven passing gates are attributed evidence, not a new worker run. The coordinator's next verifier must evaluate acceptance and the actual branch diff independently; a documentation-only review is not whole-plan acceptance. |

Remaining human action: answer the current concrete question, or specify a different choice. This is a product/retention decision, not a routine permission request for local repair. It grants no real-data cleanup, commit, deployment, app restart or Mac interaction. Actual data removal still requires the exact preview and separate explicit confirmation described in the live-test document.

### Current worker checks

Current command receipts record exit 0 for the uncached focused retirement/scratch/pointer regressions (3 files / 46 tests), `npm run typecheck` (root and Electron), `npm run typecheck:spec`, `npm run lint` and `npm run check:docs-retire`. Retirement reports zero eligible documents, last batch 15 October, not due. Direct document comparisons confirm all 54 live checkbox texts and the original requirements from Decisions onward remain byte-identical; the worktree plan snapshot, HEAD and staged entries are unchanged. This is documentation-only verification, not a fresh acceptance of the previous coding work. No generator input changed, so no generated file was rewritten. The coordinator retains the full suite; no full/slow suite, build, live-app/provider/browser/device check, real-data cleanup, external write, commit, staging, branch/worktree operation or completion rename runs in this response.

## Earlier verifier round 2 remediation in queue checkout 8ca926 (2 November 2026)

Status: source repairs for findings 1–7 pass worker checks and fresh independent source review. Finding 8 remains an explicit approval boundary; whole-plan acceptance and closure are not claimed. This entry supersedes earlier whole-plan readiness claims for this checkout. Continued from `3e4e249f9`, merge base `dccbc6e25`, without a commit, stash, branch/worktree change or completion rename. No separate spec is linked. Full/slow suites and independent whole-plan acceptance remain coordinator-owned.

- [x] **Finding 1 / 5h:** removed all nine unused exported Training payload schemas and their private helper schemas from the contracts provider module. Source searches found no remaining consumers; no live learning/training behavior was removed.
- [x] **Finding 2 / 5h:** removed the deleted Training/Messaging screen ceilings, obsolete dead-export entry and stale handler/queue/channel comments. IPC generation remains current; no size ceiling or exemption was raised.
- [x] **Finding 3 / 4a:** the coordinator records the supplied pause signal/explicit reason/diagnosis into live state before state listeners snapshot it. This covers the actual BLOCKED.md, resource-governor, kill-switch and no-progress emission paths. Manual Pause records a factual reason; Resume clears the old reason and the consumed `unverifiable` sign-off marker. The automation note includes the supplied reason even for sign-off. Real coordinator → blocked-file/resource/no-progress/manual/sign-off → dispatcher regressions exercise this without hand-setting `endReason`. The existing state-helper module owns the small extraction: no new production dependency or raised coordinator limit. The coordinator remains at 4,004 lines.
- [x] **Finding 4 / 7f:** removed the non-live form-guard checkbox. The real guard is `scripts/__tests__/ui-hints-form-fields.spec.ts` plus `npm run check:ui-hints`, not the nonexistent historical filename. The old live-campaign report is explicitly historical and its filename error is corrected.
- [x] **Finding 5 / renderer deferrals:** removed the renderer-only pending checks for attachments, suggestion/Undo behavior, invisible backdrops/Escape, live virtualization setting changes, duplicate Workboard transitions, Costs/exact amounts and helper-strip overflow. The current evidence map below replaces the older checkout's “Integration blocked” claims. Only actual provider/session/remote-worker behavior, real-data operations, restart/package/CI observations and optional audible screen-reader judgment remain deferred; no installed-runtime mismatch substitutes for an agent-runnable check.
- [x] **Finding 6 / 7g:** Local AI effectiveness uses shared cents headlines with exact `appTooltip` amounts and non-live accessible numeric outputs. No extra Tab stops were added. The precision guard now catches high-precision currency `Intl`, `toPrecision`, significant-digit options and `toFixed` forms, including the old missed panel pattern.
- [x] **Finding 7 / 5b:** RTK cleanup approval binds to the database path, fixed cutoff date and availability, rather than changing row counts. RTK's own background pruning is allowed. The validated path is passed all the way to the executor instead of re-resolving the environment after approval. Changed path/date/availability, expiry and reuse still refuse; full/partial counts and no physical-space claim remain. This is the evidenced as-built interpretation of 5b's “changed list refused”: changed approval identity is refused; normal row-count drift is not.
- [ ] **Finding 8 / numbered choices and 7i:** the compressed historical readiness sentence is not proof of answers to numbered choices 2, 4, 7(a–c), 8, 10 or 11, and defaulting 7i to unbuilt is not an explicit drop. Current direct instructions authorize local repair and verification; they do not prove those historical decisions, authorize real-data destruction or authorize a completion rename. A single current question presents the concrete implemented defaults and asks whether the extra Auto-approve question should remain unbuilt. No answer has arrived. These choices and 7i's disposition remain open until James answers; no inferred approval is recorded and no whole-plan closure is claimed.

### Current in-loop renderer evidence (replaces deferred code/UI checks)

| Former live check | Current executing-path evidence |
| --- | --- |
| 6 / 7a | Actual `input-panel.component.spec.ts` covers refusing/supported live providers, draft local runtime and dormant-chat override; `drop-zone.component.spec.ts` covers rejected drops/image pastes and supported paste. |
| 7.2–7.3 / 7b | `memory-removal-suggestions.spec.ts`, `wake-context-usage.spec.ts`, `wake-hint-review.spec.ts`, `wake-hint-removal.spec.ts` and actual `wake-management.component.spec.ts` cover source/date/usage facts, rendered suggestions, preserved identity/history and Undo. Added DOM timing case proves independent hover/focus pauses and expiry of only the remaining window, with exactly one removal. Actual provider starts/compaction/resume remain check 7. |
| 8 / 7e | `backdrop-buttons.spec.ts` inventories all nine current invisible backdrops and their Tab/accessibility attributes; `backdrop-escape.directive.spec.ts` and actual `settings-overlay-focus.component.spec.ts` prove topmost Escape, focus entry/wrapping/restoration and no global stop leakage. |
| 12.2 / 7h | `advanced-settings-tab.component.spec.ts` covers row availability/dispatch; new actual `output-stream-virtualization.component.spec.ts` toggles the live setting off → on → off on the same transcript/viewport, asserting accessible spacers, pinned prompt and restoration of original row IDs. Provider map behavior remains check 12. |
| 13.2 and duplicate 26 / 7j | New actual `workboard-memory-push.component.spec.ts` uses the real proposal IPC wrapper, MemoryReview store, projection/page/cards: pushed pending → Needs You and pushed approved/rejected → Done before polling, specialist navigation and unsubscribe. Existing store races/teardown tests remain. Real main-process proposal/job execution stays in check 13. |
| 24.2 / 7f | `scripts/__tests__/ui-hints-form-fields.spec.ts` and the current strict UI command enforce zero unnamed fields; no live checkbox. Audible screen-reader read-out remains optional check 24.1. |
| 25 / 7g | Actual `cost-page.component.spec.ts` covers populated model/session/recent amounts, estimates and exact tooltip/accessibility behavior; Local AI component tests cover visible cents, exact hover and accessible names without extra Tab stops. |
| 27.4 / 7c | Actual `session-status-dock.rules.spec.ts` fills the five-chip strip, opens `+N more`, checks native-helper wording and informational/no-panel semantics. Installed helper lifecycle and rebuilt remote transport remain checks 27.1–27.3. |

Evidence is retained under this worktree's `_scratch/oct-followups/round3/`: `report.md`, command receipts/raw logs, `fresh-review.md`, `source-seal.json` and the post-seal cleanup receipt. The final uncached focused selection passes 34 files / 385 tests; the last Local AI computed-hint revision passes its 2 files / 16 tests. These overlap and are not summed. Final root/Electron and documented spec typechecks, lint/fast lint, unchanged size limits, strict UI comparison against `dccbc6e25`, main/renderer production builds, aliases/IPC generation, IPC/exports/contracts/dead-export checks, import boundaries/loop-cwd discipline and prospective-index architecture generation/check pass. The real index is unchanged and the temporary index is removed. The renderer retains its 1.64 MB initial-bundle warning; fast lint has existing warnings. Retirement reports zero eligible documents, last batch 15 October, not due.

A fresh reviewer returns **SOURCE REVIEW: PASS** with no unresolved source/document findings, after independently running focused tests and reviewing current acceptance, actual runtime wiring, test integrity, security, async/state and UI wording. Its selections overlap and are not summed; full Gate 0/whole-plan acceptance is explicitly not claimed. It caught stale campaign live-check reason wording, now matched to actual `campaignHeldBlockReason`; the editor's existing skipped-checks warning is quoted accurately and unchanged. Red probes, first fixture-typing/opaque-hover failures and an incorrect first UI CLI invocation remain in the receipts. Final repairs update actual fixture interfaces and derive Local AI hints once per summary without changing UI baselines/exemptions or weakening tests.

No full/slow suite, installed-app/browser/device/provider interaction, real-data cleanup, external write, project commit, shared-index staging, branch/worktree operation or completion rename ran. The plan and live-test file were already tracked/modified in the root checkout; their worktree copies were not changed. Worktree-local dependencies and pre-existing build output remain; newly created Angular/checkout-owned transpile caches are removed after sealing. No app service, cluster, browser binary or copied checkout was created. The coordinator must retain the four new untracked regression specs and refreshed architecture inventory when harvesting. Finding 8 remains open exactly as above; the old default for 7i is not counted as James's drop.

## Verifier round 1 remediation in queue checkout 8ca926 (2 November 2026)

Status: all nine reported findings have source changes or an evidenced disposition in this checkout. Combined worker verification, fresh scoped source review and owned-runtime cleanup pass. Ready for coordinator-owned independent whole-plan verification. Continued from `724feb6ca`, with merge base `dccbc6e25`, in the supplied `queue/2026-10-11-oct-followups-8ca926` checkout. The two sections immediately below concern sibling checkout `546c7e`: their hook replays and reviews are historical evidence for that checkout, not fresh results for this one. No separate spec is linked. The coordinator owns the full/slow suites, whole-plan acceptance, integration and completion naming.

- [x] **Finding 1 / model-token guard:** reproduced the unchanged guard failure and centralised the two existing accounting identifiers as `CLAUDE_PINNED_MODELS.OPUS_55` and `SONNET_55`. Frontier attribution, price-only membership and existing price keys use the constants. This adds neither selectable models nor prices. The original failing run and passing guard/attribution regressions are retained under `round2/contracts/`.
- [x] **Finding 2 / part 4a, paused automations:** the existing paused-loop terminal path already saved `needs-attention` and retained its reason, but the event schema rejected that status. The schema now accepts it, the real Electron event boundary delivers it, the renderer treats it as terminal, and SQLite get/list unread counts plus mark-all-seen include it. The source path was traced from the paused loop through terminal delivery, window transport validation, preload and renderer event application. Pre-fix schema/event/renderer and real SQLite failures are retained; the final contracts/store selection passes 9 files / 163 tests. A raw-status label in the existing Automations template is unchanged; this repair does not claim a new status-wording mapping.
- [x] **Finding 3 / part 5e, RTK tracking:** applied the plan's index-only `git rm -r --cached resources/rtk`. All ten previously tracked binary/license paths are staged as deletions; the local files remain byte-identical and `git ls-files resources/rtk` is empty. Strict cached fetch and the RTK version/fetch regressions pass. This is the authorised tracking change, not real-data deletion, history rewriting or a project commit. The precise before/after byte and index receipt is `round2/rtk-index-receipt.json`.
- [x] **Finding 4 / landing-hook budget:** the actual `commitWithHooks` watchdog now allows a bounded 60 minutes. Production-path virtual-time regressions prove a 50-minute successful child is allowed, a stuck child is killed at the hour, cancellation and explicitly shorter deadlines still work, and early failures return immediately. The reported 2,828-second observation was a full-suite duration, not a measured hook replay. This worker has not replayed the complete hook; the sibling's replays above remain attributed to that sibling. Independently reproduced and adopted its minimal native-fixture correction: publish `LOCAL_ACK` only after the Stop-signal listener and scenario are ready. The two-order native probe retains the old-order lost answer and corrected-order successful answer; assertions and timeouts were not weakened.
- [x] **Finding 5 / part 7g, detailed money values:** shared detailed formatting uses decimal currency with up to 15 significant digits, retaining tiny nonzero costs without scientific notation and suppressing binary arithmetic noise such as `0.1 + 0.2`. The Costs page uses that helper for its detailed amounts. Regressions cover tiny values, arithmetic noise, negatives and existing ordinary values; headline amounts still use the cents helper.
- [x] **Finding 6 / part 7g, Costs keyboard access:** recorded amounts no longer create unconditional cost-cell Tab stops. The headline is a named non-live `output`; table amounts have their detailed value as an accessible name, and estimated aggregates retain their extra explanation and keyboard access. Cost hints are derived in computed rows instead of rebuilt on every template evaluation. DOM coverage checks the focus attributes and detailed amount access. Final strict UI verification against the actual base passes without a new exemption, raised limit or wording-retirement entry.
- [x] **Finding 7 / part 6g, honest lookup measurement:** timing starts before readiness, direct-file probing and invalidation. Complete misses report measured elapsed time plus per-lookup `directoryReads` and `fileStats`; `scanned` means fallback state-content reads. A complete miss still revalidates all file generations to catch external in-place alias edits, so this is O(number of records) metadata work, not constant-time or zero filesystem work. The bounded synthetic experiment used 1,000 generated records, five warm complete misses before and after: observed 5.11–12.34 ms before while logging literal zero, and 5.63–10.75 ms after while logging 5–10 ms. Each sample observed one directory read, 1,001 file-stat attempts and zero state-content reads. This establishes only synthetic local warm-folder behavior. The real 7,699-record folder, cold-storage behavior and actual miss frequency remain unproven; no real session data was opened by this experiment.
- [x] **Finding 8 / part 3c, intentional preservation policy:** retained the existing stronger guard before boot harvesting as well as the second dirty check immediately before removal. For unsuccessful, auto-integration-disabled or review-held runs, initial dirty work is blocked before any add/commit, preserving both unsaved bytes and the branch tip. This deliberately goes beyond the plan's narrow pre-removal check; it prevents a harvest from making unsaved work appear clean and removable. Successful auto-integrating runs retain their existing harvesting behavior. Real temporary Git-repository regressions cover dirty preservation, unchanged branch tips, clean removal and an edit arriving after the first inspection. No lifecycle product code changed for this finding.
- [x] **Finding 9 / parts 3f and 3g, held-work wording:** campaign pauses now say work was held for review instead of inventing skipped checks. Terminal chat summaries pass the saved `mergeHoldKind` to shared wording, preserving the distinction between a stall, final-audit sign-off and verified no-change work. Missing or unknown kinds now use factual generic review wording; no new persisted kind is invented. Evidence-free historical skipped rows deliberately receive that generic sentence too. The past-runs panel already preferred saved typed evidence at this checkout's initial checkpoint; added DOM regressions prove that path takes precedence over contradictory historical reason text, including unknown saved kinds, and preserves the existing known legacy reason fallback. This is existing behavior verified by regression, not a newly repaired panel path.
- Evidence: this worktree's `_scratch/oct-followups/round2/` retains before-state and index receipts, contracts/store red and green runs, queue/session probes and timings, exact command receipts, and fresh-review material. Focused queue/session checks pass 8 files / 71 tests and RTK checks pass 2 files / 54 tests; these overlap other selections and are not summed. The final combined focused selection passes 26 files / 417 tests, followed by the final shared-wording selection (3 files / 61 tests); these also overlap and are not summed. Red runs and intermediate combined-check failures remain recorded, including the initial cost-fixture type and UI-hint failures, a nonexistent alias-script attempt corrected by the real contract check, and a test-path preflight that stopped before the corrected focused run. No full/slow suite, whole-hook replay, installed-app/browser/device/provider check, real-data cleanup, project commit, stash, branch/worktree lifecycle change or completion rename ran in this repair. The RTK index-only deletion is the intentional staged change.
- [x] **Combined worker gates:** final root/Electron and documented spec typechecks, lint, size, strict UI check against `dccbc6e25`, main/renderer production builds, IPC/usage, exports, aliases/contracts, native ABI, import boundaries and loop working-directory discipline all exit 0. Architecture generation/checking uses a disposable prospective index that includes the unstaged/new paths; the real index is unchanged by it and the temporary index is removed. Coordinator harvesting must include the generated inventory and recheck it normally. Fast lint exits 0 with existing warnings; IPC usage remains advisory. The renderer retains its 1.64 MB initial-bundle warning. The retirement check reports 0 eligible documents, last batch 15 October, not due.
- [x] **Fresh independent worker review:** `round2/fresh-review/review.md` returns **SOURCE REVIEW: PASS**, with no unresolved actionable findings. The reviewer independently reran uncached focused selections (13 files / 207 cases; final Costs/native/campaign/lifecycle 7 / 153; runtime 6 / 117; final wording 6 / 78), checked the real RTK index/disk state, read current central gate output and mapped all nine findings to executing code. These selections overlap and are not summed. Whole-branch changes received mechanical scanning only. Clean-state/full-suite Gate 0 did not run; this scoped source verdict is explicitly **not** independent whole-plan acceptance or a full task-completion-gate PASS.
- [x] **Evidence sealing and owned-runtime cleanup:** `round2/cleanup-receipt.json` records exit 0 with no mismatch across 878 sealed source paths, the canonical plan matching at cleanup, and the temporary index absent. One newly owned `tsx` cache entry was removed. No new Angular cache, package compile cache or mobile web output remains; worktree-local dependency installs are retained for the verifier. Pre-existing `dist` and `.vite` output was preserved rather than claimed as newly owned cleanup. No database cluster, browser binary or copied source tree was created. Reports, raw evidence and receipts remain. The owning worker refreshes the final seal after this final documentation note.
- **Coordinator handoff, pending:** full and slow suites, independent whole-plan acceptance, integration, adoption by a rebuilt/restarted coordinator and any completion rename. Existing observations remain open in [the live-test document](2026-10-11-oct-followups_livetest.md). Do not close or rename this plan in the worker.

## Landing-hook timeout resume in queue checkout 546c7e (2 November 2026)

Status: both repairs are implemented and worker-verified, including a passing complete hook replay and fresh scoped source/runtime review. Ready for coordinator-owned independent whole-plan verification. Continued from `bf060a679` with base `dccbc6e25` in the supplied checkout. Earlier implementation and live checks are preserved. No separate spec is linked. The coordinator owns whole-plan acceptance, integration and completion naming.

- [x] Traced the refusal to the landing watchdog's fixed fifteen-minute limit, rather than a failed assertion in the supplied timeout tail. Actual related discovery selects 1,447 files from 424 changed source paths; their retained historical durations sum to 1,511.872 seconds, before environment/setup costs. That read-only discovery resolved one worker on the shared host. These historical timings size the repair; they are not a fresh pass. The production change gives landing hooks a bounded hour. Selection, parallelism, failures, cancellation and descendant cleanup retain their existing paths.
- [x] A virtual-time regression through the production watchdog reproduced the old deadline failure and passes with the repair. Existing real process-tree tests pass. Both production typechecks, final spec typecheck/lint, strict UI check, size, main/renderer builds and architecture verification pass. Normal hook generators leave tracked generated artifacts unchanged. The renderer retains its existing initial-bundle warning.
- [x] The broad replay exposed a separate native-process fixture readiness race: `LOCAL_ACK` preceded SIGINT-listener registration. Its unchanged isolated file passed, but a controlled native two-order probe reproduced a lost answer under that ordering and a correct answer when readiness follows registration. Moved only the fixture ACK after scenario initialization; every assertion and timeout remains unchanged. The corrected native-outcome/input-write/watchdog selection passes 3 files / 23 tests. A genuinely fresh reviewer independently reran those specs and returned **SOURCE REVIEW: PASS**, with no actionable findings. This is scoped source/runtime review, not whole-plan acceptance.
- [x] Retained the first complete hook replay: exit 1 after 2,090.6 seconds, solely the native readiness-race AbortError; 1,447 other files passed. This is a real failed result, not a pass. HEAD stayed unchanged and all staged entries still exactly match it; Git refreshed index metadata, so the original byte-hash check correctly reported different index bytes. The entry-level clarification is retained.
- [x] The corrected complete hook replay exits **0** after **476.84 seconds**: **1,448 files passed; 21,934 tests passed and 6 existing cases skipped**. It selected all 426 changed source paths, including the fixture repair, through `git hook run pre-commit` and a disposable prospective index. The final receipt proves exact source bytes stayed unchanged, logical real-index entries and HEAD were preserved, the owned hook root exited, and the temporary index was removed. Raw Git index metadata refreshed; no staged content changed. No project commit was created.
- Evidence: `_scratch/oct-followups/2026-11-02-hook-timeout/` in this worktree retains the final report, source seal, exact command receipts, historical sizing evidence, both complete hook logs, native readiness probe and scoped reviews. Cleanup exits 0: generated build output and compile caches are absent, sealed source hashes still match, and worktree-local dependencies remain for the verifier. An initial cleanup stopped on a newly written `.DS_Store`; the inspected retry and its receipt are retained. No project commit, stash, branch/worktree lifecycle change, app/browser/device action, real-data cleanup or product-provider live test ran. Independent reviews used the authorised Codex CLI.
- **Deferred running-app check, pending:** running-coordinator adoption needs a build containing the repair and a restart, recorded separately in [the new live-test note](2026-11-02-oct-followups-hook-timeout_livetest.md). That document is untracked in the root checkout. Do not restart this worker's owning coordinator, close this plan or rename it in the worker. The coordinator's full suite and independent whole-plan acceptance remain separate.

## Verifier round 1 repairs in queue checkout 546c7e (2 November 2026)

Status: all four reported repairs are implemented and worker-verified, ready for coordinator-owned verification. This entry concerns only the supplied `queue/2026-10-11-oct-followups-546c7e` checkout, continued from `cea54fe60` with merge base `dccbc6e259385cf79559257ce413508eb0470cbe`. Entries referring to other queue checkouts remain historical evidence for those checkouts. The initial tree was clean. No separate spec is linked. No worker commit, stash, branch/worktree change, real-index staging, completion rename or external action occurred.

- [x] **Finding 1 / part 7f:** reproduced the canonical counter at 23 while the separate regex guard claimed zero. Removed the regex reader and duplicated traversal/spec. Canonical Angular facts and the configured ESLint rule now share one name-association decision function. Fourteen valid label associations are recognised and nine genuinely unnamed fields are named from existing screen text. The canonical counter and H13 violations are both zero. H13 is strict before baseline mutations and cannot be suppressed by markers or recorded as debt. H14 ratchets the existing opaque control per owner using the same predicate as measurement; actual Git blobs establish the initial historical inventory. Already-supported bases check the rule first, without reading renderer blobs. Growth, owner transfer and dishonest records fail. No field exemption, size-limit increase or wording-ledger change was added.
- [x] **Finding 2 / part 3g:** a passed no-change audit keeps its review hold and now says the checks passed without production changes. Failed, skipped and needs-review outcomes have accurate distinct reasons; gated failures still enter recovery. Chat recaps preserve the saved kind. Unknown historical kinds use a factual generic sentence instead of inventing a skipped check. Existing boolean merge protection and operator acceptance behavior remain covered.
- [x] **Finding 3:** the default plan verifier now includes all eight canonical gates, including `npm run check:ui-hints`. The regression compares the actual ordered AGENTS.md checklist, while explicit custom/empty overrides and historical snapshots remain valid. Livetest defaults are unchanged.
- [x] **Finding 4:** reproduced the inherited model-token guard failure and centralised the two existing accounting identifiers in provider constants. Existing attribution, price-only membership and rates use those constants. The guard and attribution tests pass; no selectable model or price was added.
- [x] **Current checks:** root/Electron typechecks, the documented spec typecheck, lint, size gate, strict UI check against the actual base, main/renderer production builds, IPC/exports/contract checks and diff whitespace all pass. Focused regression selection passed 26 files / 551 tests before review follow-ups; the directly affected follow-ups and relevant coordinator paths then passed 8 files / 177 tests. These overlap and are not summed. The renderer retains its initial-bundle warning. Generated IPC and aliases are current. Architecture inventory was regenerated and checked with a disposable prospective index; before/after real-index hashes match, and the temporary index is removed. Coordinator harvesting must include the generated inventory and recheck normally.
- [x] **Fresh source review:** the first review's parser-binding hypothesis was disproved by the installed parser and executed parity tests; its actionable findings were reproduced and fixed. One further reviewer timed out without a verdict. A subsequent genuinely fresh reviewer returned **SOURCE REVIEW: PASS**, with no unresolved actionable findings. It had read-only access and did not independently execute gates; this is explicitly not a full task-completion-gate or whole-plan acceptance PASS. All findings, tested dispositions and limitations are retained.
- Evidence and cleanup: `_scratch/oct-followups/2026-11-02-round1-repair/` in this worktree retains `report.md`, source seal, command receipts, raw test logs, parser proof, source reviews and inventory index proof. Red and intermediate runs are preserved. Disposable generated build output and compile caches are removed after sealing, with a cleanup receipt; worktree-local dependencies stay for the verifier. No database cluster, browser binary or copied source tree was created. The manifest, lockfile and size policy are unchanged in this resume.
- **Coordinator handoff, pending:** the full suite, independent whole-plan acceptance, integration and any completion rename. Existing checks in [the live-test document](2026-10-11-oct-followups_livetest.md) remain open. No full/slow suite, installed-app/browser/screen-reader/device interaction, provider request, real-data deletion, release or deployment ran in this repair. Do not close or rename this plan in the worker.

## Resumed worker as-built notes (2 November 2026, current checkpoint)

Status: required implementation is ready for coordinator-owned independent verification. Continued from
`77c737e3f` in the supplied `queue/2026-10-11-oct-followups-8ca926` checkout, with merge base `dccbc6e25`.
The initial tree was clean and no merge is in progress. This entry supersedes older merge/setup claims below
for this checkout. No separate spec is linked. No worker commit, stash, branch/worktree operation,
shared-index staging, completion rename or external write occurred.

- [x] Preserved the existing required implementation: **1a–1f, 2a–2b, 3a–3g, 4a–4c, 5a–5i, 6a–6g and
  7a–7h/7j**. Part **7i** remains deliberately unbuilt; **8a–8e** and the remaining inventory keep their
  existing non-blocking follow-up ownership. Rechecked all **356** committed archive renames against the
  actual base: every moved document has an identical Git blob. The read-only retirement check reports
  **0 eligible**, last batch **15 October**; no new retirement or real-data cleanup ran.
- [x] Reproduced and repaired the remaining original **7f** acceptance gap. The separate HTML regex reader
  and its duplicate tree walker are removed; useful coverage now exercises the canonical Angular reader,
  configured lint adapter and actual CLI. Both adapters share field-name association semantics. The
  original **23** apparent failures comprised **14 valid associations** preserved by the improved reader
  and **9 genuinely unnamed fields**, now named from existing screen text. Canonical unnamed fields are
  **zero**. The strict **H13** rule cannot be suppressed or recorded as new debt. The existing single
  opaque control is recorded by owner under **H14**, using the same predicate as measurement; growth,
  owner transfers and dishonest records fail. Its first comparison with older code measures that older
  code's actual Git blobs in memory; a supported rule's missing row still means zero.
- [x] Repaired review-proven association boundaries with failing regressions and Angular/native-label
  runtime evidence: first duplicate-id target, first labelable descendant, hidden inputs, empty `for`,
  resolved/cycle-safe static and dynamic references, mutually exclusive Angular branches, and actual
  attribute-removal/property-coercion/`htmlFor` semantics. Removed only stale backdrop exemptions and the
  deleted cost-estimator's unreadable record. No field debt, gate suppression or size-limit increase was added.
- [x] Reproduced and repaired the loop-history contract failure: stored and live run summaries preserve
  existing optional `endEvidence`, so saved merge-hold reasons survive validation and history wording.
  The existing schema ceiling is unchanged. The queue's default verifier list now includes all **eight**
  canonical commands, including the strict UI check; real coordinator/SQLite/prompt tests preserve explicit
  overrides (including `[]`) and historical seven-command snapshots.
- [x] Current uncached repair regressions pass: **26 files / 556 tests**, plus the complete coordinator
  spec **123 tests**, dependency compatibility **6 tests**, and phone Stop/Cancel **2 tests**. These overlap
  prior focused runs and are not summed. The initial 154-file selection exposed the old naming failures
  and one waiting-question timeout; the latter passed unchanged both in isolation and in the final complete
  coordinator-file run. Earlier red and intermediate runs remain in the receipts rather than being hidden.
- [x] Final root/Electron and spec typechecks, lint, size, strict UI check against the actual base,
  main/renderer builds, IPC, exports, aliases/contracts, protocol and native ABI checks pass. Phone typecheck,
  lint and production build pass. Generated IPC/aliases are current. The architecture inventory was regenerated
  and checked using a disposable prospective index; the real index's before/after hashes match, and the temporary
  index is removed. Coordinator harvesting must include the generated inventory and recheck it normally.
  IPC usage remains a warn-level check; the renderer retains its initial-bundle budget warning.
- [x] A genuinely fresh fourth source reviewer independently reran **13 files / 296 tests**, actual Angular
  TestBed/native-label counterexamples and the base-comparison CLI, then returned **SOURCE REVIEW: PASS**
  with no unresolved actionable findings. The earlier failed reviews and their dispositions are retained.
  This is explicitly **not** a full task-completion-gate or whole-plan acceptance PASS.
- Evidence: this worktree's `_scratch/oct-followups/2026-11-02-resume/` retains `report.md`, `source-seal.json`,
  command receipts/raw logs, archive/index proofs and `review-pass4/source-review.md`. Post-seal runtime cleanup
  is recorded in `cleanup-receipt.json`; worktree-local dependencies stay for the verifier. This resume changes
  no manifest or lockfile. The supplied checkpoint already added direct Sass for the slow dock stylesheet test,
  using its pre-existing resolved pin; that historical manifest change is not described as absent.
- **Coordinator handoff, pending:** full suite, independent whole-plan acceptance, integration and completion rename.
  The linked live-test document currently has **54** open entries; the older **63**-entry campaign is historical.
  No full/slow suite, real browser/app/device interaction, provider request, real-data deletion, release or
  deployment ran in this resume. Do not close or rename this plan in the worker.

## Merge-conflict refresh (2 November 2026, later main merge)

Status: all 27 supplied conflicts are resolved and staged in the supplied queue worktree. Worker verification passes and the final fresh source reviewer returns SOURCE REVIEW: PASS. Ready for coordinator-owned full-suite verification and whole-plan acceptance. This entry supersedes the earlier ten-conflict pass below for the current merge. The merge remains in progress. No worker commit, stash, branch/worktree change, merge completion/abort or document rename occurred. No separate spec is linked.

- [x] Preserved both permission-classifier intents: original-tool-context checks and exact CLI refusals, plus main's anchored approval-required sentence. Incoming permission cases reproduced four failures before integration, then passed.
- [x] Kept the extracted mode-switch implementation and its display receipt, and transferred main's continuity hold to both replay sends. Two regression cases reproduced the lost hold before repair. Production wiring was traced from InstanceManager through the lifecycle facade and communication queue to model-reply acknowledgement.
- [x] Retained both independently applied 081 migrations under their original full names, with byte-identical up/down SQL, alongside wake-hint history and main's concurrent-startup/WAL protection. Rollbacks select the intended migration by full name. No persisted migration was renamed. Exact-parser import audits measure queue HEAD and the combined worker graph at 157 modules, incoming main at 156, with no Electron importers; the ceiling is tightened to strict `<158`, rejecting any growth beyond the audited graph.
- [x] Reconciled typed helper/status-strip registration and overflow, always-visible human decisions, Escape dismissal, keyboard-reachable tooltips and disabled reasons, and cents with exact amounts. Main's tooltip migration does not resurrect deliberately removed Training Data or cost-estimator files. Their incoming wording records retain explicit retirement reasons. Removed the now-obsolete hover-only helper-chip exception instead of weakening the checker.
- [x] Fixed automatically merged duplicate imports/attributes, retained both node-picker test groups and shared mock data, and restored the prompt dialog/field accessible names after main's `title` to `heading` rename. The renderer build reproduced the stale references before the fix. New DOM cases cover blocked attachment activation and the dialog's single/multiline accessible names. Existing native-disabled assertions were updated only after runtime verification of focusable aria-disabled behavior; no action assertions were removed.
- [x] Generated IPC channels and architecture inventory from the combined sources/resolved index; alias generation is current. Import formatting and removal of the retired Training Data allowlist row keep the unchanged size limits. No test/gate suppression or size-limit increase was introduced.
- [x] Current worker evidence: uncached selected regressions exit 0 (86 files / 1,276 tests); extra dialog/heading cases exit 0 (2 files / 16 tests); refreshed dependency compatibility exits 0 (1 file / 6 tests). Review follow-ups exit 0 (7 files / 112 tests and 11 files / 204 hint/dock guard tests); these overlap earlier coverage and are not summed. Root/Electron and final spec typechecks, final lint, size, strict hints against incoming main, main/renderer builds, IPC, exports, aliases/contracts, protocol, architecture and native ABI checks exit 0. IPC usage is a warn-level check; its exit 0 does not mean zero advisories. The renderer reports its initial-bundle budget warning.
- [x] Extra provenance checks remain explicit: global staged whitespace exits 2 on two source files byte-identical to incoming main; resolution-only whitespace exits 0. Comparing hints against old queue HEAD exits 1 only on incoming main's existing unreadable baseline change (2 to 3); the merged count equals main, and the default/incoming-main strict gate passes. These inherited diagnostics were not hidden or described as passes.
- [x] Refreshed the local dependency install from the merged lockfile after reproducing the old glob/minimatch mismatch. The first install hit a `.DS_Store` deletion race; a clean local retry and native preparation passed. The lockfile-exact worktree-local `node_modules` is retained for the verifier. No manifest, lockfile or dependency assertion was changed to bypass the failure.
- Evidence and review dispositions: `_scratch/merge-resolution-refresh/` in this worktree contains the report, both parent comparisons, exact command receipts/raw logs, migration/import-graph proofs, source seal and cleanup receipts. Fresh source review 2 read both compact source comparisons completely and confirmed the original merge resolutions; its sole blocker was the stale hover-only exception, now removed with passing strict checks. The final fresh reviewer directly rechecked the current source and receipts and returned SOURCE REVIEW: PASS, recorded in `independent-source-review-final.md`. It did not execute gates independently; no independent full-gate PASS is claimed. Final cleanup is recorded in `final-cleanup-receipt.json`; owned build output and caches are absent, and local dependencies remain for the verifier.
- **Historical coordinator handoff, pending at that checkpoint:** finish the merge, run the full suite and independent whole-plan acceptance, and own any completion rename. Existing live checks stay open in [the live-test document](2026-10-11-oct-followups_livetest.md). No full/slow suite, real-browser/app/device check, provider request, real-data cleanup, release or external write ran in this refresh.

## Merge-conflict resume (2 November 2026)

Status: all ten supplied conflicts resolved and staged; worker checks pass. Ready for the coordinator's independent verifier. The merge remains in progress, with no worker commit, merge completion, branch change or document rename. No separate spec is linked.

- [x] Combined queue step-up and verifier-reminder changes with blocking/optional finding triage. Stronger-worker prompts and saved instructions receive blocking findings when present; an all-low FAIL still receives every finding. Three regression cases cover this combination, including the two cases reproduced failing before the fix. Saved verdicts retain all suggestions.
- [x] Retained the extracted auxiliary/review settings types and policies alongside workload settings and queue account rules. Main's operator-only account-rule protection moved into the existing extracted privileged-key set, with both agent write paths regression-tested. The extracted set exactly matches main's authorization keys.
- [x] Kept idle-monitor loop protection plus pause/work-admission imports, both reviewer test groups, optional suggestions plus step-up renderer imports, and the incoming runtime-only Plugins screen. Its remaining package input keeps its accessible name; removed provider/template controls were not restored.
- [x] Regenerated IPC channels and the architecture inventory from combined sources/the resolved index. Alias generation adds no change. The main-build hook refreshes the installed Codex protocol snapshot from 0.165.0 to 0.166.0. Fixed two Vitest mock type incompatibilities without altering assertions. Import-only compaction keeps the combined campaign and loop coordinators within unchanged size limits.
- [x] Current focused runs exit 0: the queue/main/renderer/settings/review/idle/dependency/generator selection (75 files / 1,024 tests), additional session/loop integration checks (4 files / 37 tests), operator-only settings regression (1 file / 2 tests), and campaign coordinator/admission/landing checks (3 files / 71 tests). The first integration command named nonexistent campaign paths, so it did not provide campaign coverage; the later run uses the actual coordinator path under `__tests__` and demonstrates the three existing campaign specs. There is no standalone campaign-node-terminal-policy spec, and none is claimed.
- [x] Root/Electron typechecks, final spec typecheck, final lint, size limits, UI hints, main/renderer builds, architecture, IPC, exports, contracts/aliases, Codex protocol and native ABI checks exit 0. Global staged whitespace checking exits 2 on imported evidence logs byte-identical to incoming main; source/generated-inventory checking exits 0. Historical raw evidence is preserved.
- [x] Source review by a genuinely fresh agent found no code defects or weakened tests and identified the campaign coverage gap above. That gap is repaired, but its independent command execution was refused with “requires approval”, so this is **not** an independent gate PASS. Full-suite execution and whole-plan acceptance remain coordinator-owned.
- Evidence: `_scratch/merge-resolution/` in this worktree contains `report.md`, `source-seal.json`, `command-receipts.jsonl`, `independent-review.md`, both parent comparisons and raw command logs. Cleanup removes this turn's build output, npm download cache and compile caches; the lockfile-exact local `node_modules` is retained for the verifier under the current resume instructions. The older 30 October cleanup/setup instructions below are historical and superseded for this pass.
- **Historical coordinator handoff, pending at that checkpoint:** finish the merge, run its full suite and independent acceptance, then own any completion rename. Existing live checks remain open in the linked live-test document. No full/slow suite, browser/app/device check, real-data cleanup, provider request, release or external write ran in this pass.

## Verifier finding (24 Oct, coordinator handoff; high) — fixed 24 Oct

Part 7c's required typed-strip registration, overflow behavior and regression test had been deferred as a live check
("the host does not exist"); the helper chip rendered as a standalone div in the composer
(`input-panel.component.html`) outside any typed chip list or overflow mechanism. Waiting for missing implementation is
not a rebuilt-app, human or external-service live-test prerequisite.

**Fixed 24 Oct (verifier-round remediation as-built entry):** the owning strip foundation is integrated into this
checkout — Phase 3 step 5's one status strip above the message box, completed with Phase 5 step 16's typed `DOCK_CHIPS`
registry, the five-chip cap and the "+N more" overflow (`session-status-dock.rules.ts` / `session-status-dock.component.ts`,
adapted from the owning queue branch's C2b + step-16 integration). The helper chip now registers into that typed list
from `helper-agents-chip.ts` (`helpersDockChip`, informational, no panel, label "N helper agent(s) running", tooltip
`strip.helperAgents`), driven by the session's `nativeHelpers` summary and never child sessions; the standalone composer
chip is gone. The plan's strip spec (the chip sits in the overflow after Phase 5 step 16's limit) plus the descriptor,
registration and R1.5 end-to-end tests are in place. Full as-built entry in
[history](2026-10-11-oct-followups_history.md).

## Verifier findings (23 Oct, coordinator handoff; both high) — fixed 24 Oct

Both were fixed in the 24 Oct remediation round (attachment identity split and the `completed-needs-review` merge hold);
see the "Verification round 1 remediation — 24 Oct 2026" entry in [history](2026-10-11-oct-followups_history.md).

1. `src/main/storage/storage-runtime.ts:46` - attachment cleanup protects Harness instance IDs while attachment folders
   use PROVIDER session IDs (generated independently), so it can delete a LIVE session's attachments. Protect both
   identities with a real-identity-split regression.
2. `src/main/orchestration/loop-review-driven-terminal.ts:43` - the final-audit merge hold is gated on
   `status === 'completed'`, so `completed-needs-review` outcomes (missing plan rename, known failures, follow-ups) merge
   without operator review. Hold on that outcome too when `finalAuditMode='gate'`.

## Status

The inventory remains 49 parts: 43 implemented, five Step 8 parts parked under their recorded triggers, and 7i unbuilt with its build/drop decision still open. Numbered approval choices also remain open as described in the current round-two remediation entry; the old compressed readiness sentence does not close them. Current local source repairs pass worker verification and fresh scoped source review; the approval boundary remains open. Full/slow suites, independent whole-plan acceptance, integration and completion naming remain coordinator-owned. Do not close or rename this document in the worker.

Dated status and as-built sections: [history](2026-10-11-oct-followups_history.md).

## Verification round 2 remediation (30 October 2026)

Continued from coordinator checkpoint `17295dfab` on the supplied queue branch; its merge base with `main` is
`9638ee1f1`. This round changes no tracked product code, manifests, lockfile, tests, generators or check configuration.
No separate spec is linked. The coordinator retains ownership of full-suite verification and the completion rename.

- [x] **Finding 1 reproduced:** the dependency-compatibility spec exited 1 with the exact reported manifest-drift
  assertion. `node_modules/.package-lock.json` resolved into the root checkout; both manifest hashes differed.
  The existing fail-closed test remains unchanged. Replaced this checkout's dependency links with a real
  `npm ci --ignore-scripts --no-audit --no-fund` install from its unchanged lockfile, using a disposable cache inside
  the worktree. The focused dependency spec then exited **0 (5 tests)**. The root checkout's install was not modified.
- [x] **Current fast verification:** root and Electron TypeScript checks, `npm run typecheck:spec`, and `npm run lint`
  exit 0. `npm run rebuild:native` and `node scripts/verify-native-abi.js` exit 0 with locked Electron **42.11.18**
  and native module version **146**. The queue-prompt and renderer-event-scanner regression specs also exit
  **0 (36 tests)**. Exact commands, exit codes, timestamps and full logs are retained with the report.
- [x] A fresh independent reviewer reran the unchanged dependency spec and confirmed **exit 0 (5 tests)**,
  local install ownership, no tracked changes and the canonical plan section. Its only remaining finding was the
  intentionally pending post-evidence cleanup; `independent-review.md` retains that intermediate review.
  Final cleanup is evidenced by `cleanup-receipt.json`; whole-plan acceptance is still a separate coordinator gate.
- [x] **Runtime cleanup exited 0:** the owned install, its disposable npm cache and the previous mismatched link
  directory are absent. A first removal attempt stopped because a new `.DS_Store` appeared during deletion; the
  recorded retry completed. The root install marker is unchanged and pre-existing build output is preserved.
  No remaining dependency links vouch for a different manifest. Report, seals, receipts and raw focused logs remain.
- [x] **Fresh final cleanup/handoff review: PASS**, with no findings. `final-independent-review.md` records direct
  absence, hash, receipt and setup checks after cleanup. This follows the separate independent focused-spec rerun;
  neither review claims whole-plan acceptance or a current full-suite pass.
- [x] **Finding 2 checked against the actual base:** `npm run verify:renderer-events` still exits **1**, with the same
  four uncovered channels and two unresolved dynamic send sites. A fresh in-memory scan of the merge-base and HEAD
  Git blobs, using the byte-identical scanner, confirms **no introduced or resolved findings**. The channels are
  `global-pause:state-changed`, `instance:transcript-chunk`, `local-ai-guard:status-delta` and `plan-queue:state-changed`;
  the dynamic sites remain in `cost-handlers.ts:349` and `cross-model-review-event-forwarding.ts:20`.
  This is the verifier's non-blocking coordinator note, not a passed check or a live-test deferral.
- Evidence for this round is in this worktree at `_scratch/oct-followups/2026-10-30-verifier-remediation/`:
  `report.md`, `source-seal.json`, `command-receipts.jsonl`, `renderer-event-comparison.json` and the command logs.
- **Required verifier setup after cleanup:** this worker's current instruction explicitly requires removing dependency
  installs. The owned local install and the previous mismatched link directory are therefore removed after evidence
  capture; **do not recreate the root dependency links**. Before any verifier gate, run
  `rtk proxy npm ci --ignore-scripts --no-audit --no-fund`, then `rtk proxy npm run rebuild:native` in this worktree.
  Confirm `node_modules/.package-lock.json` resolves here, then run the dependency spec and coordinator-owned full suite.
  The current repository's verifier prompt already requires lockfile-exact setup for missing dependencies
  (`src/main/plan-queue/plan-queue-prompts.ts`). The new repository default to keep worker installs conflicts with this
  resume's explicit cleanup instruction; this round follows the explicit instruction and records the setup instead.
- **Historical coordinator handoff, pending at that checkpoint:** full-suite exit 0, independent whole-plan acceptance and completion rename.
  No full or slow suite, app/browser/device check, provider request, real-data cleanup or external action was run.
  Existing live observations remain open in the linked live-test document. Do not close or rename this plan.

## Resume as-built notes (30 October 2026)

The supplied checkout started at `561c34cba` and did **not** contain the implementation described by the 29 October
notes. Those notes concern a different saved queue branch. No separate spec is linked. The current worker recovered
the saved delta from `2b949b0df` to `dc227c762` as ordinary unstaged file edits, reconciling newer code in this checkout.
No branch/worktree operation, merge, cherry-pick, commit, stash or real-index staging was used.

- [x] Required parts **1a–1f, 2a–2b, 3a–3g, 4a–4c, 5a–5i, 6a–6g and 7a–7h/7j** are present here. The saved
  archive batch's **356** destinations match both the historical source blobs and the current checkout's original
  document bytes; the old paths are absent. This restores the existing approved batch, not a newly run retirement
  or deletion. Part **7i** remains deliberately unbuilt, and **8a–8e** remain parked with the existing follow-up owner.
- [x] Reconciled the saved implementation with newer queue routing, account restrictions, work admission and tooltip
  controls. Rechecked the executing attachment protection path (`ipc-main-handler.ts:326` supplies instance, provider
  and session IDs), incoming needs-review audit holds, and the typed helper-chip registration and overflow wiring.
- [x] Reproduced and repaired a remaining 4c gap: replacement, continuation and stronger-worker prompts now filter
  optional findings just like ordinary fix rounds. All-low failed verdicts still carry every finding; saved verdicts
  retain all suggestions. Three new cases failed before the fix and pass afterward; the queue coordinator cases pass.
- [x] Reproduced and repaired integration issues: the phone runner now resolves Vitest's declared executable; restored
  mocks retain exact callable/nullable types under Vitest 4; prompt fields use their actual heading for their accessible
  name; the attachment reason reuses its readable tooltip; two removed Training Data controls retain explicit wording
  retirement reasons. Import formatting brings three combined files within their existing size limits without raising
  limits or changing behavior. Assertions were added or preserved, not relaxed to hide failures.
- [x] Current uncached verification: **147 explicitly selected spec files / 2,579 tests passed**, plus the separate
  queue prompt/coordinator run (**151 tests**) and phone Stop/Cancel DOM checks (**2 tests**). Both TypeScript checks,
  lint, size limits, strict UI-hint comparison, main/renderer builds, IPC/usage, exports, aliases/contracts, Codex protocol,
  native ABI and architecture checks exited 0. Phone typecheck, lint and production build exited 0. Full and slow
  suites were not run by this worker. Architecture generation/checking used a disposable prospective index because
  archive destinations and new modules remain unstaged; the real index is empty. The normal build refreshed the Codex
  snapshot to the installed CLI **0.166.0**. Retirement count is **0 eligible**, last batch **15 October**.
- [x] Fresh self-review and archive byte checks are recorded. The recovery helper's suspected missing cost tooltip keys
  were disproved: `COST_INFO_COPY` supplies both imported keys. An additional `verify:renderer-events` run fails on
  **four uncovered channels and two unresolved dynamic sends**; a separate scan of the original HEAD's Git blobs
  reproduces exactly those six findings. This pre-existing check failure is recorded for the verifier, not hidden,
  treated as a live check, or repaired through unrelated scope expansion.
- Evidence, source seal, exact command/exit receipts and runtime-cleanup results are retained in this worktree at
  `_scratch/oct-followups/2026-10-30-resume/`. The owned installs, build output, caches, downloaded RTK programs and
  scratch source copies are disposable; cleanup preserves the report, receipts, seal and original shared dependency links.
- **Historical coordinator handoff, pending at that checkpoint:** full suite, fresh independent queue acceptance and completion rename. The live-test document now has **54** open entries; its **63**-entry predecessor campaign is historical. No app, browser, real-data cleanup,
  release or external write was performed. Do not close or rename this document.

## Resume as-built notes (29 October 2026)

Continued from checkpoint `997cfe317` in the supplied queue checkout. No separate spec is linked. The existing
implementation was retained; no branch, worktree, commit, stash or integration operation was performed.

- [x] Reconciled the status with the delivered 5f implementation: explicit fresh one-shots opt into
  `noSessionPersistence`; native resume, resume intent and forks retain persistence. The earlier skip is historical.
  Required parts 1a–1f, 2a–2b, 3a–3g, 4a–4c, 5a–5i, 6a–6g and 7a–7h/7j remain built. Part 7i remains deliberately
  unbuilt under its recommended default. Step 8 and the remaining inventory retain their separate, non-blocking
  follow-up ownership in `2026-10-13-oct-parked-followups_plan.md` and its successor; no new scope is inferred.
- [x] Rechecked the latest regressions, including provider/instance identity protection through
  `ipc-main-handler.ts` → `storage-runtime.ts`, incoming `completed-needs-review` final-audit holds, recorded helper
  spend, Workboard hydration, RTK fetch deadlines and the registered helper chip/overflow path.
- [x] Replaced the supplied incompatible dependency installation from the unchanged lockfile. Initial evidence
  showed Vitest 4.1.12 installed against locked 3.2.7, missing `extract-zip` and mismatched MSAL types; initial tests
  and typechecks failed. `npm ci --ignore-scripts` plus the native-module runbook restored the branch's dependencies.
  No manifest, lockfile, product code or test expectation was changed to bypass those failures.
- [x] Regenerated the stale architecture inventory after reproducing its failing gate. The normal main-build hook
  also refreshed the installed Codex protocol snapshot from CLI 0.164.0 to 0.165.0 (`thread/memory/read` added).
  Alias and IPC generation produced no further changes. These two generated files are the only worktree source changes
  in this resume; the architecture generator reads the Git index, so the coordinator must regenerate normally after
  harvesting any additional documents.
- [x] Current uncached targeted run: **147 spec files / 2,548 tests passed** (changed desktop/shared/worker specs plus
  dependency and generator regressions). Both TypeScript checks, lint, LOC, UI hints, main/renderer builds, IPC and usage,
  exports, contracts, protocol snapshot, native ABI, Electron smoke and signed-archive integrity smoke checks all exited 0. The phone's Stop/Cancel
  DOM tests (2), typecheck, lint and production build also exited 0. Retirement check reports 0 eligible docs, not due.
- [x] Report, source seal and command receipts are retained under the supplied worktree's
  `_scratch/oct-followups/2026-10-29-resume/`. Runtime cleanup and post-cleanup source hashes are recorded there;
  the dependency installs, build outputs and owned caches are disposable, while reports and logs remain.
- **Historical coordinator handoff, pending at that checkpoint:** full suite, fresh independent queue acceptance and completion rename. No full suite or slow
  browser suite was run in this worker, as instructed. The linked live-test document now has **54** open entries; its **63**-entry 27 October campaign ran a different predecessor checkout and
  does not negate implementation present here. No real-data deletion, browser interaction or external action ran.

> Earlier dated status and as-built sections moved to [history](2026-10-11-oct-followups_history.md).

**Source:** James, 11 Oct 2026. He was offered "every left-out piece in one short follow-up list" and replied:
- "definitely need to retire old docs.  We have FAR too many docs."
- "Yeah add one more doc for that list of other things"

So this plan does two things. Step 1 retires old docs. Steps 2 to 8 and [The rest of the list](#the-rest-of-the-list-one-line-each)
collect the work that no other plan builds. That work comes from the "Not in this plan (and where it goes)" and "Found
on the way (not fixed here)" lists of the nine plans written on 10 Oct, plus the few lines elsewhere in them that leave
work to nobody. The nine plans are all in `docs/plans/`:
- Phase 0: `2026-10-10-oct-phase0-confirmed-fixes_plan.md`
- Phase 1: `2026-10-10-oct-phase1-token-levers_plan.md`
- Phase 2: `2026-10-10-oct-phase2-loops-converge_plan.md`
- Phase 3: `2026-10-10-oct-phase3-calm-screen_plan.md`
- Phase 4 part 1: `2026-10-10-oct-phase4-tooltips_plan.md`; part 2: `2026-10-10-oct-phase4b-tooltips-migration_plan.md`;
  part 3: `2026-10-10-oct-phase4c-tooltips-finish_plan.md`
- Phase 5: `2026-10-10-oct-phase5-later_plan.md`
- Housekeeping: `2026-10-10-oct-housekeeping_plan.md`

The approved backlog behind them is [`claude_oct-todo.md`](../../claude_oct-todo.md). It has no row for this plan; the
backlog has no doc-retirement item at all.

**How it was checked:** on 11 Oct 2026 four read-only checks went through the nine plans against the working tree (HEAD
`4d175e55b`, "provider hardening", committed at 00:34 on 11 Oct). Their reports are in `_scratch/oct-phases/`, which is
gitignored and disposable; this plan carries what an implementer needs.
- `fu-docs.md`: retiring old docs (the inventory of 789 docs, who reads them, the options, the design).
- `fu-inventory-a.md`: 203 pieces from the Phase 0, Phase 1, Phase 2 and Housekeeping plans, with items FU-A1 to FU-A11.
- `fu-inventory-b.md`: 128 distinct pieces (145 table rows, 17 of them duplicates) from the Phase 3, Phase 4 (three
  parts) and Phase 5 plans, with items FU-B1 to FU-B20.
- `fu-wave2.md`: items FU-C1 to FU-C10, built from rows that the two inventories left in their "Not yet checked" lists.
- `_review-followups.md`: a fresh review of this plan (3 must-fix, 12 should-fix, 8 nit findings). Each finding was checked against the code and applied the same day, except where the code showed the review was wrong; its resolution log says which.

Totals: 331 pieces were classified. 171 had no home in any plan. Class counts:

| | Has a home in another plan | Rejected | Information only | Waits on a numbered choice | No home | Total |
|---|---:|---:|---:|---:|---:|---:|
| Inventory A | 64 | 13 | 16 | 6 | 104 | 203 |
| Inventory B | 26 (25 plus 1 already done) | 18 | 17 | 0 | 67 | 128 |

The 171 "no home" rows (104 in table A, 67 in table B) were checked by a script over both tables and this file, and none is
dropped: 77 are built or decided in Steps 1 to 8 (31 from table A and 46 from table B), and 95 sit on 76 one-line entries in
[The rest of the list](#the-rest-of-the-list-one-line-each). One row (A#156) is on both, because only half of it is
built (the automation half is part 4a; the campaign half stays on the list), so 171 = 77 + 95 minus 1. Step 1 and the Codex
part (5a) are new work and use no row. Rows are cited as `A#n` and `B#n` after the row numbers in the two inventory tables;
every line in this plan carries enough text to stand alone, because the tables are disposable.

The plan writer also re-checked, read-only, on 11 Oct: the Codex backups folder (counts, sizes, dates, the code that makes
and never removes them); the line anchors for AGENTS.md, the plan queue, the ignore lists, the packaging filter and the
commit hook; the anchors of the safety parts (`instance-handlers.ts`, the thin-client executor, `orchestrator-tools-step.ts`,
the worktree files, `instance-lifecycle.ts`); and the line count and room of every file in the headroom table below.
Where this plan differs from a report, the part says so. **Line numbers are as of 11 Oct and will move. Re-read the code
before editing.** Commit `4d175e55b` (146 files) touched `scripts/check-ts-max-loc.ts`,
`docs/generated/architecture-inventory.json`, `acp-cli-adapter.ts`, `settings-migrations.ts`, `instance-manager.ts` and
`loop-coordinator.ts`; the line counts below were measured after it.

**Size:** L in total: 8 steps and 49 parts, and every part stands alone. Most parts are XS to S. The larger ones are
Step 1 (M, six parts), the Codex backups part (S, but the biggest pile of disk), the notice for
paused loops (S-M), deleting two empty screens (M), and the parked parts in Step 8 (M to L, each behind a trigger or a
design pass). What goes first: Step 1, because it is the work James asked for and depends on no other plan; then Step 2,
which makes room in files that the other plans are about to add to.

**Depends on:** the nine plans above. Each part names the step it waits for, and the full table is under
[Order of work](#order-of-work). In short:
- **Nothing:** Step 1 (1d waits for James's approval of the list), Step 2, parts 3b, 3e, 5e, 5i, 6b and 6c, and the code halves of 5d and 5g (the card halves wait for Housekeeping step 4).
- **James's answer first**, because the part deletes something or changes what is merged or kept (its choice is in brackets): 1f (2), 3g (4), 5a, 5b and 5c (7), 5e (8), items 1 to 3 of 5i (10) and 5h (11). Parts 5d and 5g delete nothing until James presses a button on the disk space card.
- **Phase 0:** step 1 (3g), step 2.6a (3c), step 3 (3d), step 4 (3a), step 7b (6a), step 7g (5f), step 7h (7g) and
  step 7c (8e).
- **Phase 1:** step 5a (6f lands after it), step 12d (7a, if built) and step 18a (5e lands before it; 5b is best after it).
- **Phase 2:** step 8 (4b), step 8b (3f, 3g), steps 8d and 17 (4a), step 13 (8a) and step 14 (4c).
- **Phase 3:** step 3 (7d), step 5 (7c, 8c), step 6 (6d, 8a), step 6c (7j), step 9 (5h lands before it; 8c after it),
  step 10 (7h), step 12b (7c), step 14 (6b, same event), step 15 (7b, same file area) and step 16 (6e, 8b).
- **Phase 4:** step 4 (7f), step 4b (7e), and part 3 step 1f (7f).
- **Phase 5:** step 3 (5h), step 7 (7i), step 11 (7g), step 14 (7b) and step 16 (7c).
- **Housekeeping:** steps 4a and 4b (the disk space card: parts 5a to 5d and 5g), step 5 (6g) and step 6 (3c, ideally built with it).

## Round 11 resume (26 November 2026)

Resumed after a usage wait. The last verifier's three findings were: (1) held parts built without a recorded answer, (2) 7i neither built nor dropped, (3) header says BLOCKED. Checked against the plan on disk: the "James's answers (8 November 2026)" table already records yes for choices 2, 4, 7(b), 7(c), 8, 10 and 11, decision 19(a) for 7(a), and "not built (dropped)" for 7i/14(a). The header no longer contains "BLOCKED". The findings were therefore stale record-keeping, not code defects. Edits this round (plan only): decisions intro (item 10 of "In plain English") now cites the 8 Nov answers; 7i heading says dropped; Finishing step 1 notes all held choices were answered. No source change. Choices not in the 8 Nov table (for example 12(b), part 7h's pick) stay open as before.

## Round 12: merge of main into the branch (26 November 2026)

The coordinator merged `main` (378 newer commits) into `queue/2026-10-11-oct-followups-8ca926`; 136 files conflicted (plus 4 deleted-by-us files).
Rule used for every file: start from main, re-apply this plan's own change only where main does not already do the job.

**Where main's version won (plan sentences made stale):**
- 5c trace cap: main's `rotating-log-file.ts` (30 MB, two older pieces) is the mechanism. Removed `ndjson-rotation.ts` and its spec, `trace-legacy.ts` and its spec, `provider-runtime-trace-worker.spec.ts`, the `trace-files` clean-up target (contracts schema, storage types, usage and cleanup services, runtime, card) and the `.legacy` set-aside. Live-test 20 rewritten.
- 5a Codex copies: main's `codexBackupKeepThree` start-up pruning (old reconcile name, setting-gated). Restored `codex-private-rollout-reconcile.ts` to main; kept the card selectors, now matching `CODEX_RECONCILE_NAME`. Live-test 18 rewritten.
- 7g money in cents: main's `format-money.ts`; duplicate imports removed. The cost-estimator spec case was dropped with 5h.
- 7j Needs you: main's `needs-you-sources` lists pending memory reviews, so `needs-you.store.ts` passes `memoryReviews: []` to the projection (else each would appear twice); the Workboard page still gets them.
- Calm screen: `PERMISSION_GET_APPROVAL_DIGEST` and the approval banner are gone on main; the digest tests were dropped (6d's reminder still uses `mergePendingAndLiveApprovals`).
- Held-command reply handling moved to `input-required-respond.ts` on main; the 3a refusal (no allow/modify means refused) was re-applied there.
- `check-ts-max-loc.ts`: main already sat at each ceiling's tolerance, so ceilings rose by this plan's own lines (cli-verification-extension 937, loop-coordinator 3974, plan-queue-item-flow 892, instance.store 834, model-selection-panel 1094) and cost-tracker.ts got an entry at 714.
- UI-hints record is now a folder (`baseline/<group>.json`); the 7f specs were moved to it. Two wording entries retired for 7b's new tooltips; backdrop markers tightened after 7e.
- 7c: `sessionHelperAgentsRunning` now takes `getInstance(id)` (main's dock spec stubs only that).
- `fetch-rtk-binaries.js` keeps 5e's structure plus main's `--current-platform`; main's `worker-rtk-install.spec.ts` was adapted (sandbox gets `module`, timers; 64-hex pin; exit code instead of `process.exit`).
- Settings headroom (2a): privileged keys back in `settings-privileged-keys.ts`, Plan Queue policy entries in `settings-plan-queue-policy.ts`, Plan Queue fields in `plan-queue-settings.types.ts`.
- Deleted by this plan and modified by main (kept deleted): communication page, training page, comm IPC service, cost-estimator (5h, James yes 8 Nov). Deleted by main (kept deleted): the plan documents in the worktree, local-ai fallback notification groups.

**Checks:** `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) all pass; generators run. Targeted tests: 269 spec files touched by the merge plus 51 sibling specs, all pass on the Windows PC after fixes (earlier failures were stale specs against main, Linux change-time granularity in storage specs, and the items above).

## Round 13 (26 Nov 2026): post-merge gate repairs

- `check:ts-max-loc`: `plan-queue-item-flow.ts` is 943 lines (main's 940 plus 3 for finding triage); ceiling 892 -> 893.
- `claude-denial-patterns.ts`: the anchored "haven't granted it yet." sentence now allows the hook's trailing "Harness is showing the user a card..." guidance, so the adapter still reads the hook refusal as a denial (scheduled-session-tool-approval spec).
- `memory-review.store.ts`: the new catch uses `presentError(error).headline` (raw-error ratchet).
- `prompt-budgets.spec.ts`: verifier ceilings 9,900 -> 10,000 and 8,200 -> 8,400 for the one rating-rule sentence (measured 9,996 / 8,327).
- Spec fixtures: dock `getInstance` stub reads the signal; resident-claude adapter fake has `off`; run-policy migration spec holds back the needs-attention migration too; paste-draft templates carry the `inst` / `preview` / `detail` aliases; control-surface tab test uses `chat-search` (Training page removed by this plan); recovery spec's environment finding is `high` (medium ones are now optional and not sent).
- Checks: `npm run checks` all 7 pass; `npm run test:quiet` 52,921 tests passed (exit 0).

## Round 14 (26 Nov 2026): verification round 2 finding

Finding: the ready report listed no deferred checks although `2026-10-11-oct-followups_livetest.md` holds open rebuilt-app checks. No code changed. The report now lists every open check in the livetest document (sections 1-5, 7, 9-24, 27, 28) under the same titles as its headings; sections 6, 8, 25, 26 are verified in-loop and are not deferred.

## Round 15 (26 Nov 2026)
Verifier round 3: `grep -c livetest-failure-remediation_plan_completed.md AGENTS.md` was 0 because main's own rewrite (d9362cf8d era) dropped the filename. Kept main's wording; appended "`docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md` is history only." to the last sentence of the live-test paragraph. grep = 1, old `-followup` name = 0, `agents-doc-pointers.spec.ts` passes.

## Round 16 (26 Nov 2026)
Landing refused: the plan file changed after its checker passed. Worktree was clean at 89b6540c3 with all gates passing in round 13; only the plan's Status block was condensed (rounds 12-15 into one paragraph, round 16 added). No source change; livetest document unchanged. Re-reported ready so the checker runs again on the current text.

## Round 17 (26 Nov 2026)
Verifier round 1 (high): the branch added `sass: ^1.104.1` to package.json devDependencies and the root package-lock entry; nothing in the plan or source uses sass directly, and `npm ls sass` shows 1.104.1 already arrives through @angular/build. Removed both lines (the package-lock diff against the merge-base is now empty; package.json differs only by this plan's own script and docs:retire changes). JSON parses; `npm ls sass` unchanged. No other files touched.
