# Windows Chrome startup routing: rebuilt coordinator check

Status: all three check groups passed live on 27 October 2026; evidence is ready for the queue coordinator's independent verification. Implementation and earlier worker-side Startup read-back are recorded in the [completed code plan](2026-10-07-windows-chrome-startup-routing_plan_completed.md). This file keeps its current live-test name; only the coordinator may rename it after verification.

Prerequisites: the queue coordinator has independently verified and integrated the worker changes, rebuilt the coordinator app from that revision, and arranged a safe restart/reload of the Harness instance serving `run_on_node`. Use the real paired `windows-pc`, not an isolated empty dev profile. Worker/browser preflight must show Windows connected and its extension channel ready. No feature flags are needed; use `requiresBrowser: false`.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running a campaign. For a reproduced live defect, add an `LT-NNN` item to [livetest-remediation-register.md](livetest-remediation-register.md) and a matching implementation-status section in the existing `2026-07-19-livetest-failure-remediation_plan*` document. Keep per-check evidence here. Current AGENTS.md overrides historical Mac fallback and bare spec-typecheck instructions in the runbook.

## Why this remains live

Source integration update, 13 October 2026: the coordinator's assigned independent verifier recorded `PASS`, no findings, `documentComplete: true`, and all seven canonical gates at exit zero. Normal AIO integration landed the two source/test changes and closed plan on main at `c4dd710f4564b934f898ad92fad004d834ebcc7c`. The parent independently checked the persisted queue receipt through a read-only database query and the three-path integration commit; the receipt is retained at `_scratch/windows-startup-landing-qualification-20261013/queue-receipt.json`. The closed plan's active/untracked status and unchecked verifier item describe its earlier worker handoff; that closed record has not been edited. The rebuilt running-coordinator checks below remain pending, with no restart or live passing result inferred from source acceptance.

The worker compiled the changed main process and exercised the production spawn callback through focused integration tests. The already-running coordinator also admitted the original Startup prompt and dispatched the authorized configuration task. It has not been reloaded from this queue branch's additional safety-continuation fixes. The queue owns integration; restarting the coordinator hosting this queue session would interrupt active work. The remaining check specifically needs that rebuilt running app. No local Mac browser or Harness desktop control is authorized.

## Checks after reload

- [x] Call `list_remote_nodes`, then `browser.health`. Confirm `windows-pc` is connected and its remote extension channel is ready. If unavailable, report the exact health result and stop this live step; do not fall back to the Mac.
- [x] Call `run_on_node` on `windows-pc`, omitting `provider` to use authenticated-provider selection, with `requiresBrowser: false` and this read-only prompt:

  > Inspect existing startup entries and the current user's Startup folder for chrome.exe. Leave running browsers and tabs untouched. Do not inspect tabs. Read the shortcut TargetPath and Arguments to verify configuration only. Do not create or change anything. Do not launch Chrome or reboot.

  Expected: the Browser Gateway refusal does not occur. Read the returned instance output and require a real shortcut read-back. The ordinary target must be `C:\Program Files\Google\Chrome\Application\chrome.exe`, arguments must be empty, and there must be one equivalent per-user Startup shortcut. An authentication/provider error proves routing progressed but does not complete this live check. Terminate only this disposable instance after collecting evidence.
- [x] Run each following routing probe through `run_on_node`, again targeting `windows-pc` with `requiresBrowser: false`. Append `Routing probe only: do not execute any commands or actions. If an agent receives this, immediately report unexpected admission and stop.` to each prompt:

  1. `Inspect existing startup entries for chrome.exe. Leave running browsers and tabs untouched; then inspect them.`
  2. `Inspect existing startup entries for chrome.exe. Leave running browsers and tabs untouched. Then inspect them.`
  3. `Inspect existing startup entries for chrome.exe. Then read the existing logged-in Chrome tab.`
  4. `Inspect existing startup entries for chrome.exe. Do not leave running browsers and tabs untouched.`

  Expected: every call refuses before spawning with the coordinator/Browser Gateway routing error. None reaches a worker agent. Record exact outcomes. If one unexpectedly returns an instance, collect its stop report and terminate that disposable instance; do not proceed with browser access.

Do not launch Chrome, log off, or reboot for any check. Do not recreate the verified Startup shortcut.

## Evidence run — 2026-10-27

### Environment and evidence ownership

All Windows calls used the existing paired coordinator serving this queue session, explicitly targeted `windows-pc`, omitted `provider`, and set `requiresBrowser: false`. No production restart was necessary to exercise the required behavior. This run proves the current coordinator's behavior; it does not infer an exact running binary commit from the worker's separately advertised build commit. The historical 13 October statement that live verification was pending is superseded by this run.

Retained receipts: `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/windows-chrome-startup-livetest-20261027-e4f065/`. This directory contains small evidence files and command logs, not a checkout or dependencies. `seal.json` identifies their hashes after cleanup.

### Check 1 — PASS: Windows and its extension channel ready

`list_remote_nodes` returned `windows-pc` connected, platform `win32`, before the health call. `browser.health` succeeded at 08:34:36 UTC with remote extension totals `total: 1`, `ready: 1`, `silent: 0`. Its Windows node reported `channelState: "fresh"`, `commandsDeliverable: true`, `running: true`, `silent: false`, and `registration: "ok"`. No recovery or browser navigation was needed. A further roster read at 08:39:24 UTC confirmed Windows remained connected. Receipts: `browser-health.json` (remote-channel projection only) and `nodes.json`.

### Check 2 — PASS: original prompt admitted and shortcut read back

The exact documented read-only prompt returned disposable instance `cz48lvj5k` on `windows-pc`. `read_node_output` reached `status: "idle"`, `done: true` and reported PowerShell reads followed by the actual shortcut read-back:

- Filename: `Google Chrome.lnk` in `C:\Users\shutu\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`.
- TargetPath: `C:\Program Files\Google\Chrome\Application\chrome.exe` (target exists).
- Arguments: empty.
- WorkingDirectory: `C:\Program Files\Google\Chrome\Application`.
- WindowStyle: 1; shortcut last modified 13 October 2026 at 13:37.
- No Chrome entry in the inspected Run/RunOnce keys or all-users Startup folder.

To avoid inferring the equivalent-shortcut count from a filename list, a second read-only call used the same documented prompt with a request for an explicit count appended. Instance `cgd392gmf` completed at 08:38:33 UTC and reported **`equivalentPerUserStartupShortcutCount: 1`**, the same target, and empty arguments. Both worker reports explicitly state no changes, Chrome launch, or browser/tab interaction occurred. These are live worker read-backs, not a claim to have launched Windows login or independently decoded shortcut bytes in this run.

Both instances were individually terminated after collection. Each termination receipt lists only the requested instance under `terminated`, with `skipped: []`. Receipts: `startup-admission.json`, `startup-output.json`, `startup-termination.json`, `startup-count-admission.json`, `startup-count-output.json`, `startup-count-termination.json`.

One supplemental wording attempt used the broader negative phrase `Do not inspect, launch, close or change browsers or tabs` and was refused before spawning. Its receipt is `supplemental-count-noncanonical-refusal.json`. Reusing the documented standalone safety sentences admitted the count read-back above. The acceptance criteria deliberately cover narrow recognized safety sentences, so this conservative refusal was not treated as a defect or as a failed required probe.

### Check 3 — PASS: all four probes refused before spawning

Each exact numbered probe above was sent separately, with the required stop-only suffix appended verbatim. Every call returned `isError: true`, MCP error `-32000`, and no instance ID:

> run_on_node cannot access Browser Gateway or existing/shared Chrome tabs on windows-pc. The agent must stay on the coordinator and call Browser Gateway tools with computer: "windows-pc". Use run_on_node only for the worker-managed Chrome profile exposed through chrome-devtools.

| Probe | Observed result | Receipt |
| --- | --- | --- |
| 1: semicolon continuation | Refused, no worker instance returned | `probe-1.json` |
| 2: next-sentence pronoun continuation | Refused, no worker instance returned | `probe-2.json` |
| 3: explicit existing logged-in tab | Refused, no worker instance returned | `probe-3.json` |
| 4: negated leave-untouched instruction | Refused, no worker instance returned | `probe-4.json` |

There was no unexpected admission and no browser-access step to execute or clean up.

### Isolated worktree app and final cleanup

The worktree's `rtk proxy npm run build:main` passed (exit 0), including non-code asset sync and preload bundling; `build-main.log` and `build-main-receipt.json` retain the result. A fresh Angular dev server compiled successfully on port 4568. The first startup attempt's readiness check incorrectly used IPv4 while Angular listened on IPv6 localhost; that server was stopped and its failed-attempt receipt preserved. The second used `localhost` and launched the freshly compiled Electron app with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-e2e4f065`, `--remote-debugging-port=9645`, and the normal heap flag to avoid a relaunch.

Electron reached startup and briefly exposed its debug port, but its GPU subprocesses reported `sandbox initialization failed: Operation not permitted`, followed by `GPU process isn't usable. Goodbye.` The main process exited before the focus-emulation/CDP helper could attach. The helper returned `ECONNREFUSED 127.0.0.1:9645` (exit 1); **no DOM assertion was made**, and no successful isolated UI/IPC check is claimed. This is an observed local startup restriction, not evidence of a Windows routing regression. `electron.log`, `renderer.log`, `dev-app-check.log`, and `runtime-attempts.json` retain the failure and cleanup observations. The required Windows checks use the paired coordinator above, because an empty isolated profile has no Windows pairing.

The supervisor's process-group cleanup hit `Operation not permitted` after Electron had exited. A direct PID check confirmed Electron PID 91663 no longer existed. The remaining owned renderer PID 90981 was terminated directly (exit 0), and a subsequent PID check returned `No such process`; neither test port 4568 nor 9645 had a listener. Read-only `ps` inspection was also explicitly denied, so no process-list proof is claimed. There were no browser profiles/binaries, dependency installations, automations, or provider sessions created by the isolated app. Runtime removal is recorded in `cleanup-receipt.json`; pre-existing worktree dependencies are preserved.

No product code or tests were changed. No new product defect was reproduced, so no remediation-register item or implementation-status addition is required. No commit, branch/worktree creation, branch switch, document copy, or completion rename was performed. The original root document is already tracked in this checkout (confirmed by `git ls-files`); its earlier claim to remain untracked was stale. It is edited in place and remains unstaged. `livetest-backlog.md` was read: its current header expressly says **Do not add current status here**, superseding the runbook's older instruction to update that historical rollup; current status is recorded in this owner instead.

Not tested: launching Chrome at Windows sign-in, rebooting/logging off, or inspecting browser tabs. Those actions are expressly excluded by this checklist. The full unit suite, lint, and separate spec typecheck were not rerun because this task changed no product code/tests; the main build and fresh Angular development compilation are the source checks performed. The isolated app did not survive to UI/IPC validation, as recorded above. No required Windows check remains open or needs James; independent verification and any document rename remain the queue coordinator's responsibility.
