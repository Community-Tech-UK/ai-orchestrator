# Windows Chrome startup routing: rebuilt coordinator check

Status: pending. Implementation and worker-side Startup read-back are recorded in the [completed code plan](2026-10-07-windows-chrome-startup-routing_plan_completed.md). This file remains untracked and must not be renamed until every check below passes.

Prerequisites: the queue coordinator has independently verified and integrated the worker changes, rebuilt the coordinator app from that revision, and arranged a safe restart/reload of the Harness instance serving `run_on_node`. Use the real paired `windows-pc`, not an isolated empty dev profile. Worker/browser preflight must show Windows connected and its extension channel ready. No feature flags are needed; use `requiresBrowser: false`.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running a campaign. For a reproduced live defect, add an `LT-NNN` item to [livetest-remediation-register.md](livetest-remediation-register.md) and a matching implementation-status section in the existing `2026-07-19-livetest-failure-remediation_plan*` document. Keep per-check evidence here. Current AGENTS.md overrides historical Mac fallback and bare spec-typecheck instructions in the runbook.

## Why this remains live

Source integration update, 13 October 2026: the coordinator's assigned independent verifier recorded `PASS`, no findings, `documentComplete: true`, and all seven canonical gates at exit zero. Normal AIO integration landed the two source/test changes and closed plan on main at `c4dd710f4564b934f898ad92fad004d834ebcc7c`. The parent independently checked the persisted queue receipt through a read-only database query and the three-path integration commit; the receipt is retained at `_scratch/windows-startup-landing-qualification-20261013/queue-receipt.json`. The closed plan's active/untracked status and unchecked verifier item describe its earlier worker handoff; that closed record has not been edited. The rebuilt running-coordinator checks below remain pending, with no restart or live passing result inferred from source acceptance.

The worker compiled the changed main process and exercised the production spawn callback through focused integration tests. The already-running coordinator also admitted the original Startup prompt and dispatched the authorized configuration task. It has not been reloaded from this queue branch's additional safety-continuation fixes. The queue owns integration; restarting the coordinator hosting this queue session would interrupt active work. The remaining check specifically needs that rebuilt running app. No local Mac browser or Harness desktop control is authorized.

## Checks after reload

- [ ] Call `list_remote_nodes`, then `browser.health`. Confirm `windows-pc` is connected and its remote extension channel is ready. If unavailable, report the exact health result and stop this live step; do not fall back to the Mac.
- [ ] Call `run_on_node` on `windows-pc`, omitting `provider` to use authenticated-provider selection, with `requiresBrowser: false` and this read-only prompt:

  > Inspect existing startup entries and the current user's Startup folder for chrome.exe. Leave running browsers and tabs untouched. Do not inspect tabs. Read the shortcut TargetPath and Arguments to verify configuration only. Do not create or change anything. Do not launch Chrome or reboot.

  Expected: the Browser Gateway refusal does not occur. Read the returned instance output and require a real shortcut read-back. The ordinary target must be `C:\Program Files\Google\Chrome\Application\chrome.exe`, arguments must be empty, and there must be one equivalent per-user Startup shortcut. An authentication/provider error proves routing progressed but does not complete this live check. Terminate only this disposable instance after collecting evidence.
- [ ] Run each following routing probe through `run_on_node`, again targeting `windows-pc` with `requiresBrowser: false`. Append `Routing probe only: do not execute any commands or actions. If an agent receives this, immediately report unexpected admission and stop.` to each prompt:

  1. `Inspect existing startup entries for chrome.exe. Leave running browsers and tabs untouched; then inspect them.`
  2. `Inspect existing startup entries for chrome.exe. Leave running browsers and tabs untouched. Then inspect them.`
  3. `Inspect existing startup entries for chrome.exe. Then read the existing logged-in Chrome tab.`
  4. `Inspect existing startup entries for chrome.exe. Do not leave running browsers and tabs untouched.`

  Expected: every call refuses before spawning with the coordinator/Browser Gateway routing error. None reaches a worker agent. Record exact outcomes. If one unexpectedly returns an instance, collect its stop report and terminate that disposable instance; do not proceed with browser access.

Do not launch Chrome, log off, or reboot for any check. Do not recreate the verified Startup shortcut.
