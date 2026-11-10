# Automation standard Opus activation check

Status — 2026-11-10, queue item c94c80 re-run on current main: **3 of 3 live checks passed again** (see the 10 November section; check 2 now needs a real Claude session as caller because of the new authority guard). Earlier status, 2026-10-27, verifier retry: **3 of 3 live checks passed; evidence ready for independent verification.** The rebuilt isolated dev app displayed standard Claude Opus, its registered `create_automation` tool stored `claude` / `opus`, and the production default remains `opus` with zero active `opus[1m]` pins. The disabled verification record was never run and was deleted. The app is stopped and its runtime has been removed; see the new dated evidence below. The coordinator retains ownership of verification and any completion rename.

Prerequisite satisfied on verifier retry: the app was built and launched from the queue worktree, using the required isolated profile and debug port. Main-process readback confirmed its working directory and user-data path. The installed app was not restarted or replaced.

Plan: [automation standard Opus](2026-10-07-automation-standard-opus_plan_completed.md). Source/configuration verification and the independent completion gate passed; this document remains open for rebuilt-app activation.

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md) and [remediation register](livetest-remediation-register.md). The [original July remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is historical and closed. New implementation status belongs in the [active follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md), whose 23 October coordinator note explicitly forbids recreating the old colliding filename. LT-710 is recorded there. Keep per-check evidence here; only the queue coordinator may rename this document after independent verification.

## Checks after rebuilt app launch

1. Open the new-automation form without saving. Expected: Claude standard Opus (`opus`) selected, rather than `opus[1m]`. Close the form.
2. Through `create_automation`, save a disabled verification automation with provider omitted, no recipients/external actions, and prompt `Report the selected model only; perform no external actions.` Use a future schedule and `enabled:false`; never fire it. Read its stored `action.model` through the read-only automation store: expected `opus`, provider `claude`. Delete only this new disabled verification automation using its returned identifier.
3. Re-read the dedicated `automationDefaultModel` setting and active automation selections. Expected default `opus`, zero active `opus[1m]` pins. Historical completed definitions may retain their original model.

Why deferred: compiled code and component/MCP/native-command paths are testable now and have been checked, but the existing running app retains its loaded creation code. No live test requires sending, submitting or executing an automation.

## Evidence run — 2026-10-27

### Environment and launch evidence

- Built from the queue worktree at `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-07-automation-standard-6360f0`. `npm run build:main` exited **0**. A fresh Angular development server compiled this checkout and served port **4575**; no existing renderer server was reused.
- Both launch attempts specified `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-d76360f0` and `--remote-debugging-port=9775`. Node's main-process inspector used port 9875. The second attempt also supplied `--js-flags=--max-old-space-size=8192`, the exact flag required by `src/main/main-process-bootstrap.ts:1`, to keep the real main process under the supervisor instead of depending on `app.relaunch()`.
- The first supervised Electron process exited **0** through the bootstrap relaunch path; this was not app-readiness evidence. The second exposed its debug endpoint at **08:29:53.388 UTC**; the supervisor then recorded exit **-5** (signal 5) and completed process cleanup at **08:29:54.818 UTC**. Its stderr repeatedly reports `sandbox initialization failed: Operation not permitted` / `Failed to initialize sandbox.`, GPU subprocess exit code 6, network-service crashes, and `GPU process isn't usable. Goodbye.` The initial bundle launch also reported `sandbox_extension_issue_file_to_process ... Operation not permitted`. These are observed launch failures, not evidence of an automation-default defect. Sandbox protection was not disabled.
- The subsequent renderer and main-inspector probes both exited **1** with `ECONNREFUSED` for their respective debug ports. No DOM assertion ran. The prepared CDP driver sends `Emulation.setFocusEmulationEnabled` and the visibility override before any renderer evaluation, but could not establish a connection after the crash; no hidden-page result is counted as evidence.
- `ps` was explicitly denied with `Operation not permitted`. Process cleanup instead used the supervisor's recorded child handles and newly created process groups; it never selected or stopped pre-existing apps by name.
- Durable logs, command receipts and the evidence seal are retained in `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/lt-automation-standard-opus-2026-10-27/`. In particular: `build-main-receipt.json`, `attempt1-runtime-receipt.json`, `runtime-receipt.json`, `electron.log`, `renderer.log`, `owned-process-groups.json`, and the check-3 readbacks below.

### Per-check results

| Check | Actual status | Dated evidence and remaining action |
| --- | --- | --- |
| 1. Open the new-automation form, confirm standard Claude Opus, close without saving | **OPEN: runtime blocked** | The rebuilt Electron app crashed before the form could be opened. Neither the component state nor its displayed selection was observed. Rerun this exact form check in an agent session where Electron can initialize its sandbox, with the specified isolated profile and debug port and focus emulation before DOM assertions. Source selection is not substituted for a live result. |
| 2. Create a disabled future verification automation through `create_automation`, read the stored provider/model, delete only that record | **OPEN: runtime blocked** | No verification automation was created, saved, fired or deleted: the rebuilt app was unavailable before this tool check. There is consequently no created identifier or stored-action readback to claim. On rerun, omit provider, set `enabled:false`, use a future schedule and the exact prompt above, independently read `action.provider` / `action.model`, assert `claude` / `opus` and no runs, then delete only the returned identifier and confirm its absence. The production app was not used as a substitute for the rebuilt creation path. |
| 3. Read the dedicated default and active stored model selections | **PASS — 2026-10-27, 08:33 UTC** | The connected installed app's read-only `get_setting` returned `automationDefaultModel: opus` (`check3-production-setting-tool.json`). A separate SQLite connection opened the installed profile's `rlm/rlm.db` with `mode=ro`, grouped definitions by `active`, `enabled`, provider and stored `action.model`, and returned **zero** `active=1` records pinned to `opus[1m]`, including paused records (`check3-production-store.json`). Twelve inactive historical definitions retain `opus[1m]`, as allowed. No configuration was written. |

### Classification and verification limits

- **No James-only action identified.** The two remaining checks need a functioning agent-run Electron environment, not new authority, credentials, a physical device, or a human product decision. Existing local dev-app authorization was sufficient; it did not overcome the observed OS permission failure.
- No automation behavior defect was reproduced, so no new remediation-register entry or implementation-status entry is asserted. The startup failure is recorded here as an environment blocker with its stderr and process receipt, rather than attributed to an untested product cause.
- The historical backlog now explicitly says not to add current status (`livetest-backlog.md:24`); this owning document therefore carries the current result, despite the older runbook's backlog-update instruction.
- No production code, tests or settings were changed. Baseline `tsc --noEmit` and `npm run typecheck:spec` both exited **0** (`typecheck-receipts.json`). Full unit tests, lint and production renderer build were not run for this evidence-only change; the missing evidence is live behavior, not further unit-test coverage.
- Cleanup passed (`cleanup-receipt.json`): both attempts' owned PIDs and process groups are gone; ports 4575, 9775 and 9875 no longer accept connections. Removed the created isolated profile, `dist/`, `.angular/` and worktree scratch driver. The first directory removal encountered a remaining `.DS_Store`; the native removal exited 0 and a separate check confirmed every runtime path absent. No dependency install or source copy was made; pre-existing `node_modules` was preserved. The report, logs and command receipts remain in the durable evidence directory. No automation or setting required restoration.
- The document retains its current filename. The coordinator owns independent verification and any eventual completion rename; this run does not certify the two open checks.


## Evidence run — 2026-10-27 verifier retry

### As-built environment and launch

- No source or test changes, commits, branch changes, or worktrees were made. At retry start,
  queue HEAD and base `main` both resolved to `f5fffc23c653de06d1dfe409f74b0f776dc2e1db`;
  `git diff main...HEAD` and the working-tree diff were empty. Previous dated evidence above
  is retained as history and is superseded by this section for current check status.
- `npm run build:main` succeeded from the queue worktree. A fresh Angular dev server compiled
  that checkout on port 4575. Electron used `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-d76360f0`,
  `--remote-debugging-port=9775`, inspector port 9875, the source-required heap flag, and the
  documented session workaround `--no-sandbox --disable-gpu`. Only the disposable profile
  was seeded with `pauseOnVpnEnabled:false`; the installed profile was not changed.
- The initial empty-profile launch encountered a distinct database migration collision at
  08:40:17 UTC, now filed as **LT-710**. A read-only post-stop query found all 72 migrations
  present. Subsequent launches reused that same initialized disposable profile without
  changing database rows or code. This is a workaround for this campaign, not a claimed fix.
- An intermediate debugger probe called the lazy RPC getter before app initialization and
  thereby created an unwired singleton; its later tool call correctly refused creation.
  No automation was created by that failed probe. That is a test-harness error, not a second
  product defect. The final launch waited until the real initialization log recorded
  `Harness initialized` at **08:43:54.061 UTC**, then obtained the existing fully wired singleton.
- The successful main-process readbacks and launch receipts bind the checks to this worktree
  and isolated profile. The role choice was set to coordinator through the disposable app's
  first-run button. No real-profile role, settings or automations were written.
- Every renderer evaluation sent `Emulation.setFocusEmulationEnabled {enabled:true}` first.
  Chromium reports the optional `Emulation.setPageVisibilityOverride` method unavailable;
  focus emulation itself succeeded, and the check asserted `document.hidden:false`,
  `visibilityState:'visible'` and live animation frames before DOM observations. No forced
  Angular change detection was used.

Evidence directory (root checkout, receipts only; no copied runtime):
`_scratch/lt-automation-standard-opus-2026-10-27/`.
`retry2/` retains the fresh-profile startup failure and successful main build;
`retry3/` retains the invalid early-probe attempt; `retry4/` contains the passing check
readbacks, verification command receipts, final launch/stop receipt and driver-source receipt.
`REPORT-verifier-retry.md` and `SEAL-verifier-retry.sha256` cover this retry.

### Per-check results (supersedes the first run's open rows)

| Check | Actual status | Current dated evidence |
| --- | --- | --- |
| 1. New form defaults to standard Claude Opus; close without saving | **PASS — 2026-10-27, 08:44:29 UTC** | Clicked **More create options → Create manually** in the live Automations page. The visible model chip read **Claude · Opus latest**; the actual picker selection and form both held `provider:'claude', model:'opus'`, with no saved-record ID. Pinned was pressed and Auto was not. Clicked Close and waited for the form to disappear without saving. See `retry4/check1-form.json`. |
| 2. Provider-omitted `create_automation` stores standard Opus, never runs, then is deleted | **PASS — 2026-10-27, 08:44:07–08:44:53 UTC** | Invoked the registered `create_automation` MCP handler from the live app's initialized RPC singleton through the main debugger, retaining its actual bound production dependencies and schema validation. No callback or singleton implementation was replaced. Provider/model were omitted; `enabled:false`, a one-time schedule of **2026-11-26T08:44:07.162Z**, no recipients/external actions, and the exact required prompt were supplied. Returned ID `56d8ed7e-f2a1-4b65-ad67-bb6df3307684` was read through `getAutomationStore().get` and independently through a SQLite `mode=ro` connection: `action.provider:'claude'`, `action.model:'opus'`, `enabled:false`, `nextFireAt:null`, no last run, zero run rows. Deleted only that returned ID through the registered `delete_automation` tool; store and independent SQLite readback both confirmed zero remaining definitions/runs. See `retry4/check2-create.json`, `check2-independent-sqlite.json`, `check2-delete.json`, and `check2-independent-deletion.json`. This exercises the real registered tool handler and live persistence, not external MCP transport/authentication. |
| 3. Dedicated setting and active selections | **PASS — refreshed 2026-10-27, 08:44 UTC** | The installed app's read-only `get_setting` again returned `automationDefaultModel:'opus'`. Its RLM store was opened independently with `mode=ro`; all active definitions, including paused ones, contained **zero** `opus[1m]` pins. Twelve inactive historical definitions retain their original `opus[1m]`, as allowed. See `retry4/check3-production-setting-tool.json` and `check3-production-store.json`. |

### Findings disposition and limits

1. The two formerly open live checks now have direct runtime evidence above.
2. The recommended launch flags were tried and allowed startup past the prior Chromium
   failure. LT-710 is the separate observed empty-profile startup failure; it remains open
   in the register and active follow-up and was not silently treated as fixed.
3. Remediation links now distinguish the closed original plan from the coordinator-designated
   active follow-up. The follow-up's explicit coordinator note is newer than the generic
   instruction naming the original active filename. The completed original was not edited.

No James-only action remains for these three checks. No credentials were required, no automation
was fired, and no provider session was spawned by the test. We did not test external MCP transport,
automation execution or hardened-session spawning: those are outside these acceptance checks.

### Verification and cleanup

- Fresh main build succeeded; fresh Angular dev compilation succeeded. Focused automation
  tool/component regressions passed (the three existing spec files, 41 tests). Both
  `npx tsc --noEmit` and `npm run typecheck:spec` exited 0. Receipts and logs are in `retry4/`.
  One extra requested spec filename does not exist; the runner correctly reports only the
  three existing files. No tests were modified. Full suite, lint and production renderer
  build were not repeated for this documentation/evidence-only change; no code changed.
- All launched app/server children and owned process groups were stopped. The successful
  Electron process exited 0; ports 4575, 9775 and 9875 are closed. The verification automation
  was deleted and its absence independently checked before shutdown.
- Runtime cleanup is recorded in `cleanup-verifier-retry.json`: the created profile, `dist/`,
  `.angular/`, quiet-run output and scratch drivers are absent. Pre-existing shared
  `node_modules` and its linked test caches were preserved; no dependency install, browser binary or source copy was made.
  Only evidence reports, logs, seals and command receipts remain from this retry.
- No staging, commits, branch/worktree changes or `_completed` rename were performed.
  The document remains at its original absolute root-checkout path for the queue verifier.

## Evidence run — 2026-11-10 (queue item c94c80, fresh worktree on current main)

### Environment and launch

- Worktree `.worktrees/queue/2026-10-07-automation-standard-c94c80`, HEAD = `main` = `b4d0bb148`, clean tree, no source or test changes. `npm run build:main` exit **0**; fresh `ng serve` on port **4592** compiled this checkout (`PORT=4592` makes the dev app load it, `src/main/window-manager.ts:123`).
- Electron launched with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-35c94c80`, `--remote-debugging-port=9542`, `--inspect=9642`, the heap flag, and the recorded session workaround `--no-sandbox --disable-gpu` (the prior run found the agent session cannot initialise Chromium's sandbox; I did not retry without it). **The empty-profile start succeeded at the first attempt** (`Harness initialized` 15:39:51 UTC; no migration collision). That is one clean observation, not a fix for LT-710/LT-1015, which keep their own status. One unrelated start-up error: the thin-client WebSocket could not bind `127.0.0.1:4880` because the installed app holds it.
- Every renderer evaluation sent `Emulation.setFocusEmulationEnabled` and `Page.setWebLifecycleState {active}` first (both ok) and asserted `document.hidden:false`, `visibilityState:'visible'`. The removed `setPageVisibilityOverride` was not sent.
- Evidence directory (root checkout): `_scratch/lt-automation-standard-opus-2026-11-10/`.

### New behaviour found since the 27 October run

`create_automation` called from the registered tool now goes through `enforceAutomationAuthority` (`src/main/automations/automation-tool-impl.ts:230`, `automation-agent-authority.ts`), and the caller is resolved from the live instance manager (`orchestrator-tools-step.ts:127`). My first attempt, with a made-up caller id like the 27 October driver used, was refused: `Cannot raise scheduled job authority (the calling session could not be resolved)…` (`check2-create.json` first attempt was overwritten by the passing run; the refusal text is quoted above). That is the guard working, not a defect. For the check I created a **real** Claude session in the dev app (`createInstance`, provider `claude`, model `opus`, no prompt sent, not YOLO) and bound the tools to that instance id. See the limit below on what this proves.

### Per-check results

| Check | Actual status | Evidence |
| --- | --- | --- |
| 1. New form defaults to standard Claude Opus; close without saving | **PASS — 2026-11-10, 15:40:14 UTC** | **More create options → Create manually** on the live Automations page. Visible chip: **Claude · Opus latest · Thinking: Provider default**. Form and picker selection both `provider:'claude', model:'opus'`, no record id; **Pinned** pressed, **Auto** not. Clicked Close; form gone, nothing saved. `check1-form.json`. |
| 2. Provider-omitted `create_automation` stores standard Opus, never runs, then is deleted | **PASS — 2026-11-10, 15:40:50–15:40:59 UTC** | Registered `create_automation` handler from the initialised RPC singleton, caller = real Claude/`opus` session `ctecd3wkv`. Provider and model omitted; `enabled:false`; one-time schedule 2026-12-10T15:40:50Z; exact required prompt. Returned id `f21d2216-0296-419b-b193-b163b695b1c4`. Store read and an independent read-only SQLite query agree: `provider:'claude'`, `model:'opus'`, `reasoningEffort:'high'`, `yoloMode:false`, `enabled:0`, `nextFireAt:null`, no last fire, **0** rows in `automation_runs`. Deleted only that id through the registered `delete_automation`; store `get` → null, list empty, SQLite shows 0 matching rows. `check2-create.json`, `check2-independent-sqlite.json`, `check2-delete.json`, `check2-independent-deletion.json`. |
| 3. Dedicated default and active selections | **PASS — 2026-11-10, ~15:42 UTC** | Installed app's read-only `get_setting automationDefaultModel` → `opus` (`check3-production-setting-tool.json`). Independent `readonly` SQLite read of the installed profile's `rlm/rlm.db` (59 definitions): **0** with `active=1` containing `opus[1m]`, paused ones included. `active=1` Claude definitions hold `opus`, `sonnet`, `claude-opus-4-8` or no pin. Nothing written (`check3-production-store.json`). |

### Limits stated plainly

- **Check 2 now proves less about the default setting than it did on 27 October.** With an agent caller, the stored model comes from the calling session (`enforceAutomationAuthority` uses `caller.currentModel` when the job omits a model), so `opus` appeared because the caller was an Opus session. The default-setting path is the one with no caller (`resolveNewAutomationModelSelection`), which is what check 1's form and the native-command path use. I did not run a Sonnet caller to show the contrast; I did not exercise a native command live.
- A caller session was spawned in the dev app (no prompt sent, then terminated; instance list empty afterwards, `caller-terminate.json`). The dev app exited with `Cleanup complete` at 15:41:27 UTC, before my explicit stop; I did not investigate why.
- Not tested: external MCP transport/authentication, automation execution, hardened-session spawning, the Sonnet-caller contrast above.
- No James-only action remains. No credentials were used; nothing was fired.

### Verification and cleanup

- `npm run test:quiet` on the three automation specs (`automation-model-resolution`, `automation-model-preview`, `automation-tool-impl`): 3 files, **69 tests passed**, exit 0. `npm run typecheck` exit 0; `npm run typecheck:spec` exit 0. Full suite, lint and renderer production build were not run: no code changed.
- Dev app and Angular server stopped (both PIDs checked by working directory first; ports 4592, 9542, 9642 closed). The profile, work folder, driver folder, `dist/`, `.angular/` and the quiet-test scratch output are removed (`cleanup.json`). Pre-existing `node_modules` kept. Report, seal and receipts remain in the evidence directory.

> Plan Queue parked work: `queue/2026-10-07-automation-standard-6360f0` — 3 commit(s), reason: verifier-unreliable.
