# Saved login access implementation plan

Status: implementation complete and ready for independent plan-queue verification (2026-10-06). Every agent-runnable item is done and rerun on the base-branch code; the remaining checks need the installed app, James's actual decision and windows-pc, and are deferred to the [live-test document](2026-10-05-saved-login-access_livetest.md). No pushes, installation or running-session restarts.

Latest operator direction: James explicitly chose **keep other sessions running; continue checks only**. Do not install or relaunch the real app under this direction, and do not ask the same relaunch question again unless James changes it. The code and signed package stay ready for a future safe activation.

Current acceptance status: implementation and all canonical checks passed; the third genuinely fresh independent code review returned `VERDICT: PASS` with no unresolved actionable findings. The signed local replacement is staged and verified, but not installed. Packaged startup cannot be certified in this execution environment: both the replacement and an isolated temporary-profile launch of the already-installed build encounter macOS sandbox initialization refusal. Actual operator approval, session wake, secure Windows fill and a new authenticated page remain unverified and are recorded as deferred live checks in the live-test document, not claimed here.

**Goal:** Request and approve saved-login access visibly, then resume secure sign-in.
**Architecture:** Join a dedicated credential request workflow to existing durable browser approvals. Keep the existing vault and authorisation services as the authority; browser grants alone never enrol or authorise a login.
**Spec:** [Saved login access](2026-10-05-saved-login-access_spec_completed.md).
**Execution:** Parent implements request workflow/contracts/tool dispatch; parallel agents own provider transport, security scope/vault, and renderer/approval integration. A separate fresh agent reviews the completed working-tree diff. User instructions override skill requirements to commit or create worktrees, and routine design approval gates.

## Review focus

- An operator's decision must not authorise a different tab origin, computer, vault item or resumed logical conversation.
- Expiry, revocation or explicit vault lock while asynchronous work is pending must prevent secret writes.
- Concurrent approve/deny/cancel and repeated requests must not duplicate prompts, folder moves or grants.
- A failed enrolment must remain visible and never wake a session claiming success.
- Packaging must preserve active unrelated sessions; a staged build is not proof of live activation.

## Task 1: Reproduce and preserve the baseline

- [x] Read AGENTS.md, architecture and Angular conventions; inspect dirty files before edits.
- [x] Preflight windows-pc through Browser Gateway and inspect saved-login metadata without secrets.
- [x] Reproduce missing CLI bridge and Codex core filtering with non-secret placeholders; trace manual handoff/YOLO read grant behaviour through focused existing tests.
- Live refusal baseline for the actual target: deferred to section 2 of the [live-test document](2026-10-05-saved-login-access_livetest.md) (needs a live login target on windows-pc).

## Task 2: Provider shell transport (cli_investigation owns)

Files: Codex isolated-home helper/adapter and focused tests; credential CLI/contracts/RPC dispatcher and authenticated server context seam.

- [x] Preserve only this session's complete injected Harness bridge through Codex's private shell policy, retaining user inheritance/filtering. Never put capability values in arguments or global configuration.
- [x] Add request/status/cancel CLI commands using the exact singleton below and trusted RPC instance context.
- [x] Verify fresh launch, resume/recovery/home routes, incomplete env, native command execution and unrelated env exclusion.

## Task 3: Vault and scoped authorisation (credential_scope owns)

Files: credential vault/runner, authorisation service, SQLite unattended stores and migration 071 registration/tests.

Interfaces:
```ts
inspectExistingCredential({ item, origin }) // id, title, jailed-folder name, movement requirement, existing binding only
enrolExistingCredential({ item, origin, moveIntoFolder, expectedVaultItemRef })
// CredentialAuthorization and AuthorizationCheck gain optional taskScope, vaultItemRef and computerId.
```

- [x] Preview the exact existing item without exposing any username/password; reject ambiguous names and conflicting origin bindings.
- [x] Persist task and item restrictions; old permissions retain their existing scope. New permissions bind exact origin, computer/profile, item and login/totp purposes.
- [x] Pass secret-bearing Bitwarden item bodies through stdin, never command arguments; refuse results after an explicit vault lock.
- [x] Migration adds scoped-authorisation columns and nullable browser_approval_requests.credential_access_json.
- [x] Verify folder movement only after deliberate approval, locked vault, origin mismatch, scope/item mismatch, expiry/revocation and persistence round trips.

## Task 4: Durable request workflow (parent owns)

Files: new browser-credential-access-service/runtime/session helpers and tests; browser-approval-store; browser contracts/schema; browser-mcp-tools and unattended RPC; secure-fill operation and focused tests.

Interfaces:
```ts
request({ profileId, targetId, item, reason, purposes? }, trustedContext)
status(requestId, trustedContext)
cancel(requestId, trustedContext)
approve(approval, { permission: 'task' | 'remember', rememberForMs? })
deny(approval)
```

- [x] Validate strict model input, trust live target for origin/computer, resolve requesting logical task from Harness state and inspect vault metadata.
- [x] Reuse matching valid permission only after checking item binding/folder, otherwise create one deduplicated pending request with a real reference. Default task access is logical-conversation bound with an eight-hour maximum; remember is explicit and at most seven days.
- [x] Protect async decision work; revalidate target/item before enrolment and authorisation. Never change permission records outside existing services.
- [x] Persist decision metadata and truthful statuses, support resumed ownership/cancellation and idempotent retries, and return only non-secret request metadata.
- [x] Pass trusted task/item to fill authorisation checks; recheck after asynchronous secret resolution and immediately before writing.
- [x] Example acceptance assertion: `expect(result).toMatchObject({ decision: 'requires_user', requestId: expect.any(String), data: { status: 'pending' } })`; vault enrol and authorisation creation remain uncalled until explicit approval.

## Task 5: Visible approval and continuation (approval_investigation owns)

Files: global banner/store, per-session approval card, approval operations, manual handoff/YOLO rules, browser IPC decision delivery and focused tests.

- [x] Render session/reason, exact website/computer, saved login title, purpose/lifetime and movement disclosure with Approve/Deny. Default task; separate explicit bounded remember options.
- [x] Delegate credential decisions to the shared workflow, never generic grant creation. Keep manual handoffs pending and truthful. Keep existing mobile credential restriction.
- [x] Check actual operation success before removing requests or reporting authorisation. Use per-request delivery keys and readiness-aware continuation/denial notifications.
- [x] Verify dedicated controls, denied/failed retention, YOLO pending behaviour and decision delivery on idle/busy/reconnecting sessions.

## Task 6: Verify, independently review and update

Live continuation: [Installed approval and sign-in checks](2026-10-05-saved-login-access_livetest.md). The plan remains active; this pointer does not close or defer agent-runnable checks.

- Visible approval → secure fill → authenticated-page proof on windows-pc: deferred to sections 1–3 of the [live-test document](2026-10-05-saved-login-access_livetest.md) (needs the installed update, James's actual decision and windows-pc).
- [x] Verify denial, expiration/revocation, wrong origin/computer, pending navigation, locked vault, folder movement and duplicate requests through focused behavioural/integration tests.
- [x] Run `rtk proxy npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, `rtk npm run build:renderer`, `rtk npm run test:quiet`, retaining full logs and actual exits.
- [x] Fresh context uses task-completion-gate against the available HEAD baseline and full frozen task diff; fix actionable findings and repeat fresh review until PASS. Attribution limits from the unavailable initial raw dirty diff are disclosed in the report.
- [x] Follow the normal signed local build procedure and stage the replacement safely. Record signature/content checks and exact continuation; installation and startup acceptance remain pending rather than stopping unrelated sessions.
- [x] Bring the documents to a closable state: all implementation and agent-runnable checks pass, the code review passed, and the live deferral is documented. The `_completed` renames (and updating the spec's plan link) are the queue coordinator's step after the independent verifier passes.

## Current implementation and evidence

- Request, status and cancel share the dedicated credential service across Browser Gateway and authenticated CLI. New permissions remain pending in YOLO; authenticated legacy CLI enrol/authorize cannot bypass the operator decision.
- New authorisations bind logical conversation, exact saved item, exact origin, stable computer and login/totp purposes. Task access is capped at eight hours; explicit remember is capped at seven days. Browser action grants do not permit arbitrary password typing. Revocation of a workflow grant also withdraws its authorisation.
- Per-request decisions serialize approval, retain safe failure state, reject navigation/worker changes, prevent grant creation after cancellation and persist real terminal states. Duplicate denial retries reuse their reference while the original request window remains valid. Changed retry choices cannot extend a previous accepted deadline.
- Native Codex command probes in `_scratch/saved-login-codex-bridge-evidence.json` show the original core policy lost all four injected bridge keys, while the fixed core, include-only, inline and quoted configs retain exactly those keys and keep the unrelated variable excluded. Initial/native-resume adapter wiring tests also pass.
- Actual real-service/store/authorisation → gateway secure-fill integration covers task/item/computer/site/purpose refusal before vault read, same-conversation resume, and revoke/expiry/disconnect while vault resolution awaits.
- Windows actual Angular renderer preview evidence: `_scratch/saved-login-banner-ui-evidence.md`. Placeholder IPC only; this proves visible controls, task default, explicit remember payload, denial and locked-vault failure retention. It does not prove installed main-process sign-in. Preview tab/server were removed.
- Fresh Windows snapshot now shows the existing BabyLoveGrowth dashboard with Welcome, James and 12steps.life. A safe fill probe used a nonexistent vault reference and nonexistent selector: authorization gate passed but vault binding refused (`origin_binding_missing`); no secret was read or typed. The original missing-origin refusal is no longer reproducible on that now-authorised site. This existing authenticated session is preserved and is not credited as proof of the new approval flow.
- First full suite failed: six request/security cases were running while final guard/runtime source edits landed, plus the intentional migration leaf enlarged the worker import closure. Focused final-tree reruns and a frozen full-suite rerun are required. Worker closure proof: `_scratch/credential-worker-closure-proof.json`, HEAD149 → current150, exactly one SQL-only migration batch, no removed modules or Electron importers.
- Normal update inspection confirms the updater quits Harness to install; there is no supported hot reload of main-process code. Stage the signed local package without publishing or installing while unrelated sessions are active. Live activation/sign-in remain pending.
- Frozen full-suite run exited zero: `_scratch/saved-login-full-tests-final.log`, raw `_scratch/test-run.pid-86225.log`. This run began before the last transaction hardening and new fault test were added, so current-tree independent verification remains required. Both typechecks, lint, LOC and main build subsequently exited zero in `_scratch/saved-login-*-latest.log`; the normal full build also exited zero in `_scratch/saved-login-package-build.log`. Packaging is held until fresh review findings are fixed.
- First fresh independent review found an actionable explicit-vault-lock race after secret resolution during the live-origin await. Parent reproduced it independently in `_scratch/saved-login-lock-race-before.json` (`typedAfterLock:true`), then added a main-only generation guard and proved `_scratch/saved-login-lock-race-after.json` (`typedAfterLock:false`). Regression tests cover lock and lock→unlock; focused vault/fill tests pass in `_scratch/saved-login-lock-race-green.log`. The guard now runs at the true dispatch boundary after extension persistence/journal awaits, and managed-page credential mutations check the actual page origin atomically.
- The review also identified a Browser Gateway RPC session-identity concern: known session names alone do not authenticate task ownership. The repair now validates per-instance HMAC capabilities before Browser Gateway socket dispatch and injects them into private launch/resume MCP configurations. Isolated synthetic-session tests verify missing, wrong, cross-session, stale and removed-owner proof, without borrowing real session credentials. The independent completion verdict is currently FAIL; another fresh review is required after all fixes.

## First completion-gate remediation

- [x] Reproduce and prevent explicit vault lock and lock→unlock after secret resolution. The guard now runs again at actual dispatch after asynchronous persistence/journal checks.
- [x] Enforce the exact approved origin inside the managed-page mutation, with no unguarded fallback or secret readback. Real Gateway/Puppeteer navigation regression tests passed.
- [x] Authenticate Browser Gateway session ownership using an instance-bound capability at the socket boundary; reject missing, cross-session, stale and removed-session proof before tool routing. Authenticate launch/resume MCP configurations without command-line secrets.
- [x] Preserve independent worker extension authentication. Browser RPC is v2; the extension protocol is unchanged. Updated Harness and reconnected provider forwarders are required.
- [x] Rerun all canonical gates on these repaired sources, obtain a new fresh completion review, then stage the signed replacement package. The previous FAIL report is `_scratch/saved-login-gate-report.md`; final passing review is recorded below.

Final-source focused evidence: `_scratch/test-run.pid-47168.log`, `_scratch/test-run.pid-61021.log` (secure dispatch); `_scratch/test-run.pid-68326.log`, `_scratch/test-run.pid-49069.log`, `_scratch/test-run.pid-42305.log` (authenticated transport/provider/worker regressions). These do not replace the final full suite or live sign-in.

## Repaired-tree final verification in progress

All six non-suite canonical checks exited zero on the repaired production sources: `_scratch/saved-login-final-typecheck.log`, `_scratch/saved-login-final-spec-typecheck.log`, `_scratch/saved-login-final-lint.log`, the direct LOC gate, `_scratch/saved-login-final-main-build.log` and `_scratch/saved-login-final-renderer-build.log`.

The cold full suite exited 1 with exactly four failures in `browser-mcp-stable-tools.spec.ts`; its old fixture omitted the newly mandatory session capability, so calls correctly stopped at authentication instead of reaching the assertions. The fixture now supplies only its own synthetic server-issued capability (or an obvious invalid placeholder in the unknown-owner case). Existing permission and validation assertions are unchanged. The focused fixture rerun exited zero in `_scratch/saved-login-stable-wrapper-fixture.log`. Cold run evidence: `_scratch/saved-login-repaired-full-tests.log`, raw `_scratch/test-run.pid-49837.log`. A new normal full-suite run is active in `_scratch/saved-login-repaired-full-tests-final.log`. No current full-suite PASS is claimed until that run exits.

The canonical live continuation also has a disposable human review artifact at `.aio-review/2026-10-05-saved-login-access-continuation.html`. Reviewing that document does not authorise a credential; only the actual installed saved-login approval workflow can do so.

The repaired-source normal full suite exited zero: `_scratch/saved-login-repaired-full-tests-final.log`, raw `_scratch/test-run.pid-43654.log`. The final test-fixture spec typecheck and full lint also exited zero: `_scratch/saved-login-final-spec-typecheck-fixture.log` and `_scratch/saved-login-final-lint-fixture.log`. A new genuinely fresh independent verifier has started; its verdict is not yet available. Signed packaging is being prepared separately from installation.

Normal full package build initially failed safely because the default Homebrew Node 26 binary lacks the SEA fuse. Repeating the same build with the installed `.nvmrc`-pinned Node v24.15.0 exited zero: `_scratch/saved-login-final-package-build-pinned.log`. No version or configuration file was changed. The separate Electron native rebuild also exited zero: `_scratch/saved-login-final-package-native.log`. The new command-line forwarders are now rebuilt; signed packaging is active and is not installation.

## Second completion-gate remediation

The new independent review found a reproduced high-severity delayed extension-queue gap. `beforeDispatch` ran before enqueue, but no guard was retained for later poll delivery. A real ExistingTabOperations + ExtensionCommandStore + CredentialVault + AuthorizationService probe showed all four lock, lock→unlock, revoke and expiry cases still delivered an obvious placeholder after the guard would reject. Parent independently reproduced all four on the compiled task tree: `_scratch/saved-login-queued-guard-before.json`; no real secrets or workers were used.

- [x] Retain a main-only validity callback through pending command delivery/requeue and fail closed before poll/socket handoff after lock, revocation or expiry. Never serialize that callback or expose secret payloads.
- [x] Reproduce fixed behaviour with the same compiled real-store probe and meaningful queue integration tests.
- [x] Rerun canonical verification, get another genuinely fresh independent code gate PASS, rebuild and re-sign the staged update. The earlier package remains superseded; only the replacement below contains the reviewed queue repair. Installed startup/live acceptance is still pending.

The signed local package command exited zero in `_scratch/saved-login-final-package-sign.log`, but that package predates the confirmed queued-delivery repair. It is held for replacement, not installed or approved as the final update. The canonical verification checklist is reopened for the queue fix.

Queued-delivery repair evidence: `_scratch/saved-login-queued-guard-before-safe.json` versus `_scratch/saved-login-queued-guard-after.json`. The same compiled-production probe now catches its operation rejection immediately (rather than after a poll await); all four prior deliveries are now blocked, guard reruns on delivery, and no false operation success is reported. It uses obvious placeholders only. Meaningful queue regressions include changed computer/runtime, requeue/redelivery, final local/remote socket handoffs, disconnect cleanup, ordinary-command progress, safe exception codes and timer/health cleanup. Main types, full lint, LOC, main build and renderer build passed current code. Spec program initially found three incomplete test fixtures; their typed return/attachment/validator fakes were corrected without changing production or permission assertions. Final spec/lint/full suite reruns are active.

Current queued-repair canonical verification all exited zero: `_scratch/saved-login-queued-final-types.log`, `spec-types-fixed.log`, `lint-fixed.log`, `loc.log`, `main-build.log`, `renderer-build.log` and `full-tests.log` (each shares the `saved-login-queued-final-` prefix). Full raw log: `_scratch/test-run.pid-33781.log`. Another genuinely fresh completion verifier has now started against the frozen queued-repair source. No PASS verdict is claimed yet. The final package rebuild is active; installation and actual Windows human sign-in remain pending.

The full normal build under pinned Node24 exited zero on the frozen queued repair: `_scratch/saved-login-queued-package-build.log`, including updated worker, loop and aio-mcp standalone executables. Replacement signed packaging is active in `_scratch/saved-login-access-package-final/`; this is distinct from the held pre-queue package. Fresh code review and installed-app/live validation remain pending.

## Final code gate and staged replacement

The genuinely fresh verifier returned **VERDICT: PASS — code gate only**, with no unresolved actionable task findings: `_scratch/saved-login-gate-queued-report.md`. Its lockfile-exact disposable installation, native setup, all canonical gates, cold full suite, compiled eighteen-case queue invalidation matrix, rejection cleanup probe and two rendered Angular accessibility checks independently passed. The reviewed source fingerprints still match the shared checkout. The unchanged lockfile's existing dependency advisories and baseline attribution limits are disclosed separately; neither is represented as new task work. No production edits followed the passing frozen review.

Normal local signed packaging exited zero in `_scratch/saved-login-queued-package-sign.log`. Replacement: `_scratch/saved-login-access-package-final/Harness-0.1.0-mac-arm64.dmg`. Deep strict code-signature verification and matching app/helper signing identity both exited zero (`...package-signature-verify.log`, `...package-helper-verify.log`). All fifty-one mapped reviewed production modules (main, contracts and preload) match their current compiled files in the package (`_scratch/saved-login-queued-package-all-reviewed-modules.json`), and the bundled CLI's actual help command succeeds and includes the pending-human-approval request route: `_scratch/saved-login-queued-package-assets.json`. This is a local signed build, not a published/notarized release or an installed update.

Packaged startup **did not pass**. The ordinary smoke runner used only a fresh temporary profile and left the machine's Chrome native-host manifest unchanged. A symlink-path launch failed; a physical-path repeat also exited before readiness. Direct launch with the app's existing heap flag captured repeated `sandbox initialization failed: Operation not permitted` from Chromium helpers, followed by a GPU-process fatal trap. A separately isolated smoke launch of the already-installed `/Applications/Harness.app` returned the same failure. This separates the observed refusal from the new task code but does not prove its underlying OS cause or certify normal installed startup. Evidence: `_scratch/saved-login-queued-package-smoke-final.log`, `...smoke-physical.log`, `...direct-evidence.json`, `...direct-stderr.log`, and `_scratch/saved-login-installed-private-comparison-evidence.json`. No sandbox was disabled or security permission bypassed. Only the explicitly launched temporary-profile processes were tracked; no existing instance was quit.

The final Browser Gateway preflight reports windows-pc fresh and commands deliverable. The currently running app still exposes the old tool inventory; exact discovery does not find the new credential-request tool. Safe normal installation/relaunch and supported resumption/reconnection are therefore required before the actual request. Exact continuation and pending checks are in the linked live-test document. No actual saved-login request was approved through this new running workflow, and the pre-existing signed-in dashboard is not counted as evidence.

## Continuation evidence — 2026-10-05

James requested continuation. All reviewed source fingerprints remain unchanged, the staged DMG still exists, and repeated deep strict code-signature verification exited zero (`_scratch/saved-login-continue-signature.log`). No code edits or redundant full-suite reruns were needed.

A new Windows preflight reports fresh, deliverable windows-pc transport. Exact tool discovery and reported Browser RPC version still show the old running app; the new saved-login request route is not available there yet.

The alternate normal macOS launcher was exercised with a new disposable smoke profile, explicit smoke environment, the existing heap flag, background/hidden/new-instance options, and no installation or existing-app quit. `/usr/bin/open` returned zero, but neither the private main-process marker nor readiness marker appeared within the startup deadline. This is an accepted launch request followed by unverified startup, not proof that the app started or a confirmed diagnosis of why it did not. The native-host manifest hash remained unchanged. A subsequent exact staged executable/helper-code inspection returned zero with no remaining staged processes. Evidence: `_scratch/saved-login-launchservices-smoke-evidence.json` and `_scratch/saved-login-launchservices-smoke.log`. No sandbox was disabled and no permission record was changed.

The operator question explicitly distinguishes keeping existing sessions running from choosing a safe update/relaunch point. It remains unanswered; neither silence nor the generic continuation request is taken as permission to interrupt unrelated sessions. Installation, new-tool reconnection, actual credential request/decision and Windows sign-in evidence remain pending in the linked live-test document.

## Checks-only direction and diagnostic evidence — 2026-10-05

James answered the relaunch question with **keep other sessions running; continue checks only**. This supersedes the unanswered state above. No further installation or existing-app launch/quit was attempted.

The exact-path macOS unified-log query returned actual exit 64 with `log: Cannot run while sandboxed`. This directly establishes a command-environment restriction; it does not establish the underlying cause of the failed app launch. No missing log results are treated as proof that no OS fault exists, and no sandbox or security permission was bypassed. Content-free diagnostic metadata: `_scratch/saved-login-launchservices-os-metadata.json`.

The four existing startup-monitor, detached-process integration, bootstrap and main-entry test files were fully read and rerun to test the monitor itself. They exited zero in `_scratch/saved-login-checks-only-startup-monitor.log`, raw `_scratch/test-run.pid-77310.log`: nineteen checks, including a real synthetic detached process becoming ready and exiting, dying before readiness, and cleanup of an owned synthetic process that ignores SIGTERM. These tests prove the monitor distinguishes readiness from a mere launcher exit; they do not certify the actual packaged GUI startup. No tests or production code were edited. The reviewed task-source fingerprints remain unchanged.

Remaining acceptance is unchanged: actual packaged startup, future safe installation/resume, and the actual operator saved-login approval/denial and Windows secure sign-in. Plans remain active and untracked. Current sessions continue running; no real vault item, permission record or authenticated page was changed during these checks.

## As-built — plan queue verification (2026-10-06)

- The implementation now lives on the base branch: it landed inside commit `4ca6ef366` ("provider hardening"). The queue worktree `queue/2026-10-05-saved-login-access-2852ab` was clean, with no task code left to write. All 98 source and test files covered by the passing independent review (`_scratch/saved-login-queued-independent-scope.json`) match their recorded SHA-256 fingerprints byte for byte in that worktree. So the reviewed code, the staged signed package and the base branch are the same code.
- Rerun in the queue worktree, every check exited zero: the 44 reviewed test files (628 tests), `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, and `generate:ipc`, `generate:aliases`, `generate:architecture` plus `check:contracts` with no generated-file drift. Logs are copied to the root checkout as `_scratch/saved-login-queue-{focused,focused-raw,tsc,spec,lint,loc,gen}.log`. The full suite and builds were left to the verifier, as the queue rules require; earlier full-suite and build passes on the same fingerprints are recorded above.
- Deferred live checks: Task 1's live refusal baseline and Task 6's approval → secure fill → authenticated-page proof are in the [live-test document](2026-10-05-saved-login-access_livetest.md), sections 1–3. Each needs the installed update, a resumed requesting session, James's actual banner decision and windows-pc. James's current direction ("keep other sessions running; continue checks only") rules out installation now. None of them is claimed as verified.
- No vault item, permission record, installed app or running session was touched during this pass.
