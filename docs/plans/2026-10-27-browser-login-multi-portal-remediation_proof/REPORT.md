# Browser login multi-portal remediation: current queue handoff

Date: 2026-11-03. Status: worker implementation ready for independent verification;
full-suite completion and Windows live validation remain open. This report describes
the current checkout, not the earlier parked branch.

## Scope and recovery

The root plan is
`/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-browser-login-multi-portal-remediation_plan.md`.
It has no linked spec; its Required behaviour section is the acceptance source.
The plan and live-test document remain at their original root-checkout paths, untracked.
All implementation and proof files are in the assigned `queue/2026-10-27-browser-login-multi-e62e93` worktree.

The current base lacked the parked implementation despite the plan's historical checked
entries. Reviewed the current files and the parked branch, reproduced the origin-only
collision, then applied the relevant code/test patch without switching, committing or
merging branches. Historical proof files were not copied as current evidence.

## Acceptance and executing paths

| Requirement | Implementation | Current evidence |
| --- | --- | --- |
| Preserve both buyer recipes | `browser-login-recipe-store.ts:124` writes by stable computer/profile, origin, portal path and account; SQLite uses an ID and unique identity tuple (`browser-unattended-sqlite-stores.ts:530`). | Both stores failed the collision regression before the fix and now retain both rows; `browser-login-multi-portal.spec.ts:63`. |
| Select deterministically from the live portal | `browser-session-relogin.ts:278` resolves the live snapshot URL; `browser-login-recipe-store.ts:170` matches whole segments and the most specific portal before filtering account. | Both buyers on a new tab, sibling path/origin/computer isolation, nested portals and explicit account selection. |
| Refuse unresolved account ambiguity | `browser-login-recipe-store.ts:184` returns a diagnostic; session evaluation returns unknown before navigation or fill. | `browser-login-multi-portal.spec.ts:96` checks zero navigation/fills and unchanged account rows; markers-only refresh and ambiguous deletion are also covered. |
| Migrate persisted recipes safely | `rlm-migrations-081-085.ts:18` preserves legacy rows and diagnostics with unknown portal scope in a separate modern table, atomically empties the origin-only table, and never copies modern rows back on down. | Real startup runner, both pre-applied migration ledgers, repeated startup/down/up, preserved data/diagnostics, and legacy unknown with zero fill (`browser-login-portal-migration.spec.ts:33`, `rlm-migrations-081-085.spec.ts:53`). |
| Persist across process restart | SQLite store has no service cache; singleton constructs the real store. | Native compiled-code probe opens a disk-backed database in two different Electron Node-mode processes, verifies legacy ambiguity and both buyers from a new tab after reopening. Browser methods in the probe are simulated. |
| Keep redirects and second factor within the selected portal | `browser-session-relogin.ts:484` rechecks the live portal before fills; post-login settling remains tied to the selected ID. A bounded guarded wait precedes second-factor readiness. | Same-origin buyer redirects before/after submit, delayed code-page redirect, unreadable code pages and wait timeout (`browser-login-multi-portal.spec.ts:139`). |
| Preserve origin binding and credential authorization | RPC handler composes the existing guarded `service.fillCredential` into session checking (`browser-unattended-rpc-operations.ts:218`); `browser-gateway-service.ts:1981` delegates to `fillCredentialOperation`, which checks live origin, vault reference, authorization and secure extension (`browser-form-fill-operations.ts:276`). No bypass added. | Existing credential-vault and gateway credential suites plus explicit recipe-selection refusal regression (`browser-login-multi-portal.spec.ts:230`). No real credentials used. |
| Verify Windows buyer logins and originating campaign | Not claimed. Requires putting the changed coordinator into service and the actual Windows secure-fill/approval path. | Deferred in the existing root `2026-10-27-browser-login-multi-portal-remediation_livetest.md`; all its checkboxes remain open. |
| Full independent completion gate | Queue verifier owns full-suite execution and completion decision. | Fresh scoped review found no actionable defects; it deliberately did not run Gate 0/full suite and does not replace the queue gate. |

The main path is MCP session schema -> Gateway RPC routing -> unattended handler ->
persisted singleton/SQLite store -> live session resolver -> existing guarded service
primitives. Recording checks live markers and live portal, deletion is scoped to a
selected recipe, and outcomes update only that selected recipe ID.

## Decisions and compatibility

- Reuse the reviewed parked implementation, not its completion claims; reproduce and
  verify against current source and dependencies.
- Keep both already-used migration full names and their exact SQL/checksums. The
  existing audit-command migration remains first. The runner keys by full name.
- The current import-closure guard already includes this migration batch; no ceiling
  increase or other test/configuration relaxation was needed.
- Preserve external wire compatibility for omission of recipeId only when scope/origin
  uniquely identify one row; ambiguous omission refuses. Internal callers use the new
  interfaces directly.
- Portal paths remain case-sensitive; single-segment non-root login URLs require
  explicit portalPath, including explicit `/` for a single-tenant origin. Migrated
  origin-only recipes must be re-recorded from the live portal before automatic use.
- The linked root install had an invalid glob version and a missing nested minimatch.
  Installed the existing lockfile locally with lifecycle scripts disabled, then ran
  native preparation explicitly. This avoids unrelated global Git-hook writes;
  package.json and package-lock.json hashes are unchanged. The root install was not edited.

## Verification evidence

`command-receipts.json` records baseline, red/green and initial checks;
`post-install-command-receipts.json` records the final local-install static/build commands.
`focused-final-receipt.json` records the uncached focused selection
(including dependency compatibility, portal/session/store/recording, both migration
areas, worker isolation, MCP surface, gateway credentials and vault binding).
`install-receipt.json` records install ownership and unchanged manifest hashes.
`native-runtime-receipt.json` records the final two-process persistence check.
`native-archive-smoke-receipt.json` records the required native rebuild smoke check:
original and atomically replaced archives load consistently, tampered bytes are
rejected, invisible windows stay invisible, and real native SQLite works.

The renderer build retains the existing initial-bundle budget warning; its actual
exit status is zero. No full test suite was run by the worker, as instructed.

Final local-install result: 13 focused files / 203 tests pass uncached; native
preparation and ABI check, alias/IPC generators, frontend/spec typechecks, lint,
TypeScript-size/UI-hint checks, main build and production renderer build all exit 0.
Migration-integrity comparison confirms both up/down SQL bodies are byte-identical
to their originating versions (`migration-integrity-receipt.json`).

`fresh-review.txt` is the independent scoped task-completion-gate review. It reports
no actionable defects, no test tampering or configuration/dependency drift. Its
scoped PASS is not the full completion gate. The implementer also reviewed the
current diff and runtime wiring and ran `git diff --check`.

## Limits and handoff

### Verification-round-1 repair (2026-11-03)

- Reproduced the existing model-token guard failure before editing: both concrete
  Claude 5.5 IDs in `frontier-cost-attribution.ts` are rejected. The affected code
  and guard at the worker checkpoint are byte-identical to main. The queue's full
  suite failure is reported by its independent verifier; this worker reproduced
  the guard failure directly (`review-round-1-baseline-receipt.json`).
- Added `CLAUDE_PRICING_MODELS` in `provider.types.ts` and used it for frontier
  attribution, the accounting-only model registry and pricing keys. IDs, rates and
  model-picker membership are unchanged. No test, guard allowlist, verification
  configuration, dependency manifest or lockfile was changed. The original 13
  implementation/test files still match their sealed hashes.
- The uncached focused selection now passes: 20 files, 863 tests, including the
  previously failing guard, pricing, recorder, title generation and HyDE callers,
  plus the previous portal, credentials and migration selection. Current commands,
  exit codes and raw-log hashes are in `review-round-1-command-receipts.json`.
- Frontend/spec typechecks, lint, TypeScript-size/UI-hint checks, main build and
  production renderer build all exit 0 after this repair. The renderer retains
  its existing bundle-budget warning. These worker results do not substitute
  for the queue verifier's full-suite rerun.
- A genuinely fresh reviewer using task-completion-gate returns a scoped PASS
  for this repair with no blocking findings (`review-round-1-fresh-review.txt`).
  Its shell commands were refused as requiring approval; it could read source
  and logs but could not independently execute tests, diffs or hashes. This is
  a source review, not a full independent gate. Its optional suggestion to also
  replace existing shared cache-discount literals is outside the guard failure;
  those unchanged mappings are left for a separate change. The constants here
  cover frontier attribution, the accounting registry and base pricing keys.
- Removed 37 raw logs and the disposable native probe script from the tracked
  proof area (38 files, 1,066 lines). Reports, seals, structured results and all
  receipts remain. Historical receipt `log`/`fullLog` fields resolve by basename
  under `_scratch/portal-review-round-1/raw-evidence/`; raw repair logs stay under
  `_scratch/portal-review-round-1/`. `evidence-retention-receipt.json` records the
  removal. Seals are refreshed after the final report and cleanup receipt.
- Full-suite rerun and the formal independent completion decision remain with the
  queue verifier, as the active plan requires. Windows live checks remain deferred
  in the existing root live-test document. No commit, staging, branch operation,
  deployment or completion rename is part of this repair.

### Existing live limits

No coordinator deployment/restart, Windows browser operation, real login, secret
lookup/fill, notice acknowledgement, declaration, message or tender action was
performed. Windows availability was not tested or reported failed. Isolated native
persistence and simulated browser operations are not live Windows evidence.

The originating campaign also requires a same-coordinator restart/new-tab check and
access to notice-blocked correspondence content. Existing instructions do not
authorize interrupting active sessions or acknowledging that notice. The live
follow-up records prerequisites, exact actions and expected results.

No commit, stash, staging, branch/worktree lifecycle operation or completed-name
rename was performed. Leave dependency installs inside the worktree for the verifier.
After writing this report, command receipts and the source/evidence seal, remove
the created compiled output, Angular/Vite caches and native probe runtime/database;
retain only the proof and required dependencies. `cleanup-receipt.json` and
`final-seal.json` record actual final state.
