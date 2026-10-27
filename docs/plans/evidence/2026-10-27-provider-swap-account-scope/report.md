# Provider-swap account-scope live evidence, 2026-10-27

All three open checks were exercised. Checks 2 and 3 pass in the isolated rebuilt app. Check 1 passes for the executing main-process path, including a real named MiMo account, a different Codex account, transcript preservation and a real contextual reply; the installed app's composer/account presentation remains unobserved. This report does not close that visual requirement or rename the owning document.

## Runtime and scope

Worktree branch: `queue/2026-10-14-provider-swap-accou-60c2ee`, base `7c8922a37c5b26d7fe6fa0eefaf00c6f3f241b87`. Rebuilt main, renderer and aio-mcp distribution. Automated test bootstrap loaded the rebuilt main entry and real preload into a hidden offscreen Electron test window serving the built renderer locally. The test window replaces WindowManager's window creation only; application IPC handlers, routing, adapters, continuity and provider processes execute normally. This proves backend behavior, not normal-window/composer presentation. Profile: `/tmp/aio-lt-queue-c260c2ee`; remote-debugging port: `9832`. Focus emulation ran before evaluation; `document.hidden` was false and visibility was visible. Chromium did not support `Emulation.setPageVisibilityOverride`, which is retained in the runtime receipts.

Dependencies were pre-existing symlinks to the root checkout and were reused. No source checkout or node_modules copy was created. The first launch failed during sandbox initialization; the successful disposable test launches used `--no-sandbox`. The initial stale runner and one premature restore probe failed; receipts retain their actual statuses. `ps` was explicitly denied with EPERM, so cleanup checks use saved owned PIDs and process-existence checks instead of claiming process-tree inspection.

Existing local sign-ins were discovered without printing credentials. After the legacy-only baseline, only account-profile metadata and existing pool policies were mirrored into disposable settings. Existing named accounts were preferred in that isolated profile; the named Codex auth file was referenced by a temporary file symlink rather than copying secret values. No production settings, affected chat, active Harness session, branch or worktree was altered by this worker. Installed app files were read non-interactively; no production app restart or UI automation occurred.

## Results

1. **PARTIAL overall; backend PASS.** `named-mimo-source.json` establishes the executing MiMo source profile `comtechspare-f7a6` with the prior user fact. The disposable replay was interrupted before switching. `named-mimo-to-codex.json` records successful selection of Codex profile `legacy`, source/destination IDs differing, preserved user-message IDs, a provider notice, and no removed-account error. This is the source-profile mismatch behind the reported bug, not merely a legacy-to-legacy switch. Selection of the legacy Codex account is the actual router result; no named Codex selection is claimed. `named-codex-continuation.json` records a real successful reply recalling the prior fact, status idle, Codex model `gpt-6-astra`, and account `legacy`. Composer rendering, displayed account label, and an installed affected-chat observation remain untested because the installed Harness is a hard-denied desktop target. This is the only remaining human observation.
2. **PASS in isolated rebuilt app.** `named-account-persisted.json` records provider Codex, model `gpt-6-astra`, account `legacy`, routing source default, and no retained MiMo account. After stopping and relaunching the app with the same isolated profile, `named-account-restore-after-restart.json` records native resume of the same logical history entry on the same Codex account, with the prior user fact preserved. `named-account-post-restart-continuation.json` records a fresh successful contextual response on that account after restart. No provider/account override was supplied to history restore. The restore returns a new runtime ID, as designed. This is live persistence/recovery evidence, not only an updateState mock assertion.
3. **PASS in isolated rebuilt app.** `seven-mimo-sessions.json` records seven real OpenCode/MiMo sessions reaching idle sequentially while earlier sessions remained alive. The seventh reached idle in 6016 ms; all seven were still idle in the final snapshot, without errors. No provider prompts were needed for these idle sessions. The last recorded preflight load before capacity testing was 20.23 / 28.18 / 25.09 on the shared host, down from the initial 65.74 / 32.31 / 21.22. `capacity-cleanup.json` records termination of all seven and zero automations. The existing configured default of 20 is verified in source/installed output; admitting seven does not establish an unlimited cap.

## Attempt interpretation

MiMo's first legacy-account prompt returned quota exhausted. It still left a real user message to carry across the provider switch. Two models returned by the generic app model-list endpoint (`gpt-5.5` and `gpt-5.3-codex`) were rejected by the ChatGPT account. The installed Codex app-server's model/list response was queried directly; `gpt-6-astra` was present there and in the app's list and completed the real turns. Those rejected attempts are retained and are not counted as passes. No composer-list defect is asserted from the generic endpoint alone.

The first restart probe called recovery-candidate discovery, which correctly returned no unarchived candidates because shutdown had archived the conversation. The corrected path is history restore. An abandoned send probe with no restored runtime was stopped and is not persistence evidence. Later native history restore and successful post-restart input are the accepted check-2 evidence.

`installed-code-prerequisites.json` confirms the installed app archive contains the account reset, rollback restoration, destination continuity fields and OpenCode cap 20. It does not prove the installed running process loaded those bytes. The old document's claim that the running process is definitely pre-change has not been adopted as current evidence.

## Verification

`command-receipts.ndjson` records command arguments, timestamps, logs and actual exit codes. Current successful commands: `npm run build:main`, `npm run build:renderer`, `npm run build:aio-mcp-dist`, `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, and the focused quiet test command covering runtime-reconciler.provider-account-swap, provider-concurrency-limiter and provider-account-routing-service. Focused result: 3 files, 65 tests passed. The file runner's zero exit means a probe ran; per-check assertions in JSON determine behavioral success.

No production code or tests were changed, so no full suite, slow suite or additional unrelated build gates were run. The full suite was also avoided on the shared host after the observed overload; the campaign runbook cautions against running it concurrently with batch workers. No new product defect was reproduced; no remediation-register item is warranted. This evidence remains subject to the queue coordinator's independent verification.

## Source anchors

- `src/main/instance/lifecycle/runtime-reconciler.ts:250`: switch provider and clear source account stamp before destination resolution.
- `src/main/instance/lifecycle/runtime-reconciler.ts:502`: persist destination account stamp with provider/model.
- `src/main/instance/lifecycle/runtime-reconciler.ts:588`: restore source account on failed swap.
- `src/main/cli/provider-concurrency-limiter.ts:50`: OpenCode default cap 20.
- `src/main/ipc/handlers/session-handlers.ts:489`: normal history restore through SessionRevivalService.

The runbook requests backlog updates, but `livetest-backlog.md:24` explicitly says it is historical and forbids current additions. The owning live-test document carries this run's current status; the historical backlog was left alone.

## Cleanup

All disposable sessions were terminated through the dev app, with zero remaining instances and zero automations in `final-instance-cleanup.json`. Each isolated Electron process was stopped. The first three successful launches did not finish shutdown within the runner's 25-second deadline and required a bounded force-stop of their own main PID; the final launch exited normally with code 0 after its last instance was explicitly terminated. Runtime receipts preserve that distinction. Saved provider PID existence checks, listener checks, runtime-file deletion and final Git checks are recorded in `cleanup-receipt.json`. Pre-existing shared dependencies remain in place. No document was renamed, no commit/stash was made and nothing was staged.
