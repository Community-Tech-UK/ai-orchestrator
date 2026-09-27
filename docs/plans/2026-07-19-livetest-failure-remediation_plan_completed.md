# Live-Test Failure Remediation Plan

**Register:** [livetest-remediation-register.md](livetest-remediation-register.md)

**Status:** Code complete and verified 2026-09-23; rebuilt-app, privileged, and external checks remain in linked `_livetest.md` documents. This plan implements the LT-001..007 remediation index in
the spec's documented order, then sweeps the remaining pending `_livetest.md` backlog per the
spec's Completion Criteria.

**Historical status sweep 2026-09-20 (superseded where later sections say otherwise).** Every item section below whose header still read OPEN / not fixed was
re-checked against the executing code rather than against its own prose. Five headers were stale and
are corrected in place: LT-055 and LT-481 were in fact built (lazy semantic indexing; baseline-aware
Snooze), and LT-016/LT-017/LT-018 were duplicate 2026-07-29 triage entries already superseded by
their own FIXED sections further down. The items that remain genuinely open are LT-014, LT-100 and
LT-196 (each needs a product/architecture decision from James, not code) and LT-441 (root cause not
isolated; needs DTrace or equivalent). Everything else is either fixed or fixed-in-code awaiting a
worker redeploy or a rebuilt app, which is live-test work tracked in the owning `_livetest.md`
documents, not implementation work. The full canonical gate set is green on this tree as of
2026-09-20 (2167 files / 25734 tests).

**Historical status sweep 2026-09-23 (before the later remediation pass).** The 2026-09-20 note above was stale on three
items: LT-014 was closed on 2026-07-29, LT-100 fixed and live-verified on 2026-08-12, and LT-196 fixed
on 2026-09-13 (their register rows already said so). The same sweep found four register rows with no
status marker that were genuinely open and fixed three of them: LT-022 (hidden-window heartbeat), LT-028
(hardened Codex now refused up front) and LT-105 (errored resident Claude turn completion). See the
section at the end of this plan. LT-208 was already fixed; its row is corrected. LT-189's banner was
removed by a later commit and is reported for a decision. The remaining hardened-mode items have
product-path mitigations and pending live diagnosis: LT-029 now keeps Keychain writes outside the
jail and gives credential-specific
sign-in/retry guidance;
an actual long-session token refresh still needs live evidence. LT-441 now refuses an ungranted
`CLAUDE_CONFIG_DIR` on the product spawn path; the earlier resident-mode OS write escape still needs
`fs_usage`/DTrace with sudo. Both pending checks are in
[`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md).

**Final code reconciliation (2026-09-23):** James chose to restore LT-189's passive banner; it is back
in source and awaits a rebuilt-app check. LT-050's fatal classification fix stands and its
child-confirmation handoff is repaired with bounded delivery and visible failure. LT-543's forwarder
logs persist with bounded inactive retention, including after host sleep while the owner PID lives.
LT-596/597 accounting follow-ups and the audited LT-539–613 code paths passed focused checks.
The canonical typechecks, lint, LOC check, main and renderer builds, and final full suite passed
(2,218 files / 26,397 tests; `_scratch/test-run.pid-17614.log`). A fresh independent
`task-completion-gate` review returned `VERDICT: PASS` with no actionable findings after its
LT-543 retention finding was fixed. The incident traces below remain historical. LT-029 and
LT-441 retain separate live-only security questions in
[`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md);
this code-status update does not declare those live checks passed.

## Approach

Work strictly through the spec's "Implementation and Retest Order" (LT-006/007 → LT-001 →
LT-002/003 → delivery-reconciliation re-run → LT-004 → LT-005 → remaining backlog). Each item:
reproduce with the smallest focused test, fix, add regression coverage, run the canonical
verification checklist, then re-run the linked live test(s) for evidence. A `_livetest.md` file
is renamed `_livetest_completed.md` only when every check in it passes with current evidence —
per this repo's Live-Test Deferral rules, anything a rebuilt/restarted app or human is genuinely
required for gets recorded in a `_livetest.md` file rather than deferred silently.

## LT-006 / LT-007 — live-test contract corrections (no production code defect)

- Added a sanitized `antigravity/basic-conversation` fixture pair (mirrors the existing `gemini`
  one; the replay mapper is provider-agnostic, so this is legitimate coverage) and a `CASES`
  entry in `fixture-replay.spec.ts`, keeping the `gemini` case for back-compat.
- Investigated `failover-manager.ts`'s `mapLoopProviderToProviderType` (excludes `antigravity`
  from circuit/cooldown bookkeeping) and the `~/.gemini` config-root reads across
  `gemini-quota-probe.ts` / `antigravity-mcp-adapter.ts` / `seatbelt.ts` etc. Both are pre-existing,
  intentional, correctly-documented behavior (antigravity genuinely shares `~/.gemini` config on
  disk) — not defects. No code change needed for either.
- Remaining work is wording-only: add "Computer Use is the supported interaction path" notes and
  swap illustrative `gemini` provider-list entries for `antigravity` in the specific pending
  `_livetest.md` files the spec names (WS1, WS7-phaseb, WS13, provider-agnostic-context-evidence,
  doc-review-delivery-reconciliation, codex-context-pressure-observability-discovery). Done as
  part of the backlog sweep below, preserving each file's dated historical evidence.

## LT-001 — browser gateway existing-tab grant scope mismatch

Root cause: `recheckPreparedGrant` (`browser-gateway-action-guard.ts`) omitted the `nodeId` scoping
that `prepareExistingTabMutatingAction` applies, both in the `listGrants` SQL filter
(`profile_id = ?` never matches the deliberately node-scoped `profile_id IS NULL` rows an
existing-tab grant is stored as) and the in-memory `grantMatches` check — so an approved
existing-tab grant could never be re-found on the immediate retry, and every retry re-prompted.

- Fix: compute `nodeId = existingTabGrantNodeId(request.profileId)` in `recheckPreparedGrant` and
  pass it through to both the store query and the match input, mirroring
  `prepareExistingTabMutatingAction`.
- Regression tests added to `browser-gateway-action-guard.spec.ts`: an approved existing-tab
  session grant matches its immediate retry; a grant does not broaden to a different node scope.
  Confirmed both fail without the fix (verified via `git stash`) and pass with it.
- Full browser-gateway suite (770 tests), `tsc` (main + spec), and lint are green.
- Outstanding: live re-run of Browser Permission UX Check 1 (approve → retry `browser.type`) in
  the rebuilt app, batched with LT-002/003 below.

## LT-002 / LT-003 — embedded doc-review CSP/iframe runtime + draft-state persistence

**LT-002 (CSP):** The artifact runtime is a byte-identical inline `<script>` across every
generated artifact (template substitution never touches it — only meta/head/content
placeholders). Added a `sha256-` hash source to `script-src` in `src/renderer/index.html` scoped
to exactly that script (no `'unsafe-inline'`, no sandbox/`allow-same-origin` change). A new spec,
`src/main/doc-review/artifact-runtime-csp-hash.spec.ts`, recomputes the hash from the tracked
template and fails loudly if a future runtime edit forgets to update the CSP.

**LT-003 (draft persistence):** Added `DocReviewDraftService` (localStorage, keyed by review id,
debounced write + `beforeunload` flush) and wired it into `DocReviewPageComponent`: `onReady`
seeds itemStates from any persisted draft for that review id; every decision/comment/choice/
overall/general mutation persists; the draft is cleared on successful submit or explicit dismiss;
a decided review never rehydrates a stale draft.

- New specs: `doc-review-draft.service.spec.ts` (8 cases: round-trip, isolation by id, clear,
  debounced persist + reload, `beforeunload` flush, corrupt-JSON and malformed-entry handling) and
  `doc-review-page.component.spec.ts` (4 cases covering seed-from-draft, per-mutation persistence
  + isolation + submit-clears, dismiss-clears, decided-review-never-rehydrates). Confirmed the
  page-component regression tests fail without the fix (import error / stale behavior) via
  `git stash -u`.
- `tsc` (main + spec) and lint clean; full doc-review suite (renderer + main, 12 files / 87 tests
  after these additions) green; `check:ts-max-loc` clean.
- Outstanding: live re-run of both Doc Reviews choice-controls scenarios (standalone already
  passes; embedded scenario 2 was blocked on exactly this CSP defect) and the delivery-
  reconciliation live test, in the rebuilt app — batched with LT-001 above.

## LT-004 — lifecycle exit classification (Codex app-server vs stateless exec)

Root cause (delegated investigation, independently reviewed and merged): `codex-app-server-adapter.ts`'s
app-server exit callback reset `useAppServer`/`spawnMode` to their non-resident values **before**
emitting `'exit'`. `instance-communication.ts` classifies the exit synchronously inside that same
listener via `isStatelessExecAdapter()`, which reads capabilities derived live from `useAppServer`
— so a genuine resident app-server death (or an interrupt racing the same path) read as a
non-resident/exec adapter and fell into the stateless-exec ignore path before either the
interrupted-instance or unexpected-exit recovery branches could run.

- Fix: reordered the emit relative to the state reset in `codex-app-server-adapter.ts` (16 lines).
  `getPid()`/`isRunning()` are unaffected — they already read `connectionPhase`, set
  `closed`/`failed` before this callback fires. No change needed in `instance-communication.ts`,
  `interrupt-respawn-handler.ts`, or `runtime-reconciler.ts`.
- 8 new regression tests across 3 spec files (capability-driven not name-driven classification;
  adapter still reports resident=true during its own exit listeners; integration-level busy/idle
  exit → `onUnexpectedExit`, in-flight interrupt → `onInterruptedExit` not `onUnexpectedExit`).
  Independently re-verified in the main tree (not just the delegated agent's own report): 133
  targeted tests pass, full `cli/adapters` + `instance` suites (1888 tests) pass, existing
  double-Escape/termination-during-respawn/resume-fallback/crashloop-backoff suites (60 tests)
  unchanged and still pass, `tsc` (main + spec), `ng lint` all green.
- Outstanding: live re-run of both linked lifecycle live tests (interrupt-respawn,
  unexpected-exit) in a disposable Codex app-server session — needs a rebuilt/restarted app and a
  real process kill, recorded as pending in both files.

## LT-005 — read-only local-personal `bench:retrieval --local`

Wired (delegated investigation, independently reviewed and merged): new
`openSqliteWasmFileReadOnly()` in `sqlite-wasm-driver.ts` (loads a real on-disk SQLite file's
bytes into a private WASM heap via `sqlite3_deserialize(..., SQLITE_DESERIALIZE_READONLY)` — a
genuine engine-level read-only connection, needed because the native `better-sqlite3` addon is
ABI-mismatched under plain Node/`tsx`) plus a new `local-suite.ts` (pure, root-injectable store
discovery — never a hardcoded home path; distinct `skipped`/`failed`/`ok` outcomes) wired into
`bench-retrieval.ts` via a single pure `planBenchActions()` function that keeps `--update-baseline`
provably isolated from `--local`.

- 21 new tests, independently re-run in the main tree, including a hash+mtime+directory-listing
  proof that a full run never writes anything, and a real `SQLITE_READONLY` write-rejection test.
  I additionally ran `--local` manually against throwaway fixtures in a temp directory (never
  James's real store) via the new `--local-user-data=<path>` override and confirmed
  skipped/ok behavior end to end. Full project suite (15,116 tests), `tsc`, `ng lint`,
  `check:ts-max-loc` all green; synthetic benchmark unaffected (same baseline result).
- **2 GiB ceiling now lifted (2026-07-22).** The flagged follow-up is implemented:
  `src/main/memory/retrieval-eval/local-suite-driver.ts` re-runs the local suite in a short-lived
  `ELECTRON_RUN_AS_NODE=1` child so the native `better-sqlite3` addon (opens the file in place with
  `SQLITE_OPEN_READONLY`, no whole-file heap load, no size cap) reads the store; the parent falls
  back to the WASM reader only when no Electron binary is installed or `--local-force-wasm` is
  passed. Driver selection, Electron-binary resolution, child argv, and the JSON result hand-off are
  pure and unit-tested (`local-suite-driver.spec.ts`, 17 cases). Verified live: `--local` against
  James's real ~2.4 GB `codemem.sqlite` / ~2.6 GB `rlm.db` now reports both `ok` and scores a real
  BM25 query (R@1=1.000, n=1) — previously both `failed`. Read-only proven by a `SQLITE_READONLY`
  write-rejection on the real store plus a byte-identical (SHA-256) before/after on a throwaway
  fixture; the WASM fallback still surfaces `failed` "greater than 2 GiB". WS16 Check 3 now passes
  against the real store; recorded in `2026-07-13-fable-ws16_livetest.md`.

## LT-012 — `build:main` broken by the TypeScript 6 upgrade — **FIXED 2026-07-27**

Discovered while trying to rebuild the dev app for the LT-008 retest, and blocking the entire
campaign. `tsconfig.electron.json` uses `moduleResolution: "node"` + `baseUrl`, which TypeScript
6.0.3 (introduced in `a7f18c43`, 2026-07-26 20:48) rejects as hard errors. `tsc` still emitted to
`dist/src/`, but the `&&` chain stopped before `sync-dist.js` mirrored it to `dist/main` — the path
Electron actually loads — so every build since that commit silently left stale main-process code.

- Added `"ignoreDeprecations": "6.0"` to `tsconfig.electron.json` with a comment recording that
  node16-resolution migration is separate work. `npm run build:main` now exits 0 and refreshes
  `dist/main/index.js`.
- Note the gate gap this exposed: `tsc --noEmit` and `tsc --noEmit -p tsconfig.spec.json` were both
  green throughout, because neither uses `tsconfig.electron.json`. "Gates green" did not imply
  "the app can be rebuilt".

## LT-008 — fork-resume destroys live Claude sessions — **FIXED 2026-07-27, verified live**

The 2026-07-26 root cause was correct but **incomplete**: fixing only the resume-source id did not
resolve it. A live re-run with that fix in place reproduced the failure identically, which isolated
two further causes. All three are fixed:

1. **Resume source id** (`runtime-reconciler.ts:238-247`, and the same defect in
   `instance-lifecycle.ts` `changeAgentMode`). The fork's target id was minted locally and passed as
   the resume source. Now captures `resumeSourceSessionId = instance.sessionId` before mutation and
   spawns with `shouldResume ? resumeSourceSessionId : newSessionId`, mirroring
   `interrupt-respawn-handler.ts`, which had always been correct.
2. **A fork could never be proven healthy** — the actual reason the session died.
   `claude-cli-adapter.ts` set `confirmed = (session_id === requestedSessionId)` and
   `runtime-readiness.ts:getResumeProof` returned `false` on any id mismatch. A `--fork-session`
   resume returns a **different** id by definition, so the proof was guaranteed to fail →
   `unrecoverable` → teardown. Added a `forked` flag to `ResumeAttemptResult`: a fork confirms on
   receiving any authoritative `session_id`, and the mismatch rule is skipped for forks.
3. **Fresh-fallback did not strip listeners before terminating.** The doomed resume adapter's
   SIGTERM exit (code 143) was handled as a real instance exit → `error`, so the follow-up
   `sendInput` died on `Illegal transition: error → busy` — the visible symptom.
   `applyRecoveryRespawn` has always called `removeAllListeners()` first; `applyRuntimeChange` and
   `changeAgentMode` never did. Both now do.
4. The runtime-change path also collapsed an `inconclusive` resume-health verdict to "destroy the
   session". It now shares the recovery path's `resolveResumeHealth` policy (retry once, then keep
   the live session). The now-unused `waitForResumeHealth` dep was removed from
   `RuntimeReconcilerDeps`.

**Regression coverage:** new `runtime-reconciler.runtime-change.spec.ts` (6 cases: fork resumes from
the live id; `instance.sessionId` still advances; no error status; non-fork passthrough;
inconclusive keeps the session; unrecoverable still falls back). Confirmed failing on the pre-fix
source with the exact defect signature — `expected 'minted-fork-id' to be 'live-claude-session'` —
not an incidental error. Plus 2 cases in `runtime-readiness.spec.ts` locking fork-vs-non-fork proof.

**Live verification** (dev app, real Claude `opus[1m]` session, real turns): toggle returns
`success: true` in 2.0 s, instance stays out of `error`, log records
`continuity: 'native-resume-fork'`, and the post-toggle session recalls the pre-toggle word
("BANANA"). `Failed to spawn with resume` / `not stabilize` / `Illegal transition` each occur **0
times**. Recorded in the yolo-mode livetest doc; checks 1 and 3 now PASS.

## LT-008 (original 2026-07-26 diagnosis, superseded above)

Found 2026-07-26, reproduced 2/2 on a real Claude session in the dev app. Every yolo toggle (and any
runtime change resolving to `native-resume-fork`) tears down the live session and replays into a
fresh one; the toggle IPC returns `Illegal transition: error → busy`.

Two changes required, both in `src/main/instance/lifecycle/runtime-reconciler.ts`:

1. **Lines 238-241** — for the fork branch, stop pre-generating the target id and passing it as the
   resume source. Pass the existing `instance.sessionId` as the source and let the CLI mint the
   forked id (the adapter already adopts the authoritative id from the init message,
   `claude-cli-adapter.ts:1080-1084`), or extend `UnifiedSpawnOptions` with a distinct source field.
2. **Line 301** — the runtime-change path collapses an `inconclusive` resume-health verdict to
   `false` and destroys the session. Apply the recovery path's policy
   (`resolveRecoveryResumeHealth`, line 488): retry once, then keep the live session.

Regression coverage to add: a yolo-only change on a Claude instance with history keeps its provider
session id and does not enter `error`; an `inconclusive` verdict on a runtime change does not
terminate the adapter. Both must be confirmed failing on the pre-fix source.

Retest: `docs/superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest.md` checks
1, 2 (apply half) and 3.

## LT-009 — skill registry is empty — **FIXED 2026-07-27, verified live**

Root cause: **built-in skills never reach the compiled tree.** Every builtin is a `SKILL.md` — a
non-code asset that `tsc` does not emit. `SkillRegistry.getBuiltinSkillsPath()` resolves
`path.join(__dirname, 'builtin')` *inside the compiled tree*, i.e. `dist/main/skills/builtin`,
which simply did not exist. Discovery therefore found 0 builtins in every build, dev and packaged.

`scripts/sync-dist.js` already had a copy step for doc-review's assets with the comment
"TypeScript does not emit non-code assets" — the skills directory was just never added to it.

**Why no test caught it:** under vitest, `__dirname` resolves to the **source** tree, so
`builtin-skill-routing.spec.ts` calls `discoverSkillsWithBuiltins([])` and passes against
`src/main/skills/builtin`. The app runs from `dist`. A unit test structurally cannot catch this
class of defect.

- Fix: copy `src/main/skills/builtin` into the compiled tree in `sync-dist.js` (filtering colocated
  `*.spec.ts`), so `dist/main/skills/builtin` exists. `electron-builder` packages `dist/**/*`, so
  the packaged app is covered by the same change.
- Guard: `sync-dist.js` now asserts the built-in skills and doc-review asset directories are
  non-empty in `dist/main` after the copy and exits 1 otherwise — a build-step check, since a unit
  test cannot see the compiled tree. Verified in both directions (passes normally; exits 1 with
  `built-in skill bundles missing or empty after copy` when the copy is disabled).
- Two adjacent defects fixed at the same time, both of which would have kept the feature dark:
  the `skills:discover` handler called `discoverSkills` rather than `discoverSkillsWithBuiltins`
  (so the Skills page never listed builtins even when discovery worked), and
  `SkillsDiscoverPayloadSchema` required `searchPaths.min(1)`, which forbids a builtins-only
  discover.

**Verified against the compiled tree**, not the source: requiring `dist/main/skills/skill-registry.js`
(after `register-aliases`) and calling `discoverSkillsWithBuiltins([])` returns **17** skills, and
`getBuiltinSkillsPath()` resolves to `dist/main/skills/builtin`.

**Live verification** (dev app over CDP, real IPC): `skillsDiscover()` returns
`success: true, count: 17`, and `skillsList()` then returns 17 including `test-stabilizer` — the
skill whose slash form previously came back as `Unknown command`. Before the fix, the same call in
the same app returned 0.

Retest: `2026-07-23-skill-observability-and-design-skills_livetest.md` checks 2, 4, 7, 9 — check 1
of the registry precondition now passes; the send-path activation checks still need a run.

## LT-010 — sync handler uses `workingDirectories` instead of the file-transfer roots — **CODE FIXED 2026-07-27, awaiting worker redeploy**

Found 2026-07-26 against the live windows-pc worker; confirms and root-causes the 2026-07-24 report.
Origin: `src/worker-agent/worker-agent.ts` built `SyncHandler` from `config.workingDirectories`, so
the sync tools rejected the exact roots `upload_to_node` accepts.

- `SyncHandler` now takes `{ readRoots, writeRoots }` (the legacy `string[]` shape still means
  read+write, so existing callers are unaffected). Reads use `assertReadable`, writes
  (`applyDelta`, `deleteFile`) use `assertWritable`, and a write into a read-only root is refused
  as **"Path is in a read-only root"** rather than the misleading "outside allowed roots".
- `getSyncHandler()` builds `readRoots` from working directories plus every file-transfer root, and
  `writeRoots` from working directories plus the roots flagged `write`. The memoized handler is now
  invalidated in `rebuildFilesystemHandler()`, so a `fileTransfer` or `browserAutomation` config
  update cannot leave a stale allowlist behind (the browser-downloads root is derived from the
  browser manager).
- Regression coverage: `sync-handler.spec.ts`, 6 cases. The last case pins the pre-fix wiring
  (`new SyncHandler([workingDir])`) and asserts it rejects the transfer root — the reported bug,
  captured as a negative control.

**Still requires a worker redeploy** to take effect on windows-pc, not just an app rebuild — so
check 5 cannot be re-run from here.

Retest: `docs/plans/2026-07-16-worker-controller-file-movement_livetest.md` check 5, run against the
`aio-transfers` scratch root exactly as its recipe is written.

## LT-011 — checks that assert on signals the app never emits — **FIXED 2026-07-27**

One of the four sub-items was a **misdiagnosis and is withdrawn**; the rest are fixed.

- **Withdrawn:** `Browser gateway MCP disabled for instance` *is* logged, and has been since commit
  `c3d3714a` (2026-07-17), at `spawn-config-builder.ts:322`. It matched 0 times on 2026-07-26
  because no instance in that app had `browserToolsMode: 'off'`. History-restore check 4 is
  runnable as written — create the instance with `browserToolsMode: 'off'`, then grep.
- **`restoreMode` per rung:** `HistoryRestoreCoordinator.restore` is now a thin wrapper around
  `restoreInternal` that logs `History restore complete { entryId, restoreMode, instanceId,
  sessionId, historyThreadId }` at the single exit point, so all three rungs (`native-resume`,
  `resume-unconfirmed`, `replay-fallback`) are log-observable from one line.
- **`VectorStore.getStats()` read surface:** `vector-store.ts` now logs
  `VectorStore residency changed { event, storeId, totalVectors, residentStores,
  maxResidentStores, storeCount }` at the two moments residency actually changes (store load and
  eviction), rather than on a timer.
- **Stale preload wrappers:** `skillsDiscover` now sends `{ searchPaths }` and `skillsMatch` sends
  `{ text }`, matching their contracts. `SkillsDiscoverPayloadSchema` dropped `.min(1)` so a
  builtins-only discover is expressible. Confirmed live: `electronAPI.skillsDiscover()` returns
  `success: true` with 17 skills where it previously failed Zod validation.

Retest: history-restore checks 1-4; rlm-vector-store check 2. Both now have signals to read; the
checks themselves still need a run against real archived conversations / the real RLM corpus.

## LT-013 — a deliberate terminate archives a session id that never existed — **FIXED 2026-07-27 (session 2), verified live**

Found while running history-restore check 1, which had failed the same way in session 1 and was
assumed to be a check/environment problem. It was not: **every** archived Claude conversation
recorded a provider session id with no transcript on disk, so History restore could never reach the
`native-resume` rung. Measured 4 of 4 across two independent campaigns.

Root cause: `terminateInstance` SIGTERMs the adapter while the instance is still `idle` and only
calls `markTerminated()` after archiving, so the adapter's own exit (code 143) reached the
still-attached `instance-communication` listener, whose guard is `instance.status !== 'terminated'`.
A deliberate terminate was therefore classified as an **unexpected** exit and fired
`respawnAfterUnexpectedExit`, which assigns `instance.sessionId = generateId()` for its fork plan
*before spawning anything*. `archiveRootConversation` read that value ~30 ms later. The respawn then
aborted (`Skipping auto-respawn after CLI resolution`) without ever spawning — its only lasting
effect was destroying the archive's resume anchor.

- Fix: detach the adapter's listeners before terminating it
  (`instance-termination.ts`), the same remedy as LT-008 item 3 and the long-standing spawn-rollback
  path. One line plus the reasoning in a comment.
- Regression coverage: new `instance-termination.spec.ts` (5 cases — the terminate exit reaches no
  subscriber; the archive captures the live session id; teardown still completes; an errored
  instance still archives as `error`; an adapter without `removeAllListeners` is tolerated).
  Confirmed failing on the pre-fix source with the exact defect signature,
  `expected 'minted-fork-id' to be 'live-claude-session'`.
- Verified live against the rebuilt app: the archived `sessionId` now equals the id whose `.jsonl`
  exists, restore reports `restoreMode: native-resume` with no fallback notice, and the restored
  session recalls the pre-archive conversation from the provider side ("MANGO, ORCHID").
- Gates: `tsc` (main + spec), `ng lint`, `check:ts-max-loc`, `build:main`, `src/main/instance` +
  `src/main/history` (1111 tests) all green.

Retest: history-restore checks 1 and 3 — both now **PASS**.

## LT-014 — restore-ladder contract conflict (decision needed, no code change)

History-restore check 2 asks a dead provider session to land on `replay-fallback` with a
"could not be restored natively" notice and `nativeResumeFailedAt` recorded. Driven live it reports
`resume-unconfirmed` with none of those.

That is **deliberate**: Claude spawns fresh under the same id when it finds no transcript, so the
process is alive, and the coordinator only demotes to `replay-fallback` for a *dead* instance. Two
tests lock it with their rationale in comments, and the migration plan records "no change to ladder
semantics". Reversing it was attempted this session and **reverted** — satisfying a check's wording
by silently overturning a documented design lock is not a fix.

Two changes were kept, neither of which touches the rung:

- The post-spawn probe now stops as soon as the adapter reports a definitive answer instead of
  burning the full window, removing a 5 s stall on every restore of a dead session.
- `getAdapterResumeProof` no longer treats a **forked** resume's new session id as proof of failure.
  `ResumeAttemptResult.forked` documents that consumers must not do this (LT-008); this consumer
  did.

Both are locked by 3 new cases in `history-restore-coordinator.spec.ts`, confirmed failing on the
pre-fix source (`expected 4000 to be less than 1000`;
`expected 'resume-unconfirmed' to be 'native-resume'`).

Retest: history-restore check 2 stays **open** pending James's decision — see LT-014 in the
register for the two options.

## LT-015 — runtime-change system notices are model-only (decision needed, no code change)

YOLO checks 1, 2 and 4 assert the transcript *shows* `[System: YOLO mode enabled …]`. It is never
rendered: `app-output-stream`'s own `messages()` and `textContent` both lack it, because
`runtime-reconciler.ts` emits these notices with `adapter.sendInput(...)`, which writes straight to
the CLI — only `InstanceCommunication.sendInput` records a visible message.

The notices *are* delivered (the session answered YES when asked, and after check 4's combined
change volunteered "model switched to Sonnet and YOLO mode is off"). So this is a
where-is-it-observable question, not a lost-message one. Recorded for James rather than fixed
unilaterally: rendering them changes the transcript surface, and rewriting three checks changes the
acceptance contract.

Knock-on: session 1's check-1 PASS did not evidence this sub-assertion, so check 1 is **partial**.

Retest: yolo checks 1, 2, 4 blocked on the decision; check 5 passes independently.

## LT-015 — scope extended 2026-07-29 (still a decision, still no code change)

The 2026-07-29 campaign drove provider/model-swap check 1 and found the **same defect on a second
surface**: the expected `[System: Provider changed from claude (model …) to codex (model …)]` line
never reaches the transcript either. Same call site, same cause —
`runtime-reconciler.ts:404-408` sends provider-change *and* model-change notices through
`adapter.sendInput(...)`, exactly as it does the YOLO ones.

Two things this run adds to the decision:

1. **Delivery is confirmed again, independently.** The post-swap Claude reply opened with
   *"This is just a provider/model swap notification"*, so the model receives it.
2. **The transcript surface is not the obstacle.** Model-degradation notices already render as
   `system` entries in the same buffer (observed twice this run). So "render them" is a small,
   already-proven change, not a new surface — which materially lowers the cost of option 1.

Retest when decided: yolo checks 1, 2, 4 **and** provider/model-swap check 1.

## LT-016 — false "model no longer available" on an unpinned cross-provider swap — **SUPERSEDED: see "LT-016 — FIXED" below (original 2026-07-29 triage entry)**

Found 2026-07-29. Reproduced twice in one session (codex and antigravity targets). Root-caused to
`resolveInitialModel`'s `defaultModel` rung handing a Claude model id to a non-Claude provider;
full write-up, required behaviour and regression list in the register.

No code written. Cosmetic-but-trust-damaging (P2): the landed model is correct every time, only the
message is wrong. Sequence it behind the P0/P1 items.

Retest: provider/model-swap checks 2 and 5 — check 2 must keep passing both of its branches
(it does today), and check 5's genuine degradation notice must survive.

## LT-017 — manual Codex compaction stalls then silently restarts — **SUPERSEDED: see "LT-017 — DECIDED + FULLY FIXED 2026-08-12" below (original 2026-07-29 triage entry)**

Found 2026-07-29, reproduced twice with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`. Full write-up in the
register. No code written.

Two independently actionable parts:

1. **The 30 s stall** (`context-cost-controller.ts:92-105`) — a straightforward fix and worth doing
   regardless of the policy decision below. Every manual Codex compaction currently pays it.
2. **The silent restart-with-summary fallback** (`compaction-coordinator.ts:440-452`) — a decision,
   like LT-014/LT-015: the documented contract and deliberate code disagree. The automatic governor
   path already honours the contract; only the manual path does not.

Retest: context-cost-governor checks 1 and 3.

## LT-018 — Copilot reports 0 % context all session — **SUPERSEDED: see "LT-018 — FIXED" below (original 2026-07-29 triage entry)**

Found 2026-07-29 running WS14 check 2. Full write-up in the register. No code written.

The decision is small: wire Copilot's ACP usage into `emitContext`, or correct the `copilot-acp`
capability declaration and show *unknown* instead of a confident 0 %. The second half matters
regardless of the first — auto-compaction keys off this number, so a permanent zero means Copilot
sessions never trigger context management.

Retest: WS14 check 2.

## WS14 checks 1–7 target a superseded implementation — **decision needed**

Not a defect, but it blocks a whole doc. WS14's "SDK server mode" (`CopilotCliAdapter` +
`copilot-server-mode.ts`) is no longer on the interactive path — `adapter-factory.ts:359-364` routes
Copilot through `AcpCliAdapter` (`copilot-acp`). All four of check 1's expected log lines fire **0**
times, and checks 4, 6 and 7 are specific to the SDK path.

The behaviour those checks protect mostly still holds under ACP (persistence, interrupt without
respawn, restart continuity all verified 2026-07-29). Either rewrite checks 1–7 against
`copilot-acp` or retire them explicitly. Until then that doc cannot close.

## 2026-07-30 implementation pass — LT-015, LT-016, LT-017 (part), LT-018

Four open code issues fixed so the live-test backlog can continue after a rebuild. No behaviour was
changed beyond what each register entry required, and the one genuine policy question is still
James's.

### LT-015 — FIXED: runtime-change notices are now visible

New module `src/main/instance/lifecycle/runtime-change-notices.ts`:

- `yoloNoticeText` / `providerChangeNoticeText` / `modelChangeNoticeText` — the wording, now pure
  and unit-testable.
- `runtimeChangeNoticesFor(...)` — decides which notices a change announces (yolo-only → one;
  otherwise the provider/model notice, plus a second yolo notice when a queued model swap and a
  queued yolo flip land in the same pass).
- `announceRuntimeChange(...)` — delivers via `adapter.sendInput` **and** records a `system`
  transcript entry via the new `emitSystemNotice` dep.

The transcript write runs *after* delivery and is wrapped: the runtime change has already been
applied to the live session at that point, so a render failure is logged, never thrown. A test
covers exactly that.

`runtime-reconciler.ts` went 16 lines over its 700-line ceiling with these changes, so the notice
logic was extracted rather than the ceiling raised — the file is now 689 lines.

**Unblocks:** yolo checks 1, 2, 4 and provider/model-swap check 1.

### LT-016 — FIXED: no more false "model no longer available"

`resolveSwapModelWithSource` reports which rung supplied the model
(`requested` | `remembered` | `global-default` | `provider-default`). The reconciler suppresses the
user-facing degradation notice when the rejected id came from `global-default` — a provider-agnostic
id the user never chose for that target — while still logging it with `userVisible: false`.

The genuine cases are untouched and covered: an explicitly pinned unknown model, and a stale
remembered per-provider model, both still produce the notice. That is swap check 5's subject and it
keeps passing.

### LT-017 — DECIDED + FULLY FIXED 2026-08-12

Both mechanical halves from the earlier partial fix stand:

1. **The 30 s stall is paid at most once per session** (see LT-045 below for the respawn gap this
   originally had, now closed).
2. **The fallback is no longer disguised as a native success.** `CompactionResult` gained
   `nativeAttemptFailed`, set when the native strategy failed and restart-with-summary rescued it,
   with a matching `logger.warn` noting the provider thread was replaced rather than compacted.

**Decision (batch B, 2026-08-12):** restart-with-summary stays the intentional manual-compaction
policy; the doc's check 1 wording was updated to describe it rather than the app being changed to
match the old wording. Rationale: every live Codex build observed across this campaign never sends
`thread/compacted` at all, so a strict "report failure, keep the thread" manual contract would make
the user-visible Compact button a permanent no-op for the common case — worse for the user than an
honest, fast fallback that actually reduces context and says so (`nativeAttemptFailed: true`). The
automatic governor path is different in kind (it has already interrupted an in-flight turn, so
silently swapping the thread there is riskier) and already honours "report failure, preserve the
thread" — untouched, and correctly so.

### LT-045 — FIXED + VERIFIED LIVE 2026-08-12

Re-verifying LT-017's "30s stall paid at most once per session" claim found it didn't hold for the
one path it was written for. See the [register entry](livetest-remediation-register.md#lt-045-manual-codex-compaction-re-pays-the-30s-confirmation-timeout-on-every-call-not-just-the-first)
for the full root cause and fix — in short: the sticky flag lived on the per-adapter
`CodexContextCostController`, and restart-with-summary (manual compaction's only fallback) replaces
the adapter object wholesale on every call, wiping the flag before a second manual compaction could
ever benefit from it. A new `CompactionCoordinator.nativeCompactionProvenUnsupported` record survives
the respawn. Verified live: three consecutive manual compactions on one instance — 34.6s, 4.3s, 7.1s
— with the 2nd/3rd calls confirmed to never invoke the adapter's `compactContext()` at all.

### LT-018 — FIXED: Copilot reports real context again

`AcpCliAdapter` already received per-turn `usage` from `session/prompt` but only attached it to the
response. It now also emits a `context` event, accumulating a session aggregate in
`cumulativeTokens`.

Deliberately conservative: `used` is the aggregate, not a fabricated window occupancy (ACP does not
report occupancy), and **when the provider sends no usage, nothing is emitted** — an absent bar is
correct where a confident 0 % was the defect.

### Verification

- `npx tsc --noEmit` — clean.
- `npx tsc --noEmit -p tsconfig.spec.json` — clean.
- `npm run lint` — all files pass.
- `npm run check:ts-max-loc` — passes (no violations).
- `npm run build:main` — exit 0.
- `npm run test:quiet` — **1630 files, 16615 tests passed**.

New/extended regression coverage, each written to fail on the pre-fix source:

- `runtime-change-notices.spec.ts` (new, 12 cases) — wording, notice selection, deliver-and-record,
  and the render-failure path.
- `runtime-reconciler.runtime-change.spec.ts` (+4) — asserts `emitSystemNotice` is called; before
  the fix nothing was.
- `model-change-provider-swap.spec.ts` (+5) — provenance for all four rungs.
- `context-cost-controller.spec.ts` (+3) — the second `compactContext` resolves without advancing
  any timer and issues no second RPC; before the fix it hung for the full timeout again.
- `compaction-coordinator.spec.ts` (+3) — `nativeAttemptFailed` set only on a rescued native
  failure.
- `acp-cli-adapter.spec.ts` (+3) — aggregate accumulation, input+output fallback, and no event at
  all when usage is absent.

**One transient failure, correctly attributed:** the first full-suite run failed two
`browser-grant-policy.spec.ts` cases with `(0, proposalCoversProposal) is not a function`. The export
exists, the file passes in isolation (14/14), and the second full run was completely green.

The cause is **a concurrent writer, not a flake and not this pass.** Another agent
(`claude --print`, pid 43361) was working in this same checkout throughout, and
`browser-grant-policy.ts` is one of seven `src/main/browser-gateway/*` files it has uncommitted
(+127 lines in that file alone, plus a new untracked `browser-grant-request-operations.ts`). The
suite read that file mid-edit. Nothing in this pass touches browser-gateway.

This is the documented concurrent-loop-writer hazard, and it means **a single full-suite result in
this repo is not a stable statement about the tree** while another session is active. The green run
above should be re-confirmed once that session's work settles.

## Remaining pending live-test backlog

## LT-019 — Local AI reasoning canary blocks enrolment — **CODE FIXED 2026-07-31, awaiting worker redeploy/retest**

The rebuilt app discovered the healthy `windows-pc` OpenAI-compatible endpoint and both selected
Qwen models, but functional validation failed at the required exact-token canary for both 9B and
35B. Direct bounded evidence returned HTTP 200 with `finish_reason=length` under the health
request's eight-token limit. The first root-cause hypothesis was incomplete: adding the existing
worker `suppressReasoning()` directive and raising the budget to 32 still produced
`finish_reason=length` with zero visible content on the installed Qwen 3.5 model. A live bounded
request with LM Studio's `reasoning_effort: "none"` returned the exact sentinel in 479 ms.

The implementation adds the explicit LM Studio control to both the OpenAI-compatible canary and
real worker auxiliary generation, retains `/no_think` as a soft fallback, adds `/no_think` to the
Ollama canary, keeps a finite output limit, preserves exact-token rejection, and adds regression
coverage proving no raw model output enters evidence. The linked live test also corrects its
latency warning from 2 seconds to 30 seconds based on measured 13–22 second cold/model-swap
inference.

Retest requires rebuilding/restarting the worker as well as the parent app, then completing all
three Local AI Guard CLI checks.

Agent-runnable verification is green: 53 focused response/health tests, all 410 worker-agent
tests, both TypeScript checks, lint, max-LOC, main/worker builds, and the 1,692-file / 17,492-test
full suite. Direct bounded probes using the implemented request contract passed on both live
models (9B 479 ms; 35B 10,083 ms after swap). The rebuilt worker artifact is staged with a
verified hash; the remaining gate is durable worker deployment/restart plus the authenticated CLI
enrol/list/duplicate retest.

## LT-020 — a queued swap kills the loop iteration it lands on — **FIXED + DECIDED + VERIFIED LIVE 2026-08-11**

Status: **fully closed.** The destructive half (the queued swap SIGTERMing the loop's live iteration)
was fixed and live-verified 2026-07-31 via an adapter-loan registry (`adapter-loan-registry.ts`) that
makes the desired-runtime queue wait for the real iteration boundary instead of treating an
adapter-on-loan idle as a seal point — 0 kills observed live afterward, was 2 of 2 before. The
remaining half (whether a swap should re-provider a running loop at all) was a product decision,
not a bug; James decided 2026-08-01 on option 3 — decouple explicitly: the loop keeps its original
provider, the session moves to the new one, and the user is told via a `system` transcript notice
(`describeLoopProviderDivergence`, `src/main/instance/lifecycle/loop-provider-divergence.ts`).
Implemented, unit-tested (6 tests), and live-verified (loop survives the swap, instance moves, loop
keeps its own provider, divergence notice fires, no swap reversion, no runtime collisions). A
secondary defect found during verification (LT-030, Codex "already has an active turn" collisions
on the same path) was fixed alongside it. The one residual — whether the remote-node CLI-availability
guard's error message actually renders as a toast in a live, non-debug build — was UI-observation-only
(not a code defect) and closed 2026-08-11 on branch equivalence with James's sign-off; see
[`2026-07-31-swap-residuals_livetest_completed.md`](./2026-07-31-swap-residuals_livetest_completed.md)
and [`2026-08-01-swap-residuals-toast_livetest_completed.md`](./2026-08-01-swap-residuals-toast_livetest_completed.md).

Original finding (2026-07-31), preserved for history:

Reproduced 2 of 2 while driving provider/model-swap live check 4. A cross-provider swap requested
mid-loop queues correctly and does not interrupt immediately, then applies 371 ms before the loop's
in-flight iteration dies with `Claude CLI exited with code 143` (SIGTERM). The loop terminates
`completed-needs-review` with "UNPROVABLE workspace state". A control loop with no swap ran seven
clean iterations to `capReached`, so the loop is healthy and the swap is the cause.

Root cause is a knowledge gap, not a race in the reconciler itself: `default-invokers.ts:1226-1239`
lets a `same-session` loop **borrow the instance's live adapter**, but the desired-runtime queue
that decides when to apply a queued change has no idea the adapter is on loan, so instance-idle is
treated as an iteration boundary when it is not.

Secondary: the instance moves to the new provider but `LoopState.config.provider` does not, so the
next iteration would fail the borrow check and quietly spawn a second CLI on the old provider.

Fix direction: teach the queue about borrowed adapters (defer until the iteration genuinely seals),
carry the swap through to the loop's own config or refuse the swap with a reason, and classify a
Harness-initiated adapter teardown distinctly from a provider crash.

## LT-021 — loop tool activity is dropped at the renderer boundary — **FIXED + VERIFIED LIVE 2026-07-31**

Status: **closed.** `LoopActivityKindSchema` is now the single shared union and the main-process
type derives from it, so all 11 `LoopInvocationActivityKind` members reach `loop.store.ts`'s
activity feed instead of only 3. Verified live: 0 blocked `loop:activity` events post-fix, was 110
in one campaign session. See register row LT-021 for the fix location and evidence link.

Original finding (2026-07-31), preserved for history:

`LoopInvocationActivityKind` has 11 members and `default-invokers.ts:1183-1195` forwards all of
them on `loop:activity`, but `LoopActivityEventSchema`
(`packages/contracts/src/schemas/loop-events.schemas.ts:48`) only accepts
`status | error | input_required`. The other eight — including `tool_use`, `tool_result`,
`assistant` and `complete` — are rejected by renderer event validation and never reach
`loop.store.ts`'s activity feed. 110 blocked events were logged in one campaign session.

Fix is small: widen the schema to the emitted union and add a test that pins the two together so
they cannot drift again.

After LT-001..007 land, sweep every other untracked `*_livetest.md` file not already covered
above: run what can be run (unit/integration tests, the dev app via renderer store seeding,
Computer Use for GUI interaction per LT-007), record evidence, rename to `_livetest_completed.md`
on a full pass, or add a newly reproduced defect to the spec per its own rule 6 rather than
silently marking it done. A live-test file with a genuine external prerequisite (unavailable
provider quota, hardware, a human) gets that prerequisite recorded plainly, not silently skipped.

## LT-040 — Claude CLI never connects to the `computer-use` MCP server for any instance — **FIXED + VERIFIED LIVE 2026-08-12**

**Status: root-caused, fixed, gates green, mutation-verified, verified live.** Full observed
behaviour, the confirmed root cause, the fix and live verification evidence are in the register's
LT-040 section.

**Root cause (confirmed, not just hypothesised):** the real Claude CLI binary reserves the literal
MCP server name `computer-use` for its own built-in desktop-automation server. Read directly from the
CLI bundle (`strings -a` on the installed `claude` binary): `My()`/`XNs()` gate every server
connection through a per-project `enabledMcpServers` allowlist in `~/.claude.json` that defaults to
**disabled** only for the exact name `computer-use` (every other server name defaults to *enabled*,
opt-out only). A never-approved project — the case for every AIO-spawned working directory — has no
allowlist entry, so a server named `computer-use` is classified `{type:"disabled"}` and the CLI never
even attempts to spawn it: no error, no child process, no log line on our side. A separate CLI code
path that injects Anthropic's *own* built-in `computer-use` server (`setupComputerUseMCP()`) was
investigated and ruled out for AIO specifically — it only runs when the session is interactive, and
AIO always spawns Claude with `--print` (non-interactive). Confirmed decisively by renaming the
injected server to a scratch name and observing it immediately connect (then reproducing the failure
again by reverting the name).

**Fix:** renamed the injected MCP server's *registration name* (not the `aio-mcp` CLI subcommand,
which is unrelated and unchanged) from `computer-use` to `harness-computer-use`, via one exported
constant (`COMPUTER_USE_MCP_SERVER_NAME` in `desktop-mcp-config.ts`) used by all four provider config
emitters (Claude/Codex-app-server JSON, Codex TOML, Gemini settings JSON, ACP) and the two Gemini
merge/detection call sites in `adapter-spawn-helpers.ts`. Every other `'computer-use'` string literal
in the codebase was audited and confirmed to be an unrelated identifier (RPC messages, the `aio-mcp`
subcommand name, a lock-file purpose string, renderer component/tab ids, a skill script filename) and
left unchanged.

**Verification:** a mutation-verified regression test (`desktop-mcp-config.spec.ts`) asserts the
server is never registered under the literal reserved name, across all four emitters — reverting the
fix reproduces the exact `expected [ 'computer-use' ] to not include 'computer-use' ` failure. All
canonical gates green (`tsc --noEmit` ×2, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, targeted `test:quiet` — 3 files / 32 tests). Live: a spawned Claude instance's
`aio-mcp computer-use` child process now appears in `ps` (was **absent** in every prior sample across
3 independent instances), the agent listed the full 18-tool `harness-computer-use` set, and it
successfully called `mcp__harness-computer-use__computer_health` and got back real driver-health JSON —
a genuine round trip, not just tool-list presence.

Originally: reproduced live across 3 independent instances (1 dev, 2 live packaged-app sessions), not
fixed. `computerUseEnabled: true`, `desktopGetHealth()` fully healthy, and the `computer-use` MCP
server correctly injected into `--mcp-config` (well-formed JSON, verified by direct extraction) — but
of the four Harness-injected MCP servers (`codemem`, `browser-gateway`, `computer-use`,
`orchestrator-tools`), `computer-use` was the only one that never became a live child process of the
spawned `claude` CLI, in every one of three samples checked via `ps`. This blocked Check 1 and
effectively Check 4 of
[`2026-08-09-computer-use-consent-and-targeting_livetest.md`](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md)
regardless of local Mac control being approved — re-running those checks belongs to whichever batch
owns that livetest doc, since it is outside this pickup's assigned batch.

## LT-061 — tool-loop detector under-detects realistic Bash-tool doom loops — **FIXED 2026-08-12, verified live**

**Status: fixed, gates green, mutation-verified, verified live on an ACP provider.** Full observed
behavior, root cause, decision, fix and verification are in the register's LT-061 section. Headline:
`repeat-no-progress`/`ping-pong` hashed a tool call's entire raw arguments object, including Claude's
cosmetic per-call Bash `description` field, which Claude naturally varies even across an identical,
non-progressing `command` — so the argsHash never repeated and the detector never fired.

**Decision: went general, not Bash-only.** `toProviderToolUseObservedEvent` now strips a fixed,
cross-provider/cross-tool set of annotation field names (`description`, `reason`, `rationale`,
`explanation`, `justification`, `summary`, `note`, `thought`) before hashing, for every tool and
provider — not a `toolName === 'Bash'` gate, which would rot the moment a different tool/CLI added
its own annotation field under a different name. Both loop detectors' existing "result must also
match/stay stable" requirement bounds the risk of this masking a genuinely operative field that
happens to share one of these names. 6 new tests (bridge normalizer + a pipeline-level test through
the real `DoomLoopDetector`), all mutation-verified — reverted the fix, watched the exact 3
affected tests fail, restored, watched them pass.

**Scope-narrowing discovery while verifying live**: re-running the identical repro shape against
**Claude** (the provider the original repro used) still produced zero `instance:doom-loop` events
with the fix live, because Claude's adapter never emits live `tool_use`/`tool_result` events at all —
only the ACP adapter (Copilot/Cursor/Grok) does. The identical prompt against a live Cursor instance
fired a real warn (count 3) then critical (count 6), confirming the fix and pipeline are correct
where reachable. The adapter-emission gap is a separate, larger defect, filed as **LT-062** below —
Sibling-audit-round2 check A2 does not yet pass live for a Claude session because of it.

## LT-062 — the WS-A2 tool-loop detector never receives an observation for Claude/Codex/Gemini/Antigravity/Ollama sessions — **FIXED 2026-08-12, verified live**

**Status: fixed, gates green (except a shared-tree file-size ratchet, see below), mutation-verified,
verified live on Claude.** Full observed behavior, root cause, the fix, and live verification are in
the register's LT-062 section. Headline: `bindRawAdapterProviderEvents` was the only production call
site feeding the tool-loop detector, driven purely by an adapter's own raw `tool_use`/`tool_result`
`EventEmitter` events, and only `acp-cli-adapter.ts` (Copilot/Cursor/Grok) ever emitted them.

**Correction to the original diagnosis**: re-verifying live before fixing found Claude's modern
streaming path never emits an `'output'` message of `type: 'tool_result'` at all for an ordinary
(non-error, non-permission-denial) call — only `'tool_use'` — so a pure message-layer bridge could
never pair Claude's calls, contrary to the original write-up's claim that both halves reached
`'output'`. **Two-part fix**: (1) `observeToolLoopEvent()` now bridges any `kind: 'output'` event
whose `messageType` is `'tool_use'`/`'tool_result'` into the detector, gated on
`metadata.transport !== 'acp'` to avoid double-counting `AcpCliAdapter`'s existing raw+output
dual-emit — this covers Claude's `tool_use` half and whatever Codex/Gemini/Antigravity/Ollama already
surface as `'output'`; (2) `claude-cli-adapter.ts` now also raw-emits the same `tool_result`
`EventEmitter` event `AcpCliAdapter` already uses, for every `tool_result` content block, closing
Claude's `tool_result` gap without touching the visible transcript (that raw channel only feeds the
detector + context-evidence capture, never rendering). One path in per half — no double-count risk
between the bridge and the raw-emit, since they cover different halves of the pair.

**Known residual**: Codex/Gemini's real-time `output` tool events carry no correlation id at all, so
they still only reach the `runaway` counter, not `repeat-no-progress`/`ping-pong` pairing — a genuine
per-adapter gap, not addressed this session (Claude, the acceptance bar and the provider the original
repro used, was the priority within budget).

6 new tests across 3 files, mutation-verified (reverted each fix piece, watched the exact affected
tests fail, restored, watched them pass). `tsc` (main + spec), `eslint`, `build:main` all clean on the
touched files. `check:ts-max-loc` fails on `claude-cli-adapter.ts`, but that file was being edited
concurrently by another uncommitted fix (LT-047) throughout this session; this fix's own net
contribution is 13 lines, and the file was already over its tolerance-adjusted ceiling from HEAD alone
before today's session's work landed — not resolvable by this fix alone in a shared tree.

**Live-verified**: rebuilt `dist/main`, restarted the isolated dev app, and re-ran the exact original
repro (8-call identical `cat watch.txt` Bash loop) against a fresh Claude yolo instance. Where the
original repro captured 0 `instance:doom-loop` events, this run captured a `repeat-no-progress` warn
(count 3) then critical (count 6) — confirming the fix live, not just in tests.

## LT-060 — concurrent dev-app livetest runners collide on one shared profile — **FIXED 2026-08-12, verified live**

**Status: fixed, gates green, verified live.** Full observed behavior, root cause, fix and
verification are in the register's LT-060 section. Headline: `resolveHarnessUserDataPath`
(`src/main/app/user-data-path.ts`) ignored Electron's own `--user-data-dir` CLI switch for every
unpackaged launch and always resolved to the shared `<appData>/harness-dev` profile, so the
livetest campaign's own recipe of launching several concurrent dev apps with distinct
`--user-data-dir` values silently collapsed them onto one profile and one single-instance lock —
only the first one to start actually ran; later ones self-quit with `single-instance-lock-failed`.
Found while Batch E tried to launch its own isolated dev app per the 2026-08-11 campaign brief and
it collided with two other batches already sharing the same profile (`ps aux` showed the "isolated"
processes actually running against `harness-dev`; a CDP probe found a third batch's instances live
in that shared app). Fixed by adding an opt-in, dev-only `AIO_DEV_USER_DATA_PATH` env override,
following the same pattern as the existing packaged-only `AIO_STARTUP_SMOKE_USER_DATA_PATH`.
3 new tests in `user-data-path.spec.ts`, mutation-verified (fail without the fix, pass with it).
`tsc` (main + spec), `eslint`, `build:main` all clean on the touched files.

## LT-034 — the context ring renders aggregate token spend as occupancy — **FIXED 2026-08-11, verified live**

**Status: fixed (option 1 — label the aggregate honestly), gates green, verified live in the dev app.**
Full fix notes, the three design traps, and the before/after evidence are in the register's LT-034
section. Headline: the ring now reads *"Tokens used this session: 103,264 (this provider does not
report context-window occupancy)"* where it previously claimed *"Context window: 52% used"* after
three one-word turns, and a resident Claude instance is unchanged. The more damaging half — the 80 %
warning injecting "delegate to children" guidance into a nearly-empty context — is also fixed.

Found running WS14 check 2's outstanding live re-check. A `copilot-acp` instance given three
one-word turns rendered `"Context window: 52% used (103,222 / 200,000 tokens)"`. `used` is
`cumulativeTokens` — `acp-cli-adapter.ts:2017-2023` publishes running *spend* as occupancy, clamped
at 100 %, so a long session pins at a confident 100 % over a nearly-empty context.

The adapter is not at fault: it declares `occupancyReporting: 'aggregate-only'`
(`acp-cli-adapter.ts:357`) and documents the choice. **Nothing on the rendering path reads that
declaration** — its only consumer in the tree is `context-safety-policy.ts:116`. The ring keys on
`ContextUsage.occupancyReported`, set by `instance-communication.ts:1631` for any provider-reported
usage. LT-018's flag answers "is this number known?"; it does not answer "is this number occupancy?".

Affects every `aggregate-only` adapter: `acp-cli-adapter.ts:357`, `copilot-cli-adapter.ts:149`,
`gemini-cli-adapter.ts:164`, non-resident `claude-cli-adapter.ts:305`, non-app-server
`codex-app-server-adapter.ts:627`.

**The decision that was taken.** Two candidate fixes differed in what the user is told: carry the
capability to the renderer and label the aggregate honestly (keeps useful information), or stop
emitting `used`/`percentage` and let LT-018's "no data" path render (discards it). **Option 1 was
chosen** — the aggregate is real and useful, it was simply mislabelled.

**Do not treat this as reopening LT-018.** LT-018 is fixed and was verified live in the same run —
"no data" for never-reported, real occupancy for resident Claude, and the flag surviving a
compaction.

## LT-055 — RLM context stores never index for `semantic_search`, which silently degrades to keyword — **FIXED 2026-08-12 (status corrected 2026-09-20)**

**Status: fixed.** The recommended option — lazy indexing on first semantic query — was chosen and
built; this section's earlier "OPEN, decision needed" wording was left stale and is corrected here.
The register's LT-055 row carries the authoritative write-up and the correction to the original
root cause.

Original finding: `RLMContextManager.indexStoreForSemanticSearch()` had no *awaited* production
caller, so a general-purpose context store (`rlmCreateStore`/`rlmAddSection`) could still be
vector-empty when a `semantic_search` query arrived, and that query silently fell back to keyword
matching with no signal that anything had degraded. RLM's separate episodic memory store was
unaffected — it indexes on every write via a different path (`episodic-rlm-store.ts`).

As built: `executeQuery()` awaits `ensureStoreIndexedForSemanticSearch(store.id)` before running a
`semantic_search` (`src/main/rlm/context-manager.ts:369-372`, helper at `:595-617`). Concurrent
queries deduplicate onto one in-flight indexing promise, a failed attempt is evicted so the next
query retries rather than inheriting the failure, and both fallback-to-keyword paths now log
observably instead of degrading in silence. Verified 2026-09-20 by reading the executing path.

This is deliberately **not** treated as one of the repo's known-by-design unwired primitives
(`fuseHybrid`, `policy-engine`, `lease-dispatch`, `lesson-store`) — those were built ahead of a
feature that does not exist yet. `semantic_search` is a shipped, already-used RLM query type that
silently behaves differently from its own name for this one store kind, which is why it is filed as
a defect rather than left as a documented gap.

WS16 livetest check 7 (`filterMemoriesForTier`) was evaluated against the same wire-vs-leave
question and reached the opposite conclusion: it **is** one of the by-design unwired primitives —
its only consumer (`memoryInstructionGate` setting, default ON) has zero call sites anywhere in
`src/`, confirming there is currently no system-tier memory-assembly feature at all for it to gate.
No defect filed for it; the WS16 livetest doc records the decision to leave it unwired as
preventive, matching the established pattern.

## LT-050 — a Codex app-server parent's `spawn_child` reliably destroys itself — FIXED IN CODE; live check pending

**Status update 2026-09-23:** The 2026-08-12 classification fix and live evidence below stand. The separately recorded dropped `spawn_child` confirmation now waits for the active parent turn, retries the typed pre-send collision, and records admission only after successful send; a bounded wait leaves a visible failure. Focused tests and the final independent review passed. A rebuilt-app Codex handoff check remains pending.

**Status: fixed at the classification layer, verified live.** Full observed behavior, root-cause
trace, fix detail, mutation-verified test evidence, and the live-verification session are in the
register's LT-050 section (`### Fix — 2026-08-12`).

Re-verified the filed diagnosis by reading the executing path fresh: `instance-orchestration.ts`'s
`inject-response` handler really does send the `spawn_child` confirmation into the parent without
waiting for its current turn to finish, and that does collide with
`CodexAppServerThreadRuntime.captureTurn`'s single-active-turn guard exactly as filed. What the
filing missed: the throw site (`app-server-thread-runtime.ts:199-203`) already labels that specific
collision `recoverability: 'retry-thread'` — a transient-scheduling-race marker — but
`app-server-recovery-policy.ts`'s `planCodexAppServerRecovery` only ever branched on `failure.kind`
and never read `failure.recoverability`, so the label was discarded and every `request-rejected`
(this collision **and** genuinely terminal rejections like an invalid model) fell through to the same
`{action: 'restart-runtime', keepInstanceUsable: false}` default. That single boolean
(`keepInstanceUsable`) is what `sendInputImpl`'s catch reads to decide `status: 'idle'` vs.
`status: 'error'` — and `status: 'error'` was the entire cascade (illegal `error → busy` transition →
`IdleMonitor` zombie-kill → no adapter). **Fixed:** the policy now trusts the throw site's own
`recoverability` field for the `request-rejected` kind, so only the active-turn collision (labelled
`retry-thread` at the one throw site that produces it) becomes `keepInstanceUsable: true`; every other
`request-rejected` is unchanged. Two mutation-verified tests added to
`app-server-recovery-policy.spec.ts` (revert fix → new collision test fails; restore → passes; a
second test proves the fix did not broaden to unrelated `request-rejected` causes). Gates green:
`tsc` ×2, `lint`, `check:ts-max-loc`, `build:main`, targeted spec 8/8.

**Verified live** (own isolated dev app, `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-lt050`, port `9462`,
rebuilt main): a real Codex app-server parent hit the identical collision twice (spawning two
real, genuinely-long-running children) and survived both times — stayed `idle`, kept its pid, zero
zombie-kill/no-adapter log lines — versus 2/2 fatal in the original filing. This unblocks
resilient-threads-sessions check 3's precondition (a Codex parent can now hold two live orchestration
children). Check 3 itself (kill one child, force a fresh fallback, assert the reconcile log line) is
still **not run** this session: forcing a decisive fresh fallback for Codex requires directly
manipulating the shared, actively-reconciled `~/.ai-orchestrator/codex` session store that concurrent
sibling livetest sessions were writing to at the same time, which the project's own memory explicitly
warns against manually touching — judged too risky to attempt safely in this window. See the
resilient-threads livetest doc's own evidence-run entry.

**Residual, not implemented (recorded as a decision needed, not unilaterally picked):** even with the
crash fixed, the confirmation the collision was trying to deliver is still silently dropped — live
evidence showed a parent's turn ending without ever learning a just-spawned child's id when the
collision hit mid-turn. A real fix for that needs either a bounded retry once the runtime reports
free, or an LT-030-style reciprocal interlock (`beginRuntimeChange`/`waitForRuntimeChange`) applied to
the `inject-response` call site — deliberately not implemented here, both because the orchestration
layer is meant to stay provider-agnostic (either option means either a blind generic retry needing its
own regression suite, or duplicating LT-030's Codex-specific interlock machinery for a second call
site) and because the catastrophic harm (the parent dying) is already eliminated.

## As-built notes

(Updated as work lands — see the spec's Remediation Index table for authoritative per-item
status; this section tracks plan-level progress only.)

- 2026-07-19: LT-001, LT-002/LT-003, LT-004, LT-005, LT-006/LT-007 all code-complete, tested, and
  independently re-verified (full 15,116-test suite, tsc x2, lint, max-loc all green throughout).
  Remaining untriaged backlog (25 files) swept: no further code defects found; all genuinely
  blocked on a rebuilt app + live provider session + human/Computer-Use interaction, or a named
  external prerequisite. No file renamed `_livetest_completed.md` yet — every fix still needs its
  linked live GUI/process re-run, which this plan intentionally defers rather than fabricates.
  LT-005 has one disclosed real limitation (2 GiB store-size ceiling) — see its section above.
- 2026-07-22: LT-005's 2 GiB ceiling — the only open engineering item in the whole backlog per the
  2026-07-19 session-2 status report — is now fixed via a native Electron-as-Node read-only child
  (`local-suite-driver.ts` + 17 tests). `--local` verified live against James's real ~2.4 GB /
  ~2.6 GB stores (both `ok`, real BM25 R@1=1.000), read-only proven, WASM fallback intact. All
  agent-runnable gates green: `tsc` (main + spec), `ng lint`, `check:ts-max-loc`, targeted
  retrieval-eval + bench specs (72 tests), synthetic `bench:retrieval` no-regression. WS16 Check 3
  now passes against the real store. The remaining WS16 checks (loop/memory in-app scenarios) and
  the rest of the pending backlog still need a rebuilt+restarted app with live provider/loop/GUI
  interaction, unchanged from the 2026-07-19 findings. Nothing renamed `_completed` or committed.
- 2026-07-26: live campaign against the **packaged** app (automations as a real-session driver,
  ledger/RLM DB assertions, verified `kill -9`) and then the **dev** app with
  `--remote-debugging-port=9444` for real `sendInput`/`toggleYoloMode`. 15 docs advanced with new
  evidence; still **0 renamed** `_livetest_completed.md`. Unlike previous sessions this one found
  **three reproduced product defects** — LT-008 (P0, yolo/fork resume destroys live Claude
  sessions), LT-009 (P0, skill registry empty), LT-010 (P1, sync allowlist) — plus LT-011
  (unobservable check contracts) and five triage observations, all added to the spec. Notable
  positive: the 2026-07-18 LT-004 symptom is **disproven** on the current build — four `kill -9`s on
  a resident Codex app-server each recovered in ~330 ms with the session preserved, and
  `Ignoring per-turn process exit for stateless exec adapter` appears 0 times. Also recorded 5 of 6
  real WS1 provider fixtures. Gates green (`tsc` main+spec, providers 484/484, fixture replay 7/7).
  Full report: merged into `docs/plans/livetest-backlog.md` on 2026-09-06 (original in
  `_scratch/livetest-backup-2026-09-06/`); runbook for
  the next session: `docs/plans/livetest-campaign-runbook.md`. Nothing renamed or committed.
- 2026-07-27 (session 2): closed LT-012's flagged gate gap — `npm run build:main` is now a required
  step in `AGENTS.md`'s canonical checklist, with the reason recorded inline (neither `tsc --noEmit`
  reads `tsconfig.electron.json`, and `build:main` is the only gate that runs `sync-dist.js`'s
  non-code-asset guard). Then ran the history-restore and yolo-mode live checks against a rebuilt
  app and a **restarted** `ng serve`. **Six checks moved**: history-restore 1 and 3 → PASS, yolo 5 →
  PASS, yolo 2 and 4 → all mechanism assertions PASS, and check 1 corrected from clean to partial.
  One new **P0 defect found, fixed and verified live** — LT-013, which had been silently corrupting
  the resume anchor of every archived Claude conversation; the previous session's identical
  `resume-unconfirmed` result had been read as an environment problem rather than a defect. Two
  further findings (LT-014, LT-015) are **decisions for James, not code**: in both cases the live
  check and a documented design lock contradict each other, and one attempted "fix" was reverted
  for exactly that reason. Gates green throughout (`tsc` main+spec, `ng lint`, `check:ts-max-loc`,
  `build:main`, full suite 16173/16174 — the single failure is the pre-existing `obug`/`@types/node`
  npm-tree drift, unchanged from 2026-07-27 session 1 and untouched by this session). Nothing
  renamed `_livetest_completed.md`; nothing committed.
- 2026-07-19 (session 2): full re-triage of all 34 pending `*_livetest.md` docs (4 parallel
  agents). Re-confirmed the code fixes are now committed (`be8e5616`) and the agent-runnable gates
  are green (tsc main+spec, `ng lint`, WS16 bench Check 1 no-regression, plus targeted specs:
  static-mcp 9/9, model-catalog 64/64, handoff redaction 8/8, history-restore 11/11, workboard
  56/56). **0 of 34 docs are closeable autonomously**: the running production app was packaged
  00:31, before the fixes were committed (09:54–10:44), and this session has no desktop
  Computer-Use tooling — so every remaining check needs a rebuilt+restarted app plus live
  GUI/provider/remote/human interaction. **No new product defects found.** Only open engineering
  item remains LT-005's 2 GiB ceiling. Full per-doc index + a cluster-ordered closure runbook for
  James merged into `docs/plans/livetest-backlog.md` on 2026-09-06. Nothing
  renamed/committed; production app untouched.

## LT-046 — the rolling handoff document never accumulates state on a turn without billable usage — FIXED + VERIFIED LIVE 2026-08-12

Found while adding direct rung-choice observability to close the rolling-handoff-state livetest.
`noteTurnCompleted` (the feature's only write path) lived inside `recordCompletionCost`, which
early-returns on any turn without billable `response.usage` — a real Claude session completed 14
turns, correctly grew `contextUsage`/`totalTokensUsed` via a separate event path, and still recorded
zero handoff state and zero cost-tracker entries. Moved the call to the shared turn-completion call
site, gated only by the setting. Full detail and verification: [register entry](livetest-remediation-register.md#lt-046-the-rolling-handoff-document-never-accumulates-state-on-a-turn-without-billable-usage).

## LT-065 — the WS5 workspace-write observer silently drops every change on a symlinked workspace path — **FIXED 2026-08-12, verified**

**Status: fixed, gates green, regression test mutation-verified.** Full observed behavior, root
cause, fix and verification are in the register's LT-065 section. Headline: `createAttemptDeltaObserver`
(`loop-attempt-observation.ts`) resolved its own `workspace` root with plain `path.resolve()`, but
`discoverWorkspaceRepositories`'s `git rev-parse --show-toplevel` always returns the REAL
(symlink-resolved) path — on macOS that means anything under `/tmp` (`/private/tmp`). The two roots
diverged by exactly the symlink prefix, so `toWorkspaceFileChange`'s `path.relative(workspace,
absolutePath)` started with `../` for every file and was silently discarded by the existing
"outside the workspace" guard — a real write reported as `changes: []`, defeating the exact
degraded-retry replay guard WS5 exists to provide.

Found running loop-convergence-and-cost-safety check 5 (a killed mid-turn Claude CLI that had
already written a real file to `/tmp/aio-lt-degraded` was auto-retried instead of paused for
review; `ITERATION_LOG.md` logged "files changed: 0" for both the killed iteration and the
following full-length iteration that also wrote a second file). Root-caused with a differential
test: the identical scenario against a non-symlinked workspace correctly reported "files changed: 1"
on the first iteration.

Fixed by realpath-resolving the observer's `workspace` root before it's used for either repository
discovery or the `path.relative` comparison, falling back to plain `path.resolve` only when the
target doesn't exist yet (preserving the existing "workspace root could not be read" behavior).
New regression test in `loop-attempt-observation.spec.ts` builds a real repo behind a real symlink
(portable — doesn't rely on macOS's own `/tmp` behavior) and was watched to fail against the pre-fix
source (`expected [] to deeply equal ['write1.txt']`) before passing after the fix. 27 tests total
across the touched module and its three adjacent dependents (`loop-workspace-repositories.spec.ts`,
`loop-repo-state.spec.ts`, `loop-invocation-attempt.spec.ts`) pass with no regressions. `tsc` (main +
spec), `lint`, `check:ts-max-loc`, `build:main` all clean.

## LT-047 — a resident Claude CLI session never fires the adapter `'complete'` event — FIXED + VERIFIED LIVE 2026-08-12

Confirmed and root-caused in a dedicated pass: resident Claude turns complete entirely inside
`processCliMessage`'s `case 'result':` (`claude-cli-adapter.ts`), which emits `'context'`/`'status':
'idle'` but never called `completeResponse()`. The only call site that reached `completeResponse()`
was the one-shot `sendMessage()` path's `process.on('close', …)` handler — unreachable for a resident
session, since its process never exits between turns. Reproduced live: 0/5 `'complete'` events on a
resident Claude instance vs 3/3 for a Codex control, 0 cost-tracker entries across those 5 turns.

Fixed by accumulating each resident turn's raw NDJSON and, at `result`, feeding it to the existing
`parseOutput()` (same conversion the one-shot path already trusts) then calling `completeResponse()`,
guarded by a new `awaitingOneShotCompletion` flag so it can never double-fire against the one-shot
path's own completion. Consumer map (13 items: cost tracking, calibration telemetry, cache-hit
analytics, cost attribution fan-out, `PostSampling`/`Stop` lifecycle hooks, the provider-runtime
`'complete'` trace event, context-evidence drain ordering, provider-limit detection/clear, and LT-046's
handoff-state write) is in the register entry — two items turned out NOT to be broken
(`onToolStateChange`/turn-completion notifications to parents run off the separate `'status'` event,
which resident turns already emit correctly).

4 mutation-verified regression tests in `claude-cli-adapter.spec.ts` (64/64 total pass). Live-verified
post-fix on a rebuilt dev app: 3/3 resident Claude turns fired `'complete'` with real `content`+`usage`,
and 3/3 cost-tracker entries were recorded (was 0 before). `tsc` (main + spec), `lint`, `build:main`
all clean; `check:ts-max-loc` required raising `claude-cli-adapter.ts`'s ceiling 2346 → 2430 (this fix
plus a concurrent same-cycle LT-062 change already in the file).

Separately found while verifying the cost-tracking claim: Codex resident turns **also** never record
cost, via an unrelated mechanism (`'complete'` fires but `response.usage` is undefined) — filed as
LT-090 below, not fixed. Full detail: [register entry](livetest-remediation-register.md#lt-047-a-resident-claude-cli-session-never-fires-the-adapter-complete-event).

## LT-023 — a crash inside the recent-respawn suppression window was a silent dead end — FIXED + VERIFIED LIVE 2026-08-12

The filed diagnosis held up on inspection: `instance-communication.ts`'s exit handler folded
`!withinRecentRespawnWindow` directly into `canAutoRespawn`, so a second crash landing inside the 5s
recent-respawn window fell straight to the terminal `error` branch **without ever calling
`deps.onUnexpectedExit`** — meaning `respawnAfterUnexpectedExit` and the circuit breaker inside it
were never invoked, and nothing scheduled a retry. `waitReason` is a renderer-only concept (never
written onto the main-process `Instance`), so with no call into the respawn path there was nothing
to carry a backoff chip either.

Fixed by adding a deferred-retry branch: a crash suppressed only by the recent-respawn window now
transitions the instance to `respawning`, queues a `{ kind: 'backoff', attempt, retryAt }`
waitReason immediately, and retries through the same `onUnexpectedExit` path once the remaining
window elapses — so the circuit breaker's own backoff ladder is always reached instead of bypassed.
Extracted into `src/main/instance/instance-communication-recent-respawn-retry.ts` to keep
`instance-communication.ts` inside its LOC ceiling (raised 2622 → 2696).

3 mutation-verified regression tests in `instance-communication.spec.ts` (95/95 total pass). Live in
a real dev app: a within-window double-kill produced `Suppressing…` → `Deferring auto-respawn…
{ remainingSuppressMs: 1699 }` → `Retrying auto-respawn…` → `Recovery respawn complete`, where
before the fix it stopped dead after `Suppressing…`. The `backoff` waitReason was captured live on
the real `instance:batch-update` IPC stream the renderer consumes
(`{"kind":"backoff","attempt":2,"retryAt":...}`), and the renderer already has display code for that
exact shape. A separate 4-crash run showed the circuit breaker's own ladder producing
`attempt: 3 → delayMs: 10000` then `attempt: 4 → delayMs: 30000`, both recovering successfully.

Gates: `tsc` (main + spec), `lint`, `check:ts-max-loc`, `build:main`, targeted `test:quiet` — all
green. Full detail: [register entry](livetest-remediation-register.md#fix--2026-08-12--deferred-and-retried-instead-of-left-terminal-verified-live).

## LT-090 — Codex resident turns also never record cost (response.usage undefined on 'complete') — FIXED + VERIFIED LIVE 2026-08-12

Found investigating LT-047's cost-tracking claim, via a mechanism unrelated to LT-047. `'complete'`
fires reliably for resident Codex turns, but `response.usage` was `undefined` whenever `turn/completed`'s
own `usage` field came back empty. Re-verified live and independently before fixing (fresh instance,
real tool-using turn: 0 `costGetEntries` rows). Root cause pinned down: `thread/tokenUsage/updated`'s
`last` sample already carries a full input/output/cache/reasoning breakdown, captured for the context bar
but never consulted for cost. Fixed with a new `lastTurnUsageBreakdown` field (`codex-base-adapter.ts`,
populated by `codex-app-server-notification-adapter.ts`, reset per turn to prevent stale reuse) that
`codex-app-server-turn-adapter.ts` falls back to — mutually exclusive with the existing `turn.usage`
branch, so a turn's cost is never counted twice. Field-parsing extracted to a new
`codex/token-usage-breakdown.ts` to keep the notification-adapter file under its LOC ceiling (now
allowlisted at 699). Live-verified post-fix: 2/2 real turns recorded correct `tokensUsed`/`costUsd` and
exactly one `costGetEntries` row each (was 0/2). Re-verified LT-047's resident-Claude fix stayed intact
through this session's unrelated `buildArgs` extraction from `claude-cli-adapter.ts`. Three
mutation-verified regression tests added to `codex-cli-adapter.app-server.spec.ts`. **New finding from
the same investigation, filed separately as LT-100**: Cursor and Grok (both on the shared
`AcpCliAdapter`) also recorded zero cost for real turns — a different-shaped gap (the ACP server itself
never reports `usage`), not fixed, needs a product decision. Full detail: [register
entry](livetest-remediation-register.md#fix-and-live-re-verification--2026-08-12-cost-tracking-follow-up-batch).

## LT-100 — ACP-transport providers (Cursor and Grok confirmed) record zero cost when the ACP server omits `usage` — OPEN, found 2026-08-12, decision needed

Found running the LT-090 cost-tracking blast-radius survey. Live-tested Cursor and Grok (both route
through the shared `AcpCliAdapter`, not any per-provider parsing file — confirmed via
`createCursorAdapter()`/`createGrokAdapter()` in `adapter-factory.ts` and the `transport: 'acp'` tag on
each instance's own output events): both got a real reply on a real turn, and both recorded **zero**
`costGetEntries` rows. `AcpCliAdapter.toCliUsage()` deliberately returns `{ duration }` only (no token
fields) when the ACP server's `session/prompt` result carries no `usage` object — the same
no-fabrication design the LT-018 context-bar fix already established ("a missing bar beats a confident
zero"). The app log confirms `usageKeys: null` for both providers' turns — the ACP server itself sent no
`usage`, not a malformed one. Different shape from LT-047/LT-090: those had real usage data available
*somewhere* in the adapter and just didn't route it to `'complete'`; here the data does not appear to
exist at all for these two providers' sampled turns. Not fixed — this is a product/UX decision (accept
the gap vs. add a heuristic-estimate fallback that reverses the LT-018 design choice), written up rather
than decided unilaterally. Copilot shares the identical code path but was not independently live-tested
(EBRD-only seat). Full detail: [register
entry](livetest-remediation-register.md#lt-100-acp-transport-providers-cursor-and-grok-confirmed-record-zero-cost-when-the-acp-server-omits-usage).

## LT-095 — no UI exists to approve or deny a `computer.request_app_grant` request — FIXED and live-verified 2026-08-12

Found running Computer Use consent/targeting checks 1 and 4, now unblocked from LT-040 (fixed earlier
the same day). `computer.request_app_grant` correctly never auto-approves under ACP-YOLO (confirmed:
it only ever resolves via the registry's own 60s timeout, never `auto_approve`) — but a real, spawned
Claude instance's grant request also could **never be approved**, because no IPC channel, preload
export, or renderer component anywhere called `PermissionRegistry.resolve()` for it or showed it to a
human. The same no-UI shape also affected `orchestrator-tools-step.ts`'s App Store/Play release-gate
and calendar-mutation approvals, which share the same `PermissionRegistry` primitive and the same
`decidedBy === 'user'` check that could never be satisfied. ACP tool-permission requests are the only
consumer with a real UI (a separate `input_required` chat-message mechanism in `acp-cli-adapter.ts`);
step 7 of check 1 (ACP YOLO auto-approval) was independently live-verified still working (a real
Cursor yolo instance wrote and read back a file in under 3s, no approval pause).

**Fixed 2026-08-12, generously per James's instruction** ("whatever you recommend, but be generous"):
built one renderer-reachable approval surface for all three `PermissionRegistry` consumers rather
than a Computer-Use-only affordance, since the sibling-gap claim was verified true by reading
`orchestrator-tools-step.ts`'s `authorizeReleaseMutation`/`authorizeCalendarMutation` (same
`requestPermission()`/`decidedBy === 'user'` pattern, longer 5-minute timeout). New
`permission-registry:list-pending`/`:resolve`/`:extend` IPC + a root-level
`PendingApprovalsBannerComponent` (modelled on `BrowserApprovalsBannerComponent`) showing every
pending request app-wide with a risk badge, description, requesting instance, countdown, and
Approve/Deny/**+2 min** actions. New `PermissionRegistry.extend()` addresses the brief's "60s is short
for a human" concern (chosen over an auto-pause-while-visible heuristic — see the register entry for
why). ACP-transport requests are deliberately excluded from the list (they already have a working,
different resolver; adding a second one would race it).

**Live-verified end-to-end** in an isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-095`, CDP
9475): a real spawned Claude instance's `computer.request_app_grant` call appeared in the live DOM
banner within its 60s window; clicking the real Approve button produced a real grant with
`decidedBy: "user"` (confirmed via `desktopListGrants`) — the first ever produced through a human
action via this path. A second request was extended via the real +2 min button (countdown moved from
"36s left" to "1m 59s left") and then denied via the real Deny button; no grant was created and the
audit log recorded `decidedBy: "user"` on the denial. The App Store/Play and calendar flows were not
live-triggered (real, largely irreversible external side effects) but run through the identical,
unbranched handler code and are covered by mutation-tested unit tests using their real `action`
values. This directly unblocks Computer Use consent/targeting checks 1 (steps 3–6) and 4 — see that
livetest doc's new evidence section for the check-by-check result.

**Sub-defect fixed (earlier the same day):** the same code path's audit-log entries never carried a
top-level `appId` (only inside free-form metadata), so `computer.get_audit_log` filtered by `appId`
returned empty even for a real, correctly-ordered request/deny lifecycle for that exact app. Fixed by
threading `appId` through all four `audit()` call sites in `desktop-grant-approval-controller.ts`.
Mutation-verified regression test added to `desktop-gateway-service.spec.ts` (reverted the fix,
watched it fail; restored, 37/37 pass). Gates green: `tsc` ×2, `lint`, `check:ts-max-loc`,
`build:main`, targeted `test:quiet`.

**Gates (this fix):** `tsc` ×2 clean (one pre-existing unrelated failure from concurrent work), `lint`
clean, `check:ts-max-loc` clean for every touched file (one pre-existing violation in
`acp-cli-adapter.ts` confirmed to be another session's concurrent edit), `build:main` clean, targeted
`test:quiet` green across 4 new/changed spec files plus 5 adjacent specs whose shared files this fix
touched.

Full detail: [register entry](livetest-remediation-register.md#lt-095-no-ui-exists-to-approve-or-deny-a-computerrequest_app_grant-request).

## LT-130 — RendererHeartbeat misreports every lock-screen period as a UI freeze — FIXED 2026-08-12, not live-verified

Found investigating a prior worker's report of "recurring ~12s renderer stalls" around 2026-08-11
12:56 BST in the packaged app's `app.log` (pid 38865, read-only inspection only, never
restarted/killed). The real pattern was far larger than reported: 10,034 stall/recovery log lines
across the four-day retained log window, grouping into 24 bursts (1 minute to ~11 hours each) that
together cover roughly half the window — every burst starts within 60-90s of a `RuntimeDiagnostics`
`lock-screen` power event and stops shortly after the matching `unlock-screen`/`resume`. Root cause:
Chromium throttles a backgrounded/locked-screen renderer's timers to ~once a minute
(`stalledMs≈60000ms`, `missedBeats:0` — a single coalesced tick, not a real freeze) — no
`backgroundThrottling: false` is set on the `BrowserWindow` (`src/main/window-manager.ts:86`).
`RendererHeartbeatMonitor` had no suspend/lock-screen awareness, unlike `RuntimeDiagnostics`'s own
main-process stall detector, which already gates on the same `systemSuspended` state — so it
misreported every lock-screen period as "UI event loop likely blocked" at `error` level.

Fixed by adding `handleSystemSuspend()`/`handleSystemResume()` to `RendererHeartbeatMonitor`
(`src/main/logging/renderer-heartbeat-monitor.ts`) — `scan()` returns early while suspended, and
resume rebases every tracked renderer's `lastBeatAt` to now so the lock/suspend duration itself is
never counted as a stall, while a genuine freeze starting after resume is still caught. Wired from
`RuntimeDiagnostics`'s existing `noteSystemSuspend`/`noteSystemResume` (`src/main/app/runtime-diagnostics.ts`),
alongside the other services already notified there. Three new mutation-verified regression tests in
`renderer-heartbeat-monitor.spec.ts`. Gates green: `tsc` ×2, `lint`, `build:main`, targeted
`test:quiet`; `check:ts-max-loc` shows one pre-existing, unrelated ratchet violation on
`acp-cli-adapter.ts` from concurrent work, not touched by this fix.

**Not live-verified**: campaign rules forbid restarting/interacting with the packaged app, and this
fix was judged not worth reproducing via a real macOS lock-screen cycle against an isolated dev app
(risk of colliding with shared `powerMonitor` state). Live confirmation is deferred to the next real
lock/unlock cycle on the packaged app after its next normal rebuild-and-restart.

Full detail: [register entry](livetest-remediation-register.md#lt-130-rendererheartbeat-misreports-every-lock-screen-period-as-a-ui-freeze).

## LT-167 — `checkCodexCliAuthentication` misclassifies a signed-out Codex CLI as authenticated — FIXED + LIVE-VERIFIED 2026-08-18

Found driving the in-session-auth-repair live tests. `parseCodexAuthOutput()`
(`src/main/providers/codex-cli-auth.ts`) checked the positive `logged in` substring before the
negative `not logged in`/`login required`/`logged out` patterns, and `"not logged in"` itself contains
`"logged in"` as a substring, so a genuine sign-out was always misclassified as authenticated. Both
consumers were broken: Doctor's Codex row always reported `healthy` regardless of real auth state, and
`InstanceAuthRepairHandler.maybeBlockOnAuth` always vetoed real Codex auth-shaped turn failures with
"the provider still reports authenticated" — so the whole in-session repair banner/auto-resume feature
was silently inert for Codex.

Reproduced without touching any real global credentials, by launching an isolated dev app with `HOME`
pointed at a disposable empty directory (so the real `codex` CLI's own auth resolution — and the app's
probe, which runs in the same process/env — both genuinely saw no credentials). Confirmed with a direct
shell probe under the identical `HOME`: `codex login status` → `Not logged in`, exit 1. The app's Doctor
report showed `authenticated: pass`/`"Codex CLI authenticated"` with `rawOutput: "Not logged in"`
sitting right next to it — the contradiction that pinned the bug. A real Codex turn in that env failed
with a genuine `401 Unauthorized`, which `detectAuthFailureSignal` matched, but the probe still vetoed
the block (`app.log`: "Ignoring auth-shaped turn failure: the provider still reports authenticated").

Fixed by reordering the negative checks before the positive one, mirroring `detectAuthFailureSignal`'s
own exclusion-first pattern. No existing test file covered `codex-cli-auth.ts` at all; added
`src/main/providers/__tests__/codex-cli-auth.spec.ts` (7 tests). Watched 2 of the 7 fail with the exact
`authenticated: true` vs `false` mismatch on the pre-fix ordering, then pass after the fix. Live
re-verified post-fix (rebuilt `dist/main`, same fake-`HOME` dev app): Doctor's `provider.codex` row now
correctly reports `degraded`/`authenticated: fail`/`"Codex CLI is not logged in"`.

Gates green: `tsc` ×2, `eslint` on both touched files, `check:ts-max-loc` unaffected, `build:main`,
targeted `test:quiet` (7/7 pass).

**Batch V2 evidence run — 2026-08-19 (cheap re-confirmation only, not independently re-driven live).**
Re-ran `src/main/providers/__tests__/codex-cli-auth.spec.ts` against the current tree post-rebuild:
7/7 still pass. This confirms the fix has not regressed since 2026-08-18; it does not repeat the
disposable-fake-`HOME` live drive (already recorded above), which was judged adequate given the
existing live evidence is same-day and the regression suite specifically pins the exact ordering bug.

Full detail: [register entry](livetest-remediation-register.md#lt-167-checkcodexcliauthentication-misclassifies-a-signed-out-codex-cli-as-authenticated).

## LT-146 — Antigravity instances silently ignore their configured working directory — FIXED + VERIFIED LIVE 2026-08-18

Found running check 4 of the provider-agnostic context-evidence live test: a fresh Antigravity
instance scoped to a disposable one-file `/tmp` workspace reported reading `agy`'s own persistent
default scratch directory (`~/.gemini/antigravity-cli/scratch`, 621 files) instead. Ruled out a
harness `cwd`-plumbing bug (the adapter correctly passes `cwd` to the spawned process) — root cause is
that `agy` has its own workspace concept gated by `--add-dir`/`--project`, independent of process
`cwd`, and the AIO adapter never passed either flag. Reproduced identically via a direct shell `agy
--print` invocation with no harness involved at all.

Fixed by adding `--add-dir <workingDirectory>` to `buildArgs()`
(`src/main/cli/adapters/antigravity-cli-adapter.ts`) whenever a working directory is configured. Two
new regression tests in `antigravity-cli-adapter.spec.ts`, both watched to fail with the fix reverted
(`git apply -R` on the change) and pass with it restored. Live-verified by re-running the same direct
`agy --print --add-dir /tmp/aio-lt-evidence-batchC ...` invocation: it now correctly lists the
workspace's real 2 files instead of the shared scratch directory.

Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`, targeted `test:quiet` (7/7 pass in
`antigravity-cli-adapter.spec.ts`).

Full detail: [register entry](livetest-remediation-register.md#lt-146-antigravity-instances-silently-ignore-their-configured-working-directory).

## LT-147 — the context-evidence provider kill switch does not stop capture for instances already running — FIXED IN CODE 2026-08-31, LIVE RE-CHECK PENDING

**Current implementation status (2026-08-31): fixed in code; live re-check pending.** Tool-result
capture now resolves the provider's current configured evidence mode for every raw and parsed capture.
Changing a running provider to `off` therefore blocks both ingress paths immediately, even while the
instance's spawn-time context still says `shadow`. A failing-first processor regression test covers
that exact cached-shadow/live-off state; the existing communication evidence suite was updated to
exercise the live-mode dependency explicitly.

The following paragraphs retain the original live finding and decision analysis for provenance.

Found running check 8 ("Provider kill-switch rollback") of the provider-agnostic context-evidence live
test. `initializeInstanceEvidenceOwnership()` resolves `contextEvidenceModeByProvider` once, at spawn
or respawn, and caches it on `instance.contextEvidence.mode`; nothing re-reads the live setting per
turn. Live-verified: a `grok` instance created under `shadow` kept capturing real, non-empty evidence
records on turns sent *after* the provider was flipped to `off`, with the instance still alive and no
respawn. This contradicts the setting's own `restartRequired: false` policy metadata
(`settings-control-policy.ts:273`), which asserts the change takes effect without any restart.

The remediation selected option (a): the existing `restartRequired: false` contract and the term
"kill switch" require a live setting change to stop capture immediately. A rebuilt-app live run of
the owning check remains pending; the code-level behavior is regression-tested.

Full detail: [register entry](livetest-remediation-register.md#lt-147-the-context-evidence-provider-kill-switch-does-not-stop-capture-for-instances-already-running).

## LT-136 — checkpoint timeline mislabels every checkpoint "Auto" and drops its name — FIXED + VERIFIED LIVE 2026-08-18

Found while driving WS-B7 (compaction preview dialog) of the sibling-audit-round2 live test.
`SnapshotManager.listSnapshots()` — the only source for the checkpoint timeline UI and its badge
count — reads from an in-memory `SnapshotIndex` that never carried `name`/`description`/`trigger`,
so it hardcoded `trigger: 'auto'` and dropped `name` for every listed entry regardless of what was
actually persisted to disk. A manual pre-compaction checkpoint (WS-B7's `applyCompaction()`, e.g.
labeled `"Before manual compaction (keep latest 1 exchange)"`, `trigger: 'checkpoint'` on disk) was
indistinguishable in the UI from a routine per-turn safety checkpoint — both showed as an unnamed
`Checkpoint {id}` tagged "Auto".

Fixed by carrying `name`/`description`/`trigger` through `SnapshotMeta` and all three
`SnapshotIndex.add()` call sites (create, startup disk rebuild, session import) in
`snapshot-index.ts`/`snapshot-manager.ts`/`session-continuity.ts`, and reading them back in
`listSnapshots()` instead of hardcoding. Extended the existing `snapshot-manager.spec.ts` test to
assert the real name/trigger; watched it fail against the three files reverted to `HEAD`, then pass
restored. Live-verified post-fix in a rebuilt, restarted isolated dev app: a real Claude instance's
checkpoint timeline now shows correctly labeled "Checkpoint" entries (not "Auto") for both the
Preview→Confirm and plain "Compact Now" compaction flows.

Gates green: `tsc` ×2, `eslint` on touched files, `build:main`, targeted `test:quiet`
(`src/main/session/` — 32 files, 308 tests).

Full detail: [register entry](livetest-remediation-register.md#lt-136-checkpoint-timeline-mislabels-every-checkpoint-auto-and-drops-its-name).

## LT-168 — Auth-repair auto-resume can never revive a still-live errored instance — FIXED AND VERIFIED LIVE 2026-09-20

Found immediately after LT-167's fix made check 4 (auto-resume) reachable for the first time. The
background watch correctly detects a real sign-in (probe returns `authenticated`), but the `revive()`
call it makes always fails with `failureCode: 'target_missing'` — reproduced on 9 consecutive retries
over 90+ seconds with zero change, not a race. Root cause: the auth-repair `revive` callback
(`instance-manager.ts:475-494`) delegates to `SessionRevivalService`, which excludes `'error'`-status
instances from "live" and instead looks them up in **archived** history — but an instance that merely
went to `'error'` after a failed turn (exactly the state auth-repair leaves it in) was never
explicitly archived, so no history entry exists and the lookup always comes back empty. This is
provider-agnostic, not specific to the Codex instance used to find it — any provider hits the same
wall, because the callsite reuses a request shape built for waking an already-archived dormant thread,
not for a still-live session that just needs its adapter respawned in place.

Fixed 2026-08-31 without changing `SessionRevivalService`: auth repair now uses
`InstanceManager.restartInstance()` to recreate the same live instance's adapter in place, then
replays the already-resolved failed turn directly through communication so attachments and the
original context block are preserved. One automatic attempt is permitted; a failed restart or
re-send restores the banner in manual-retry mode rather than polling into an endless restart loop.

Focused auth/Claude/lifecycle coverage is 207/207 green. Both TypeScript checks, lint, the size
ratchet, and `build:main` pass. The repository-wide suite currently has six unrelated failures in
concurrently modified session-recovery files; all scoped suites pass.

Verified live 2026-09-20 on a rebuilt app: a real Codex `401` took the `auth-required` block, a
genuine sign-in restored inside a disposable fake `HOME` cleared the banner within 9s, the same
instance restarted in place with `Native resume succeeded` and `liveId === instanceId`, and the
replayed turn was answered in the transcript 17s after the sign-in — one restart, no loop, no
`target_missing`. Evidence in
[the owning livetest](2026-07-21-in-session-auth-repair_livetest.md#evidence-run--2026-09-20).
Still not live-covered: attachment/context-block preservation (regression tests only) and LT-530's
Claude-specific structured auth path.

Full detail: [register entry](livetest-remediation-register.md#lt-168-auth-repair-auto-resume-can-never-revive-a-still-live-errored-instance--target_missing-forever).

## LT-160 — `instance.waitReason` never reaches the canonical main-process Instance object — FIXED + VERIFIED LIVE 2026-08-18

Found running WS7 Phase B check 6 (offered switch on a long park). A real `InstanceProviderLimitHandler
.maybePark()` call correctly parked a live dev-app instance (`isParked()` true, the real "parked
until …" notification fired), but `SessionAdmissionService.admitAutomatedWrite()` — the guard that is
supposed to suppress automated writes to a parked instance — still returned `{kind: 'admitted'}`
against that same, confirmed-parked instance instead of `{kind: 'suppressed', reason: 'quota-parked'}`.

Root cause: `waitReason` was set exclusively through `InstanceStateManager.queueUpdate()`, which only
ever wrote into the renderer-broadcast `pendingUpdates` batch, never onto the canonical main-process
`Instance` object. Every other batched field (`status`, `contextUsage`, `desiredRuntime`) is *also*
assigned directly onto the live object by its own caller elsewhere in the codebase — `waitReason`
(added later, "Phase 6/§G") was the one field that never got that direct-write step, at any of its
three call sites (`InstanceProviderLimitHandler`, `InstanceAuthRepairHandler`, the loop coordinator's
D7 quota-park wiring). Two real main-process readers gate on it synchronously —
`SessionAdmissionService.admitAutomatedWrite()` and the mobile gateway's `mobile-input-queue.ts` send
gate — and both were structurally blind to every quota-park/auth-required wait state as a result.

Fixed in `InstanceStateManager.queueUpdate()` (`src/main/instance/instance-state.ts`): writes
`waitReason` directly onto the live `Instance` when the parameter is not `undefined` (mirroring the
existing "omit=preserve, null=clear" contract), in the one function every caller already funnels
through. New regression test in `instance-state.spec.ts`, reverted-and-watched-fail before restoring.
Live-verified post-fix: re-parked a fresh instance via the real production `maybePark()` call, then
confirmed `admitAutomatedWrite()` against it now correctly returns `{kind: 'suppressed', reason:
'quota-parked'}`.

Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`; targeted suites
(`session-admission-service.spec.ts`, `mobile-input-queue.spec.ts`, `instance-state.spec.ts`,
`instance-state-machine.spec.ts`, 140 tests) and the full `src/main/instance/` tree (102 files, 1195
tests) all green post-fix.

Full detail: [register entry](livetest-remediation-register.md#lt-160-instancewaitreason-never-reaches-the-canonical-main-process-instance-object).

## LT-137 — interrupting mid-deferred-permission-resume can drop the approved action — **FIXED 2026-09-10**

Status: **fixed, regression-tested, gates green.**

**Corrected root cause:** not a timing-dependent race between interrupt and auto-resume as originally
framed. The Claude CLI process has already exited by the time a deferred-tool-use decision event
fires (`stop_reason: 'tool_deferred'` arrives after CLI exit), so
`DeferredPermissionHandler.resumeAfterDeferredPermission`'s `transitionState(instance, 'respawning')`
call **always** fires while `instance.status === 'waiting_for_permission'` — not just when an
interrupt happens to land in a narrow window. `InstanceStateMachine`'s `TRANSITION_MAP` never allowed
`waiting_for_permission → respawning`, so this always threw `IllegalTransitionError` and silently
dropped the approved action, needing a further explicit prompt-response to recover. An interrupt
attempted in this window is actually rejected by `adapter.interrupt()` (no live process to signal) and
changes nothing about the outcome — it does not cause the bug, and its absence does not prevent it.
This was invisible to CI because the existing `deferred-permission-handler.spec.ts` fully mocks
`ops.transitionState` as an unvalidated `vi.fn()`, never exercising the real state machine.

**Fix:** added `'respawning'` to `waiting_for_permission`'s allowed transitions in
`src/main/instance/instance-state-machine.ts`, with a comment explaining the always-occurring root
cause.

**Verification:** a faithful minimal repro using the real `InstanceStateMachine` confirmed the throw
before the fix and its resolution after. A new regression test in
`deferred-permission-handler.spec.ts` wires `ops.transitionState` to a real `InstanceStateMachine`
instance (seeded to `waiting_for_permission`) instead of the spec's usual bare mock — mutation-checked
by reverting the state-machine fix and observing the test fail with the exact
`IllegalTransitionError: Illegal transition: waiting_for_permission → respawning` from the original
live logs. Full `src/main/instance/` suite (128 files, 1654 tests) green. All canonical gates green
(`tsc` ×2, lint, `check:ts-max-loc`, `build:main`, `build:renderer`); `test:quiet` 22619/22620 (the
one failure is in an untracked file from an unrelated concurrent session).

Original finding (2026-08-18), preserved for history:

Found while driving WS-A5 (admission suppression) of the sibling-audit-round2 live test. Approved a
pending Bash permission prompt (`decisionScope: 'session'`) on a yolo-off instance, then called
`interruptInstance` before the auto-resume completed. `app.log` shows
`DeferredPermissionHandler.resumeAfterDeferredPermission` attempting the transition
`waiting_for_permission → respawning`, which `InstanceStateMachine` correctly rejected
(`IllegalTransitionError`) and logged as `Auto-resume after deferred permission failed`. No crash —
the guard did its job — but the just-approved tool call was never executed, and the instance needed
a further explicit prompt-response before it returned to `idle`.

Not fixed or root-caused further this session — recorded as a real, reproduced edge-case race (an
interrupt landing in the narrow window between permission-approval and auto-resume), not chased
because it needs either a state-machine allowance for this specific transition or an interrupt-side
guard, and establishing which is the right fix needs more investigation time than this pass had.

Full detail: [register entry](livetest-remediation-register.md#lt-137-interrupting-an-instance-while-a-claude-deferred-permission-auto-resume-is-in-flight-can-drop-the-just-approved-action).

## LT-181 — a genuine race lets the pre-queue "already has an active turn" error back into the transcript — FIXED + LIVE-VERIFIED 2026-08-18 (fix made symmetric after a completion-gate finding)

Found by accident while driving the mobile-queue livetest's check 1 (queue while busy): two
near-simultaneous `POST /api/instances/:id/input` calls for the same instance both read
`instance.status` as not-yet-busy and both proceeded straight to `sendInput()`. The loser got the
adapter's raw `"Codex app-server runtime already has an active turn"` rejection landed in the
transcript as an `error` message — the exact pre-queue bug `mobile-input-queue.ts` exists to prevent,
reproduced live against a real dev-app `codex` instance.

Root cause: `shouldQueueInput()`/`isReadyForQueuedInput()` read `instance.status`, which only flips to
a busy status once the adapter's `sendInputImpl` actually runs, itself several `await`s deep inside
`InstanceManager.sendInput()` — a real window where two callers can both observe a stale status.

**First-pass fix (incomplete — see below):** a synchronously-set `directSendInFlight: Set<string>`
guard on `MobileGatewayServer`, checked alongside `shouldQueueInput()` in `handleInput()`'s
direct-send branch only. Reported closed after a passing regression test and a live-verified
sequential race.

**A completion gate reviewing the work reproduced a symmetric gap this missed**: the guard was only
ever set inside `handleInput()`'s direct-send branch, never inside the queue's own delivery path
(`MobileInputQueue.deliverNext()` → `deps.deliver(...)` → `sendInput()`), so a fresh direct send could
still race an *in-flight queue delivery* for the same instance — an ordinary sequence (a queued
message drains just as its unblocking turn finishes, and the user sends again), reproduced with a
scratch spec that got `sendInput` called twice and a non-queued second response.

**Fixed by closing the window symmetrically**: both callers (`handleInput()`'s direct-send branch and
the `inputQueue`'s `deliver` dependency) now funnel through one shared helper,
`MobileGatewayServer.dispatchSend()`, the only place that marks/clears a renamed
`sendInFlight: Set<string>` around the adapter call — one place to get this wrong, not two to keep in
step. `MobileInputQueueDeps.isPaused(instanceId)` (`src/main/mobile-gateway/mobile-input-queue.ts`)
still gates the queue's post-enqueue drain safety-net against `sendInFlight`, now covering both kinds
of in-flight send.

Two regression tests in `mobile-gateway-server.spec.ts`: the original direct-vs-direct case, plus a new
direct-vs-queue-drain case matching the gate's reproduction exactly. Watched the new test fail two
ways — a full revert (both LT-181 tests fail) and a partial revert that restored only the pre-gate
asymmetric shape (only the new test fails, isolating the finding as real and specific) — before
restoring the full fix and confirming both green.

Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc` (`mobile-gateway-server.ts` trimmed back to 1625
lines, inside the 1585+50 tolerance, ceiling not raised), `build:main`; targeted suite
(`mobile-gateway-server.spec.ts` + `mobile-input-queue.spec.ts`, 114 tests, was 113) all green post-fix.

Full detail: [register entry](livetest-remediation-register.md#lt-181-a-genuine-race-lets-the-pre-queue-already-has-an-active-turn-error-back-into-the-transcript).

## LT-138 — no Settings UI exists to grant the per-project `allowPrCreation` opt-in — FOUND 2026-08-18, FIXED 2026-08-24

Found while driving WS-B1 (PR creation round trip). `PrCreationService.createPullRequest()`'s Gate 1
requires a per-project opt-in in the `allowPrCreation` settings map before it will even reach the
(correctly implemented) never-delegable approval dialog. There is no Settings UI control anywhere
to grant that opt-in — confirmed by grepping the entire renderer for `allowPrCreation` (zero
matches). Live-reproduced: with the map empty, `vcsCreatePullRequest` fails with `"PR creation is
not enabled for this project. Enable \"Allow PR creation\" in project settings first."`, pointing
the user at a settings location that does not exist.

The rest of the gating was correctly wired: the setting persists through the generic renderer
`setSetting` IPC channel (verified: wrote `{'/tmp/...': true}`, read it back), and
`$AIO_MCP settings set allowPrCreation` is correctly refused (`policy=read-only cliWritable=no`,
confirmed on the packaged app) — so an agent could not grant itself this authority, only a human via
a UI that did not yet exist. Same shape as LT-095 (no UI to resolve a Computer Use grant): backend
correct, human control surface missing.

**Status update (Batch E, 2026-08-24): found already fixed in the working tree, independently
verified live rather than trusted on sight.** Per the decision recorded in
`2026-08-19-open-decisions-resolved.md` ("build the control"), a real "Allow PR creation" checkbox
now exists in `SourceControlRepoActionsComponent`, writing `settingsStore.set('allowPrCreation',
{...})` keyed by the repo's absolute path — the same key/shape `resolvePrCreationOptIn()` reads on
the main-process side, both ends canonicalized. The refusal message was also corrected to point at
"the Source Control panel for this repository" instead of the non-existent "project settings".
Verified this session: `source-control-repo-actions.component.spec.ts` 6/6 pass; a live
`vcsCreatePullRequest` call with the opt-in map empty reproduced the exact corrected refusal message;
`setSetting('allowPrCreation', {<path>: true})` persisted and read back correctly. Did not proceed
past Gate 1 to click the native OS approval dialog (Gate 2) — no local Mac UI control this session,
same boundary the original 2026-08-18 finding already established; Gate 2 itself was already known
correct and is unchanged by this fix.

Full detail: [register entry](livetest-remediation-register.md#lt-138-no-settings-ui-exists-anywhere-to-grant-the-per-project-allowprcreation-opt-in-that-gate-1-of-prcreationservicecreatepullrequest-requires-before-a-pr-creation-attempt-can-even-reach-the-correctly-implemented-never-delegable-approval-dialog).

## LT-148 — Codex context-pressure diagnostics classifier miscounts the user's own turn echo as tool-bearing — FIXED + VERIFIED LIVE 2026-08-18

Found running the baseline case of the Codex context-pressure controlled-reproduction discovery doc.
A trivial "reply with X, do not use tools" turn — confirmed via the instance's own output buffer to
have made zero real tool calls — still produced an `item-completed` diagnostic record classified
`itemClass: "other"`, which the doc's own safety protocol treats as tool-bearing. Root-caused with a
temporary, reverted debug log: the raw app-server item `type` was `"userMessage"` (the model's own
echo of the user's turn content), not `"reasoning"` as first suspected — `classifyCodexObservedItem()`
had no case for it, so it fell through to the generic `'other'` default.

Fixed by adding a `'user-message'` class to `CodexObservedItemClass` and a
`case 'user_message': case 'userMessage':` branch in
`src/main/cli/adapters/codex/context-pressure-diagnostics.ts`, matching the existing snake/camel
dual-casing pattern. The type has exactly one consumer file (confirmed before touching it), so the
change is fully contained.

Two new/updated regression tests in `context-pressure-diagnostics.spec.ts`, both watched to fail with
the fix reverted and pass restored. Live-verified end-to-end (not only unit-tested): rebuilt, restarted
the isolated dev app, re-ran the identical baseline prompt — the same item now reports
`itemClass:"user-message"` instead of `"other"`. A follow-up small-ticket case with 3 genuine tool
calls now reports exactly 3 tool-bearing items and 0 `"other"`, where before the fix it would have
reported 4 (the spurious user-message echo plus the 3 real tool calls).

Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`, targeted `test:quiet` (14/14).

Full detail: [register entry](livetest-remediation-register.md#lt-148-the-codex-context-pressure-diagnostics-classifier-miscounts-the-users-own-turn-echo-as-a-tool-bearing-item).

## LT-161 — `deserializeInstance()` silently drops wire fields: `failoverProviders` plus four more found in a completeness pass — FIXED + LIVE-VERIFIED for all five fields 2026-08-19 (Batch V2, closes the prior residual)

Found immediately after LT-160, finishing WS7 Phase B check 6's renderer-visible half. With LT-160
fixed, `listInstances()` correctly returned `failoverProviders` for a real, parked instance, but the
renderer's own instance store still had no `failoverProviders` on its copy — `canOfferFailover()`
(`composer-banners.component.ts`) read `false`, so the "Switch provider" button never rendered.

Root cause: `InstanceListStore.deserializeInstance()` — an explicit field-by-field allowlist mapper
that every renderer hydration path funnels through — never listed `failoverProviders`, even though the
renderer's own `Instance` type declares it and the main process always sends it. The field was silently
dropped for every instance, always, regardless of `sessionFailoverProviders` configuration. The
underlying failover mechanism itself (settings → instance creation → `InstanceProviderLimitHandler` →
`attemptInstanceFailover`/`failoverNow`) was already proven correct via WS7 checks 1–5; this was purely
a renderer read-side gap.

**A second, independent review asked the natural follow-up: is that the only field dropped? It was
not.** Enumerating the full renderer `Instance` interface against what `deserializeInstance` actually
reconstructs found four more silently-dropped fields, each with a real, silently-broken consumer:
`hardened` (WS13 hardened-session-died banner — never renders, never self-recovers), `contextEvidence`
(context-evidence panel's conversation-id lookup — permanently undefined), `fastMode` (FAST badge resets
to OFF on every app restart/resync regardless of real state), and `executionLocation` (every remote-node
instance shows as local right after resync/creation). Severity raised P2 → P1 for this reason. Cleared
as genuinely not-wire-carried by design: `isRenamed` (no renderer reads it) and `pendingYoloMode`
(sourced from `desiredRuntime` per an explicit design comment already in the file).

Fixed by adding all five fields to `deserializeInstance()`. **Also added a structural completeness
test** (not just five individual field assertions) — one fixture covering every wire field, run through
`deserializeInstance()`, asserting each survives except the two deliberately-excluded ones — so a sixth
dropped field fails loudly instead of passing silently the way these five did. Reverted the four-field
fix via a `/tmp` copy (never `git stash`/`checkout --`) and watched the structural test fail
(`field "contextEvidence" should survive deserializeInstance(): expected undefined to deeply equal {...}`),
then restored and confirmed 23/23 pass.

Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`; targeted suites
(`instance-list.store.spec.ts` — 23 tests, `composer-banners.component.spec.ts` — 9 tests) and the full
`src/renderer/app/core/state/instance/` tree (9 files, 121 tests) all green post-fix.

**Live-verification status, precisely:** the original `failoverProviders` fix was live-verified in the
real renderer (freshly-created, freshly-parked instance's detail view showed `canOfferFailover(): true`
and the "Switch provider" button in the DOM). The four completeness-pass fields (`hardened`,
`contextEvidence`, `fastMode`, `executionLocation`) are unit-tested (including the revert-and-fail
check) but were **not** separately re-driven live in the dev app this session — recorded as a residual
for a future live spot-check, not claimed as live-verified.

**Batch V2 evidence run — 2026-08-19 (residual closed).** Driven live against the rebuilt app (app.asar
2026-08-19 01:39; dev app launched fresh from the current `dist/main`, a genuine post-rebuild restart —
exactly the scenario that broke these fields). Rather than only exercising `deserializeInstance()`
through a mocked unit fixture, called the actual running `InstanceListStore` inside a real renderer:
`window.ng.getComponent(document.querySelector('app-dashboard')).store['listStore'].addInstance(wire)`
with a synthetic but fully-populated wire-shaped `Instance` object covering all five previously-dropped
fields (`failoverProviders`, `hardened`, `contextEvidence`, `fastMode`, `executionLocation: {type:
'remote', nodeId: ...}`). `addInstance()` and `stateResync()` both route through the identical
`deserializeInstance()` (confirmed by reading `instance-list.store.ts:109-111` and `:128-137`), so
exercising one exercises the same code the other uses on a real app restart. Read back via
`store.instancesMap()`: all five fields survived intact, including the remote `executionLocation`,
matching what `deserializeInstance()`'s source (`instance-list.store.ts:783-790`) now does. A genuine
remote-node `forceNodeId` spawn could not be produced in an isolated dev-app profile (windows-pc's
pairing/connection is scoped to the app process it dialed into, not a fresh empty profile — confirmed
by reading `execution-location-resolver.ts:52-76` and observing a real `"Forced nodeId not
reachable — falling through to local"` warn with `nodeStatus:"not-found"` when attempted), so the
synthetic-wire-object route was used instead of a real remote spawn; this is the same underlying
mapper function either way. Also re-ran `instance-list.store.spec.ts` in the current tree: 23/23 pass.
No residual remains open for this ticket.

Full detail: [register entry](livetest-remediation-register.md#lt-161-deserializeinstance-silently-drops-wire-fields--failoverproviders-plus-four-more-found-in-a-completeness-pass).

## LT-139 — contained automations silently ran as 'standard' (unsandboxed) — FIXED + VERIFIED LIVE 2026-08-18

Found while driving WS-C5/C7 (authority cards + contained runs) of the sibling-audit-round2 live
test — this was the single highest-value finding of the run. `AutomationActionSchema` never
declared WS-C7's `executionProfile`/`containedFallback` fields, even though the shared
`AutomationAction` type and the renderer's Automation builder form both set them. Zod's default
`z.object()` strips unknown keys, so every create/update through `validateIpcPayload` silently
dropped both fields: an automation built with "Contained" selected in the UI would persist and
then run with full, unsandboxed host access and no error anywhere — the exact silent downgrade the
`AutomationExecutionProfile` type's own doc comment says must never happen.

Live-reproduced before touching anything: created a real contained+Claude automation via the IPC
the UI form uses, confirmed the stored action had no `executionProfile` field, then fired it and
watched it spawn and complete as a normal unsandboxed Claude instance — the required "contained on
Claude must fail at fire time, never spawn" behavior was structurally unreachable.

Fixed by adding `executionProfile`/`containedFallback` to `AutomationActionSchema` in
`packages/contracts/src/schemas/automation.schemas.ts` (one shared schema feeds create, update, and
the full read/broadcast `AutomationSchema`, so this is a single-point fix). 3 new regression tests
in `automation.schemas.spec.ts`, reverted to `HEAD` and watched all 3 fail with the pre-fix
silent-drop behavior before restoring the fix.

Live re-verified post-fix (rebuilt `dist/main`, restarted the dev app): the same contained+Claude
automation now correctly fails at fire time (`"Contained runs require Codex — claude cannot enforce
isolation."`, `instanceId: null`); a contained+Codex automation now runs, and its child process's
attempt to write outside the working directory failed with a real OS-level `Operation not
permitted` (not just an unenforced config flag), and the spawned `codex app-server` process's
environment (checked via `ps eww`) carried no API keys/tokens.

Gates green: `tsc` ×2, `eslint` on touched files, `build:main`, targeted `test:quiet`
(`packages/contracts` — 57 files/467 tests; `src/main/automations` — 13 files/161 tests;
`src/renderer/app/features/automations` — 8 files/81 tests).

**Batch V2 evidence run — 2026-08-19 (re-confirmed on the rebuilt app with a fresh disposable
automation).** Against an isolated dev app on the current `dist/main` (not James's real automations —
`list_automations` recorded 33 before and 33 after, unaffected), created a real
`contained`+Claude automation via `automationCreate` (`action.executionProfile: 'contained'`,
`containedFallback: 'fail'`). The create response's own echoed `action` already carried both fields;
more importantly a **separate** `automationGet` call (a fresh read, not the create echo) also returned
`executionProfile: 'contained'`/`containedFallback: 'fail'` on the stored `action`, confirming
persistence rather than just request/response round-tripping. Deleted it immediately after
(`automationDelete`), then confirmed `automationGet` on the same id returned `{success:true,
data:null}` — genuinely gone, not soft-deleted. Did not re-trigger the fire-time contained-fallback
enforcement path this session (already live-verified above); this run isolates and reconfirms the
schema-persistence half specifically.

Full detail: [register entry](livetest-remediation-register.md#lt-139-automationactionschema-packagescontractssrcschemasautomationschemasts-never-declared-ws-c7s-executionprofilecontainedfallback-fields-even-though-the-shared-automationaction-type-and-the-renderers-automation-builder-form-automations-pagecomponentts-both-set-them).

## LT-169 — Skill kill-switch "Disable" does not block automatic trigger-matched injection — FIXED 2026-08-18, hardened after gate review

Found running skill-observability check 3. A follow-up session isolated the root cause with live
process-level instrumentation rather than guessing from source: `SkillAttributionService` is a
per-*process* singleton, and skill auto-injection (`SkillsLoader.detectRelevantSkills`, called from
`unified-controller.ts`'s `fetchSkills`) runs inside the separate context-worker OS process
(`context-worker-main.ts`, an Electron `utilityProcess` with its own module realm and its own
better-sqlite3 connection to the same RLM file — confirmed live via distinct `pid`s, main `10247`
vs worker `10257`). `SKILLS_LOAD`/`SKILLS_SET_CONTROL` run in the main process against the main
process's own singleton, so the explicit-load half of the kill-switch always saw fresh writes and
correctly returned `SKILL_DISABLED`. The old `loadControlCache()` memoized the controls `Map`
**forever** after the first read *per singleton instance* with no cross-process invalidation
mechanism: temporary debug logging showed the worker process's cache, once warmed on its first
turn, kept serving that first snapshot indefinitely and ignored every later `setControl()` call
from the main process — in both directions (a later disable stayed invisible to the worker, and a
later re-enable also stayed invisible). This is exactly the same class of bug the earlier session's
source reading couldn't see, because the guard code (`if (mode === 'disabled') continue`) genuinely
is correct — it's just evaluated against a stale in-memory snapshot in a different OS process.

**Fix:** `loadControlCache()` (`skill-attribution-service.ts:208-249`) now always re-queries the DB
when it's available, instead of memoizing past the first read. The DB row is the only state every
realm actually shares, so it's the only safe source of truth for every read; `controlCache` is kept
only as a last-known-good fallback for a transient DB error and for the pre-existing
DB-unavailable (in-memory-only) mode. No other consumer needed a code change — the explicit-load
path, the health-summary path, and the auto-injection path all already route through this one
method; only its caching behaviour was wrong.

**Verification:**
1. New unit test (`skill-attribution-service.spec.ts`) creates two live `SkillAttributionService`
   instances sharing one DB with no reset between them (modelling main-process vs worker-process).
   It fails on the reverted code (`AssertionError: expected 'enabled' to be 'disabled'`) and passes
   with the fix, in both directions (disable then re-enable).
2. End-to-end in an isolated dev app over CDP: a baseline `flaky test` send produced a
   `test-stabilizer` activation (warming the worker process's cache), `skillsSetControl` disabled
   it from the main process, and a second real `flaky test` send produced **no** new activation
   (`skillsActivationsRecent` held at exactly 1 row for 45s post-send) — the exact production
   scenario, reproduced and then closed.

Gates green (initial fix): `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`, targeted
`test:quiet` (`skill-attribution-service.spec.ts` 11/11, `skills-loader.spec.ts` +
`unified-controller.spec.ts` included in the same targeted run, 56/56 total).

### Update — independent completion gate found two residual issues, both fixed same session

The gate confirmed the root-cause fix above was correct (byte-identical revert, exact claimed
failure reproduced, regression test faithfully modelled the cross-process split, no other instance
of the same memoization anti-pattern found reachable from the worker) but returned FAIL on two
findings:

1. **Fail-open on a transient DB read error (`skill-attribution-service.ts`, was lines 242-247).**
   Always re-querying the DB fixed "stale forever" but reintroduced the same wrong *direction* for
   the single read that happens to race a real write: if the main process disables a skill and the
   worker's very next read throws (`SQLITE_BUSY` or similar) before observing that write, the old
   catch-block fallback (return the last-known-good snapshot, or an empty map on a first-ever
   failure) reports "no override" and lets a builtin default open to `enabled` — the same symptom
   as the original bug, narrowed from "forever" to "until the next successful read". A kill switch
   must fail closed. **Fixed:** `getControl()` now returns a synthetic `{ mode: 'disabled' }` for
   the requested skill whenever the most recent `loadControlCache()` attempt threw (tracked via a
   new `lastControlReadFailed` flag set immediately before every return), instead of falling back to
   a snapshot that cannot know about a write it raced. Both `getEffectiveMode()` and skills-loader's
   direct `getControl()` callers inherit this because they both route through `getControl()` — one
   fix location, no per-consumer duplication. `listControls()` (UI display only, not part of the
   injection-decision gate) intentionally stays best-effort.

2. **Double DB round trip per matched skill per turn (`skills-loader.ts`, `resolveModeFor`), Low
   severity.** `resolveModeFor()` called `attribution.getControl(name)` itself, and on the common
   fallback path (no explicit control) called `attribution.getEffectiveMode(name, source)`, which
   internally calls `getControl(name)` a second time for the same skill — wasted work the
   memoization used to hide, now doubled by removing it. Bounded (only matched candidates, PK-indexed
   tiny table, cheap next to the embedding calls in the same function) but unambiguously avoidable.
   **Fixed:** extracted the pure, DB-free part of `getEffectiveMode()`'s logic into
   `resolveSourceDefaultMode(skillSource)`; `resolveModeFor()` now calls that directly instead of
   `getEffectiveMode()` on its fallback path, so `getControl()` is called exactly once per skill per
   evaluation. `getEffectiveMode()` itself is unchanged for its only other caller (the explicit-load
   IPC handler), which was already a single read.

**Verification, both watched failing on revert via a `/tmp` copy (never `git stash`/`checkout --`):**
- Fail-closed: two new tests in `skill-attribution-service.spec.ts` using a `flakyReadDriver` test
  wrapper that throws once on the next `.all()` call, modelling a transient read error without
  touching the real driver otherwise. Both failed identically on the reverted fail-closed fix —
  `AssertionError: expected 'enabled' to be 'disabled'` — and pass restored, alongside a third
  assertion in the same test proving the failure is genuinely transient (the next healthy read
  recovers the real state, not a permanent lockout).
- Single round trip: a new test in `skills-loader.spec.ts` spies on `getControl` with `vi.spyOn` for
  a registry-discovered (not `registerSkill`-declared) skill, so it exercises the fallback branch.
  Failed on the reverted perf fix — `expected [ Array(2) ] to have a length of 1 but got 2` — and
  passes restored.
- Existing 11 (now 13) `skill-attribution-service.spec.ts` tests and 38 (now 39)
  `skills-loader.spec.ts` tests continued to pass throughout, including the original
  memoization-staleness regression test, unaffected by either change.

Gates green (re-run after both fixes): `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`,
targeted `test:quiet` (`skill-attribution-service.spec.ts` 13/13, `skills-loader.spec.ts` +
`unified-controller.spec.ts` in the same targeted run, 59/59 total).

**Batch V2 evidence run — 2026-08-19 (cheap re-confirmation, plus an incidental live positive).**
Re-ran `skill-attribution-service.spec.ts` + `skills-loader.spec.ts` against the current tree
post-rebuild: 52/52 pass — no regression. Separately, while live-verifying LT-170 on the rebuilt app
(below), a real `flaky test` send produced a `test-stabilizer` activation that reached the renderer;
that activation necessarily passed through this fix's always-re-query `loadControlCache()`/fail-closed
`getControl()` path, so it is a live, incidental confirmation that the kill-switch machinery is intact
end-to-end post-rebuild, though the kill-switch itself (disabling the skill and confirming it stops
firing) was not separately re-exercised this session.

Full detail: [register entry](livetest-remediation-register.md#lt-169-skill-kill-switch-disable-does-not-block-automatic-trigger-matched-injection).

## LT-170 — `skills:activation-delta` never reaches the renderer without a manual refresh — FIXED + REGRESSION-TESTED + LIVE-VERIFIED 2026-08-18 (Batch U2)

Long-standing (2026-07-27, 2026-08-01, 2026-08-12, and an earlier 2026-08-18 session all reproduced
it without isolating the cause). Root cause: `SkillAttributionService` is a per-process singleton
(the same constraint as LT-169), and `recordActivation()` runs inside the **context-worker child
process**'s own `UnifiedMemoryController` — its `emit('activation', …)` fires on a different
`EventEmitter` object than the one `registerSkillAttributionHandlers()` subscribes to in the main
process. Unlike LT-169's DB-backed `controlCache`, a live push event has no "always re-read" fix;
the missing hop had to be re-established explicitly. Fixed by adding a genuine fire-and-forget
outbound message (`WorkerSkillActivationMsg`) to the existing worker↔main protocol: the worker
forwards each activation it records, and the main process re-emits it on its own
`getSkillAttribution()` singleton — no changes needed to the already-correctly-wired
`registerSkillAttributionHandlers()`. Regression-tested (`context-worker-client.spec.ts`, 2 tests,
watched failing on revert) and live-verified end-to-end on a rebuilt dev app: a raw
`onSkillActivationDelta` listener received a real activation with no manual refresh, for the first
time since this defect was first observed.

**Batch V2 evidence run — 2026-08-19 (re-confirmed post-rebuild, on a genuinely fresh dev-app
process).** Launched a dev app fresh from the current `dist/main` (post 2026-08-19 01:39 rebuild;
`dist/main/index.js` had no newer `src/main` sources, and the app itself was launched fresh for this
session — a real new context-worker child process, not a reused warm one). Attached
`onSkillActivationDelta`/`onRlmStoreUpdated`/`onRlmSectionAdded`/`onWakeContextGenerated` listeners
before creating a real local Claude instance, then sent `sendInput({message: "flaky test — ..."})`
on it. Result: `test-stabilizer` landed in `skillActivationDelta` (count 1) with no manual refresh —
the fix holds after a genuine restart, not just the same warm process it was originally verified in.

Full detail: [register entry](livetest-remediation-register.md#lt-170-skillsactivation-delta-never-reaches-the-renderer-without-a-manual-refresh-cross-process-eventemitter-split).

## LT-192 — calendar mutation approval requested before checking the target account can possibly succeed — FIXED + REGRESSION-TESTED 2026-08-18 (fix corrected after a completion-gate finding), not live-verified against a real Graph mutation

`OrchestratorToolsRpcServer.handleRequest()`'s shared case for the four `graph_calendar_*` mutation
methods requested blocking human approval via `authorizeCalendarMutation()` before ever checking
whether the target account existed or was agent-writable — that check lived only downstream, inside
`requireWritableAccountKey()` in `orchestrator-calendar-tools.ts`, reached only after approval. With
zero Microsoft accounts connected on this machine (`graph_calendar_status` → `{"accounts":[]}`),
another agent's `graph_calendar_create_event` call blocked on an unanswerable approval and timed out
client-side with no side effect — an operator (or an unattended caller) can be asked to approve, and
made to wait out the full approval window for, a mutation that was always going to fail.
`graph_calendar_connect` sits in the same case group but is not part of the defect: connecting is how
an account is created, so it must remain callable with zero accounts.

Fixed by adding `assertCalendarMutationAccountPrecondition()` (no-ops for `connect`, otherwise reuses
the newly-exported `requireWritableAccountKey()`) and `dispatchCalendarMutation()` — a shared
precondition→approval→dispatch helper, generic over the RPC method's literal type — to
`orchestrator-tools-rpc-calendar.ts`. The RPC server's calendar-mutation case now calls
`dispatchCalendarMutation(...)` once, deliberately kept to a single call site so the dispatcher does
not grow direct knowledge of Graph account-resolution internals — that logic lives entirely beside
the existing calendar RPC glue instead. The already-approved and already-denied paths are unchanged:
same approval call shape, same denial error text, same downstream tool dispatch.

Four new/updated tests in `orchestrator-tools-rpc-server.spec.ts`: three fail-fast cases (create/
update/delete against an unconnected account never call `authorizeCalendarMutation` or the tool
handler, surfacing the real `requireWritableAccountKey` error text) and one "connect still reaches
approval with zero accounts" case. Two pre-existing tests (approved-path dispatch, denied-path block)
were updated to supply a writable calendar account so they keep exercising their original paths
rather than being short-circuited by the new precondition. Watched the three new fail-fast tests fail
— twice, once before and once after refactoring the precondition into `dispatchCalendarMutation()` —
each with `promise resolved "undefined" instead of rejecting`, by removing the precondition call in a
`/tmp`-isolated copy first; restored and confirmed 67/67 pass both times.

Gates green: `tsc` ×2, `ng lint`, `build:main`; `check:ts-max-loc` clean with **no ceiling change** —
the case-block rewrite that calls the new shared helper was net-negative against the pre-existing
case body, keeping `orchestrator-tools-rpc-server.ts`'s total net growth to +3 lines (offset by one
import line), so the file still reports only as the pre-existing informational notice (47 over its
710 ceiling, inside the standing +50 tolerance) rather than a new violation. Targeted suite
(`src/main/mcp/`) green.

Not live-verified against a real Graph mutation: doing so needs either a connected Microsoft account
(out of scope — `graph_calendar_connect` opens interactive OAuth and was explicitly excluded from
this check) or reproducing the exact zero-account production state against a live, approval-answering
operator, neither of which this session could safely do.

**Completion-gate finding (fixed):** an independent completion gate reviewing the diff found that the
first-pass precondition extracted `payload.account` with a hand-rolled
`typeof payload['account'] === 'string' ? payload['account'] : ''` — comparing the raw, untrimmed
value — while the real handler's own `AccountSchema` (`z.string().trim()...`) trims before resolving.
A whitespace-padded but otherwise valid, connected, writable account (e.g. a trailing space from an
LLM-composed tool call) would be falsely rejected by the precondition before approval was even
requested, though the identical call succeeded before this session's change. Fixed structurally, not
with a bare `.trim()`: exported `AccountSchema` and added `extractRequestedAccount()`
(`orchestrator-tools-rpc-calendar.ts`), which normalizes via `AccountSchema.safeParse(...)` — the same
schema instance the real handler's payload schema already applies to this field — so the precondition
and the real resolution can no longer drift apart. New test: "reaches operator approval for a
whitespace-padded account, matching Zod's trim normalization". Reverted the normalization (hand-rolled
extraction restored in a `/tmp` copy) and watched only that new test fail, with
`Calendar mutation is not permitted for agent calendar mutations:   james@communitytech.co.uk  `;
restored and confirmed 68/68 pass. Gates re-run clean post-fix: `tsc` ×2, `ng lint`, `check:ts-max-loc`
(still no new violation, ceiling config still untouched), `build:main`.

Full detail: [register entry](livetest-remediation-register.md#lt-192-calendar-mutation-approval-requested-before-checking-the-target-account-can-possibly-succeed).

## LT-188 — manual "Compact Now" races its own auto-compact trigger — FIXED + REGRESSION-TESTED 2026-08-19 (Batch N3)

`ContextCompactor` is a process-wide singleton whose `addTurn()` fires an un-awaited `this.compact()`
the moment `fillRatio` crosses `triggerThreshold`. `CompactionRuntime.restartCompact()` (the manual
"Compact Now" strategy for any provider without native compaction, including Claude) rebuilds the
whole transcript via a loop of `addTurn()` calls before making its own unconditional
`await compactor.compact()` — so on a transcript large enough to cross the threshold mid-loop, the
loop itself triggers an uncoordinated background auto-compact racing the caller's own explicit one,
both mutating the same shared `this.state`. Live-reproduced against a real `claude` instance: two
distinct `[ContextCompactor] Compaction started` log lines per one `compactInstance()` IPC call, at
different `fillRatio` values; under `require-confirmation`, two independent pending paid-fallback
approval requests for one "Compact Now" click; under `notify-and-allow`, one attempt completed with
no Local AI Guard routing event at all (the race apparently starved the aux call before it ran).

**Fixed** by taking the first of the three named options — suspend auto-compact during the manual
rebuild — since `addTurn()` has exactly one production caller (`restartCompact()`'s own rebuild loop),
so its auto-trigger firing mid-rebuild was always redundant with that same function's trailing
explicit `compact()` call. Added `addTurn(turn, { suppressAutoCompact?: boolean })`; the rebuild loop
now passes `suppressAutoCompact: true` on every call, so only the loop's own explicit `compact()` ever
runs. Regression-tested at the unit level (3 new tests in `context-compactor.spec.ts`, reverted and
watched 2 fail, restored and confirmed 60/60 pass); **not re-driven live end to end this session** —
judged not worth the ~$5–6/round real provider spend and 20+ minute wall clock the original live repro
needed, given the fix is narrowly scoped and mechanically verified against the exact diagnosis.

Full detail: [register entry](livetest-remediation-register.md#lt-188-manual-compact-now-races-its-own-auto-compact-trigger-producing-duplicate-compactions-and-duplicate-fallback-proposals).

## LT-189 — `notify-and-allow` fallback policy has no notification/banner delivery — RESTORED IN CODE 2026-09-23; rebuilt-app check pending

**Current status:** The passive banner passed a live check on 2026-08-21, was removed in a later change, and was restored in source on James's 2026-09-23 decision. The earlier live run below proves the old build only; the restored build still needs the linked rebuilt-app check. See the [register correction](livetest-remediation-register.md#lt-189-notify-and-allow-fallback-policy-has-no-notificationbanner-delivery-anywhere).

`LocalAiRoutingGuard.authorizeFallback()`'s `notify-and-allow` branch calls
`this.dependencies.notifyFallback?.(event)`, but the only production construction site
(`local-ai-runtime.ts`) never supplied a `notifyFallback` callback, so it was always a no-op. The
renderer's only fallback-facing component (`local-ai-fallback-banner.component.ts`) rendered
exclusively from the `require-confirmation` pending-decision queue, which a `notify-and-allow` event
never enters. Live-confirmed 2026-08-18: several real `notify-and-allow` compression fallbacks fired
with the renderer watched live the whole time — no banner, toast, or notification of any kind, only
the effectiveness dashboard's counters updating silently.

**Fixed 2026-08-21** (by a separate, uncommitted session; live-verified independently by Batch Q2,
which did not author the fix). The product decision resolved to a passive, dismissible banner
distinct from the `require-confirmation` decision banner: `notifyFallbackInto()`
(`local-ai-runtime.ts:183`) is now wired at the production construction site
(`local-ai-runtime.ts:282`), and `local-ai-fallback-banner.component.ts` gained a second
`.local-ai-fallback-notifications` section (mounted globally via `app.component.html`) with a
`Dismiss` action. Batch Q2 rebuilt `dist/main` from the current source, drove a real
`notify-and-allow` fallback via the `titleGeneration` slot (a documented cheaper substitute for the
original compression-slot repro — the `notify()` call site is reached identically regardless of
which slot or policy source triggers it), and confirmed via CDP with focus emulation that the banner
rendered with the correct slot label and that a real click on `Dismiss` removed it from the DOM.

Full detail: [register entry](livetest-remediation-register.md#lt-189-notify-and-allow-fallback-policy-has-no-notificationbanner-delivery-anywhere),
[livetest evidence run 2026-08-21](../superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md#evidence-run--2026-08-21-batch-q2--lt-189-confirmed-fixed-and-live-end-to-end-backend--renderer-checks-25-re-confirmed-blocked-reasoning-unchanged).

## LT-190 — Local AI Guard fallback cost estimation silently returns nothing for any real `defaultCli` value — FIXED + REGRESSION-TESTED 2026-08-18, gate-finding follow-up FIXED same day

`LocalAiRoutingGuard`'s pre-authorization cost estimate comes from `resolveFallbackModel()`, which
passes `settings.defaultCli` (a CLI-facing id like `'claude'`) straight into
`computeProviderTokenCost()` → `getProviderModelRate()` → `normalizePricingProvider()`
(`src/shared/data/model-pricing.ts`), whose `switch` only recognized upstream vendor names
(`'anthropic'`/`'openai'`/`'google'`) and returned `undefined` for anything else — including
`'claude'` itself, which is never a vendor name. Every fallback routing event's `estimatedCostUsd`
was therefore silently omitted for any ordinary (non-`'auto'`) `defaultCli` setting, not an edge case.
Live-reproduced: real `compression` fallback events persisted `provider: 'claude', model: 'opus[1m]'`
with `estimated_cost_usd: NULL`, despite `opus[1m]` having a real priced entry.

Fixed by making `normalizePricingProvider()` pass through an id that is already a
`PROVIDER_MODEL_LIST` key (identity) before falling back to the vendor-name switch. The separate,
correctly-wired post-call "known cost" path (fed by real vendor names like `'anthropic'`) is
unaffected.

`src/shared/data/model-pricing.spec.ts` — 3 new tests in a `getProviderModelRate provider-id aliasing
(LT-190)` block. Reverted the fix in an isolated copy first and watched the CLI-style-id test fail
with `expected undefined to deeply equal { input: 5, output: 25 }`; restored and confirmed 19/19 pass.
Live-verified post-fix (rebuilt `dist/main`, restarted the dev app on the same profile): the next two
real fallback routing events persisted `estimated_cost_usd: 0.38982` and `0.5037` where every prior
event in the session had `NULL`.

Gates green: `tsc --noEmit` ×2, `ng lint`, `build:main`; `check:ts-max-loc` unaffected (one
pre-existing unrelated violation in `mobile-gateway-server.ts` from other concurrent work).

A same-day independent completion gate confirmed the original defect/repro/revert evidence, then found the fix's own widening was itself unsafe: the `CLI_PROVIDER_KEYS` identity-passthrough let `getProviderModelRate()`'s flat, non-namespaced static-table fallback resolve for `copilot`/`cursor` too — and those providers reuse the exact same raw model-id strings as the primary vendors they proxy for pass-through models (`COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5 === 'claude-opus-5'`, plus the same shape for a Codex-family id on both Copilot and Cursor). So a Copilot-pinned default resolved to Anthropic's direct per-token API rate — a confidently wrong number, not the honest `undefined` it returned before the original fix. Copilot here is a subscription seat (James's EBRD-scoped seat), not metered billing, so this was the wrong billing model entirely, not just an imprecise one; the same reasoning applies to Cursor.

Checked first (both already correct): `exceedsConfiguredCeiling()` (`local-ai-fallback-store.ts:267-273`) already fails closed on `estimate === undefined` (blocks before comparing to the ceiling), and `createRoutingEvent()` omits the `estimatedCostUsd` field entirely rather than defaulting it to `0` when unpriceable — so the existing budget-ceiling path already distinguishes "unpriceable" from "priced at zero" and fails safe on the former. The gate-reported bug's real cost was handing that guard a defined wrong number instead of the `undefined` that would have tripped it.

Fixed by adding an explicit `STATIC_TABLE_PROVIDERS` allowlist (`claude`/`codex`/`gemini`/`grok` — the primary vendors that own the raw-id space `MODEL_PRICING` is keyed by) and gating the static-table fallback branch on it, after the provider-namespaced live-overlay lookup (unaffected) and before the `PROVIDER_MODEL_LIST` membership check. Deliberately an allowlist so a future provider is unpriced by default rather than silently inheriting a colliding raw id.

Added the regression test the gate asked for: `getProviderModelRate('copilot', COPILOT_MODELS.CLAUDE_OPUS_5)` must not equal the `claude` rate — asserts the real collision, the fixed function returns `undefined` and is `not.toEqual` the Claude rate, the same shape for a Codex-family id on Copilot and Cursor, that `computeProviderTokenCost` propagates `undefined` not `0`, and that Cursor's `AUTO` sentinel is unpriced too. Reverted the allowlist gate in a `/tmp` copy and watched the new test fail with `expected { input: 5, output: 25 } to be undefined`; restored and confirmed 20/20 pass. Gates re-run clean: `tsc --noEmit` ×2, `ng lint`, `build:main`, `check:ts-max-loc` (unaffected). Sent back to a fresh completion gate.

One related, pre-existing, out-of-scope observation flagged in the register: `getModelRate()` (the provider-agnostic sibling used elsewhere by `computeTokenCost()`/`CostTracker`) has the same theoretical id-collision exposure and was not touched by either LT-190 change — a different call path (real reported usage, not a pre-authorization estimate), left for whoever next touches it.

Full detail: [register entry](livetest-remediation-register.md#lt-190-local-ai-guard-fallback-cost-estimation-silently-returns-nothing-for-any-real-defaultcli-value).

## LT-193 — Unpriced fallback dispatches display as `$0` rather than unknown

**Status: FIXED + COMMITTED — found already fixed by Batch Q2 (2026-08-21), status corrected from
stale "not fixed"; the fix itself was not authored by this batch and its exact authorship/date is
not recorded here.**

Filed from the LT-190 second completion gate. `addAccountingCost()`
(`src/main/local-ai-guard/local-ai-row-mappers.ts:655-659`) coalesced an absent cost to `0` when
folding a routing event into `LocalAiIncident.estimatedCostUsd` (a required non-nullable `number`),
so an unpriceable dispatch was rendered as a literal `$0` in the target card, incident panel and
effectiveness panel.

The presentation decision (`—` vs `$X + N unknown` vs a "not metered" badge) resolved to
`unpricedDispatchCount` alongside `estimatedCostUsd`, rendered as "cost unknown (N unpriced)" on the
target card and incident panel and "N unpriced — cost unknown, not zero" on the effectiveness panel
— the exact template `LT-193`'s own writeup suggested. Confirmed already in `HEAD` (`fc90e707
Livetest fixes`, not part of any batch's currently-uncommitted work) while Batch Q2 was verifying an
adjacent Local AI Guard livetest doc: `LocalAiIncident.unpricedDispatchCount`
(`shared/types/local-ai-guard.types.ts:227,323`), populated in `local-ai-row-mappers.ts:267,480,604`,
read at all three originally-named render sites (`local-ai-target-card.component.ts:479-487`,
`local-ai-incident-panel.component.ts:292-302`, `local-ai-effectiveness-panel.component.html:76`),
with regression coverage in the matching `.spec.ts` files for each. Not re-run/re-verified live by
Batch Q2 — this is a source-reading correction of a stale status label, not a fresh live-test pass.

See the [LT-193 register entry](livetest-remediation-register.md#lt-193-unpriced-fallback-dispatches-display-as-0-rather-than-unknown).

## LT-200 — instance-detail Review panel's `reviewStartSession` call always fails Zod validation

**Status: FIXED + REGRESSION-TESTED (2026-08-18).**

Found while preparing to drive the skill-observability livetest's check 8 (design-drift review
agent) live. `InstanceReviewPanelComponent.runReview()` sent `reviewStartSession({ agentId:
agentIds[0], instanceId, workingDirectory, files, options: { agentIds, diffOnly } })` through the raw
preload API — `ReviewStartSessionPayloadSchema` requires `{ instanceId, agentIds: string[], files,
diffOnly? }`, no `agentId` (singular), no `workingDirectory`, no `options` wrapper. Live-reproduced
with `REVIEW_START_SESSION_FAILED: "agentIds: Invalid input: expected array, received undefined"` —
every call from this panel failed, for every agent, every time. This is the panel check 8's own
wording names ("review panel agent list should show 'Design Drift Analyzer'"), so that check was
structurally unreachable through it. The sibling `reviews-page.component.ts` was unaffected — it
already goes through `OrchestrationIpcService.reviewStartSession()`, which builds the correct shape.

Fixed the call site to build `{ instanceId, agentIds, files, diffOnly }` and corrected the preload
wrapper's stale TypeScript parameter type (`orchestration.preload.ts`) to match the real schema.
Regression test added and watched fail on revert (`instance-review-panel.component.spec.ts`, 21/21
pass restored). Gates green: `tsc --noEmit` ×2, `ng lint`, `check:ts-max-loc` (unaffected),
`build:main`.

Re-verified live the same session against a real `design-drift-analyzer` run: a fixture with an
`Inter` display font and a keyword-eased `transition: all` produced exactly the two expected
`design-drift/typography`/`design-drift/motion` findings with file:line citations; a backend-only
SQL migration fixture produced zero findings. Check 8 now passes both halves.

Full detail: [register entry](livetest-remediation-register.md#lt-200-instance-detail-review-panels-reviewstartsession-call-always-fails-zod-validation).

## LT-194 — Workboard Decision Timeline's compaction source never produced an entry — FIXED + REGRESSION-TESTED + LIVE-VERIFIED 2026-08-18

`buildCompactionDecisions()` reads `CompactionCoordinator.getEpochTracker(instanceId).getHistory()`,
but nothing in production ever called `CompactionEpochTracker.onCompaction()` (the only method that
pushes into `.history`) or `incrementTurn()` (which feeds `turnsBeforeCompaction`) — both were dead
code outside the class itself. Live-reproduced by running a real `compactInstance()` call and getting
`[]` back from `workboardGetDecisionsForItem({instanceId})`.

Fixed by calling `getEpochTracker(instanceId).onCompaction()` in `CompactionCoordinator.executeCompaction()`
on every successful compaction, and `getEpochTracker(instanceId).incrementTurn()` in the existing
`onContextUpdate()` per-turn hook. Regression test added (`compaction-coordinator.spec.ts`, 4 new
tests) and watched 3 of them fail on revert (`expected [] to have a length of 1`); restored and
confirmed 22/22 pass. Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`.

Re-verified live post-fix (rebuilt `dist/main`, restarted the dev app): a real compaction now produces
`"Context compacted after 7 turns"` from the IPC call and in the real Workboard item detail DOM.

Full detail: [register entry](livetest-remediation-register.md#lt-194-workboard-decision-timelines-compaction-source-could-never-produce-an-entry).

## LT-195 — automation retry/backoff silently cancelled for every one-time automation by an async event race — FIXED + REGRESSION-TESTED 2026-08-18 (fix corrected after a completion-gate finding); LIVE-RE-VERIFIED 2026-08-19 (Batch V2, closes the prior residual)

`AutomationRunner.handleTerminalRun()` synchronously arms a retry timer, then (for a `oneTime` run)
calls `emitAutomationState()`, which asynchronously re-emits `'automation:changed'` after a
`store.get()` resolves. By then the automation's `nextFireAt` has already gone `null` (spent by
firing), so `AutomationScheduler`'s generic `'automation:changed'` listener fell to its `else` branch
and called the FULL `deactivate()` — cancelling the just-armed retry within ~1ms, every time, for
every one-time automation (manual `runNow`, provider-limit-resume automations, any user-created
one-time schedule). No error surfaced; the run just stuck at attempt 1 forever with
`consecutiveFailures` never incrementing either (the runner correctly, but now pointlessly, skips
recording an outcome while it believes a retry is pending).

Root-caused with certainty via a Node-inspector-instrumented `deactivate()` capturing a live stack
trace: `deactivate ← 'automation:changed' listener ← emitChanged ← automation-runner.js:433
(emitAutomationState's .then())`, with the just-armed retry handle present in `retryHandlesBefore` at
the moment of the call.

**First-pass fix (superseded).** Added `AutomationScheduler.hasPendingRetry(automationId)` and
checked it in the `'automation:changed'` listener before the destructive `deactivate()` — ANY event
while a retry was pending took the `deactivateSchedule()`-only branch. Live-verified at the time
(rebuilt `dist/main`, restarted the dev app): the repro scenario reached `attempt: 2` on a new run
row, and the real Workboard item detail DOM showed `"Retried automatically — attempt 2 of 3"`.

**Completion-gate finding (P1 regression, fixed same day).** That guard couldn't distinguish the
async echo from a genuine external disable. `AUTOMATION_UPDATE` (the handler behind the Automations
page "Pause" toggle) and the `update_automation` MCP tool both call `scheduler.schedule(automation)`
(fire-handle only) then `emitChanged(...)` on an ordinary disable — reachable from normal UI use, not
an edge path — and neither calls `deactivate()`/`cancelRetry()` first (unlike delete, which does).
So disabling an automation while a retry was armed left the retry running anyway: the UI said "off",
but a run fired later regardless — for auto-created provider-limit-resume automations specifically,
an unexpected session resume against something the operator believed disabled. Not oneTime-specific
either: `handleTerminalRun` doesn't gate retry scheduling on `isOneTimeRun`, so a cron automation
disabled mid-backoff hit the same gap. Reproduced empirically by replaying the real
`store.update({enabled:false})` → `scheduler.schedule()` → `emitChanged()` sequence: `retryHandles`
stayed non-empty when it had to be empty.

**Corrected fix.** The retry-preserving branch now also requires `event.automation?.enabled ===
true` — the one field every disable path in this codebase actually flips (the "Pause" toggle,
`AUTOMATION_UPDATE`, `update_automation` all only ever change `enabled`; a fired run's own echo never
touches it), so a genuine disable is now told apart from the echo by the same authoritative bit those
write paths themselves use, not a heuristic. `event.automation === null` (delete) also correctly falls
through to full `deactivate()` regardless of delete's own explicit call. Rewrote the misleading
first-pass code comment to state this. Two new regression tests added (disable racing an ARMED retry,
for both a oneTime and a cron automation — the pair that pins the distinction alongside the original
echo-preserves-retry repro and the no-pending-retry-disable control, 4 tests total now). Reverted only
the corrected condition via a `/tmp` copy and watched exactly the two new tests fail (`expected 1 to
be +0`) with the other 25 — including the original repro — staying green; restored and confirmed
27/27 pass. Gates re-run clean: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`, full
`src/main/automations` suite (165/165).

Originally not live-re-verified after the correction — closed below.

**Batch V2 evidence run — 2026-08-19 (residual closed, real disable-vs-armed-retry race driven
live).** Against an isolated dev app on the current `dist/main` (a disposable automation, deleted
after — production automations unaffected: 33 before, 33 after via `list_automations`), created a
one-time automation with a deliberately-nonexistent `workingDirectory` so every fire fails fast and
deterministically (`CliSpawnCwdError` → "Automation instance was removed"), then `automationRunNow`.
Attempt 1 failed in <1s and armed a retry (`app.log`: `"Scheduling automation retry"`,
`attempt:1, delayMs:31318`). Attempt 2 fired automatically ~31s later, also failed fast, and armed a
third retry (`delayMs:60343`, computed fire time ~60s out). **Then, with that third retry genuinely
armed** (confirmed by its own log line, timestamped *after* this session's `automationUpdate` disable
call landed — the same racy ordering the completion-gate reproduced), called
`automationUpdate({id, updates:{enabled:false}})` — the exact same handler the Automations page
"Pause" toggle and the `update_automation` MCP tool use (`AUTOMATION_UPDATE`, fire-handle-only
`scheduler.schedule()` + `emitChanged()`, no `deactivate()`/`cancelRetry()` first). Polled past the
computed fire time (36+ real seconds, confirmed against wall-clock): no third run row ever appeared
(`automationListRuns` stayed at exactly 2 rows, both `failed`), `nextFireAt` stayed `null`, and
`app.log` recorded no `"Firing automation retry"` line for attempt 3 — the armed retry was genuinely
cancelled by the disable, not fired anyway. This is the live confirmation of the completion-gate's
corrected `event.automation?.enabled === true` condition working against the real, unmodified
`AUTOMATION_UPDATE` production write path (not a replayed unit-test sequence). Also re-ran
`automation-retry-integration.spec.ts` + `automation.schemas.spec.ts` against the current tree:
43/43 pass, no regression. No residual remains open for this ticket.

Full detail: [register entry](livetest-remediation-register.md#lt-195-automation-retrybackoff-silently-cancelled-by-an-async-automationchanged-race-for-every-one-time-automation).

## LT-196 — "Scan for corrections" learning-scan is structurally non-functional for Claude sessions — FOUND, NOT FIXED, 2026-08-18, needs a design decision

`correction-miner.ts` depends on a `type: 'tool_result'` `OutputMessage` (with `metadata.is_error`)
existing in archived history for every tool call — true when its file-header survey was written
(2026-07-30), but silently invalidated for Claude by the later, correctly-motivated LT-062 fix
(2026-08-12): Claude's adapter now only turns a `tool_result` into a visible transcript message on
the permission-denial branch; an ordinary success or failure is raw-emitted only on the live
`'tool_result'` event (doom-loop detection) and never written to history. Every archived Claude
invocation therefore has `isError: null`, and the miner's first gate (`isError !== true → skip`)
discards everything before pairing starts.

Live-reproduced twice against real Claude sessions (a genuine `grep --bogus-flag` → corrected `grep`
pair, matching the miner's own detection shape) and confirmed via a Node-inspector read of the
archived conversation that it contains zero `tool_result` messages. `runScan()` reports
`patternsFound: 0` with no error — no signal anything is broken.

Not fixed — two viable directions are a genuine architecture/product decision, not a bug fix: (a)
persist a lightweight, transcript-invisible `tool_result` record specifically for later mining, or (b)
feed the miner from a separately persisted log of the raw `'tool_result'` events already emitted live.
Either risks reintroducing some of the LT-062 transcript-noise fix if done carelessly.

The rest of the Memory Review inbox (approve / edit-approve / reject with correct provenance,
decision persistence across a real app restart, and an approved lesson reaching a subsequent real
loop's actual prior-context block) was independently live-verified working correctly this same run.

Full detail: [register entry](livetest-remediation-register.md#lt-196-scan-for-corrections-learning-scan-is-structurally-non-functional-for-claude-sessions).

## LT-206 — RLM and Wake renderer events are dead for the worker-routed paths — FIXED + REGRESSION-TESTED 2026-08-18; LIVE-VERIFIED after a genuine post-rebuild restart 2026-08-19 (Batch V2, closes the prior residual)

The 3rd/4th instance of LT-169/LT-170's class (a per-process `EventEmitter` singleton emits inside
the context-worker child process; main's separate instance of the same singleton never observes it).
Diagnosis independently confirmed empirically first — not just re-read from the filed defect — via a
main-process inspector diagnostic listener plus real `createInstance()` calls through the actual
renderer path: `store:created` persisted correctly to `rlm.db` and `buildWakeContextText()` returned
real text, but main's own singleton listener stayed silent both times, while a control call made
directly in main fired it immediately (proving the listener wiring was fine and the worker boundary
was the only break). Also empirically confirmed `wake:hint-added` is NOT dead (`addHint()` has no
worker call path in production) — a live `wakeAddHint()` → `onWakeHintAdded()` round-trip through the
real renderer succeeded immediately.

Fixed with one generic mechanism rather than a third and fourth bespoke message: new
`src/main/instance/context-worker-event-forwarding.ts` holds an allowlist of clone-safe
`(singleton, event)` pairs forwarded worker→main (`RLMContextManager`'s `store:created`/
`section:added`/`section:removed`/`query:executed`, `WakeContextBuilder`'s `wake:context-generated`),
posted as one message shape (`{type:'worker-event', source, event, payload}`) and re-emitted on
main's matching singleton by `dispatchWorkerBroadcast()`. LT-170's `skill-activation` message was
folded into the same dispatcher so there is a single place this mechanism lives; LT-170's own tests
were re-run unmodified and still pass. `context-worker-client.ts` was at its exact 700-line ceiling —
kept there by making the client-side change net-zero lines rather than raising the ceiling.

Regression-tested with 9 new tests in `context-worker-event-forwarding.spec.ts`; reverted the fix via
a `/tmp` copy and watched 7 of 9 fail (the 2 that still passed were the deliberate `wake:hint-added`
negative control and an RPC-bookkeeping check, both correctly unaffected by the fix), then restored
and confirmed all 9 pass plus 227 tests across 15 adjacent spec files unaffected. Originally not
live-verified against a rebuilt/restarted app — closed below.

Related, out of scope: the codebase-indexing lane worker (`codebase-indexing-lane-main.ts`) is a
*third* process with its own separate `RLMContextManager` singleton instance, discovered incidentally
while tracing callers. Not investigated for the same defect class — flagged for a follow-up ticket,
not fixed here. (LT-207, immediately below, is that follow-up.)

**Batch V2 evidence run — 2026-08-19 (residual closed with a genuine post-rebuild restart).** Launched
a dev app fresh from the current `dist/main` (post 2026-08-19 01:39 rebuild; confirmed no `src/main`
file was newer than `dist/main/index.js` before launch, so this dev app runs the same code the
rebuilt packaged app does) — a real fresh process, real fresh context-worker child, not a reused warm
instance. Attached `onRlmStoreUpdated`/`onRlmSectionAdded`/`onWakeContextGenerated` listeners before
`createInstance()`, then created a real local Claude instance and sent it a message. Result:
`rlmStoreUpdated` (5), `rlmSectionAdded` (4), and `wakeContextGenerated` (1) all landed in the
renderer with no manual refresh — the worker→main forwarding survives a genuine restart, not just the
already-warm process it was verified in the first time. Also re-ran
`context-worker-event-forwarding.spec.ts` against the current tree: unaffected. No residual remains
open for this ticket.

Full detail: [register entry](livetest-remediation-register.md#lt-206-rlm-and-wake-renderer-events-are-dead-for-the-worker-routed-paths).

## LT-207 — the codebase-indexing lane's own `RLMContextManager` singleton never reaches main — FIXED + REGRESSION-TESTED 2026-08-18

The 5th instance of LT-169/LT-170/LT-206's class, and the follow-up flagged as out-of-scope by the
LT-206 section above. A third process — the codebase-indexing lane
(`codebase-indexing-lane-main.ts`) — constructs its own worker-local `RLMContextManager.getInstance()`,
and `CodebaseIndexingService.addSection()` genuinely calls `this.contextManager.addSection(...)`
inside it, so `section:added` fired during codebase indexing was invisible to main and never reached
the renderer's `RLM_SECTION_ADDED` channel.

Diagnosis independently confirmed empirically, not just re-read: a real dev app (`--inspect`) had a
diagnostic listener attached to main's `RLMContextManager.getInstance()`, first confirmed live against
a **control** `section:added` fired directly on main (`createStore`+`addSection`, no worker involved)
to rule out a listener-wiring problem, then against a **real** `CodebaseIndexingLaneGateway.indexCodebase()`
call that indexed a real one-file directory through the real forked/utility-process lane worker.
Post-fix, the real indexing run's `section:added` landed on main's singleton exactly once (a fresh
app restart plus single-listener count ruled out double-delivery).

Fixed by reusing LT-206's generic mechanism rather than a third bespoke forwarder. The lane worker
needed a new transport adapter because it talks to main over `LaneOutboundMessage`
(`background-jobs/types.ts`), not `ContextWorkerOutboundMsg` directly: added a `{type:'worker-event',
message}` variant to `LaneOutboundMessage`, threaded it through `ProcessLaneGateway` →
`BackgroundJobRuntime.registerLane()` → `CodebaseIndexingLaneGateway`'s constructor, which calls
`dispatchWorkerBroadcast()` unmodified — the same LT-206 function, not a copy. On the worker side, a
guarded `ensureWorkerEventForwarding()` calls `registerWorkerEventForwarding()` once per process,
positioned *after* `RLMDatabase.getInstance()` is configured with the job's `userDataPath` and
*before* the first `RLMContextManager.getInstance()` call — `RLMContextManager`'s constructor eagerly
resolves `RLMDatabase.getInstance()` with no config, and since both are `getInstance()` singletons
where the first caller wins, registering forwarding first would have permanently pinned the RLM
database to its default (wrong) path for the worker's lifetime.

Left as-is, and worth noting: `RLM_SECTION_ADDED`/`RLM_STORE_UPDATED` renderer forwarding is still
gated by the pre-existing, unrelated `isHighVolumeContextStore()` filter
(`store.config.kind === 'codebase-auto'`) in `ipc-main-runtime-wiring.ts`. The live check above
deliberately used a plain (non-`'codebase-auto'`) store to isolate the process-boundary fix from that
filter; auto-indexed codebases (created via `codebase-indexing-auto-coordinator.ts`, which does tag
`'codebase-auto'`) still will not emit per-section renderer updates — an intentional, separate
high-volume-suppression decision, not a defect this ticket touches.

Also added `codebase-indexing-lane-main-import-isolation.spec.ts` (none existed for this lane before,
unlike the context worker's sibling guard) since the fix's new import
(`context-worker-event-forwarding.ts`) pulls `skill-attribution-service.ts` and
`wake-context-builder.ts` into the lane's closure for the first time; confirmed zero `electron`
value-imports across the resulting 107-module closure.

Regression-tested with one new test on each side of the transport: `codebase-indexing-lane-main.spec.ts`
(worker posts the forwarded message) and `codebase-indexing-lane-gateway.spec.ts` (main dispatches it
onto `RLMContextManager`). Reverted each fix file individually via a `/tmp` copy and watched exactly
its own new test fail with all sibling tests green — worker side: `expected "spy" to be called with
arguments: [ { type: 'worker-event', … } ]` (only `ready`/`job-started`/etc. posted); gateway side:
`expected [] to deeply equal [ { …(2) } ]` (nothing reached main's singleton) — then restored and
confirmed 6/6 and 8/8 pass, plus 110/110 across `src/main/background-jobs` + `src/main/indexing` and
40/40 across the LT-206 context-worker spec set, unaffected.

**Batch V2 note — 2026-08-19.** Not independently re-driven live this session. Attempted to trigger
`codebaseIndexStore()` on a disposable one-file `/tmp` directory via a fresh `rlm.createStore()` id,
but the indexing lane's own worker-process `RLMContextManager` reported `"Store not found"` for that
id even after the store existed on main's singleton — the two processes' in-memory registries do not
share a store created this way, and reaching the real store-registration path this fix's own live
verification used would need the full `codebase-indexing-auto-coordinator.ts` workflow rather than a
quick manual probe. Not pursued further given the existing evidence above already includes a real
end-to-end indexing run through the actual lane worker AND a fresh app restart (used to rule out
double-delivery) — no residual is recorded as open for this ticket, but this session did not add
independent confirmation beyond re-reading the existing evidence and its regression tests (both still
green — see LT-206's spec re-run above, which covers the shared `dispatchWorkerBroadcast()`).

Full detail: [register entry](livetest-remediation-register.md#lt-207-the-codebase-indexing-lanes-own-rlmcontextmanager-singleton-never-reaches-main).

## LT-215 — fresh-fallback degradation notice never lists a child that died during the exact restart window — LIVE RE-CHECK FAILED 2026-09-21, SUPERSEDED BY LT-603

**2026-09-21:** the live re-check ran (four consecutive reproductions). The code change below is present and fires, but the restart's own ready-edge redelivery clears the retained record before `reconcileChildrenAfterRestart` reads it, so the observable symptom is unchanged: no `Reconciled orchestration children after restart` log line and no lost-child line in the degradation notice. Tracked onward as LT-603; the notes below describe the 2026-08-31 code change only.

Status: **fixed in code 2026-08-31; live re-check pending.** The implementation uses the actual
session-admission suppression event as the restart-window boundary, avoiding an arbitrary timestamp:
when a child-completion response cannot be admitted because its parent is unavailable, the
child/admission pair is retained after the normal live reap. Fresh-fallback reconciliation adds the
child to `droppedChildIds`, fails the obsolete pending admission, and drains the record once;
successful same-session redelivery clears it instead. A failing-first orchestration regression test
covers the reaped-child case and its one-shot cleanup.

The following paragraphs retain the original controlled reproduction and root-cause evidence.

`InstanceChildCompletionHandler.handleChildExit()` → `notifyChildTerminated()`
(`orchestration-handler.ts:1130`) always strips a dead child from `ctx.childrenIds` as soon as its own
adapter process exits, independent of the parent instance's own liveness. `buildFallbackHistory()`'s
`reconcileChildrenAfterRestart()` call (the mechanism Phase 4 of the resilient-threads-sessions plan
built specifically to report children that died while the parent was down) only finds something to
report if the child is still listed in `ctx.childrenIds` at that point — which it structurally never
is, because the live reap is synchronous/event-driven and the restart ladder is multi-step and async.
Measured on a fresh, first-respawn-attempt Codex parent with a synchronous native-resume-throw
(maximally fast forcing): the live reap completed at parent-exit+9ms; the restart ladder's own
reconcile point did not run until parent-exit+1318ms — 1.3s too late in every timing this and three
prior sessions produced. Net effect: `get_children`/`get_child_summary` are correct (different code
path), but the `[SESSION DEGRADATION NOTICE]` never lists the dead child as lost, and
`"Reconciled orchestration children after restart"` never logs.

Full detail, exact timestamps, and the recommended (not implemented) fix shape: [register
entry](livetest-remediation-register.md#lt-215-fresh-fallback-degradation-notice-never-lists-a-child-that-died-during-the-exact-restart-window-and-the-reconciled-log-line-never-fires).

## LT-220 — Antigravity adapter never surfaces tool events — DECIDED + DOC-CORRECTED

Status: **complete as a scope/documentation remediation.** The gap is accepted, the false adapter
comment and owning-check premise are corrected, and no stream-parser rewrite is planned unless the
capability becomes load-bearing.

A live `antigravity` shadow-mode turn with two real, confirmed tool calls (list dir, read file)
completed normally but produced zero evidence records (`contextEvidenceList` → `[]`,
`captureFailureCount: 0` — no error, the capture pipeline was simply never entered).
`antigravity-cli-adapter.ts` never emits `type: 'tool_result'` `OutputMessage`s or raw
`captureToolResult` adapter events — the only two entry points the evidence-capture pipeline listens
on — because it only ever spawns `agy --print` in the plain-text default. The adapter's own header
comment claims `agy` "has no `--output-format stream-json` mode"; that is false, confirmed live this
session against the installed binary (`agy --help` lists `text, json, stream-json`). Contrast:
`gemini-cli-adapter.ts` does emit real `tool_result` events and does get captured, so the doc's check
4 premise that Antigravity "exercises the identical...code path" as Gemini does not hold — they share
a capability *label*, not the underlying instrumentation.

Full detail and both candidate fix directions: [register
entry](livetest-remediation-register.md#lt-220-antigravity-adapter-never-surfaces-tool-events-so-context-evidence-capture-is-always-empty-regardless-of-mode--and-the-docs-check-4-premise-same-code-path-as-gemini-is-wrong).

## LT-216 — `find_or_open` cannot attach to an existing tab on a relay-backed remote node — FIXED + REGRESSION-TESTED 2026-08-19

Status: **fixed and regression-tested; not live-re-verified.**

`confirmExistingCandidate()` (`src/main/browser-gateway/browser-target-discovery-operations.ts`)
accepted a cached tab only if the extension re-reported it *inside* the 2.5–3s `report_inventory`
command. Measured on the live `windows-pc` node, a relay re-reports each tab on a rolling sweep of
**20–55 seconds**, so the confirm window was roughly 10x too short and rejected about nine live tabs
in ten. Reproduced 3/3 against tabs present in the same session's own `list_targets` output.

With no URL the agent gets `existing_tab_not_confirmed_after_inventory_refresh`. **With a URL the
same null result falls through to `openTab()` and silently opens a duplicate, unauthenticated tab
instead of reusing the logged-in one** — the damaging half, established by reading the branch rather
than triggered live, since triggering it would have opened real tabs in James's browser.

Fixed by confirming against a 120s freshness horizon (`EXISTING_TAB_CONFIRMATION_HORIZON_MS`) instead
of "re-reported during this refresh", and by treating a failed refresh *command* as non-fatal while
extension *contact* is still fresh. Ghost inventory from an ended browser session (hours old) and
silent nodes are both still refused.

New spec `browser-target-discovery-confirmation-horizon.spec.ts` (5 tests); reverted both halves via a
`/tmp` copy and watched 3 of 5 fail, with the 2 guard tests correctly green in both directions.
883/883 browser-gateway tests pass.

**Residual:** `windows-pc` is paired to the packaged app, which runs its own bundled build, so live
re-verification needs a repackage + restart. Full detail: [register
entry](livetest-remediation-register.md#lt-216-find_or_open-cannot-attach-to-an-existing-tab-on-a-relay-backed-remote-node-and-silently-opens-a-duplicate-instead).

## LT-217 — `browser_audit_entries` is 99.7% internal bookkeeping and grows without bound — ONGOING GROWTH FIXED

Status: **complete for production growth.** Internal attach/poll writes are suppressed and 90-day
read retention is implemented and tested. Optional compaction of the historical 1.36 GB is separate
destructive maintenance, not an unfinished product fix.

Measured read-only against the live production `rlm.db`: 3,444,307 rows, of which
`browser.extension_attach_tab` is 2,314,562 and `browser.list_approval_requests` is 1,116,376, while
every genuine agent browser action in the entire retained history (back to 2026-05-04) totals about
11,000. The table occupies **1.36 GB — roughly 32% of the 4.27 GB `rlm.db`** — and there is no
DELETE or pruning path anywhere in `src/`.

Two causes, both writing a full audit row per call: `attachExistingTab()` fires once per tab per
inventory report (~2–3 rows/second continuously, 50k–115k/day sustained), and `listApprovalRequests()`
is polled by `BrowserApprovalsBannerComponent` on a permanent 5-second timer (17,280/day, matching the
observed total).

The cost is not only disk. This is the forensic record for browser incidents — one this campaign has
already had to search — and it is now overwhelmingly noise, on top of continuous SQLite write
pressure against a 4.27 GB file in the main app. Full detail: [register
entry](livetest-remediation-register.md#lt-217-browser_audit_entries-is-997-internal-bookkeeping-and-grows-without-bound).

## LT-218 — `browser.snapshot` reports success with empty text when it cannot read the page — FIXED, LIVE RECHECK PENDING

Status: **fixed and regression-tested; one live unreadable-page recheck remains.** The selected
contract carries `textUnavailableReason` through extension, coordinator, cached/fresh results, and
shared types while preserving usable title/partial-read behavior.

Reproduced on two independent `windows-pc` tabs in the same minute: `browser.snapshot` returned
`outcome: "succeeded"` with correct `title`/`url` and **`text: ""`**, while `browser.query_elements`
against the *same* targets returned `failed` with the real reason — "Cannot access contents of the
page. Extension manifest must request permission to access the respective host."

Root cause is two stacked catches in `resources/browser-extension/background.js`:
`capturePageText()` does `chrome.scripting.executeScript(...).catch(() => [])`, and its caller
`buildTabPayload()` does `capturePageText(tab.id).catch(() => ({ title: tab.title, text: '' }))`.
A host-permission rejection therefore becomes an empty string and the command still resolves.
Title and URL survive because they come from `chrome.tabs.get()`, which needs no host permission —
which is exactly what makes it read as a successful snapshot of a blank page.

This is the "confident wrong answer" class: an agent reading a tender portal is told the page is
empty rather than that it lacks permission. It also explains the sibling `accessibility_snapshot`
timeouts on the same tabs, and means the `extractionHint` aux-extraction path is being handed an
empty capture. Full detail and both candidate fix shapes: [register
entry](livetest-remediation-register.md#lt-218-browsersnapshot-reports-success-with-empty-text-when-the-extension-cannot-read-the-page-at-all).

## LT-221 — opening a context-evidence record's card always failed with EVIDENCE_AUDIT_FAILED — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested** — a stale SQL `CHECK` constraint, corrected with a new schema
migration.

`contextEvidenceGetCard` (the "Open card" button in `app-context-evidence-panel`) failed
unconditionally, for every provider and every conversation, with `EVIDENCE_AUDIT_FAILED` —
live-reproduced in the real dev-app UI over CDP with focus emulation. Root cause, confirmed directly
against the live SQLite file: migration `004_context_evidence`'s `evidence_access_log` table `CHECK`
constraint never included `'get-card'`, even though the column's own TypeScript type
(`EvidenceAccessLogInput.operation`) always declared it valid — the SQL and the type had drifted
apart. Every `contextEvidenceGetCard` call's mandatory access-audit `INSERT` therefore always violated
the constraint, and a bare `catch { throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED') }`
discarded the real SQLite error, hiding the cause from `app.log`.

Fixed with a new migration (`005_evidence_access_log_get_card`, `CONVERSATION_LEDGER_SCHEMA_VERSION`
4→5) that rebuilds `evidence_access_log` with the corrected `CHECK` list, using the same
rename→create→copy→drop pattern already established in `rlm-migrations-022-035.ts`; runs
automatically for every existing and fresh installation. New regression test watched fail against the
pre-fix source (both the schema-version assertion and the reproduced `SQLITE_CONSTRAINT_CHECK` error)
and pass after the fix; 65/65 conversation-ledger tests and 302/302 context-evidence tests unaffected.

Full detail, the exact reproduction command, and the deliberately-out-of-scope observability gap (the
swallow-and-rethrow pattern that hid this bug's real cause): [register
entry](livetest-remediation-register.md#lt-221-opening-a-context-evidence-records-card-always-failed-with-evidence_audit_failed--a-stale-sql-check-constraint-fixed-with-a-schema-migration).

## LT-222 — the app-wide log redactor turns a legitimate `null` under any token-shaped key into the literal string "<redacted-secret>" — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested.**

`redactSecretField()` (`src/main/diagnostics/redaction.ts`) — the function every `logger.*` call in the
app routes secret-shaped-key values through — passed `number`/`boolean` values through correctly but
had no case for `null`/`undefined`, so both fell into its final `return '<redacted-secret>'`, turning a
real `null` into the four-word string `"<redacted-secret>"`. Live-reproduced via Codex context-pressure
diagnostics: `turn-start`'s `baselineUsedTokens` and `token-usage`'s `previousLastTotalTokens` (both
typed `number | null`, both legitimately `null` on a session's first turn/request) both matched
`SECRET_KEY_PATTERN` (containing "token") and both landed on disk as the string `"<redacted-secret>"`
instead of `null` — corrupting 3 of 6 real diagnostic lines from one ordinary Codex turn, which
`scripts/analyze-codex-context-pressure.ts` then correctly rejected as malformed (schema mismatch).
This is not Codex-diagnostics-specific: it is the general-purpose logger redaction primitive, so any
`number | null` field under a token/secret/password/credential/authorization/cookie-shaped key suffers
the identical corruption whenever it happens to be null/undefined.

Fixed with an explicit `null`/`undefined` pass-through before the `typeof` checks — a strictly-widening
change. New regression test watched fail against the pre-fix source, then pass after; 33/33 diagnostics
+ 23/23 logging tests unaffected. Rebuilt and re-verified live: the same two fields now log as real
`null`, and the analyzer's malformed-record count dropped from 3 to 0 for the identical live scenario.

Full detail: [register entry](livetest-remediation-register.md#lt-222-the-app-wide-log-redactor-turns-a-legitimate-null-under-any-token-shaped-key-into-the-literal-string-redacted-secret).

## LT-223 — the context-pressure analyzer's own itemClass allowlist drifted from LT-148's fix and rejects every real `user-message` record as malformed — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested.**

After fixing LT-222, the same live Codex baseline turn still had 1 of 6 diagnostic records rejected:
the `item-completed` record for `itemClass: 'user-message'`. `scripts/codex-context-pressure/types.ts`'s
`ItemClass`/`ITEM_CLASSES` — the analyzer's own, separately-maintained copy of valid item classes —
never included `'user-message'`, even though the runtime classifier's real type
(`CodexObservedItemClass`, `context-pressure-diagnostics.ts`) has included it since LT-148 (2026-08-18)
fixed the classifier to stop miscounting the user's own turn echo as a tool-bearing item. The analyzer's
duplicated allowlist was simply never updated to match — so the exact record shape LT-148 exists to
produce was rejected by the tool meant to analyze it. The livetest doc's own §11 privacy-validator
snippet carried the identical stale allowlist and would flag a legitimate `'user-message'` value as a
false "privacy failure" — confirmed by running the literal snippet before correcting it.

Fixed both the code (`ItemClass`/`ITEM_CLASSES`) and the doc's own §11 snippet. New regression test
watched fail against the pre-fix source, then pass after. Re-ran the analyzer against the identical real
log data used for LT-222: 6/6 accepted, 0 malformed (from 5/6 and 4/6 across the two fixes). Also ran
the corrected §11 privacy-validator against the same real output: passes, all four steps.

Full detail: [register entry](livetest-remediation-register.md#lt-223-the-context-pressure-analyzers-own-itemclass-allowlist-drifted-from-lt-148s-fix-and-rejects-every-real-user-message-record-as-malformed).

## LT-280 — the context-evidence panel is fully built to label degraded (corrupt/failed/deleted/staging) records, but `list()` structurally never lets any reach it — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested.**

The context-evidence panel's own file-header contract states degraded evidence statuses (`corrupt`,
`failed`, `deleted`, `staging`) are "always visibly labeled, never presented as complete," and its
rendering code (`getIsDegradedStatus`/`getStatusLabel`/`getStatusDisclosure`, fully wired into the
template) correctly implements that for all five statuses. But `EvidenceRetrievalService.list()` — the
single method backing both the renderer's `contextEvidenceList` IPC channel and the `evidence_list` MCP
tool — never passed `includeMaintenanceStates: true` to the ledger, so the ledger's default
`WHERE status = 'complete'` filter silently excluded every degraded record before the renderer or an
agent ever saw it. Live-reproduced: directly setting a real captured record's status to `corrupt` (then
`deleted`) via the ledger DB made it vanish from the panel entirely rather than show a labeled,
disabled entry.

Fixed with a one-line addition (`includeMaintenanceStates: true`) to the `list()` call. New regression
test watched fail against the pre-fix source (asserting the exact call arguments), then pass after;
379 tests across the context-evidence/conversation-ledger/IPC-handler/MCP-tool test files unaffected.
Rebuilt and re-verified live: the same corrupt and deleted records now render with the correct badge
and disclosure text; "Inspect" stays disabled; "Open card" fails cleanly with `EVIDENCE_CARD_NOT_FOUND`
rather than crashing.

Full detail: [register entry](livetest-remediation-register.md#lt-280-the-context-evidence-panel-is-fully-built-to-label-degraded-corruptfaileddeletedstaging-records-but-list-structurally-never-lets-any-reach-it).

## LT-290 — fable-ws16 check 5's `lessons` recall-trace surface had zero production `record()` callers — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested.**

`RecallTraceStore`'s `lessons` surface could never hold a trace: a repo-wide grep for
`getRecallTraceStore().record(` found exactly two production call sites (`rlm`, `codemem`) and none
for `lessons` — the only production `lessons`-surface interaction was `markUsed()`, which filters
existing traces and can never create one. Fixed by recording a `lessons` trace at loop start
(`loop-coordinator.ts`'s `surfaceLearnings` closure) whenever `getLessonStore().digest()` surfaces at
least one lesson. New regression test watched fail against the pre-fix source, then pass after; live
re-verified on a real loop (`loop-1787166879293-5e633139`) via the running main process's `--inspect`
port.

Full detail: [register entry](livetest-remediation-register.md#lt-290-fable-ws16-check-5s-lessons-recall-trace-surface-had-zero-production-record-callers--structurally-could-never-hold-a-trace).

## LT-291 — fable-ws16 check 6's reinforcement-on-use could never fire on a successful loop — FIXED + REGRESSION-TESTED, 2026-08-19

Status: **fixed and regression-tested.**

`creditSurfacedLessonUse`'s `outcomeText` (the loop's convergence note) is `null`/unset on the
accepted-completion (`decision: 'stop'`) branch by design — `evidence-resolver.ts` returns
`convergenceNote: null` for a clean success, and nothing else in the success path ever populates it —
so the crediting function silently no-opped on every genuinely successful loop, contrary to its own
doc comment that the convergence note is "the cheapest, always-present signal." This is a different,
unrelated mechanism from `completion.crossModelReview.enabled` → `captureReviewLessonForVerdict`
(which distills a NEW lesson from a *blocking* review finding and never touches `RecallTraceStore` or
logs "Reinforced surfaced lessons on use") — a prior same-day attempt on this doc tested that
mechanism and, correctly, found no evidence for check 6, because it was never the right mechanism.
Fixed by falling back to the accepted terminal intent's own `summary`, present whenever a loop
completes via the real `aio-loop-control complete --summary` mechanism agents use in production. New
regression test watched fail against the pre-fix source, then pass after; live re-verified on the same
real loop — `app.log` shows `Reinforced surfaced lessons on use {count: 1}` at the loop's exact
termination timestamp, and the seeded lesson's `uses` went `0 → 1`.

Full detail: [register entry](livetest-remediation-register.md#lt-291-fable-ws16-check-6s-reinforcement-on-use-could-never-fire-on-a-genuinely-successful-loop--the-convergence-note-is-never-populated-on-that-path-contrary-to-its-own-always-present-doc-comment).


## LT-270 — the automatic 4x-cumulative context-cost governor has no measurable path to reducing real cost on this Codex build — DECIDED + RESCOPED

Status: **complete as a contract correction.** The automatic path is a safety pause on builds that
never confirm native compaction. Acceptance is no cost increase and no lost work; the measured run
reduced input by 3.1% and lost no work.

Measured via a real paired governor-on/governor-off comparison (identical disposable-repo fixture,
identical six-turn sequence, real Codex spend on both sides, ~$4.17 total): real billed input tokens
were 407,155 (governor on) vs 420,330 (governor off) — a **3.1%** reduction, against the owning doc's
own **≥60%** acceptance target for check 4. Both runs produced the identical correct final edit with
no duplicate edits and no lost task.

Root cause: the governor-on run paused at the same `interrupt-unconfirmed` branch the owning doc's
check 3 (2026-08-19) already found, then resumed — once manually nudged — on the *same, still-full*
context it paused with; no compaction, no restart, `adapterGeneration`/`sessionId` unchanged
throughout. `CodexAppServerThreadRuntime.interrupt()` returns `status: 'no-active-turn'` whenever the
triggering turn has already completed by the time the policy engine's async, queued decision actually
evaluates — a plausible, source-consistent explanation for why the scripted `compaction-unobserved`
branch has now been unreachable in 2 of 2 real attempts, though the exact race was not independently
instrumented. Even a perfectly-timed interrupt would still meet **LT-017**'s wall (`thread/compacted`
never observed on any Codex build in this campaign) — the manual path's only real fallback is
restart-with-summary, and the automatic path deliberately does not use it (this doc's 2026-08-12
evidence run: "silently swapping the thread out from under it is materially riskier" for an
already-interrupted live turn). That leaves the automatic path with structurally no route to its own
stated cost-reduction purpose today.

Full detail, falsification criteria and both candidate directions: [register
entry](livetest-remediation-register.md#lt-270-the-automatic-4x-cumulative-context-cost-governor-has-no-measurable-path-to-reducing-real-cost-on-this-codex-build--measured-not-inferred).

## LT-300 — a ping-pong loop that had genuinely finished could never terminate — FIXED + REGRESSION-TESTED, 2026-08-20

Status: **fixed and regression-tested.**

When `crossModelReview.pingPong.enabled` is true the coordinator's completion seam is an if/else-if
chain whose ping-pong branch runs first, leaving the `completionDetector.hasSufficientSignal(...)`
verify-before-stop branch as an unreachable `else if`. Every completion signal was therefore computed,
written to `iteration.completionSignalsFired`, and discarded. Terminal intents do not rescue it —
only `block` and `fail` are honoured outside that branch.

Inside the gate, `evaluatePingPongCompletion` returned `null` unless `classifyCleanReview` returned
clean, and that classifier has no path to `clean: true` without the literal `[[LOOP:CLEAN_REVIEW]]`
sentinel: its model backend can only ever *confirm* not-clean, and a deterministic clean verdict is
deliberately downgraded to `UNCLEAR_CLEAN_REVIEW`. Since `pp.roundCount += 1` sits downstream of that
gate, `roundCount` stayed 0 and the `roundCount >= maxRounds` backstop was unreachable by
construction. Neither review-driven stall backstop applied either: both require
`!madeProductionChange`, and the agent changed production files on every iteration while being
definitionally finished.

Reproduced live on `loop-1787241037235-b6fe2309`: `LOOP_TASKS.md` with every leaf resolved,
`OUTSTANDING.md` reporting "Needs human — (none)", `[ledger-complete]` firing on all five iterations,
and `round 0/15 · reviewer $0.00` after 2h40m, 118.3k tokens and $20.25.

Fixed by extracting `resolvePingPongBuilderDone` into `loop-pingpong-builder-done.ts`: a *sufficient*
completion signal read from `iteration.completionSignalsFired` counts as a builder done-declaration
equal in authority to the sentinel, and short-circuits the classifier call (saving a per-iteration
`loopScoring` round-trip). This cannot cause a premature stop — it opens a review round, it does not
terminate the loop, and the reviewer still gates convergence. The classifier's sentinel-only authority
over *prose* is intentionally unchanged; it is a sound guard against stopping on optimistic wording.

Regression tests: `loop-pingpong-builder-done.spec.ts` (5) and two new cases in
`loop-pingpong-completion.spec.ts`. Reverted in a `/tmp` copy and watched them fail with
`expected "spy" to be called once, but got 0 times` — the exact round-0/15 symptom — then restored.

## LT-301 — `diffSource` was plumbed to both reviewers and read by nothing, so a non-git workspace produced rubber-stamp reviews — FIXED + REGRESSION-TESTED, 2026-08-20

Status: **fixed and regression-tested.**

An exhaustive repo-wide grep found three producers of `diffSource` and zero consumers, despite
`loop-fresh-eyes-reviewer.ts`'s doc comment explaining that `'none'` means the workspace "is not a git
repository". Outside a repository `collectWorkspaceDiff` returns an empty diff, so the reviewer's
`diffBlock` collapsed to `''` while the impl-mode prompt still announced "The git diff below is your
STARTING POINT". A reviewer shown nothing, and not told it was shown nothing, cannot distinguish that
from "no changes to object to".

Fixed by consuming `diffSource` in `buildPrompt`: an explicit "No diff is available — read the code
directly" block that names whether git was unreadable or the diff was genuinely empty, forbids reading
the absence as evidence of correctness, and tells the reviewer to report the gap rather than approve.
The impl-mode instructions no longer point at a diff that is not there.

Regression tests: two new cases in `agentic-pingpong-reviewer.spec.ts`, both watched to fail on revert.

## LT-302 — a preflight verify timeout was reported identically to red tests — FIXED + REGRESSION-TESTED, 2026-08-20

Status: **fixed and regression-tested.**

`VerifyOutcome` has always distinguished `failureKind: 'timeout'` from `'command'`, but
`LoopPreflightResult` collapsed every failure to `status: 'failed'`, dropping the distinction before it
reached the UI. On the observed loop, `PRE_FLIGHT.md` recorded `Duration: 599998ms` and
`(verify timed out after 600000ms)` for a `npm run verify` chain of fourteen commands — including the
full test suite, `rebuild:native` and `smoke:electron` — against the non-configurable 600s default.
The operator saw "Preflight failed" and would reasonably go looking for a broken test.

Fixed by carrying `failureKind` through `LoopPreflightResult.commands[]` (type, Zod schema and
`runLoopPreflight`) and labelling the chip "Preflight timed out". The red state is kept deliberately: a
timeout *is* a failure to verify. Only the wording was wrong.

Follow-up not taken here: `verifyTimeoutMs` is hard-coded at `loop-config-defaults.ts:102` and is not
exposed in the loop config panel, so an operator who hits this cannot raise the budget from the UI.

Regression tests: two in `loop-audit-runtime.spec.ts`, one in `loop-control.component.spec.ts`.

## LT-303 — a non-git loop workspace degraded diff-backed review silently — FIXED + REGRESSION-TESTED, 2026-08-20

Status: **fixed and regression-tested.**

`normalizeManagedIsolation` already detected a non-git workspace and disabled isolation, but only at
`info` level, so nothing surfaced the consequence: for a reviewer-backed loop, review material had been
reduced to nothing. The observed loop ran 2h40m against `/Users/suas/work/orchestrat0r` while the real
repository was its `ai-orchestrator` subdirectory.

Fixed by `emitNonGitReviewWorkspaceWarning`, called from `startLoop` once the repo baseline is captured.
It fires for reviewer-backed loops only — ping-pong or cross-model review. `mode: 'review-driven'` alone
deliberately does **not** qualify: the fresh-eyes gate that builds a diff is itself gated on
`crossModelReview.enabled`, so a plain review-driven loop never builds one and warning on it would be a
false positive. A regression test pins that silence. When it does fire it logs a warning and emits a
`loop:activity` status line so the gap appears in the loop feed. Advisory rather than blocking — a
non-git workspace is legitimate, it just must not be invisible.

Known gap, deliberately not closed: `runFreshEyesReviewGate`'s `forcedByContradiction` escape valve
(`loop-coordinator-completion-gates.ts:341,345`) synthesises a default cross-model review config and
collects a diff even when `crossModelReview.enabled` is false. No start-time predicate can anticipate
it, because it keys off `state.freshEyesForcedByContradiction`, which is set during the run. A loop in
that state gets an undiffed contradiction review without a start-time warning; closing it would need a
warning at the review site rather than at loop start.

Regression tests: four `nonGitReviewWorkspaceWarning` cases in `loop-coordinator-state-helpers.spec.ts`.

## LT-350 — cancelling a loop does not kill an in-flight preflight verify subprocess — **FIXED 2026-09-10**

Status: **fixed, regression-tested, gates green.**

**Fix:** `LoopCompletionDetector` now tracks every spawned preflight/quick-verify child in a
`Map<string, Set<SpawnVerifyRegistration>>` keyed by `loopRunId`, via a new `addVerifyChild`/
`removeVerifyChild`/`abortVerify(loopRunId)` API. `spawnVerify` (`loop-spawn-verify.ts`) accepts an
`onSpawn` registration callback and refactors its timeout-kill logic into a shared
`reapAndFinish(reason: 'timeout' | 'cancelled')` so the same kill path serves both a natural timeout
and an explicit cancel. `LoopCoordinator.cancelLoop()` now calls
`await this.completionDetector.abortVerify(loopRunId)` immediately after `terminate(...)`, so a
cancel force-kills any verify child still running before the loop is reported stopped. A new
`'cancelled'` `VerifyFailureKind` was threaded through the 5 duplicated failure-kind type/schema
locations (`loop-state.types.ts`, `loop-audit.types.ts`, `packages/contracts/.../loop.schemas.ts`,
`loop-store.types.ts`, plus `loop-coordinator-utils.ts`'s message branch) so a killed verify reports
distinctly from a genuine failure or timeout.

**Verification:** a new integration test
(`loop-coordinator-cancel-preflight-verify.spec.ts`) drives a real long-running verify script (a real
`.js` file, not an inline `node -e` string — an inline string gets corrupted by the
`/bin/bash -lc` wrapper `buildVerifyInvocation()` uses to source `PATH`, which produced a
false-passing first draft) and asserts the child process is actually gone after cancel. Both the new
integration test and 4 new unit tests in `loop-completion-detector.spec.ts` were mutation-checked by
reverting the `abortVerify` call and confirming genuine failure (marker file created, meaning the
child was not killed). Full `src/main/orchestration/` suite (224 files, 2879 tests) green. All
canonical gates green (`tsc` ×2, lint, `build:main`, `build:renderer`, `test:quiet` 22615/22615);
`check:ts-max-loc`'s ceiling for `loop-coordinator.ts` was intentionally raised 3948 → 3954 with a
dated justification comment in `scripts/check-ts-max-loc.ts` for the small `cancelLoop` addition.

Original finding (2026-08-21), preserved for history:

Status: **found, not fixed.**

`runLoop` awaits `runLoopPreflight` synchronously before the first iteration (`loop-coordinator.ts:1821-1828`).
`runLoopPreflight` → `completionDetector.runVerify(config)` → `spawnVerify` (`loop-completion-detector.ts:648-745`)
does a raw `child_process.spawn`, tracked only by a local closure and its own `setTimeout` — never
registered with any lifecycle/instance mechanism `cancelLoop` can reach. `cancelLoop`
(`loop-coordinator.ts:1494-1520`) force-terminates the active iteration/instance and awaits adapter
cleanup, but no instance exists yet during preflight, so none of that touches the verify child.

Reproduced by accident while driving check 2 of this doc's own livetest (a non-git-workspace-warning
probe): a loop was started against `/Users/suas/work/orchestrat0r` with a blank `verifyCommand`, which
auto-inferred to `npm --prefix "ai-orchestrator" run verify` (full test suite included) from the
workspace's own `package.json`. `loopCancel` was called ~2.5s later, well before any iteration spawned;
it returned `success: true` and the loop state showed `status: 'cancelled'` within ~4s. The inferred
`npm run verify` chain kept running regardless — at T+5 minutes its `vitest` workers were still active,
driving this shared campaign host's 1-minute loadavg from ~6 to 27.9, and had to be killed manually.

Required behaviour: `cancelLoop` (and any other terminal transition reached while a preflight/quick
verify is in flight) must also abort that spawned child promptly, not just the per-iteration CLI
instance. Recommended: thread an `AbortSignal` or the existing `isCancelled(loopRunId)` check into
`spawnVerify`, and have `cancelLoop`/`confirmStablyStopped` await that kill before resolving.

Not fixed here — found while working an unrelated pair of livetest docs (batch Q1) and out of scope for
this batch's assigned checks; recorded so a future pass can pick it up. See register row LT-350.

## LT-371 — short worker-socket losses churn remote-browser state and can strand commands before handoff — FIXED + REGRESSION-TESTED; LIVE CHECK PENDING 2026-08-23

Status: **implemented and regression-tested; rebuilt-runtime validation pending.**

The original browser-flapping prompt provisionally attributed the drops to the extension/native-host
relay because `list_remote_nodes` looked healthy shortly after each event. Cross-layer evidence proves
the opposite. The worker log has 63 coordinator-socket closes (61 code 1006) while its extension poll
heartbeat remains continuous and `browser.health.serviceWorkerRestarts` remains zero. Every one of the
30 coordinator reliability `node_disconnect` events follows `WorkerNodeConnection Node WebSocket
disconnected`; source tracing confirms that event is the only caller of
`RemoteBrowserExtensionBridge.expireNode()`. The sole live relay limits the observation to one remote
node, so this does not establish a fleet-wide transport defect.

The transport drops are not periodic and do not form a load-correlated storm. All 30 eventually
re-registered, with median recovery 10.556 seconds and 24/30 inside 30 seconds. The product churn is
caused by `DISCONNECT_GRACE_MS = 2_500`: it declares most ordinary recoveries true disconnects,
deregisters the node, suspends up to 21 attachments, and rejects the browser queue. The reconnect
count is higher because first contact/zero-attachment contact transitions also emit reconnect
telemetry and because replacement sockets arrive before their superseded half-open sockets close;
worker logs show one sequential process, not duplicate workers.

A second source-level defect exists at the command boundary: `pollCommand()` marks a command delivered
before the router answers the long-poll request, while the connection event previously discarded the
requesting socket's identity. With no socket, the response vanished; with a fast re-registration, the
old request id was written onto the replacement socket and ignored because the worker had removed that
request on close. Both cases are safe to retry because the command never reached the extension; today
they instead age into `browser_extension_command_receipt_missing`.

Implementation plan:

1. restore the worker-node disconnect grace to the documented 30 seconds;
2. bind each inbound RPC to a one-shot responder for its originating WebSocket, refusing to write an
   old response onto a replacement socket;
3. requeue only a non-null browser poll result that definitively was not handed to its requesting
   socket, retaining the command's original absolute undelivered deadline and never replaying
   ambiguous sends; hold later work behind a per-queue handoff barrier and restore the uncertain
   command at the head so recovery cannot invert FIFO order;
4. regression-test the grace boundary, bounded command requeue, router wiring, the exact old-poll
   → replacement-socket → new-poll sequence found by the first completion gate, and the overlapping
   navigate → click ordering plus expired-deadline release found by later review;
5. run canonical/full verification and the mandatory fresh completion gate;
6. defer rebuilt-runtime observation and the deliberate check-6 browser generation transition to a
   dedicated livetest document, because neither the packaged app nor James's worker may be restarted
   in this task.

As built, the coordinator now uses the documented 30-second grace, binds each inbound RPC to its
originating socket, and keeps later queue work behind a handoff-confirmation barrier. A response that
provably cannot leave through its requesting socket returns the same command id to the queue head
within its original absolute deadline; accepted responses and receipt-ambiguous commands are never
replayed. Six focused files / 90 tests pass, both TypeScript checks, lint, and `build:main` pass, and
the final independent reviewer returned `VERDICT: PASS` with no actionable findings. The current full
suite is 18,555/18,556, with the sole failure in unrelated concurrent
`src/main/session/session-continuity.spec.ts`; the LOC ratchet's sole violation is unrelated concurrent
`src/main/history/history-manager.ts`. Runtime evidence remains in the dedicated LT-371 livetest and
requires only a rebuilt/restarted coordinator for this fix, not a worker/extension/native-host deploy.

## LT-370 — quality-tier auto-pick chooses a model the endpoint's host cannot load

**Status: implemented and regression-tested 2026-08-24. Live confirmation pending a rebuilt app.**

The 2026-08-20 entry diagnosed this as "the configured tier models do not exist on the endpoint", and
its recommended fix was to point `auxiliaryLlmQualityModel`/`auxiliaryLlmQuickModel` at ids the
endpoint serves. Correlating both halves of the failing request in `app.log` showed that would have
changed nothing: request `coord-8438` was dispatched as `model: "gpt-oss:120b"` — a model the endpoint
**does** serve — and the configured `qwen/qwen3.6-35b-a3b` had already been discarded upstream by
`endpointAdvertisesModel()`. The real defect is that `pickModelForTier` orders `quality` purely by
apparent parameter count and takes the largest advertised id regardless of whether the host can load
it; `windows-pc` reports 32607 MB of GPU memory, so a 120B model fails to load and Ollama returns 500
after ~9 seconds. The same log carries 143 successful quick-tier `deepseek-r1:7b` dispatches, which
also corrects the original entry's "the entire local-AI path is silently inert" — only the six
quality-tier slots were affected.

Implementation:

1. add `AuxiliaryModelFailureCache` (`src/main/rlm/auxiliary-llm-utils.ts`) — a per-endpoint,
   10-minute memory of auto-picked models that failed to generate;
2. filter the candidate list through it in `tryEndpointForSlot` before `pickModelForTier`, and tag the
   resolution `autoPicked`;
3. record a failure in `generate`'s catch **only** for auto-picked models, so an explicit per-slot or
   tier pin keeps surfacing its own error instead of being silently substituted;
4. clear the memo in `configure` alongside the health cache;
5. keep the filter never-worse — it returns the unfiltered list when filtering would empty it, so a
   degraded endpoint can never become no endpoint.

Bounding the pick by the node's reported `gpuMemoryMB` was considered and rejected: it needs a
parameter-count-to-VRAM heuristic that is wrong across quantisation levels and partial CPU offload,
and the failure memo reaches the same end state after one cheap failure with no hardware guessing.

As built, 9 regression tests were added (5 in `auxiliary-llm-utils.spec.ts`, 4 in
`auxiliary-llm-service.spec.ts`), two of them mutation-checked. Reverting the `usable()` call made
the step-down test fail with `expected '' to be 'distilled text'`; dropping the `if (autoPicked)`
write guard made the cross-slot pin test fail with `expected false to be true`. Both passed again on
restore. That second test exists because the first completion gate found the write guard was inert —
it is only observable across two slots, where a pinned slot's failure must not poison an unpinned
slot's own auto-pick. `npx tsc --noEmit` and the spec typecheck are clean, and 1191 tests pass across
`src/main/rlm/` and `src/main/browser-gateway/`. Runtime
confirmation is deferred — it needs a rebuilt app, and closing the owning
`2026-07-17-browser-gateway-reliability_livetest.md` check 1 additionally needs
`browserAuxExtractionEnabled` ON, which is `policyTier: read-only` and not writable from the CLI.

## LT-441 — hardened mode's Seatbelt jail does not confine a Claude resident session's own `CLAUDE_CONFIG_DIR` writes

**Status: product-path guard implemented and regression-tested 2026-09-23; original resident-mode OS
write escape remains unverified.** The exact syscall/mechanism is not isolated.

While attempting to stage WS13 checks 10/11 (the "allow-and-retry" denial-crash lever) with a
non-destructive fault-injection technique — a scoped `ClaudeCliAdapter.prototype.spawnProcess`
monkeypatch (Node Inspector, matched only to one throwaway `/tmp` instance's `workingDirectory`)
that pointed `CLAUDE_CONFIG_DIR` at a fresh directory under `~/Desktop`, deliberately outside every
granted `WRITABLE_ROOT_n` — the expected denial-crash never happened. Instead the hardened, resident
Claude CLI wrote its own config bootstrap (`.claude.json`, a timestamped backup, `sessions/`) into
that ungranted directory successfully, 3/3 times across independent instances.

This was cross-checked, not assumed:

- `app.log`'s `"Spawning CLI under Seatbelt hardened mode"` line confirmed hardening engaged with the
  correct 7-root default set on every spawn.
- A separate, independent `child_process.spawn` capture (patched via the same Node Inspector session,
  decoupled from the adapter patch) recorded the literal OS-level `sandbox-exec` argv: the exact base
  policy text (byte-diffed clean against `resources/sandbox/aio-seatbelt-base.sbpl`) plus the correct
  `-D WRITABLE_ROOT_n=` params, none of which included the Desktop path, and `env.CLAUDE_CONFIG_DIR`
  correctly threaded through to the real spawn call.
- A byte-identical manual replay of that captured policy/roots via `sandbox-exec` from an unsandboxed
  shell, run against Claude's one-shot `--print` mode, correctly **denied** the same write (target
  directory never created) — ruling out a hole in the policy text or the roots list themselves. The
  gap is specific to something resident/stream-json mode reaches that one-shot mode does not.
- In the same live instance, an ordinary agent-driven tool-call write to a different ungranted path
  (`~/Desktop/aio-lt-C-agent-probe.txt`, the same shape check 3 already tests) was correctly **denied**
  — so the jail is not globally bypassed; only this specific CLI-internal write path escapes it.
- At the time of the 2026-08-24 reproduction, no production file under `src/main/` referenced
  `CLAUDE_CONFIG_DIR`. That negative search is historical: the new spawn guard now references it.
  The observed write still needs a process/syscall trace before its owner can be stated with certainty.

**Product-path guard:** `resolveHardenedSpawn` now checks a hardened Claude spawn's effective
`CLAUDE_CONFIG_DIR` against realpath-resolved writable roots and refuses an ungranted path before
spawning. `BaseCliAdapter.spawnProcess` passes the merged child environment into that check, so an
ambient value is covered too. For a derived Claude account route, `createCliAdapter` grants only that
resolved profile home, rather than the parent account-pool directory. Focused tests cover ungranted,
ambient, sibling-prefix, and derived-profile cases. The earlier claim that this was unreachable
through the product is withdrawn: ambient environment and resolved account routes are real product
inputs, even though the filed reproduction used a scoped Node Inspector monkeypatch.

**Still open:** the guard prevents that ungranted environment from reaching the resident CLI through
the normal AIO spawn path; it does not identify or repair the OS mechanism that let the 2026-08-24
resident write succeed. That needs a disposable resident-mode replay with `fs_usage`/DTrace under
sudo to identify the writing process and syscall or IPC path. See the linked
[live check](2026-09-23-outstanding-plans-sweep_livetest.md#check-8--lt-441-resident-claude-confinement-trace).

**Effect on WS13 checks 10/11:** this particular crash lever did not work. Those checks were later
closed on 2026-09-20 with a different interrupt-suppression lever; LT-441's syscall question remains
independent of them.

## LT-029 — hardened Keychain refresh limitation and credential-specific repair

**Status: safe limitation implemented and regression-tested 2026-09-23; live refresh proof pending.**

The default Seatbelt writable roots still exclude `~/Library/Keychains`. Granting that directory
would let a jailed provider modify the user's whole login Keychain, so the selected policy is to
keep it outside the jail. A jailed legacy Keychain write was observed to fail, but no actual
long-session OAuth refresh has yet been observed under this policy; do not describe every refresh as
proven to fail.

`classifySandboxFailure` recognizes provider credential errors separately from file denials. On a
terminal hardened exit, `noteSandboxDenialOnExit` now sends a credential-specific notification with
sign-in/retry advice. The composer uses the same recent-output keywords: credential failures show
Sign in and Retry session; only an observed file denial shows Allow path & retry. For a routed Claude
account, Sign in launches the exact account profile's login rather than the legacy home; notices and
busy state are tied to the instance that started the request. Focused tests covered these paths,
including a delayed result after selection changes. The actual refresh and rebuilt-app interaction
are deferred to [live check 7](2026-09-23-outstanding-plans-sweep_livetest.md#check-7--lt-029-hardened-credential-refresh-and-repair).

## LT-520 — a dev app steals the machine's Chrome native-messaging manifest

**Status: implemented and regression-tested 2026-08-24. Live confirmation pending a rebuilt app.**

Found while reading `browser.health` during the 2026-08-24 campaign: the packaged app reported its
local extension `not_installed` while the machine's manifest pointed at
`/tmp/aio-lt-E/browser-gateway/native-host/…`, a batch agent's dev profile. The manifest is
machine-global (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), so
`AIO_DEV_USER_DATA_PATH` isolation never covered it, and `prepareBrowserExtensionNativeHostRuntime`
overwrote it unconditionally. The correct guard already existed but was wired only into the
worker-agent paths, never into the Electron main path.

Implementation:

1. add `mayClaimBrowserExtensionNativeHostManifest()` — packaged always wins; unpackaged claims only
   an absent or already-owned manifest; `AIO_CLAIM_LOCAL_BROWSER_MANIFEST=1` is an explicit opt-in;
2. add a `claimChromeManifest` option to `prepareBrowserExtensionNativeHostRuntime`, defaulting to
   `true` so no existing caller changes behaviour, that skips only the Chrome manifest write and OS
   registration — this install's own runtime config and wrapper are still written;
3. compute the decision in `src/main/browser-gateway/index.ts` from `app.isPackaged` and log a warning
   naming the opt-in when the claim is declined;
4. regression-test all four arbitration outcomes, the force-claim opt-in, and the byte-identical
   foreign manifest.

As built, 6 tests were added to `browser-extension-native-runtime.spec.ts` (15 green in that file).
The behavioural one was mutation-checked: forcing the new branch unconditionally true made it fail on
the manifest bytes, and it passed again on restore. `npx tsc --noEmit` clean.

Two follow-ons are recorded rather than done. The `not_installed` **remediation text** ("Install the
Harness Chrome extension and restart AI Orchestrator") is wrong for this case — the extension is fine
and another install holds the manifest — but rewording it needs the health probe to distinguish
"manifest absent" from "manifest owned by someone else", which is a larger change than this fix. And
the manifest currently on the campaign machine still points at a dev profile; restoring it is a
campaign cleanup step (`_scratch/lt-2026-08-24/orchestrator/restore-native-manifest.sh`), not part of
the code change.

## LT-480 — real auto-injected skill activations silently persisted to the wrong database

**Status: implemented and regression-tested 2026-08-24, verified live end-to-end against a rebuilt
dev app.**

Found while re-confirming the skill-observability livetest's recording check (Batch E, 2026-08-24): a
real `sendInput` turn containing a builtin trigger phrase correctly pushed a live
`skills:activation-delta` event to the renderer, but the corresponding `skill_activations` row was
absent from both a direct `sqlite3` query against the profile's own `<userData>/rlm/rlm.db` and the
app's own `skillsActivationsRecent()` IPC call. The row was not lost — it landed in
`~/.aio/<sha256(process.cwd()).slice(0,12)>/rlm/rlm.db`, a per-checkout fallback path shared across
every dev-app profile, keyed only on the repository's working directory.

Root cause: `context-worker-main.ts` called `registerWorkerEventForwarding(transport)` — which
eagerly constructs `RLMContextManager.getInstance()`, whose constructor eagerly calls the no-config
`getRLMDatabase()` — before its own explicit, correctly-pathed `RLMDatabase.getInstance({dbPath,
contentDir})` pre-init. `RLMDatabase.getInstance()` is a singleton where only the first caller's
config is honored, so the no-config call won and permanently pinned the database to its fallback
resolution (`getElectronUserDataPath()` in `rlm-database.ts` only tries
`electron.app.getPath('userData')`, which resolves to `undefined` inside the context worker's
`utilityProcess` of type `node`, which has no `app` module — not env-var driven at all). This is the
exact ordering hazard LT-207 named and avoided for the codebase-indexing lane worker's copy of the
same singleton, left unfixed in the original context worker that introduced the pattern in the same
commit (LT-206, 2026-08-19).

Implementation: swapped the two top-level statements in `context-worker-main.ts` so the RLM database
pre-init runs before `registerWorkerEventForwarding(transport)`, mirroring LT-207's fix. Added a
regression test to `src/main/instance/__tests__/context-worker-main.spec.ts` asserting (a) the first
`RLMDatabase.getInstance()` call carries the real `dbPath`, and (b) it fires before
`registerWorkerEventForwarding` (via `invocationCallOrder`). Reverted the ordering in place, watched
the new test fail (`expected 11 to be less than 10`), restored from a `/tmp` backup (diff-verified
byte-identical), and confirmed both tests in the file pass again.

Live end-to-end re-verification: rebuilt `dist/main`, restarted the dev app fresh, created a new
instance, sent a real "flaky test" turn — the activation now lands correctly in the profile's own
`rlm.db`, is returned by `skillsActivationsRecent()`, and the shared fallback file gained zero new
rows for that instance. Also re-confirmed LT-169's kill-switch fix still holds on top of the
now-correctly-persisting path (disable → resend → activation count unchanged).

Gates: `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `ng lint` clean,
`npm run build:main` green, `test:quiet` 70/70 across `context-worker-client.spec.ts` +
`context-worker-event-forwarding.spec.ts` + `skill-attribution-service.spec.ts` +
`skills-loader.spec.ts` + `unified-controller.spec.ts` (includes the new/updated
`context-worker-main.spec.ts` tests). `check:ts-max-loc` unaffected.

Not chased further this session: whether the packaged app's context worker is affected identically
(the mechanism is structural, not dev-specific, but this session did not independently confirm
against the packaged app's own `~/.aio/<hash>` fallback file) — flagged as very likely but unverified.

## LT-481 — the Workboard's Snooze control cannot durably hide an already-urgent Needs You card — **DECIDED + FIXED 2026-09-06 (status corrected 2026-09-20)**

Found driving check C2 for the first time in this doc's history (five prior sessions bucketed the
whole check as "NOT RUN — needs a mobile client" without separating out its agent-driveable
Workboard/session-picker half). A real `waiting_for_permission` instance's Needs You card was
snoozed via a real DOM click; it correctly hid, then silently reappeared 2-5 seconds later with the
instance's status unchanged the whole time — confirmed at the signal level (`store.isSnoozed()` flips
back to `false` on its own).

Root cause: `WorkboardStore.snoozeItem()` records only an item id, no baseline attention level, so
the hand-raise effect's `attentionLevelClearsSnooze(level)` — which checks only the item's *current*
level (`level !== 'working' && level !== 'waiting'`) — is unconditionally true for every item already
in the Needs You lane, clearing the snooze on the very next reactive recompute regardless of whether
anything actually changed.

**Not a wiring accident.** Every existing `workboard.store.spec.ts` test for this mechanism
deliberately snoozes a *working* item and asserts it un-snoozes on a transition into blocked/failed/
idle — exactly the intended, tested design (mute a non-urgent item, reveal on genuine escalation).
None cover snoozing an item that's already urgent, which is this doc's own check scenario. The gap is
between the check's literal precondition and a narrower, deliberate design — a product-decision fork
between (a) making the hand-raise comparison baseline-aware so the button works as the check expects,
or (b) not offering a Snooze control on Needs You cards at all, not something to decide unilaterally.

**Resolved.** James chose direction (a) — make the hand-raise comparison baseline-aware — over
removing the control. This section's "not fixed" wording was left stale and is corrected here; the
register's LT-481 row is the authoritative write-up.

As built: `WorkboardStore` stores the attention level held at snooze time rather than a bare id
(`ReadonlyMap<string, AttentionLevel>`, `src/renderer/app/features/workboard/workboard.store.ts:66`,
captured in `snoozeItem()` at `:245-255`), and `snoozeClearedByAttention(current, baseline)`
(`workboard-projection.ts:116`) clears a snooze only on completion or a strict rise above that
baseline — so `working`/`waiting` churn and staying at the same level no longer self-clear. The
hand-raise effect consults the baseline at `workboard.store.ts:91-101`. Verified 2026-09-20 by
reading the executing path.

Full detail and both candidate directions:
[register entry](livetest-remediation-register.md#lt-481-the-workboards-snooze-control-cannot-durably-hide-a-needs-you-card--deliberate-design-not-a-wiring-bug-but-it-contradicts-this-docs-own-check-scenario).

## LT-521 — check 1's "logs show shadow decisions" wording describes a log line that does not exist — DOC-CORRECTED

Status: **complete as a documentation correction.** The owning check now describes the real,
already-live-verified silent shadow behavior; no unnecessary production log was added.

The provider-agnostic-context-evidence livetest's check 1 Expected Result includes "logs show shadow
decisions (policy computed, action NOT executed)." No file on the shadow/enforce decision path
(`output-persistence.ts`, `context-evidence-diagnostics.ts`, `context-policy-runtime.ts`,
`context-safety-policy.ts`) contains any `logger` call describing a shadow-mode decision —
`output-persistence.ts` has exactly one `logger.warn`, for an unrelated migration-error path; the
other three files have zero `logger` calls between them. Shadow mode's real behaviour (capture without
alteration, `maybeExternalize()` returning the raw output unchanged) is correct and unaffected — this
is purely a gap between the check's own wording and what was ever implemented, first observed
2026-08-12, confirmed by source read 2026-08-18, and left unfiled both times as cosmetic. Filed this
session per an explicit instruction not to silently accept a real (if cosmetic) gap.

Required behaviour: either add an `info`/`debug` log line at the point a shadow-mode decision is
computed but not executed (natural home: `output-persistence.ts`'s `maybeExternalize()`, immediately
before its `mode === 'shadow'` early return), or correct check 1's Expected Result to describe shadow
mode's real, silent behaviour — the same choice this doc already made for LT-220's "accept the gap,
correct the false claim" precedent. Not decided here; editing a check's acceptance criteria or adding
new production logging as scope is not this session's call.

Not fixed. Full detail and acceptance criteria:
[register entry](livetest-remediation-register.md#lt-521-check-1s-logs-show-shadow-decisions-wording-describes-a-log-line-that-does-not-exist-anywhere-in-the-shadowenforce-decision-path).

## LT-522 — every `copilot-account:*` IPC channel rejected every renderer call — FIXED + MUTATION-CHECKED, 2026-08-25

Status: **fixed, regression-tested, mutation-checked. Live UI confirmation pending a rebuilt app.**

The GitHub Copilot account routing feature committed today (`20f534775 copilot routing`) was
completely unreachable from the renderer. All 15 `copilot-account:*` channels failed Zod validation
before any handler ran, so Settings › GitHub Copilot Accounts could not list, create, rename, route,
preview or diagnose anything.

Found by accident, from the packaged app's own logs, while sweeping Copilot instance provenance for
[automation provider exclusions](../superpowers/plans/2026-07-30-automation-provider-exclusions_livetest_completed.md)
check 6: **239,644** `IPC validation failed` warnings across the retained `app.log` set, split exactly
119,822 / 119,822 between `copilot-account:preview-route` (`Unrecognized key: "ipcAuthToken"`) and
`copilot-account:list` (`Invalid input`) — a 1:1 retry loop about a millisecond apart.

Root cause: the preload builds this domain **with** `withAuth` (`src/preload/preload.ts:79`), which
stamps every payload with an `ipcAuthToken` key — present even before a token exists, because it is set
to `undefined`, and an explicitly-`undefined` property is still an own key. All 10 payload schemas in
`packages/contracts/src/schemas/copilot-account.schemas.ts` were `.strict()` and none declared it, and
`validatedHandler` validates the raw payload without stripping. The two sibling domains preload wires
the same way, `provider.schemas.ts` and `voice.schemas.ts`, both declare
`ipcAuthToken: z.string().optional()` — the convention existed and this domain missed it.

It shipped green because `copilot-account-handlers.spec.ts` had **zero** occurrences of `ipcAuthToken`:
it invoked the real handlers with bare payloads the preload never sends, so it tested a shape that
cannot occur in production.

Fix: a shared `ipcAuthTokenField` spread into all 10 schemas, keeping `.strict()`. Admitting the stamp
into the parsed payload was verified safe first — `store.createProfile()` and `store.createRule()`
build their persisted records field by field and never spread the input, so it cannot reach disk. 32
regression tests cover all 15 channels in both token states plus strictness controls (`env`,
`copilotHome`, `configPath` still refused; non-string token still refused). Reverting the schema change
fails 13 of them; restoring it returns 45/45.

Gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main` — all clean.

Remaining: the live UI confirmation belongs to
[the Copilot account routing livetest](../superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest.md),
whose check 1 opens Settings › GitHub Copilot Accounts — the exact surface this defect disabled.

Full detail: [register entry](livetest-remediation-register.md#lt-522-every-copilot-account-ipc-channel-rejected-every-renderer-call-because-strict-schemas-did-not-declare-the-preloads-auth-stamp).

## LT-523 — orchestration-protocol response injection bypasses `SessionAdmissionService`, corrupting a genuinely blocked session — FIXED IN CODE 2026-08-31, LIVE RE-CHECK PENDING

**Current implementation status (2026-08-31): fixed in code; live re-check pending.** All
orchestration replies now pass through a single extracted admission/redelivery delivery path before
the `inject-response` event can reach stdin. Blocked permission, interrupt, and respawn states
suppress the write and retain the complete response metadata for ready-edge redelivery. Consensus
delivery uses the same final emitter after its existing admission, so it is not admitted twice.
Failing-first tests cover blocked user-action suppression and redelivery-handler registration.

The following paragraphs retain the original live finding and root-cause evidence.

Found driving the sibling-audit-round2 livetest's check C2 "approve/confirm works from the Workboard
card" sub-assertion — untested across five prior evidence-run sessions in that doc, each blocked on
needing a real `approve_action`/`confirm`-shaped request without Guardian adjudication or an
auxiliary LLM endpoint (both unreachable this session too — see B3 in that doc). Produced one the
same way the app itself does: a real Claude instance was asked to emit the documented
`:::ORCHESTRATOR_COMMAND:::{"action":"request_user_action","requestType":"approve_action",...}:::END_COMMAND:::`
marker verbatim in a plain reply, which `OrchestrationHandler.processOutput()` parsed into a real
pending `UserActionRequest`. The same instance was then driven to a genuine `waiting_for_permission`
status via an ordinary non-yolo Bash request — exactly the precondition the Workboard card's
Approve/Reject buttons require (`attentionLevel === 'blocked'`).

The card rendered correctly and clicking the real DOM `Approve` button correctly called
`respondToUserAction()` and cleared the card. But the response text was fed straight to Claude's
stdin **while the instance was still genuinely waiting on an unrelated, earlier Bash permission
prompt** — Claude abandoned/duplicated the pending tool call, orphaning the original deferred
permission with no way to answer it, and a later stream-idle-timeout auto-respawn attempt then
collided with a late permission decision (`Illegal lifecycle transition blocked: waiting_for_permission
→ respawning`), dropping the decision and leaving the instance stuck.

Root cause: `OrchestrationHandler.injectResponse()` only emits `'inject-response'`; the sole listener
(`instance-orchestration.ts`) calls `adapter.sendInput()` directly, serialized per-instance to prevent
stdin corruption, but with **no call to `SessionAdmissionService.admitAutomatedWrite()`** — the gate
every other automated writer (automations, channel messages, `consensus_query` results) is required to
call, and which A5 in the same doc already live-verified correctly suppresses writes to a
`waiting_for_permission` instance. This is a structural gap in the orchestration-response path, not
narrow to `request_user_action` — every `OrchestratorAction` reply (`spawn_child`, `call_tool`,
`report_error`, etc.) shares the same unguarded write.

Code remediation is complete; the rebuilt-app scenario remains to be re-run live. Full detail, root
cause, required behaviour, and acceptance criteria:
[register entry](livetest-remediation-register.md#lt-523-orchestration-protocol-response-injection-respondtouseraction-and-every-other-orchestrationhandler-command-reply-bypasses-sessionadmissionservice-corrupting-a-genuinely-blocked-session).

## LT-524 — WS15 durable resume never fires when a turn's entire output occurs before the coordinator has accepted any frame — FIXED IN CODE 2026-08-31, LIVE RE-CHECK PENDING

**Current implementation status (2026-08-31): fixed in code; live re-check pending.** A durable
worker registration now always receives a resume RPC, including an empty coordinator cursor list.
The worker treats that request as discovery and merges every buffered durability-ring instance that
is absent from the coordinator cursors at sequence zero. Failing-first tests cover the empty-cursor,
offline-only-instance, and mixed known/unknown-instance cases.

The following paragraphs retain the original isolated-worker reproduction and root cause.

Found driving [WS15 checks 2/3](2026-07-13-fable-ws15_livetest.md), which prior sessions back to
2026-07-26 had repeatedly recorded as "not run — needs a deliberate cut of James's live worker link,
not something to induce unattended." That reasoning was sound for `windows-pc`, but this session
instead paired a fully disposable worker-agent process to its own isolated dev-app coordinator — never
touching any of James's real nodes — giving full, non-destructive, in-process control over the link via
a Node Inspector `net.Socket.prototype.write` monkeypatch (the same class of lever WS13 Batch C already
established as legitimate for this campaign).

Sent a real prompt to a remote instance, cut the link a few seconds later — before any output
notification had reached the coordinator — held it until the coordinator's own 90s heartbeat-timeout
genuinely force-disconnected the node, then restored it and let the worker reconnect normally.
Confirmed independently of AIO (via the Claude CLI's own on-disk session transcript) that a complete,
real assistant response was generated entirely during the outage. After reconnect, `app.log` never
logged "Durable stream resume completed" and the instance's transcript never received the response —
total, silent, permanent loss, with no gap marker and no error surfaced anywhere. Reproduced twice
(an essay turn and a trivial "ping" turn) in the same session.

Root cause: `StreamDurabilityCoordinator.resumeNode()` (`src/main/remote-node/stream-durability-coordinator.ts:97-100`)
returns immediately when `state.cursors.size === 0` — i.e. when the coordinator had not yet accepted at
least one output frame for that instance before the drop. A turn whose entire output window falls after
the link goes down therefore has no cursor to resume from, and the coordinator never even asks the
worker's ring buffer whether it has anything buffered, even though in this reproduction it plainly did.

Code remediation is complete; the disposable-worker disconnect scenario remains to be re-run live.
Full detail, root cause, required behaviour, and acceptance criteria:
[register entry](livetest-remediation-register.md#lt-524-ws15-durable-resume-never-fires-for-a-turn-whose-entire-output-occurred-before-the-coordinator-had-accepted-any-frame--silent-total-loss).

## LT-525 — a mid-turn instance stays stuck in `degraded` after its worker node reconnects — FIXED IN CODE 2026-08-31, LIVE RE-CHECK PENDING

**Current implementation status (2026-08-31): fixed in code; live re-check pending.** `degraded`
can now restore every nonterminal remote lifecycle state, including active turns, interrupts, and
hibernation. Reconnect reconciliation also isolates each instance so one stale/invalid transition
cannot reject node registration or prevent later instances from reattaching. Failing-first state
machine and failover tests cover both behaviors.

The following paragraph retains the original isolated-worker reproduction and root cause.

Found in the same [WS15 checks 2/3](2026-07-13-fable-ws15_livetest.md) session as LT-524, same
isolated-worker reproduction. When the disconnected node's instance was `processing` at drop time,
the reconnect-reconciliation handler (`WorkerNodeRegistry.onReconnect`, `node-failover.ts:119-140`)
tries to restore it straight back to `processing`, which `InstanceStateMachine`'s transition table
does not allow from `degraded` (`instance-state-machine.ts:161`: only `ready`/`idle`/`error`/
`initializing`). The resulting `IllegalTransitionError` is swallowed by `RpcEventRouter`'s generic
catch, bouncing the node's first re-registration attempt (code 4001) — the retry then succeeds, but
because `onReconnect` is a one-shot listener already unregistered before the throw, the instance is
never reconciled and stays `status: 'degraded'` indefinitely even once the node is fully healthy
again. Reproduced twice; only an incidental, unrelated `sendInput()` moved it back to `idle`.

Code remediation is complete; the disposable-worker reconnect scenario remains to be re-run live.
Full detail, root cause, required behaviour, and acceptance criteria:
[register entry](livetest-remediation-register.md#lt-525-a-mid-turn-instance-whose-worker-node-disconnects-gets-permanently-stuck-in-degraded-after-the-node-reconnects).

## LT-526 — `hardened: true` + a remote node silently runs fully unsandboxed — FIXED IN CODE 2026-08-31, LIVE RE-CHECK PENDING (P0)

**Current implementation status (2026-08-31): fixed in code; live re-check pending.** Adapter
creation now rejects the hardened/remote combination before either the remote or local-model early
return, so a `RemoteCliAdapter` cannot be created while the instance claims hardened protection. A
failing-first adapter-factory regression test proves the combination fails closed.

The following paragraphs retain the original isolated-worker reproduction and root cause.

Found closing out [WS13 check 5](2026-07-13-fable-ws13_livetest.md), previously left open across
five sessions as "no agent-reachable path sets `hardened: true` on a `forceNodeId` create" — true
for every exposed IPC/MCP surface, but `createInstance` itself has always accepted both fields.
Using the same disposable worker built for the sibling WS15 checks in this session, called
`createInstance({ hardened: true, forceNodeId: <connected node> })` directly. It did not fail
closed: the instance reached `idle` normally with `executionLocation: { type: 'remote' }` **and**
`hardened: true` both recorded, and the worker's own log — independent of the coordinator —
contains zero mentions of `sandbox`/`seatbelt` anywhere, confirming the CLI ran completely
unsandboxed on the remote node with no error or fallback.

Root cause: `adapter-factory.ts`'s remote-execution branch returns a bare `RemoteCliAdapter`
**before** reaching the hardened-mode fail-closed guard further down the same function — the exact
"early return skips a fail-closed check" shape a comment on that same branch already documents and
fixes for Copilot, but was never applied to the hardened-mode check. The guard's own inline
`// FAIL CLOSED` comment is unreachable dead code for every remote instance.

Code remediation is complete; the rebuilt disposable-worker scenario remains to be re-run live.
Full detail, root cause, required behaviour, and acceptance criteria:
[register entry](livetest-remediation-register.md#lt-526-hardened-true--a-remote-node-silently-runs-completely-unsandboxed--the-fail-closed-guard-is-unreachable-dead-code).

## LT-527 — Copilot adapter constructor blocked on CLI discovery (FIXED 2026-08-26)

Root cause, reproduction and acceptance are in
[the register](livetest-remediation-register.md#lt-527-copilot-adapter-constructor-blocked-on-cli-discovery).

**Implementation status: complete.** `CopilotCliAdapter`'s constructor no longer resolves the CLI
launch; a private `ensureLaunchResolved()` does it once, from an overridden `spawnProcess()`.
Regression cover added at `src/main/cli/adapters/copilot-cli-adapter.lazy-launch.spec.ts` (verified
to fail 3/4 when the fix is reverted).

**Verification, 2026-08-26** — all six canonical gates green with the fix in place:

```
npx tsc --noEmit                     → 0
npx tsc --noEmit -p tsconfig.spec.json → 0
npm run lint                         → 0
npm run check:ts-max-loc             → 0
npm run build:main                   → 0
npm run test:quiet                   → 0   (1,796 files / 19,042 tests passed in 198.9s)
```

Also re-verified under the reproduced failure environment: 10/10 previously-timing-out tests pass
in 551ms.

**Not closed by this item:** the same synchronous probe remains in `createCopilotAdapter()`
(`adapter-factory.ts:332`) on the ACP spawn path. Tracked in the register entry's residual note.

## LT-528 — warm-started Codex ignored requested YOLO launch permissions — FIXED + LIVE-VERIFIED, 2026-08-31

Status: **complete. Implementation, focused regressions, live verification, all canonical gates,
and fresh completion review pass.**

The session-scoped Computer Use autonomy livetest exposed a launch-state mismatch: a Codex create
with `yoloMode: true` consumed a warm adapter spawned with default non-YOLO permissions, so its first
MCP call still required approval despite the UI and instance state reporting YOLO enabled.

The preflight now treats resolved YOLO mode as incompatible with a default warm adapter and takes the
fresh-spawn path. The focused regression test failed first with `warm` instead of `fresh`, passes
after the fix, and the rebuilt isolated dev runtime completed the same `computer.list_apps` call on
the second consecutive YOLO create without an approval request.

Final verification passed both TypeScript checks, lint, the TypeScript LOC gate, the main-process
build, and the full project-pinned Node 24.15.0 suite (1,832 files and 19,713 tests). An independent
fresh completion-gate review returned `VERDICT: PASS` with no actionable findings.

Full reproduction, root cause, acceptance criteria, and evidence:
[register entry](livetest-remediation-register.md#lt-528-warm-started-codex-sessions-ignored-requested-yolo-launch-permissions).

## LT-529 — generic Settings selects displayed their first option instead of the persisted value — FIXED + LIVE-VERIFIED, 2026-08-31

Status: **complete. Implementation, focused regressions, live verification, all canonical gates,
and fresh completion review pass.**

The Computer Use autonomy livetest found the real select displaying `guarded` after restart while
IPC and the enforced policy both held `unrestricted`. The setting persisted correctly; the generic
`SettingRowComponent` applied its select value before the `@for` options existed, so the browser
later chose the first option.

The matching option is now selected as each option renders. A focused component test failed first
with the exact `guarded`/`unrestricted` mismatch and passes after the fix, as does the Computer Use
settings-tab suite. In the restarted isolated dev runtime, the select and IPC now both report
`unrestricted`.

Final verification passed both TypeScript checks, lint, the TypeScript LOC gate, the main-process
build, and the full project-pinned Node 24.15.0 suite (1,832 files and 19,713 tests). An independent
fresh completion-gate review returned `VERDICT: PASS` with no actionable findings.

Full reproduction, root cause, acceptance criteria, and evidence:
[register entry](livetest-remediation-register.md#lt-529-generic-settings-selects-displayed-their-first-option-instead-of-the-persisted-value).

## LT-530 — Claude structured OAuth failure rendered as assistant prose — FIXED, rebuilt UI check pending

Session `470f3695-ba5b-497a-95a6-9ad8c5bf7b2f` exposed two linked gaps. Claude's
`authentication_failed` API event arrived inside a synthetic `assistant` envelope, and both AIO
Claude execution paths rendered it as normal assistant prose instead of emitting an adapter error.
The later auth-repair probe could also report healthy after another process refreshed the shared
credentials and incorrectly veto recovery of the process-specific failed turn. Generic CLI
detection compounded the confusion by inferring authentication from a successful version probe.

Fixed with a shared Claude stream-error parser and typed authoritative provider-auth error used by
the direct adapter and spawn-worker proxy. Communication now preserves the complete failed turn;
auth repair accepts structured provider evidence even when the later shared probe is healthy, then
performs the bounded same-instance restart/replay implemented for LT-168. Version detection now
leaves auth unknown for provider-specific probes to determine.

The exact captured stream event was replayed through the real adapter: zero assistant outputs, one
typed auth error. Focused coverage is 207/207 green. Both TypeScript checks, lint, the size ratchet,
and `build:main` pass. The full suite is blocked only by six unrelated failures in concurrently
modified session-recovery files. Rebuilt UI verification of a genuine concurrent OAuth refresh race
remains pending because it cannot be staged safely without disturbing active Claude credentials.

Full detail: [register entry](livetest-remediation-register.md#lt-530-claude-structured-oauth-failure-was-rendered-as-assistant-prose-and-vetoed-by-a-later-healthy-probe).

## LT-531 — record-mode loop preflight spent its whole verify budget producing no baseline — FIXED IN CODE 2026-09-03

Status: **fixed in code and mutation-checked; rebuilt-app check pending.**

`runLoopPreflight` (`loop-audit-runtime.ts`) ran the loop's full verify under the complete
`verifyTimeoutMs` regardless of `preflightMode`, and the preflight is awaited before iteration 0
(`loop-coordinator.ts:1832-1846`). In a workspace whose verify command was auto-adopted from its own
`package.json` `verify` script, that meant 600s of dead time at the head of the run to produce
`timed out` — no baseline — for a status nothing downstream reads (`preflight-red-baseline` is
declared in `loop-audit.types.ts` with no producer in `src`).

Reproduced from loop `loop-1788392553418-c66131dc`: `Mode: record`, `Duration: 599971ms`, output tail
still inside `check:dead` (step 6 of 14) at the kill.

Implemented:

1. `LOOP_PREFLIGHT_VERIFY_BUDGET_MS` = 180s caps the verify budget whenever the preflight is not a
   gate. `block` mode keeps the configured budget.
2. A passing quick-verify ends a non-gating preflight; the slow command is recorded as an explicit
   `skipped` entry with its reason rather than silently omitted.
3. `renderLoopPreflightMarkdown` notes both the timeout ("baseline UNKNOWN, not proven red") and the
   skip case, so `PRE_FLIGHT.md` never implies a clean baseline it did not establish.

Regression tests: `caps the baseline verify budget when the preflight is not a gate` and
`stops after a passing quick-verify when the preflight is not a gate` in
`src/main/orchestration/loop-audit-runtime.spec.ts`. The second was mutation-checked by reverting the
short-circuit and watching it fail.

Not closed by this work at the time: **LT-350** (cancel does not kill an in-flight preflight verify
subprocess) is the same code path; the 180s cap bounded the orphaned child's lifetime without
stopping it. **Fixed separately 2026-09-10** — see LT-350's own section above.

Residual, deliberately not fixed here: a workspace whose verify cannot finish in 180s and has no
quick-verify command configured still pays the capped budget and still records `timed out` on every
run. **Closed as [LT-532](livetest-remediation-register.md#lt-532-a-record-mode-preflight-with-no-cheap-command-still-burned-the-capped-budget-and-looked-like-a-failure) (2026-09-03):** record mode now skips the slow command when no cheap baseline ran, and the strip no longer paints that timeout as a blocking failure.

## LT-532 — record-mode preflight with no cheap command still burned the capped budget — FIXED IN CODE 2026-09-03

Status: **fixed in code; rebuilt-app check pending.**

Reproduced on the live loop `loop-1788423509509-eab2bd46`: `Mode: record`, `Duration: 179999ms`,
command `npm --prefix "ai-orchestrator" run verify`, red `Preflight timed out` chip while iteration 1
was already running. The grey `Audit gate pending` chip was the default final-audit gate waiting
until completion, not a stuck gate.

Implemented:

1. `runLoopPreflight` skips the full verify in `record` mode when no cheap command ran. The skipped
   entry carries `PREFLIGHT_VERIFY_SKIPPED_NO_CHEAP_NOTE`. `block` still runs the command it gates on.
2. `buildLoopAuditChips` mutes a record-mode timeout as `Preflight baseline unknown` and a skipped
   record preflight as `Preflight skipped`. A gating timeout stays red `Preflight timed out`. A
   not-yet-run final audit reads `Final audit pending`.

Regression tests: `does not run the full verify when the preflight is not a gate and no cheap command ran`
in `loop-audit-runtime.spec.ts`; chip wording in `loop-audit-chips.util.spec.ts` and
`loop-control.component.spec.ts`.

## LT-535 — a promptless provider-limit park resumed by sending nothing — FIXED 2026-09-17

Status: **fixed in code + regression-tested; rebuilt-app check pending.** James runs the packaged
`/Applications/Harness.app`, so this does not reach him until a rebuild and repackage.

Reproduced from the 2026-09-17 `five_hour` incident in `~/Library/Application Support/Harness/logs/app.log`.
Six sessions parked between 18:39 and 20:09 Europe/London (all times below are Europe/London); the
resume fired for all six at 20:30:05. Two re-sent their turn, four
logged `Cleared provider-limit park with no message to re-send` and sent nothing. Hibernation was
the obvious suspect and is not the cause: `cuggrdz6x` was hibernated by the idle sweep at 19:09 and
still logged `Send targets a hibernated session — waking before delivery` then
`Resumed regular session after provider quota reset`. The split tracks exactly one thing — whether
the session had ever been through `InstanceCommunicationManager.sendInput` before parking
(`cp0nlqnbs` 5, `cuggrdz6x` 10, both resumed; `cz37wakz1`/`cf8v1xrl6`/`c8n0z4wyg` 0, `pcto77u6s` 1
held by the preflight, none resumed).

Root cause: the completion-path park passes `resumePrompt: this.overflow.getResumePrompt(instanceId)`,
and `InstanceCommunicationOverflowTracker.lastSent` is written only by
`InstanceCommunicationManager.sendInput`. A session driven by its create-time initial prompt
dispatches straight to the adapter through `sendInitialPromptWithAttachmentFallback`, so a park
raised on that turn's completion — the normal Claude shape, limit notice as exit-0 assistant
content — recorded `resumePrompt: null` and `resumeNow()` cleared the park without sending.

Implemented:

1. `buildProviderLimitContinuationPrompt()` in `instance-provider-limit-resume-scheduler.ts` is the
   single continuation turn for a promptless park. Replaying the initial prompt was rejected: by the
   time a five-hour window closes the session can be hours into that task, and replaying restarts it.
2. `resumeNow()` sends that turn when a *live park entry* carried no prompt, instead of clearing the
   park silently. The continuation turn is deliberately gated on the park entry: with neither a park
   nor a carried prompt nothing is sent, so a stale Resume click arriving after the park already
   cleared stays the no-op it was before this change (`instance-provider-limit-ipc.ts` has no
   `isParked` guard of its own).
3. `resumeFromAutomation()`'s live-instance branch sends the continuation turn when the automation
   carried no prompt. That branch previously sent nothing, which reproduced the same silent resume
   after an app restart, where the in-memory park entry is gone.
4. The durable automation's dispatch fallback now uses the same builder in place of its own variant
   naming the instance id and the raw limit reason, so the timer and automation paths agree. The
   limit reason moved to the automation's `description`, where it is triage detail for whoever finds
   a row still pending rather than noise in a prompt the model reads.

Regression tests in `instance-provider-limit-handler.spec.ts`: `sends the continuation turn when the
park captured no turn to re-send`, `prefers the captured turn over the continuation turn`, `still
de-dupes a double fire when the park captured no turn`, `sends nothing when there is neither a live
park nor a carried turn`, and `sends the continuation turn post-restart when the automation carried
no prompt`. The first, third and fifth fail against the pre-fix handler; the second and fourth are
regression guards that must pass both before and after.

Not covered: `pcto77u6s`'s shape, where the held turn returned before `rememberLastSent` and the
turn that eventually hit the limit came from the runtime reconciler's transcript replay rather than
a dispatch AIO made. The continuation turn resumes it correctly, but recording the held turn as the
resume prompt is a separate change and is not made here.

Residual risk, recorded not fixed: `cancel()` deletes the durable resume automation fire-and-forget
(`instance-provider-limit-resume-scheduler.ts`), and blocks a racing fire only for the 60s
`RESUME_DEDUPE_MS` window. If that delete fails silently and the automation fires later against a
session that is dismissed but still live, `resumeFromAutomation`'s no-entry branch now sends the
continuation turn where a promptless park previously sent nothing. This extends an existing
exposure rather than creating one — a park that *had* captured a prompt already re-sent it through
the same race before this change. Hardening it means awaiting the automation delete in `cancel()`
or recording an explicit dismissed marker for `resumeFromAutomation` to check, both of which change
cancel semantics beyond this defect.

## LT-536 — loop harvest commits refused by the repository hook stranded finished work — FIXED 2026-09-18

Reproduced 2026-09-18 during the stranded-worktree rescue
(`docs/plans/2026-09-18-stranded-worktree-rescue_report.md`). Eight loop worktrees held uncommitted
output at lifecycle phase `blocked`. `app.log.3`/`app.log.4` show the harvest commit refused by the
repository pre-commit hook: `node: command not found` under the packaged app's PATH (5 runs) or the
plan-spec guard (2 runs). The eighth run predates log retention.

Implemented:

1. `harvestWorktree` and the boot-reconcile harvest commit with `--no-verify`: the harvest is a
   safety commit on a throwaway session branch.
2. `listActivePlanDocuments()` (`src/main/workspace/git/active-plan-documents.ts`) mirrors the
   plan-spec guard's pattern and standing-register exemption over `base...sessionBranch`.
   `finalizeLoopWorktree` (via `WorktreeManager.listActivePlanDocuments`) and boot reconcile call it
   before integration and block with `Session adds active plan/spec/livetest documents; land it
   manually`. Integration and promotion already skip hooks, so without this, fixing (1) would have
   let active plans reach the base branch.
3. Boot reconcile keeps a clean `blocked` run whose branch tip moved away from `sessionTip` blocked
   (`Session branch changed outside AIO; review it before landing`) instead of adopting the tip and
   auto-integrating it.
4. `managedWorktreeStatus()` no longer says `saved on <branch>` for a failed harvest, and shows the
   fixed identity and landing-guard reasons verbatim.

Regression tests: `worktree-manager.spec.ts` (`commits harvested work even when a pre-commit hook
refuses the commit`, `lists active plan documents the session branch adds relative to its base`),
`loop-worktree-lifecycle.spec.ts` (`refuses to auto-integrate a session that adds active plan
documents`, `does not inspect plan documents for a run that will not be integrated`),
`loop-worktree-lifecycle-reconcile.spec.ts` (`captures a dirty worktree at boot even when a
pre-commit hook refuses the commit`, `keeps a blocked run blocked when its clean session branch
moved outside AIO`, `refuses to integrate a session branch that adds active plan documents`),
`managed-worktree-status.util.spec.ts`. The harvest and the three reconcile tests fail against the pre-fix
code.

Follow-ups James chose on 2026-09-18 (rescue report items 15 and 16), both implemented:

5. Loop promotion passes `dirtyRootPolicy: 'block-overlap'` (`LOOP_DIRTY_ROOT_POLICY` in `loop-landing-policy.ts`), from both
   `WorktreeManager.promoteWorktreeIntegration` and boot reconcile. An unrelated untracked root file
   no longer blocks; an overlapping one does. Tests: `worktree-manager.spec.ts` (`promotes loop work
   past an unrelated untracked root file but not an overlapping one`),
   `loop-worktree-lifecycle-reconcile.spec.ts` (`promotes past an unrelated untracked root file`,
   `keeps a promotion that overlaps dirty root work blocked and retries it on the next boot`).
6. "Mark resolved" for a blocked run in the Past loop prompts panel, over the new
   `LOOP_RESOLVE_BLOCKED_WORKTREE` channel. `resolveBlockedLoopWorktree()` sets phase `cleaned` and
   `resolvedByOperatorAt`, refuses a dirty worktree folder, and deletes nothing. Tests:
   `loop-worktree-resolve.spec.ts`, `loop-worktree-resolve-handler.spec.ts`, `loop-store.spec.ts`,
   `loop-past-runs-panel.component.spec.ts`, `managed-worktree-status.util.spec.ts`.

Rebuilt-app check pending: see the LT-536 acceptance list in the register.

## LT-537 — the operator switch barring agent secret requests was never enforced — FIXED 2026-09-19

Found during the 2026-09-19 code-completeness audit of the stranded-worktree rescue, while checking whether
report item 1's deferred "agent-initiated secret requests" work was still needed. It was not: main already
raises the card from agent metadata. What was missing was the operator control over it.

Implemented: `InstancePermissionRequestFlow.handleInputRequired` refuses a `secret_required` request when
`workspaceSecretsEnabled` or `workspaceSecretsAllowAgentRequests` is off — before forwarding to the renderer —
answering the agent so it does not wait, emitting a `permission:lifecycle` deny (`source: 'operator-setting'`),
and adding a system output note. Unreadable settings fail closed.

Regression tests in `src/main/instance/instance-permission-request-flow.spec.ts`: `refuses an agent secret
request when the master switch is off`, `… when agent requests are barred`, `forwards an agent secret request
when both operator switches are on`, `fails closed when settings cannot be read`. The three new blocking cases
fail against the pre-fix code.

Rebuilt-app check pending: see the LT-537 acceptance list in the register.

## LT-538 — the loop panel told the operator a provider-limit park would never resume — FIXED 2026-09-19

Found by the independent completion gate on the stranded-worktree follow-ups, which rejected a new "Turn on
auto-resume" loop-timeline action. Traced: `instanceProviderLimitResumeEnabled` gates only regular sessions
(`instance-manager.ts:439`); loops always schedule their own resume (`loop-provider-limit-handler.ts:486`). The
pre-existing `loop-provider-limit-resume-off` hint carried the same false premise on the default path.

Implemented: removed the hint (id, copy, predicate, spec block, loop-panel binding) and the new timeline action;
the timeline keeps its accurate "resumes on its own" copy. Tests: `loop-causal-timeline.spec.ts`,
`loop-control-timeline.spec.ts`, `loop-causal-timeline.component.spec.ts`, `hint-policy.spec.ts`. No live check
is needed: the change removes a message and a control, and the remaining copy is covered by unit tests.

<a id="lt-539"></a>

## LT-539 — a hardened create can adopt an unsandboxed warm-start adapter — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-539).

Found while running WS13 hardened-mode livetest check 4 in the queue worktree
`queue/2026-07-13-fable-ws13-1b04f4`. `InstanceSpawnPreflightChain.prepare()`
(`src/main/instance/lifecycle/instance-spawn-preflight-chain.ts`) computes `warmStartBlocked` without a
hardened term, and `WarmStartManager.consume()` matches only provider + working directory — so a
`hardened: true` create with a matching warm adapter waiting adopts a process that was spawned with no
Seatbelt wrapper, while still reporting `hardened: true` to the UI. Reproduced live with a negative control:
the warm case logged `Consumed warm process` + `Using warm-start adapter (skipping spawn)` and **no**
`Spawning CLI under Seatbelt hardened mode`; the no-warm case logged the Seatbelt spawn three times for an
otherwise identical create. This is the LT-528 defect shape (fixed for `yoloMode` on 2026-08-31) one guard
short.

Original remediation direction (at report time): The fix is a hardened term in `warmStartBlocked`; the regression test belongs in the
preflight chain's spec and must be watched failing first. Note the bypass only reaches non-YOLO creates
(`warmYoloMismatch` already blocks YOLO ones), and a non-YOLO Claude session refuses the Bash tool, so the
live evidence is the executing path plus logs rather than a write probe — recorded that way in the register.

<a id="lt-540"></a>

## LT-540 — a packaged smoke-mode app hijacks the machine-global Chrome native-messaging manifest — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-540).

Found while running WS13 hardened-mode livetest check 7. A packaged app started with `AIO_STARTUP_SMOKE=1`
and an isolated `AIO_STARTUP_SMOKE_USER_DATA_PATH` still claims
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_orchestrator.browser_gateway.json`
and repoints it at the throwaway profile, which `scripts/packaged-startup-smoke.js` then deletes in its
`finally` — leaving the installed app's local Chrome extension channel pointed at a path that no longer
exists. Two causes combine: `mayClaimBrowserExtensionNativeHostManifest` gates only on `app.isPackaged`
(LT-520's rule, correct for two real installs), and `defaultChromeNativeMessagingDir()` derives the path from
`os.homedir()` rather than `userData`, so the smoke harness's isolation does not cover this file. Reproduced
live (manifest `path` became `/tmp/aio-lt-pkg-profile/browser-gateway/native-host/ai-orchestrator-browser-host`,
sha1 `30e622e6…` → `3b7dea75…`) and restored by hand during that run. The reproduction used a manual launch
with the same env the script sets, not an `npm run smoke:packaged` invocation — that last step is read from
the script, not observed.

Original remediation direction (at report time): The fix is to decline the claim on a smoke/disposable profile, or restore the prior manifest
on exit. Acceptance: `npm run smoke:packaged` leaves the manifest byte-identical while the installed app runs.

<a id="lt-541"></a>

## LT-541 — every remote assistant reply was silently dropped by the durable-stream dedupe — FIXED + LIVE-VERIFIED 2026-09-20

Found on the very first baseline turn of the WS15 re-check in the queue worktree
`queue/2026-07-13-fable-ws15-332c74`, with no link interruption involved. Five probes and a 400-word essay
all produced a real assistant reply in the Claude CLI's own on-disk transcript and **none** of them reached
the instance's `outputBuffer`. Coordinator instrumentation over the Node inspector showed the cause
directly: `instance.context` (seq 18) arrived 52 ms ahead of `instance.output` (seq 17, the reply) and
advanced the cursor past it, so `StreamDurabilityCoordinator.accept()` rejected the reply as a replay
duplicate and logged it at `debug` only. The worker batches output on a 50 ms timer while context/complete
go out immediately, so seq order and wire order had never matched. Present since the WS15 landing commit
`c3d3714a` (2026-07-17); it is very likely part of what LT-524 recorded as outage-window loss.

Implemented on both sides. Worker: `sendCompleteNotification()`/`sendContextNotification()` flush the output
buffer before recording their own seq (`src/worker-agent/worker-instance-notifier.ts`). Coordinator:
`accept()` takes an `isReplay` flag and drops a below-cursor frame only when the worker tagged it
`replay: true`; a live below-cursor frame is delivered and logged at `warn`, and never rewinds the cursor
(`src/main/remote-node/stream-durability-coordinator.ts`, wired through
`src/main/remote-node/rpc-event-router.ts`). Six failing-first tests across
`worker-instance-notifier.spec.ts`, `stream-durability-coordinator.spec.ts` and `rpc-event-router.spec.ts`,
all mutation-checked. Live re-verification after rebuilding both halves: seqs 1→4 ascending, all accepted,
`FIXED-OK` in the transcript.

<a id="lt-542"></a>

## LT-542 — the WS15 parked-work window never opened on a heartbeat-timeout disconnect — FIXED + LIVE-VERIFIED 2026-09-20

Found while running WS15 check 3 in the same worktree. `NodeHealthMonitor` deregisters a silent node
**before** closing its socket, so when the 30 s grace expired the registry entry was already gone and
`isDurableNode()` — which read `capabilities.streamDurability` off that entry — reported false for every
durable worker. The in-flight `instance.sendInput` was aborted with a plain `Node disconnected` error, and
the `Parking in-flight work RPCs for durable worker reconnect` line the check expects had never been seen in
any campaign. Heartbeat timeout is the normal shape of a real link outage, so the parked-work window was
unreachable in practice.

Implemented by moving the fact into the component that uses it:
`ConnectionDisconnectLifecycle.noteNodeDurability()` records what each `node.register` advertised, and
`beginGrace()` reads that instead of the registry (`src/main/remote-node/connection-disconnect-lifecycle.ts`,
called from `src/main/remote-node/worker-node-connection.ts`). Two failing-first tests in
`src/main/remote-node/__tests__/worker-node-connection.spec.ts` (durable registration with no registry entry
parks then rejects with `(parked-work window elapsed)`; non-durable still fails fast), mutation-checked by
restoring the registry lookup. Live re-verification: parking at grace expiry, `parked work RPCs resume` on
reconnect, and — in a separate 210 s outage — the `(parked-work window elapsed)` rejection exactly 60 s after
parking.

<a id="lt-543"></a>

## LT-543 — the browser-gateway forwarder's log lines go nowhere — FIXED IN CODE; live check pending (reported 2026-09-20)

**Status update 2026-09-23:** The forwarder has a persistent user-data log sink and bounded inactive retention. A fresh reviewer found that an old owner marker could prune a live process after sleep; a failing-first regression confirmed it, and the fix now retains any directory whose owner PID is live. Focused tests and final gates passed; a rebuilt-forwarder live check remains pending. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-543).

Found while running browser-gateway reliability livetest check 2 in the queue worktree
`queue/2026-07-17-browser-gateway-rel-72bff1`. The `aio-mcp` browser-gateway forwarder logs to nothing:
outside Electron `getElectronUserDataPath()` returns `undefined`, so `LogManager`'s constructor sets
`enableFile = false` (`src/main/logging/logger.ts:337-346`), and `runBrowserMcpForwarder` sets
`enableConsole: false` to keep stdout clean for JSON-RPC
(`src/main/browser-gateway/browser-mcp-stdio-server.ts:159`). Every forwarder log line therefore lives
only in an in-memory buffer inside a process that is then killed — including
`Restored previously revealed browser tools`, the loud `Could not restore …` warning, and the
tool-surface contract-mismatch warning. Verified live: a reveal + forwarder restart provably restored
the tool surface (the restarted forwarder's first `tools/list` already contained `browser.evaluate`)
while `app.log` kept 0 occurrences of the line and both forwarder processes wrote nothing to stderr.
The 2026-08-19 "grep count is 0" note in that livetest was therefore never evidence about reveals.

Original assessment (2026-09-20): This needed a deliberate scope choice: either give the forwarder a real sink
(a log directory passed through its env by the MCP config writer, or forwarding entries to the parent
over the RPC channel it already holds), or correct the check's expected evidence to the observable
surface — the restored `tools/list` plus `browser.health`'s `revealRestoreFailed`, which survives
because it travels as an RPC field. Same shape as LT-521.

<a id="lt-544"></a>

## LT-544 — both extension channels accept commands and never run them while health calls them healthy — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-544).

Found while trying to run browser-gateway reliability livetest checks 1 and 6 in the queue worktree
`queue/2026-07-17-browser-gateway-rel-72bff1`; it blocks checks 1, 4 and 6 and every other live browser
check. Eight consecutive extension commands (5 × `find_or_open` and 2 × refreshing `list_targets` on
`windows-pc`, plus 1 × `find_or_open` on the local Mac Chrome — a different extension install) each
failed after ~30 s with `browser_extension_command_timeout`, while `browser.health` reported both
channels healthy (`channelState: "fresh"`, `commandsDeliverable: true`, poll age 0.8–5 s, empty queue,
2 waiting pollers, no `consecutiveUnansweredCommands`, no warnings, no reliability events) and
`browser.recover_extension` refused with `browser_extension_recovery_incident_not_confirmed`. The audit
table dates the outage to the last successful extension-executed command at 2026-09-20 01:48:44Z
(~16 h 50 m; cached `list_targets` keeps succeeding because it never reaches the extension),
spanning an app restart, with two other sessions hitting the same failure and refusal at 15:38–16:19Z.
The running app contains the `commands_unanswered` detection (24 matches in `app.asar`, process started
two minutes after it was written), so the widened gate is live and still did not fire.

Original assessment (2026-09-20): The root cause was not yet isolated. Reading the path rules out the undelivered branch (its
reason string differs), a worker-side timeout (the 30 s budget is the coordinator's, set at
`browser-target-discovery-operations.ts:499`), a singleton mismatch between the tracker that records and
the health read, and a `rejectQueue()` reset (that needs a node disconnect, which would have emitted a
`node_disconnect` event — none appeared). The next step is a persisted log line at the
`armExecutionTimeout` record site and at the health read, then a repeat of the burst: that separates
"never recorded" from "recorded but cleared or bypassed" in one run.

<a id="lt-545"></a>

## LT-545 — every object-payload renderer IPC call in `OrchestrationIpcService` is double-wrapped — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-545).

Found while running check 4 of the skill-observability livetest in the queue worktree
`queue/2026-07-23-skill-observability-b8464f`; it blocks that whole check from the UI side.
`invokeChannel(channel, payload)` hands its payload object to `ElectronIpcService.invoke`, which
calls the preload wrapper with it as the **first positional argument**
(`electron-ipc.service.ts:131`). Wrappers such as
`skillsDiscover: (searchPaths?: string[]) => ipcRenderer.invoke(ch.SKILLS_DISCOVER, { searchPaths })`
then wrap it again, so the main process receives `{ searchPaths: { searchPaths: [...] } }` and the
Zod schema rejects it. Confirmed live on `skills:discover`, `skills:set-control` and `skills:match`
through the real Angular service; all three succeed when the preload wrapper is called positionally.
User-visible effects: the Skills page's **Discover Skills** button shows a red validation banner and
can never list global skills, and every On/Suggest/Off control in the Skill Health panel (and the
instance-header skill toggle) fails into a `Could not update skill "…"` toast without changing the
persisted control.

Original remediation direction (at report time): A signature scan of that one service finds 16 channels with the same mismatch
(skills discover/set-control/match/load-reference/load-example, workflow get-template/get-execution/
cancel/complete-phase/skip-phase/satisfy-gate/get-by-instance/get-prompt-addition, review
get-session/get-agent, supervision get-tree); only the three skills channels were exercised live, so
the remainder is reported from signatures, not reproduced. The fix is a single calling convention —
either `invoke()` spreads positional arguments, or those wrappers take one payload object — and it
wants a generated check in the same family as `verify:ipc` so a service call and its preload wrapper
cannot drift apart again. Whichever direction is chosen, it touches shared IPC plumbing used by
workflow, review and supervision surfaces, so it needs their regression tests too, not just the
skills ones.

<a id="lt-546"></a>

## LT-546 — a suggest-only skill has no reachable control, and the panel mislabels the D1a default — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-546).

Same run as LT-545, and independent of it: repairing the IPC seam still leaves no way to promote a
suggest-only skill. The Skill Health panel is the only surface that sets control modes, and its rows
come from `getSkillHealthSummary`, which aggregates `skill_activations`
(`rlm-skill-attribution.ts:182`). A global skill defaults to `suggest-only`, so it never injects, so
it never gets a row, so it never gets a control — the D1a promotion path is circular. Observed live:
33 skills discovered while the panel read "No skill activations recorded yet" with zero buttons. The
instance-header badge is also activation-derived and only toggles `enabled ↔ disabled`, and nothing
in the renderer surfaces a suggestion for a suggest-only skill. Separately,
`[class.active]="(row.mode ?? 'enabled') === mode"` renders **On** as active for a control-less
global skill whose effective mode is `suggest-only` — observed for `list-mcp-servers`.

Original remediation direction (at report time): The row source has to come from the registry (or a union of registry and
activations) and each row has to render the effective mode through the same
`resolveSourceDefaultMode` rule the loader uses, rather than defaulting to `enabled`. Worth deciding
at the same time where a *suggestion* for a suggest-only skill is meant to appear, since today it
appears nowhere and that is what makes the dead end invisible.

<a id="lt-547"></a>

## LT-547 — an enabled, detected skill over the injection budget is dropped in silence — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-547).

Same run. `fetchSkills` budgets `maxTokensPerSkill = 5000` (`unified-controller.ts:780`) and
`loadSkillsWithBudget` skips any skill that does not fit (`skills-loader.ts:466`), producing no
`loadedDetails` entry and therefore no `recordActivation` call. `ui-ux-pro-max` measures
`tokenEstimate: 10932` by the app's own `skillsLoad`, so no threshold or control setting can ever
make it auto-inject, and the user sees nothing at all: no injection, no activation row, no health
row, no log (`skills-loader.ts` has no logger and its `skills:detected` event has no listener).
Isolated with a controlled probe rather than inferred — a fixture skill with `ui-ux-pro-max`'s
identical 914-character description and a 78-token body injected on the same real send at
`matchScore: 0.6785713094638416` while `ui-ux-pro-max` recorded nothing.

Original assessment (2026-09-20): The behavior needed a product choice: either oversized skills load partially or
progressively, or the budget admits them, or the skip is recorded as a first-class "detected but not
injected" reason that the Skill Health panel can show. The cheap half — making the drop observable —
should land regardless of which way the first half goes, and it connects naturally to check 5's
existing `oversized-core` doctor lint, which already knows this skill is too big and currently has no
link to the injection path.

<a id="lt-548"></a>

## LT-548 — a materialised workspace secret is passed to the CLI on the command line — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-548).

Workspace Secret Card live test, check 4, run from the `queue/2026-08-23-workspace-secret-ca-4b8813`
worktree against an isolated dev app. The store side is correct end to end — per-workspace scoping,
encrypted at rest, audit records the authorised `resolved` use, nothing returned over IPC — and then
`SpawnConfigBuilder` hands the decrypted value to the CLI as a `--mcp-config <json>` argv token
(`spawn-config-builder.ts:219`, `workspace-mcp-connector-materialize.ts:64-78`). Read back live from
an unrelated shell with `ps -ww -p 48746 -o command`, i.e. from outside the workspace whose scoping
the store enforces.

Original remediation direction (at report time): The fix is a transport change, not a policy change: a `0600` temp file passed by
path, or the value delivered through the connector process's own env/stdin. Worth doing alongside
LT-551, because until an agent can raise the card at all, this is the only way a workspace secret
gets used.

<a id="lt-549"></a>

## LT-549 — the secret card keeps a rejected credential in its password input — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-549).

Same run, check 1 step 4. Forcing `safeStorage.isEncryptionAvailable()` false in the live main
process gave three of the four required outcomes; the input keeps the rejected 39-character value
because it is uncontrolled and `finishSecretCard` only clears state on success
(`user-action-request.component.ts:759-788`, `user-action-request.component.html:104-112`).
Reproduced twice. No leak to console, transcript or `app.log`.

Original assessment (2026-09-20): This was a small, self-contained renderer fix.

<a id="lt-550"></a>

## LT-550 — Workspace Secrets management hides the name, the timestamps and the audit trail — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-550).

Same run, check 2 step 2. The panel shows `label || name` and `purpose` and nothing else, so the
slug an agent quotes is invisible whenever a label exists, and `createdAt`/`lastUsedAt` are fetched
and dropped. `getWorkspaceSecretAudit` is wired through preload, the instance IPC service and the
facade, and called by no component.

Original remediation direction (at report time): Presentation-only apart from the audit view, which needs a small panel section.

<a id="lt-551"></a>

## LT-551 — nothing can raise the secret card — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-551).

Same run, check 3 step 1. The card is reachable only from a CLI stream message shape no provider CLI
emits, and the agent-facing orchestration protocol has no `secret_required` request type
(`orchestration-protocol.types.ts:130-134`). Confirmed against a live Claude session, which answered
`NONE` and named `request_user_action` / `ask_questions` as what it would use instead — the plaintext
path that lands in conversation history.

Everything downstream of the entry point already works and was verified in the same run. The decision
to make first is *where* the entry point belongs: an orchestration request type (matches how the
renderer already models the card), an orchestrator MCP tool (matches how agents reach other Harness
capabilities), or both. LT-537's operator switch should be re-verified once the path exists, because
it currently guards something unreachable.

<a id="lt-570"></a>

## LT-570 — the Settings Help drawer is a modal that manages no focus — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-570).

Settings UX remediation livetest, LT-1 checks 1 and 6, run against a live Electron instance at
800×600 with focus emulation and real key events. Opening `#settings-help-drawer`
(`role="dialog"`, `aria-modal="true"`) leaves `drawer.contains(document.activeElement)` false, the
next Tab lands on a General-tab control behind the modal, and Escape restores nothing. The compact
nav overlay mirrors it: Escape with focus inside drops focus to `<body>`.

Original remediation direction (at report time): `settings.component.ts` has no focus handling in `openHelpDrawer`,
`closeHelpDrawer`, `toggleNav` or `closeCompactNav`, and the template declares the modal purely
declaratively. Self-contained renderer fix: initial focus, a Tab trap while open, and focus return
on close for both layers.

Numbering note: this campaign took `LT-570`–`LT-575` rather than the next sequential ids. The
register on the queue branch ended at `LT-534`, the register in this checkout at `LT-538`, and this
plan already carried `LT-551` from another campaign reporting the same day; a gap was the only way
to avoid colliding with the workers still allocating ids.

<a id="lt-571"></a>

## LT-571 — Remote Nodes → Pairing renders an entirely empty panel — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-571).

Same run, LT-1 checks 3 and 5. With `remoteNodesEnabled` false (the fresh-profile default), the
Pairing panel renders zero characters and zero child elements at all four test widths in both
themes, while Computers and Advanced both print a disabled-state line. The body itself is fine —
enabling the server fills the panel with 276 characters / 34 elements.

Original remediation direction (at report time): One missing `@else` at `remote-nodes-settings-tab.component.html:135`; Computers
at `:344` is the pattern to copy.

<a id="lt-572"></a>

## LT-572 — icon-only Settings rail controls are under the 44 × 44 hit-target floor — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-572).

Same run, LT-1 check 6. Measured live: `.nav-item` is 37 × 38px and icon-only at ≤900px
(`.nav-item-label` computes `display: none`), and `.settings-nav-toggle` is a fixed 30 × 30px icon
button at every width. The plan's own constraint requires 44 × 44 for icon-only actions. Accessible
names are all present and correct, so this is purely target size. The section switcher's 40px
height is allowed by Task 1 Step 6 and is out of scope.

Original remediation direction (at report time): SCSS-only: expand the pointer target without widening the 56px rail.

<a id="lt-573"></a>

## LT-573 — the save-state banner announces nothing, including its error state — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-573).

Same run, LT-2 check 4. A real Ecosystem write failure preserved the user's typed text and rendered
the ENOENT message on screen, but a query for `[role="alert"], [role="status"], [aria-live]` across
the whole Settings page returned zero elements: `SaveStateBannerComponent` has no live-region
semantics on the host or the inner `.save-banner`
(`ui/save-state-banner.component.ts:23`). The same banner is the save/error surface for Ecosystem,
Permissions, Remote Nodes, Display and Network. The Remote Nodes tab's own error line does have
`role="alert"` and behaved correctly in the same run, which is what makes the gap visible.

Original remediation direction (at report time): Two attribute bindings on one shared component, plus a spec per consuming tab.

<a id="lt-574"></a>

## LT-574 — Ecosystem lists no commands on any visit after the first — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-574).

Same run, found while setting up the LT-2 unsaved-edit fixtures. `ECOSYSTEM_LIST` clears
`cacheByWorkingDir` and not `dirMtimeCache` (`ecosystem-handlers.ts:71`), so the next scan takes the
mtime-unchanged reuse branch (`markdown-command-registry.ts:472-491`) against the entry it has just
deleted and drops every command in the directory, reporting `success: true` with empty
`diagnostics`.

Decisive reproduction: the same directory listed twice in a row returned `["lt-alpha","lt-beta"]`
then `[]`; one `touch` of `.claude/commands` restored both on the very next call, then `[]` again
after that. `clearDirectoryMtimeCache()` exists for exactly this case and is called only from a spec
(`src/main/commands/__tests__/markdown-command-registry.spec.ts:160`), never from production code.

Original assessment (2026-09-20): This was the highest-severity item in the batch — the Ecosystem tab tells the
user they have no commands when they do. Only the markdown command registry has an mtime cache, so
agents, tools, plugins and output styles are unaffected.

<a id="lt-575"></a>

## LT-575 — light-theme contrast failures on Settings surfaces — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-575).

Same run. First contrast measurement of this work; the livetest previously recorded contrast as
unverified in either direction. A WCAG 2.x pass over six Settings tabs found 6/10/20/13/41/6 failing
text elements in light theme against 0/0/0/1/2/0 in dark.

Two families were confirmed against rendered pixels rather than computed styles alone, and both are
obvious by eye: the Permissions → Rules `app-task-preflight-card` tiles render near-black values on
hardcoded dark surfaces (1.09:1), and the Ecosystem `app-instruction-inspector` `missing` pill is
pale mint on pale olive (1.82:1) with 3.33:1 source metadata. Screenshots are in the livetest doc.
`.btn.primary` measuring 1.00:1 is a gradient-background false positive and is excluded.

Original remediation direction (at report time): Both components need their hardcoded surfaces replaced with theme tokens so
surface and text flip together.

<a id="lt-590"></a>

## LT-590 — the loop diagnosis card loses its severity colours in the light theme — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-590).

Found running [Loop issue diagnosis UX](2026-09-02-loop-issue-diagnosis-ux_livetest.md) LT-1 in a
Plan Queue worker. Layout is fine — no clipping, no horizontal overflow and zero overlap with the
ping-pong row or the activity feed at 1400 px or 900 px — but the colour half of the check fails in
one theme.

Measured from rendered pixels with the theme set through the product's own control: severity chip
1.75:1 (CRITICAL) / 1.41:1 (WARN), fixability tag 1.91:1 / 1.46:1, `See why` primary button 1.56:1 /
1.09:1, `Stop` primary-danger 1.65:1. The card's prose stays at 17.6:1 because it uses
`var(--text-primary, …)`; the chip, the tag and the button fills are hard-coded dark-theme hexes in
`loop-issue-card.component.scss` with no light-theme branch. Dark and high-contrast both pass.

Same family as LT-575, different surface — worth fixing in the same pass if that one is picked up.

Original remediation direction (at report time): Replace the card's literal severity/button colours with theme tokens.

<a id="lt-591"></a>

## LT-591 — the WARN escalation borrows signal A's id, so the card headlines work that never repeated — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-591).

Same run, [LT-2](2026-09-02-loop-issue-diagnosis-ux_livetest.md#lt-2--real-detector-messages-read-as-english-in-the-card).
The WARN-escalation branch of `evaluateLoopProgress` appends its escalation under signal id `A`,
which the catalog defines as identical-work-hash repetition, so the diagnosis card headlines
"Repeating the same work" for a condition that measured no work hashes at all, and offers signal
A's hint advice while the signal that actually caused the WARN run-up is demoted to the second row
of the disclosure.

Reproduced by running the real `buildLoopIssueView` over every signal-bearing iteration in the
production loop-mode database: 51 of 2,447 real iterations render this headline. Live example
`iter-loop-1778974464545-b67e72ab-3-9b1c79`, whose real signals are `D-prime:WARN` (tests unchanged
despite file writes) and `A:CRITICAL` "3 WARN iterations in last 5 — escalated to CRITICAL".

The gates stayed green because `loop-issue-diagnosis.util.spec.ts` asserts this headline against a
hand-written escalation message — the test encodes the defect as the expectation. This is the exact
gap the check was deferred to close.

Original remediation direction (at report time): Either the escalation gets its own signal id and catalog entry, or it carries the
id of the signal whose WARNs it is escalating.

<a id="lt-592"></a>

## LT-592 — the fixability tag, the next step and the primary action can name different signals — FIXED IN CODE; final verification pending (reported 2026-09-20)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-592).

Same run and same check. `rollupFixability`, `nextStep` and `actionsFor` derive from different
signals, so a CRITICAL iteration carrying a fixable signal ahead of a not-by-hint one renders a
"Needs a decision" tag beside "What you can do  Give a hint …", with both `See why` and `Stop`
filled as primary. Real iteration `iter-loop-1778363605952-38a768a3-2-33da80` (`A` + `F`); 3 of
2,447 corpus iterations show the contradictory next step and 6 show two primaries. The existing
not-by-hint test only covers `BLOCKED`, where `blocked: true` suppresses `stop.primary`.

Original remediation direction (at report time): Small: take all three from one signal and allow at most one primary action.


<a id="lt-593"></a>

## LT-593 — Stop on a busy Claude session terminates it instead of interrupting it — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-593).

Found running check 16 of `2026-09-03-enhancements-backlog_livetest.md` in a dev app built from
`queue/2026-09-03-enhancements-backlo-451811`. Reproduced 2/2 on real local `claude` sessions; a
codex session driven through the identical scenario behaves correctly, so this is specific to the
resident-CLI Claude path.

Clicking `⏸ Interrupt` while a Claude turn is running ends the session: the transcript shows
`Interrupt requested: unresolved` then `Your message was restored to the input — restart the
instance to send it.`, the instance status becomes `terminated`, and the queued message is dropped
into the composer draft.

`app.log`, instance `clw1in6rd`:

```
1789947771585 InterruptRespawn      Interrupt requested                                                   status busy, provider claude
1789947771593 InterruptRespawn      Interrupt settled in place via adapter status; disarming force-abort  status idle
1789947772686 InstanceCommunication Adapter exit event                                                    code 0, signal null
1789947772687 InstanceCommunication Suppressing auto-respawn: owner flow is probing native resume         suppressedUntil 1789947806585
1789947772687 InstanceCommunication Instance exited unexpectedly                                          newStatus terminated
```

Root cause traced: `interrupt-respawn-handler.ts:413` sets `autoRespawnSuppressedUntil` on an
accepted interrupt; `noteInterruptSettled()` (same file, 580-597) clears the interrupt bookkeeping
but leaves that field set; the Claude process then exits code 0 about a second later and is handled
by the generic unexpected-exit path (`instance-communication.ts:2106+`), where
`wouldAutoRespawnIfNotRecent` is false *because it includes* `!autoRespawnSuppressed`, so the LT-023
deferred-retry branch at line 2179 cannot fire and the exit falls into `newStatus = 'terminated'` at
line 2196.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-593`.


<a id="lt-594"></a>

## LT-594 — the loop causal timeline's terminal readings are unreachable — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-594).

Found running check 15 of `2026-09-03-enhancements-backlog_livetest.md`. A 400 ms sampler across a
real loop's run-to-completion captured only the `running` frame; the component then left the DOM
and never rendered any terminal reading.

`LoopStore.applyState`'s terminal branch (`loop.store.ts:649-678`) calls `clearActive(chatId)` and
never re-upserts, so `LoopControlComponent.active()` is `undefined` from that instant and the
`@if (active(); as a)` block at `loop-control.component.html:62` — the only mount of
`<app-loop-causal-timeline>` — stops rendering. Every `TERMINAL_STATUSES` branch in
`loop-causal-timeline.ts`, including the wired `cap-reached` / `cost-exceeded` "Raise the cap and
continue" recovery, is therefore dead UI. Parked `provider-limit` is the one reachable non-running
state (`loop-state-status.ts:15-17` keeps it non-terminal while `endedAt == null`) and was verified
live and correct.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-594`.

<a id="lt-595"></a>

## LT-595 — the composer picker keeps the old model after a closed-session continuation — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-595).

Found running check 2 of `2026-09-05-history-preview-model-selection_livetest.md`. The pick itself
works: the restored session really does run the chosen model and the prompt really does wait for
the confirmation. What is wrong is the label afterwards — the composer's model picker keeps naming
the pre-pick model for the life of that view, while the session-header picker and
`instance.currentModel` both name the new one.

A 150 ms sampler across the preview-to-live handoff caught the window. At t=1069 ms
`ComposerToolbarComponent.instanceId` flips from `history-preview:<entryId>` to the real instance id
while `currentModel` is still the pre-change value, so the instance-changed branch of the seeding
effect (`composer-toolbar.component.ts:244-283`) seeds `pendingSelection` with the stale model. At
t=1220 ms the store catches up, but `shouldHydrateComposerPickerSelection`
(`composer-toolbar.component.ts:590-609`) will not hydrate over a concrete same-provider pick, so
the label never corrects — the effect does this reconciliation for reasoning effort
(`composer-toolbar.component.ts:280-282`) but not for the model. The window exists because
`HistoryPreviewSessionService.applySelection`
(`history-preview-session.service.ts:149-188`) validates the confirmed `changeModel` response and
then discards it instead of writing the confirmed runtime into `InstanceStore`, so the renderer
only learns the new model when main's own instance update arrives.

Reproduced twice live in the dev app on 2026-09-21 (codex `gpt-5.6-sol` → `gpt-5.6-luna`; claude
`claude-sonnet-5` → `claude-haiku-4-5-20251001`), with a screenshot showing the two pickers
disagreeing in the same frame.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-595`.

<a id="lt-596"></a>

## LT-596 — a Codex native sub-agent's token spend is charged to nobody — FIXED IN CODE; live check pending (reported 2026-09-21)

**Status update 2026-09-23:** Implementation and follow-up review remain active. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-596).

Found running check 3 of `2026-09-05-token-efficiency-remediation_livetest.md` in an isolated dev
app. Instance `x9wpqpqb7` (Codex CLI 0.155.1, `gpt-5.6-sol`) delegated one sub-agent whose whole
task was to answer `BANANA`. Codex gave the child its own thread and its own rollout,
`rollout-2026-09-21T03-20-51-01a0c1c4-2268-…jsonl`, with `parent_thread_id` pointing at the root
and a single usage record of 21,830 tokens.

AIO's ledger for that instance holds seven entries summing to 549,332 tokens — exactly the root
thread's own provider cumulative. The child's 21,830 tokens are charged to no instance at all, and
`costGetSummary()` reported `hasEstimatedEntries: false` across the whole profile, so the
"combined as estimates" behaviour the livetest asks about never happens either.

The path closes at `CodexUsageAccounting.ownsThread()`. A thread is registered only from
`thread/started` (`codex-app-server-notification-adapter.ts:79`), which never appears in `app.log`
for the child id; with the child unowned, `belongsToTurn`
(`codex-app-server-turn-adapter.ts:228-231`) treats its `turn/completed` as foreign, and the
fallback handler (`codex-app-server-adapter.ts:261`) only processes usage while no root turn is
active — which is never true for a sub-agent.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-596`.

<a id="lt-597"></a>

## LT-597 — an interrupted Codex turn costs zero in the ledger while the quota window moves — FIXED IN CODE; live check pending (reported 2026-09-21)

**Status update 2026-09-23:** Implementation and follow-up review remain active. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-597).

Found running check 3 of `2026-09-05-token-efficiency-remediation_livetest.md`. A turn interrupted
after 128.9 s and 27,535 characters of streamed prose produced no cost entry at all;
`cumulativeTokens` sat unchanged at 270,700 either side of it.

AIO was faithful to its source. Codex 0.155.1 emitted no `token_usage_record` for the aborted turn
and its in-turn `token_count` repeated the previous cumulative byte for byte, so the delta really
was zero. The same event showed `rate_limits.primary.used_percent` going 97 → 98, and the model had
plainly generated output, so the spend was real. Every completed turn in the same session
reconciled exactly (five turns, 325,341 tokens, all four buckets matching the provider sum), which
isolates this to the aborted shape.

It contradicts the 2026-09-05 plan's own "Preserve failed, interrupted, idle and child spend".
Failed and idle spend were not re-tested; interrupted spend is not preserved.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-597`.

<a id="lt-598"></a>

## LT-598 — the context manifest omits the adapter-appended system-prompt blocks — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-598).

Found running check 2 of `2026-09-05-token-efficiency-remediation_livetest.md`. The manifest is
accurate as far as it goes: all five supplied blocks for instance `x1649222z` hash-matched the
delivered native input exactly, in order, at the exact offsets, including a budgeted `repo-map`
excerpt on a second instance where the manifest hash described the delivered 3,172-character
excerpt rather than the 4,549-character source.

It is not complete. The delivered `[SYSTEM INSTRUCTIONS]` region was 28,041 characters against
24,992 manifested — a 3,049-character `[Browser Gateway]` block that no manifest entry covers, and
that sits after the `tool-permissions` block the prompt contract treats as final.
`withBrowserGatewaySystemPrompt` (`adapter-spawn-helpers.ts:338-373`) appends up to four such
blocks from `adapter-factory.ts:684`, after both `recordContextManifest` call sites have already
run.

Pre-existing structure rather than a 2026-09-05 regression, filed because that plan states "The
manifest describes exactly the supplied blocks" and this check measured that it does not.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-598`.

<a id="lt-599"></a>

## LT-599 — the streaming rewind guard protects a field the transcript never reads — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-599).

Found running check 2 of
`2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_livetest.md`. The 2026-09-08 plan added
`nextMonotonicStreamingContent` and wired it into both the main buffer and the renderer store, and
both genuinely keep the committed text in `OutputMessage.content` — a real provider rewind on live
Cursor ACP traffic (343 → 1 characters, instance `ud1nrgbfc`) was caught and held.

The bubble still rewinds, because both merge sites also copy the incoming metadata verbatim and
`DisplayItemProcessorService.convertToItems` renders `metadata.accumulatedContent` in preference to
`content` (`display-item-processor.service.ts:235-243` and `255-262`). Driven through the real
renderer entry point (`InstanceOutputStore.queueOutput`, the only caller being the IPC subscriber at
`instance/instance.store.ts:201`), an 84-character committed sentence rendered as a bare `I'll` in
`div.markdown-content` while the store still held the full sentence.

Five instrumented live Cursor turns showed no visible collapse, because on the one turn that
rewound, main absorbed the drop before the renderer's first paint of that bubble. The collapse
needs the bubble painted before the rewound snapshot flushes, which the 100 ms `TEXT_THROTTLE_MS`
batch boundary decides — so it is intermittent in the field, not absent.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-599`.

<a id="lt-600"></a>

## LT-600 — an in-place ACP interrupt settle never records that the interrupt completed — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-600).

Found running check 1 of
`2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_livetest.md`. The watchdog half of that
plan works and is confirmed live: Stop during a Cursor ACP tool turn settles to `idle` at once, and
across 163 s of silence there was no stuck banner in the buffer or the DOM and zero
`Process may be stuck` / `Stream idle timeout exceeded` lines in `app.log`.

What is missing is the completion record. The ACP client-cancel fix emits `status: 'idle'`, which
routes the settle through `noteInterruptSettled` (`interrupt-respawn-handler.ts:580-597`). That
method disarms the force-abort net but emits no transcript message and no closing boundary, and
`handleInterruptCompletion` then early-returns at `:639-642` because `idle` is not an
interrupt-recovery status. The `Interrupted — waiting for input` message at `:686-697` is
unreachable on this path, so the last persisted record of a cleanly settled Stop stays
`phase: requested, outcome: unresolved`. Deterministic for ACP, reproduced on two instances.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-600`.

<a id="lt-601"></a>

## LT-601 — a user Stop is recorded as a completed turn — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-601).

Found running §9 of
`docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md`.
The Stop control itself works: a Codex app-server turn stopped promptly, the context-pressure
diagnostics recorded the terminal `turn-complete` with `completionStatus: "interrupted"`, and the
transcript showed `Interrupted — waiting for input`. The instance record then reported
`lastTurnOutcome: "completed"`.

`handleInterruptCompletion` sets `'interrupted'` correctly at `interrupt-respawn-handler.ts:646` —
the adapter's `TurnInterruptCompletion` and the diagnostic status both come from the same
`state.finalTurn.status`. The adapter's following `idle` status event then reaches
`markTurnInactiveIfSettled` (`instance-communication.ts:360-374`), which stamps
`lastTurnOutcome = 'completed'` and `recordTurnEnd('completed')` for any still-active turn hitting a
ready-for-input status, with no interrupt check. The overwrite site is provider-agnostic.

Downstream, `default-invokers.ts:1605`'s D6 loop-pause guard tests
`lastTurnOutcome === 'interrupted'`, so it cannot fire on this path. The loop behaviour itself was
not exercised — only the field it reads.

Distinct from LT-600, which concerns the missing interrupt *boundary* record on the ACP in-place
settle path.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-601`.

<a id="lt-602"></a>

## LT-602 — the header chip never shows a session's spawn-time reasoning effort — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-602).

Found while recording the fixed run settings required by §2.2 of
`docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md`.
A session created with `reasoningEffort: 'low'` (and again with `'xhigh'`) renders
`· Thinking: Provider default` in the header chip for its whole life, while `listInstances()` and
`stateResync()` both return the real value.

The `instance:created` payload omits the key entirely: `InstanceLifecycle` emits that event early at
`instance-lifecycle.ts:1392` so the card can render during init, and
`instance.reasoningEffort = resolveSpawnReasoningEffort(...)` is only assigned at
`instance-lifecycle.ts:1585`. `deserializeInstance` therefore stores `undefined`,
`pickerSelection()` yields `reasoning: null`, and the picker falls back to `'Provider default'`.
Each step was read off the running components with `ng.getComponent`. The picker component is not at
fault — its own spec covers the `pending-create` rendering path.

Original remediation direction (at report time): Full observed behaviour, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-602`.

<a id="lt-603"></a>

## LT-603 — the restart's own ready-edge redelivery erases the retained child record before the fresh-fallback reconcile reads it — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-603).

Found performing the live re-check LT-215 was waiting on, for check 3 of
`docs/superpowers/plans/2026-07-17-resilient-threads-sessions_plan_livetest.md`. Supersedes LT-215.

LT-215's 2026-08-31 repair is present in the running build and fires correctly:
`notifyChildTerminated` retains the reaped child in `OrchestrationHandler.suppressedChildCompletions`
whenever the `child_completed` injection is suppressed with `reason: 'respawning'`. It is then undone
on the same restart. The fresh-fallback `adapter.spawn()` inside
`RuntimeReconciler.applyRecoveryRespawn` (`runtime-reconciler.ts:689`) emits a `respawning -> idle`
transition; `SessionAdmissionService.handleStateUpdate` → `tryRefire` refires the suppressed
`child_completed`; `onChildCompletionRedelivered` → `forgetSuppressedChildCompletion` clears the
record — 20-28 ms before `reconcileChildrenAfterRestart` reads it. The reconcile returns
`dropped: []`, `Reconciled orchestration children after restart` never logs, and the degradation
notice carries no lost-child line.

Structural rather than a timing fluke: `buildFallbackHistory` is only reached after
`await hooks.waitReady(adapter)` (`runtime-reconciler.ts:710-716`), so the ready edge always precedes
the reconcile on this path. Four consecutive live reproductions on 2026-09-21 with prototype-level
tracing of both mechanisms in the running main process.

Original remediation direction (at report time): Full observed behaviour, timings, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-603`.

<a id="lt-604"></a>

## LT-604 — a worker server started after launch has no RPC router, so every worker stays "disconnected" — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-604).

Found while building a disposable worker for checks 2 and 5 of
`docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md`, which need a paired worker
whose model endpoint can be stopped at will.

`RpcEventRouter` is constructed in exactly one place — the startup step in
`src/main/app/remote-gateway-initialization-steps.ts:33-41`, which returns early when
`remoteNodesEnabled` was false at launch. Neither `REMOTE_NODE_START_SERVER` nor the pair-both
`ensureRemoteNodeServerRunning()` (which itself flips `remoteNodesEnabled` at runtime) installs it,
and nothing watches the setting. The socket layer still authenticates the worker, so every "is it
connected" surface disagrees with reality: `connectedCount: 1` and `Registration accepted` on the
worker, while the roster shows `disconnected` with fallback capabilities, heartbeats are dropped,
and Local AI Guard sees no worker endpoints at all.

Proven by A/B on 2026-09-21 with one worker binary and config against the same dev profile: launched
with the setting true → `RpcEventRouter "Node registered via RPC"`, roster `connected`, two
discovered worker endpoints; launched with it false and the server started from the renderer → no
router log lines, roster `disconnected`, zero discovered endpoints, enrolled worker target stuck in
`checking`.

Original remediation direction (at report time): Full observed behaviour, root cause, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-604` (added on branch
`queue/2026-07-26-local-ai-guard-plan-58373b`; ids 539–603 were already reserved by other in-flight
queue items when this was filed).

<a id="lt-605"></a>

## LT-605 — the session-restart-recovery startup notice is not rendered anywhere — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-605).

Found running `docs/superpowers/plans/2026-08-30-session-restart-recovery_livetest.md` in full
against an isolated dev app (commit `b8fcbe88`, profile `/tmp/aio-lt-queue-cd0ca9ca`, CDP `:9590`,
focus emulation verified before every DOM assertion).

`SessionRecoveryBannerComponent` is imported by no template. Its selector
`app-session-recovery-banner` occurs exactly once in the tree — the component's own `selector:`
declaration — and the class name appears only in that file and its own `TestBed` spec, with no
`NgComponentOutlet`, `ViewContainerRef.createComponent` or route entry anywhere. The
dashboard does not list it in `imports`, `DashboardComponent.openRecoveryPicker()` has no caller
outside its own spec, and `SessionRecoveryDismissalStore` is injected only by the banner — so
nothing in the running app ever constructs it. The component is
tree-shaken out of both the development and the production renderer bundle — `Autosaved session
available` and `Dismiss autosave recovery notice` appear in neither, while the picker's `Autosave
recovery` group label ships normally.

Live consequence: with one candidate held by `SessionRecoveryStore`, the dashboard shows no notice
at all, and check 5's *Dismiss autosave recovery notice* control cannot be activated by a user.
Recovery is still reachable through the Resume Picker (`resume.openPicker`), which lists the
candidate and recovers it correctly — what is gone is the discovery path the plan exists for.

Its own spec passes because it mounts the component directly in `TestBed` and never asserts that
the shell renders it. `2026-08-30-session-restart-recovery_plan_completed.md` task 5 ticks "Add a
non-modal startup banner when candidates exist" and names the shell edit that was never made.

Original remediation direction (at report time): Full observed behaviour, root cause, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-605` (added on branch
`queue/2026-08-30-session-restart-rec-0ca9ca`; ids 539–604 were already reserved by other in-flight
queue items when this was filed).

<a id="lt-606"></a>

## LT-606 — Resume Picker row actions have no visible focus ring — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-606).

Found in the same run, check 2 step 4.

`.resume-action:focus-visible { outline: 2px solid var(--focus-ring); }`
(`resume-picker-host.component.ts:71`) references a custom property that exists only in
`apps/mobile/src/styles.scss`. In the desktop renderer the `var()` is unresolvable, the declaration
is invalid at computed-value time, `outline` resolves to `unset` → `outline-style: none`, and
because the author rule still wins the cascade it *strips* the global `:focus-visible` ring from
`src/renderer/styles/_base.scss:86`.

Measured in the running app: the focused **Recover** button reports `focusVisible: true` with
`outline: "rgb(243, 239, 229) none 0px"`. A synthetic button focused by a real Tab keypress reports
`outline: "rgb(184, 154, 102) solid 2px"`, and adding the identical broken declaration drops it to
`none`. Affects every row action — all six `ResumePickerAction` members (`Latest`, `Live`, `Resume`,
`Fork`, `Fallback`, `Recover`) render through the same footer template — so it is not
recovery-specific. Only `Live` was not exercised live, because the disposable profile had no live
instances. `session-recovery-banner.component.scss:89` repeats it;
`settings-tiered-row-list.component.scss:15` already uses the correct `var(--focus-ring, #6ea8fe)`
fallback form.

Original remediation direction (at report time): Full observed behaviour, root cause, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-606`.

<a id="lt-610"></a>

## LT-610 — deep-linking to another approval moves the highlight but never the keyboard focus — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-610).

Found running `2026-09-01-browser-approval-coherence_livetest.md` check 2 step 5 against a dev app
built from `queue/2026-09-01-browser-approval-co-ad14db`.

With the Browser page already open and focus on approval card A, clicking the banner for a
different pending approval B moves the URL and the `[style.outline]` highlight to card B but leaves
`document.activeElement` on card A — measured at 1.2 s and 5.2 s, with focus emulation on. A patched
`HTMLElement.prototype.focus` plus a capture-phase `focusin` listener logged **nothing**, so
`BrowserApprovalFocus.apply()` never ran for B. Focus catches up one step later on the next
unrelated click in the component.

`apply()` is driven only from `BrowserPageComponent.ngAfterViewChecked()`
(`browser-page.component.ts:188`), while the focused-request signal is consumed solely inside the
`@for` embedded view (`browser-page.component.html:281-282`). Under zoneless signal-targeted change
detection the embedded view refreshes on its own and the host's view hook does not run. The likely
remedy is an `effect()`/`afterRenderEffect` on the focused-request signal instead of a lifecycle
hook.

The existing test does not catch it because it manufactures the missing call:
`browser-page.approval-routing.spec.ts:136` invokes `ngAfterViewChecked()` by hand before asserting
`expect(focus).toHaveBeenCalledTimes(2)`.

Original remediation direction (at report time): Full observed behaviour, root cause, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-610`.

<a id="lt-611"></a>

## LT-611 — a browser mutation with no `instanceId` can never redeem the approval it just raised — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-611).

Found in the same run, reaching check 1 through the renderer's own `BROWSER_CLICK` IPC channel
(whose payload schema has no `instanceId`).

A credential hard stop raised that way, approved with **Allow once**, and retried with its
`requestId` returns `requires_user` / `no_matching_grant` and mints another approval instead of
executing — a permanent approve → retry → new-approval loop. The agent path (real instance id over
the Browser Gateway RPC socket) redeems correctly, so it is specific to callers that omit
`instanceId`.

Cause: approval and grant creation record `request.instanceId ?? 'unknown'`
(`browser-gateway-action-guard.ts:164,171,245,309,405,553,620`) and the exact-approval redeemer
looks the grant up under the same value, but `prepareMutatingAction` (line 229),
`recheckPreparedGrant` (line 388) and `prepareExistingTabMutatingAction` (line 537) match with
`request.instanceId ?? ''`, which `grantMatches` rejects at
`browser-grant-policy.ts:229`. The replacement approval carried no `selector`, and
`recheckPreparedGrant` is the only creation site that omits one — confirming which branch fired.

No renderer component calls those mutation channels today, so there is no live user-visible loop;
the surface is registered and schema-validated, and the sentinel mismatch will break the first
caller that uses it.

Original remediation direction (at report time): Full observed behaviour, root cause, required behaviour and acceptance in
`docs/plans/livetest-remediation-register.md` under `## LT-611`.

<a id="lt-612"></a>

## LT-612 — every ACP provider records a failed command as a success — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-612).

Found running LT-196 correction-miner livetest check 2 in the Plan Queue worktree
`queue/2026-09-06-lt196-correction-mi-b4d3fd`. `buildAcpToolResultMessage`
(`src/main/cli/adapters/acp-tool-call-material.ts:110-120`) sets `is_error` from the ACP `status`
alone, but Cursor and Grok both report `status: "completed"` for a shell command that ran and
exited non-zero — `completed` means the tool call finished, not that the command succeeded. The
real exit code sits in `update.rawOutput.exitCode` at that same call site and is already read by
`renderAcpRawOutput` to print `(exit code 2)` into the body; it is never used for `is_error`.

Since `findCorrectionPairs` requires `failInv.isError === true`, no ACP session can be mined at
all. Reproduced live with a negative control: the identical failing-then-fixed `/usr/bin/grep`
pair gives `patternsFound: 1` on Claude and `patternsFound: 0` on both Cursor and Grok. Copilot
shares the path but has no account signed in on this device. LT-196's spec acceptance criterion 2
is therefore unmet on the live path, even though every unit test for it passes — the exit code
never reaches `buildAcpToolResultMessage` (its params are `{ toolCallId, title, status,
sessionUpdate, output }`), so the spec can only vary `status`, and no test could have caught it.

Original remediation direction (at report time): The fix is an exit-code term in `buildAcpToolResultMessage` (and the matching one
in `buildAcpToolOutcomeFallback`), with `cancelled` and unsettled calls still carrying no
`is_error` key — that part is correct today and is confirmed live. Full observed behaviour, root
cause, required behaviour and acceptance in `docs/plans/livetest-remediation-register.md` under
`## LT-612`.

<a id="lt-613"></a>

## LT-613 — clicking a History entry closes the sidebar instead of expanding it — FIXED IN CODE; final verification pending (reported 2026-09-21)

**Status update 2026-09-23:** The code remediation passed focused checks, final combined gates, and fresh independent review; any owning rebuilt-app or external live check remains pending. The incident analysis below records the original 2026-09-20/21 finding and its then-current remediation direction. See [the working evidence checkpoint](2026-09-23-outstanding-plans-progress.md) and [register detail](livetest-remediation-register.md#lt-613).

Found incidentally while running LT-196 correction-miner livetest check 3.1. The History sidebar's
`.history-backdrop` div (`history-sidebar.component.ts:31-34`) wraps the `<aside>` and carries an
unconditional `(click)="closeHistory.emit()"`; `history-item.component.ts:28` binds
`(click)="toggleExpand()"` without `stopPropagation`, unlike the same component's restore/delete/
share handlers. One click both expands the entry and unmounts the sidebar rendering it, so the
expanded transcript is unreachable by mouse. Reproduced with a real `Input.dispatchMouseEvent`;
a real `Enter` on the focused header works, because the backdrop binds only `click` and
`keydown.escape`.

Original remediation direction (at report time): One-line fix plus a component test. Detail in
`docs/plans/livetest-remediation-register.md` under `## LT-613`.

## LT-614 — a timed-out ACP approval card stayed on screen and its Cancel did nothing — FIXED 2026-09-22

Reproduced during the OpenCode provider dev-app check (`2026-09-22-opencode-provider_plan_completed.md`, Task 6.2);
shared by every ACP provider. Fixed in commit `46cd2aa0`: `AcpCliAdapter` now reports every request settled without
the user (`input_required_resolved`, once per request) through a new IPC channel so the card, pending count, remote
observer and phone prompt all clear; Cancel on ACP cards sends a keyed `cancel`; stale replies return
`INPUT_REQUIRED_NOT_PENDING`; registry entries close with the real decision (`user` / `cancelled`). Verified by unit
and mutation-checked race tests and in the dev app (timeout, Cancel, Stop). Full observed behaviour, root cause,
required behaviour and acceptance in `docs/plans/livetest-remediation-register.md` under `## LT-614`.

## LT-022 / LT-028 / LT-105 — FIXED 2026-09-23 (outstanding-plans sweep)

- **LT-022:** visibility-aware heartbeat. `renderer-heartbeat.service.ts` sends `visibility` and beats
  on `visibilitychange`; `renderer-heartbeat-monitor.ts` uses `HIDDEN_HEARTBEAT_STALL_THRESHOLD_MS`
  (150 s) for a hidden renderer; `RendererHeartbeatPayloadSchema` gains optional `visibility`.
- **LT-028:** `adapter-factory.ts` refuses a hardened Codex instance before constructing the adapter.
- **LT-105:** `claude-cli-adapter.ts` completes an errored resident turn once (`turnErrored`), with a
  per-turn double-fire guard; `instance-communication.ts` skips the provider-limit clear and reports
  `Stop` as `error` for such a turn; the `result` usage block moved to `claude-result-usage.ts`.

Each fix has regression tests shown to fail with the fix reverted. Rebuilt-app checks are in
[`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md).
