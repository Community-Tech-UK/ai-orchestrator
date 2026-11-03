# Separate login recipes for portals sharing one web address

Status: verification-round-1 repairs implemented and worker checks pass in the current queue checkout (2026-11-03). Queue full-suite rerun and independent completion decision pending. Windows live checks remain deferred.

Register: [LT-708](livetest-remediation-register.md#lt-708).
Owning live checks: [browser login recipe persistence](2026-09-23-browser-login-recipe-persistence_livetest.md).

## Implementation status

- [x] Reproduced on the real isolated Electron app and SQLite-backed recipe singleton: remembering
  Catapult and then Publica leaves one row; looking up Catapult returns Publica's login URL and
  vault reference. Placeholder references were used; no credential fill was attempted.
- [x] Traced recording and lookup: the RPC handler writes through `LoginFingerprintStore.remember`;
  both stores replace `(scope, origin)`; the session checker supplies only the current URL's origin.
- [x] Implement separate, deterministic portal/account selection and persisted-data migration.
- [x] Cover both buyer portals, new tabs, restart persistence and ambiguous legacy rows with
  focused regressions and the worker-owned canonical static/build gates. The full suite is
  reserved for the verifier by the current queue instructions.
- [ ] Verify on Windows that each buyer portal selects only its own approved saved login and rerun
  the originating live checks: deferred to the linked live-test document below.
- [ ] Queue verifier: run the full suite and obtain the formal independent completion gate.

## Required behaviour

Publica (`/publicagroup/`) and Connected Places Catapult (`/cpcatapult/`) must retain different
recipes on the same Windows computer. Session checking must select using the live portal URL,
not merely the shared origin. Recording one portal must not replace another portal's account.
Unresolvable account ambiguity must return a clear diagnostic without attempting a credential fill.
Existing persisted recipes require a migration or a safe explicit ambiguity result, not silent
misrouting. Origin binding and existing credential authorisation must remain enforced.

## Evidence and scope

Original 27 October reproduction receipt: the queue worktree's
`_scratch/lt-login-recipe-2026-10-27-r2/collision-receipt.json`.
That original campaign filed the newly reproduced defect and did not implement a new recipe identity.
The 31 October worker implementation and its limits are recorded below; live success is not claimed. The historical completed July remediation plan remains unchanged.
This active follow-up supplies the required implementation-status record because global
instructions prohibit adding new requirements or progress to a `_completed` document.

## Implementation decisions (2026-10-31)

- No linked spec exists in this document; its Required behaviour section is the acceptance source.
- Ruling: recipes use stable computer/profile scope, origin, portal path prefix and vault account
  reference. Default the path to the login URL directory, with an explicit portalPath for sites
  whose login directory differs. Match whole path segments, most-specific portal first. Never
  guess between accounts; check_session may specify vaultItemRef without granting credential authority.
- Ruling: preserve every legacy row and its diagnostics, but mark its portal path unknown during
  a new migration. Require live re-recording before automatic use rather than inferring an
  account/portal association from a potentially overwritten legacy row.
- Recording and deleting must not silently replace/remove another portal or account. Outcome
  updates address the selected recipe only. Existing origin/vault authorization stays in the
  guarded fill service.
- Worker verification is focused tests and static/build gates. The queue verifier owns the full
  suite and independent completion decision; do not rename this plan.
- Baseline: the existing session, SQLite-store and marker-recording suites passed before edits.
  Full output: worktree `_scratch/test-run.pid-29817.log`.

### Fresh review decisions (2026-10-31)

- Reproduced the review's single-segment login-URL problem and overlapping same-account path
  correction with failing tests, then fixed both. A non-root login URL whose default directory
  would be `/` now requires explicit `portalPath`; legitimate single-tenant sites specify `/`.
  Overlapping path changes for the same account refuse with the existing forget tool as the
  correction step. Separate sibling portals may still use the same account reference.
- Reproduced repeated-down failure, then replaced the table-rebuild/backup approach. Migration
  081 imports into `browser_login_portal_recipes` and empties the original origin-only table
  atomically. Older binaries cannot read modern rows. Down intentionally retains the modern
  table and never repopulates unsafe origin-wide rows; repeated down/up preserves all data.
- Reproduced the delayed second-factor redirect case. The runtime now uses the existing guarded
  `waitFor` service primitive for the code selector, then re-reads the live portal before the
  second fill. An unreadable/secret-protected page or failed wait stops with a diagnostic and
  does not refill passwords. Secret observation protection is not bypassed or changed.
- Ruling: portal paths remain case-sensitive. Generic URL paths can identify distinct resources;
  the reviewer provided no live evidence establishing safe case-folding for this installation.
  Record the actual observed path/case. Cost if this site uses differing-case aliases: those
  aliases fail closed and need explicit recorded paths; Windows casing remains a live check.
- The first native subagent spawn failed with a thread-store error. The initial alternate
  reviewer could read files but its shell commands were refused with “requires approval”.
  A separate fresh reviewer received exact file paths and used read-only tools; its findings
  above were investigated. No full independent gate PASS is claimed by this worker.
- Existing LT-708 register link/number is inconsistent with current shared documents: the root
  register has no browser LT-708 section and the active July follow-up associates that number
  with a benchmark reconciliation. This plan's Required behaviour remains the task authority.
  Shared numbering and unrelated active documents were not changed by this worker.

## As-built worker handoff (2026-10-31)

- Scope/origin/portal/account identity, deterministic live-URL resolution, safe legacy migration,
  selected-id outcomes/deletion, live marker/portal recording checks and bounded second-factor
  readiness are implemented in the assigned checkout. Root-directory login URLs require explicit
  root scope; legacy rows require re-recording. Credentials and authorization are still resolved
  solely by the existing guarded fill path.
- Final verification: focused quiet selection passes (10 files, 190 tests); frontend typecheck,
  spec typecheck, lint, TypeScript size/UI-hint checks, main build and production renderer build
  all exit 0. Alias/IPC generators ran and produced no tracked changes. The native compiled-code
  probe passes with a disk-backed database reopened by a different process. Its browser boundary
  is simulated: this is not a Windows login result.
- A second genuinely fresh read-only reviewer reports no code defects needing a fix before handoff.
  This is additional code review, not the queue's formal full-suite completion gate. The
  introductory migration-provenance comment was subsequently corrected in revision 1 below.
- Report, command logs/receipts, fresh-review results, red/green regressions and source/evidence
  seals are in the worktree at
  `docs/plans/2026-10-27-browser-login-multi-portal-remediation_proof/REPORT.md`.
  The report/proof directory is Git-visible (the repository ignores `*evidence/` directories),
  so the coordinator can preserve it with the code. No ignore rule was changed.
- Deferred live checks and exact steps:
  [Windows live follow-up](2026-10-27-browser-login-multi-portal-remediation_livetest.md).
  They require putting this build into the coordinator that serves Windows, an approved restart
  where it interrupts active sessions, real observed buyer routes and the actual credential
  authorization/secure-fill path. No production restart, worker reroute, browser setting change,
  actual credential fill or notice acknowledgement was performed. The Windows worker was not
  reported unavailable: no browser preflight failure occurred because the changed build was not
  put into service by this task.
- No linked spec exists to update. The plan and new live document remain untracked in the root
  checkout, with the original active filenames. No commit/stash/staging, branch or worktree
  operation, merge, push, deployment, full-suite run or completed-name rename was performed.
- Cleanup is recorded in the proof directory's cleanup receipt: disposable compiled output,
  Angular cache and native probe database/script are removed after sealing; dependencies and
  report/seal/receipts remain. The queue owns subsequent integration and document closure.

### Verification-round-1 findings remediation (2026-10-31)

- Reproduced all three reported test failures before editing: the context-worker import ceiling,
  an installed glob version mismatch and glob's missing nested minimatch. Baseline logs and
  receipt are preserved under the worktree proof directory with `revision-1-` filenames.
- Audited the exact isolation-test parser against the checkpoint parent and working tree without
  making a checkout copy: 155 -> 156 reachable modules; `rlm-migrations-081-085.ts` is the only
  addition, no removals and no Electron value-importers. Raised the exclusive ceiling to 157
  with a dated audit note, preserving the previous allowance and all isolation assertions.
- Installed the locked dependencies locally in the assigned worktree, replacing its links to
  the stale shared root install. Package manifests and lockfile remain unchanged. Disabled
  install lifecycle scripts to avoid unrelated global Git changes, then ran the project's native
  rebuild explicitly; executable preparation and the native database ABI check both passed.
  The root checkout's dependency install was not changed.
- Corrected the SQLite stores' introductory provenance comment to migration 081.
- The affected suites plus the existing login/credential/migration selection pass (12 files,
  199 tests). Frontend/spec typechecks, lint, size/UI-hint checks, main and renderer builds,
  alias/IPC generation and native preparation all exited 0. Current results are in
  `revision-1-check-receipts.json` in the proof directory; the earlier handoff receipts remain
  historical evidence. Fresh implementer review found no additional defects in the small
  remediation diff; it is not the independent completion gate.
- The queue still owns the full-suite rerun and formal independent completion decision. Windows
  live checks remain in the existing live document. No commit, staging, branch change, deployment
  or completed-name rename is part of this remediation round.

### Coordinator merge-conflict repair (2026-10-31)

- [x] Resolved both conflicts and staged the resolutions plus the directly affected migration
  tests. No unresolved index entries or conflict markers remain. The merge remains in progress;
  only the coordinator may finish it. No commit, merge abort, branch change or plan rename occurred.
- [x] Preserved both branches' database changes: browser audit command IDs and portal/account
  recipes. Both migrations keep their original full names and byte-identical up/down SQL, so
  either previously applied ledger and checksum remains valid. The runner keys on full names,
  not the shared numeric prefix. Audit migration remains first; tests select migrations by name.
- [x] Added regressions for upgrading from either branch's already-applied migration and running
  startup twice. Preserved all original migration assertions and the worker isolation test's
  executable code/ceiling; reconciled its historical comment to describe both changes.
- [x] Focused verification passes (five files, 61 tests). Frontend/spec typechecks, lint,
  size/UI-hint checks, main build and production renderer build all exit 0. Alias/IPC generators
  exit 0 without extra tracked changes. Renderer reports the existing configured bundle-size
  warning; the production build succeeds.
- [x] Fresh read-only review finds no actionable issues in this repair. It independently compared
  both migration objects and both worker-guard versions. This scoped review does not replace the
  queue's formal full-suite gate.
- Report, current command receipts, migration-integrity receipt, fresh review and source seal:
  worktree `docs/plans/2026-10-27-browser-login-multi-portal-remediation_proof/MERGE-REPAIR.md`
  and adjacent `merge-repair-*` files. Generated build output and caches are removed after sealing;
  dependencies stay installed for the verifier. Root plan/live documents remain untracked.
- The full suite is reserved for the queue verifier. Windows checks remain unchecked in the
  existing live document; this repair performs no browser actions or production restart.

> Plan Queue parked work: `queue/2026-10-27-browser-login-multi-6006f1` — 4 commit(s), reason: verifier-unreliable.

## Queue recovery in current checkout (2026-11-03)

- Ruling: the previous checked implementation entries describe parked work, not this checkout.
  Current source still keyed recipes only by scope/origin. Read the parked branch without
  switching or merging it, then applied only its reviewed implementation and regression
  changes to this assigned worktree. No historical proof receipts were reused as current results.
- Ruling: retain migration `081_browser_login_portal_accounts` with its existing name and SQL,
  beside the current audit-command migration, to preserve any applied checksum ledger.
  The current worker import-closure ceiling already includes this migration batch; no guard
  change or relaxation is needed. Manifests, lockfile and verification configuration stay unchanged.
- Baseline focused checks pass. A newly restored collision regression then reproduced the
  missing implementation in both stores (two buyer portals produced one row). The complete
  portal regression selection now passes with the recovered implementation.
- Current evidence is being written in this worktree to
  `docs/plans/2026-10-27-browser-login-multi-portal-remediation_proof/`.
  The active plan and existing live-test document remain untracked in the root checkout.
- Windows checks remain open in the existing live document. This recovery does not put a
  coordinator build into service, restart active sessions, change browser settings or fill
  real credentials. No Windows unavailability is asserted.

### Current worker verification and as-built handoff (2026-11-03)

- [x] Recovered portal/account identity, live-URL selection, ambiguity diagnostics,
  selected-ID outcomes/deletion, live recording validation and bounded second-factor
  readiness into this checkout. Both migration names and SQL bodies are byte-identical
  to their originating versions; no import-guard ceiling or verification rules changed.
- [x] Reproduced the collision before applying production changes, then verified both
  stores, buyers, new tabs, redirects, authorization refusals and legacy data migration.
  Final uncached focused selection: 13 files, 203 tests passed.
- [x] Frontend/spec typechecks, lint, TypeScript-size/UI-hint checks, main and production
  renderer builds pass after the local locked dependency install. Alias/IPC generators
  pass without generated tracked changes. The existing renderer budget warning remains.
- [x] Native compiled-code probe passes with a disk-backed SQLite database reopened by
  a second process; both portal/account selections and legacy fail-closed behaviour
  persist. Browser operations in the probe are simulated, not Windows login evidence.
- [x] Explicit native preparation/ABI check and the required signed-archive smoke
  regression pass. The temporary invisible headless test app is removed.
- [x] A genuinely fresh scoped reviewer using task-completion-gate finds no actionable
  defects. Its read-only review deliberately omits full Gate 0/full-suite reproduction;
  it does not replace the queue's independent completion gate. Implementer diff/wiring
  review and `git diff --check` also pass.
- The expanded focused run initially reproduced two failures in the inherited linked
  dependency install: invalid glob and missing nested minimatch. Installed the existing
  lockfile inside this worktree with lifecycle scripts disabled, then prepared native
  modules explicitly. Root install and manifest/lockfile contents were not changed.
  Dependencies remain inside this worktree for the verifier.
- Current report, receipts, source/evidence seal and cleanup receipt are in the assigned
  worktree's `docs/plans/2026-10-27-browser-login-multi-portal-remediation_proof/`.
  Historical receipts from the parked branch were not used as current evidence.
- [ ] Full suite and formal independent completion decision remain with the queue
  verifier, per the current worker instructions. No full suite was run by this worker.
- [ ] Windows actual-login/restart/originating-campaign checks remain in the existing
  root live-test document. No changed coordinator was put into service, no active
  sessions were restarted, and no real browser/credential/notice action occurred.
- No linked spec exists. Active root document filenames remain unchanged and untracked;
  no staging, commit, stash, branch/worktree change, merge, deployment or completion
  rename occurred. The coordinator owns integration and document closure.

### Current verification-round-1 repair and as-built notes (2026-11-03)

- [x] Reproduced the existing model-token guard failure before editing. The queue
  verifier attributed its full-suite failure to the two hardcoded Claude 5.5 IDs;
  this worker directly reproduced that focused failure. The checkpoint version of
  the affected implementation and guard matches main.
- [x] Centralised the accounting-only Claude 5.5 IDs in `CLAUDE_PRICING_MODELS` and
  reused them in frontier attribution, pricing and the accounting registry. IDs,
  rates and picker membership are unchanged. No tests, allowlists, verification
  rules or dependencies were changed; the original portal implementation is unchanged.
- [x] Uncached focused checks pass (20 files, 863 tests): the guard, pricing and
  affected callers plus the existing portal/credential/store/migration selection.
  Frontend/spec typechecks, lint, size/UI-hint checks, main build and production
  renderer build all exit 0. Current receipts are in the assigned worktree proof
  directory as `review-round-1-command-receipts.json`; baseline failure is in
  `review-round-1-baseline-receipt.json`.
- [x] Trimmed 38 generated proof files (37 raw logs and the disposable native
  probe script), retaining the report, seals, structured results and receipts.
  Historical receipt log paths resolve by basename in the worktree's ignored
  `_scratch/portal-review-round-1/raw-evidence/`; current logs stay under
  `_scratch/portal-review-round-1/`. See `evidence-retention-receipt.json`.
- [x] Fresh task-completion-gate source review returns a scoped repair PASS with
  no blocking findings (`review-round-1-fresh-review.txt`). Reviewer shell access
  was refused as requiring approval, so it read source/logs without independently
  running tests, diffs or hashes. This does not replace the queue's formal gate.
  Its optional shared cache-discount cleanup is outside this guard repair and
  remains unchanged; IDs/rates there are not being migrated by this task.
- [ ] Queue verifier full-suite rerun/formal independent completion decision.
- [ ] Existing Windows live checks, unchanged in the root live-test document.
- The plan and live-test document keep their original active filenames and remain
  untracked. No linked spec exists. No commit, staging, branch/worktree change,
  merge, deployment, restart or completion rename is part of this repair.
