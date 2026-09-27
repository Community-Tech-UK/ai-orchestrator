# Computer Use Permission Onboarding Live Test

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed here: 2 · Transferred: 3 · Failed: 0

All agent-runnable evidence in this source checklist is complete. The three remaining packaged-app,
clean-TCC and System Settings campaigns were moved without changing their acceptance criteria to
[RES-010 in the consolidated human/external checklist](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-010--packaged-macos-computer-use-permission-ownership-and-repair).
That document is now the only active owner; the detailed sections below are retained as historical
context rather than open work.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Deferred live-validation checks for [2026-07-11-computer-use-permission-onboarding-plan_completed.md](./2026-07-11-computer-use-permission-onboarding-plan_completed.md).
> Prerequisites: a rebuilt app from this working tree (`npm run build` recompiles the Swift
> helper at protocol 1.1.0 — required, the previously compiled 1.0.0 helper will report
> `version_mismatch` until rebuilt), and for the ownership checks a **signed packaged**
> arm64 build with clean TCC state (`tccutil reset ScreenCapture` / `tccutil reset
> Accessibility` for Harness's bundle id, or a fresh macOS user).
> Rename this doc `_livetest_completed.md` only when every check passes with evidence.

All code, targeted tests, typecheck, lint, LOC ratchet, and the full quiet suite pass
in-loop (see the completed plan). Everything below genuinely needs a rebuilt/packaged app,
real macOS TCC state, or human interaction, and cannot run in a headless session.

## Check 1: Packaged ownership boundary (plan Task 8)

1. Build the arm64 packaged app per `docs/packaging-native-modules.md`.
2. Verify the helper is present, executable, and nested-code signed:
   `codesign --verify --deep --strict --verbose=4 release/mac-arm64/Harness.app`.
3. Inspect the helper's designated requirement and signing chain
   (`codesign -d -r- .../Resources/desktop-helper/desktop-helper`) without logging
   credential material.
4. On clean TCC state, enable Computer Use, click the banner's Accessibility action, and
   confirm macOS lists **Harness** in Privacy & Security → Accessibility — not a raw
   temporary/helper path.
5. Click the Screen Recording action and confirm Harness appears under Screen & System
   Audio Recording, attributed to Harness's Electron process.

**Expected:** both permissions attribute to Harness. If Accessibility attributes to the
raw helper binary instead, STOP acceptance — fix nested signing/packaging or move the AX
seam into a bundled helper/XPC service. Do not paper over it with UI copy or tests.

**Historical status:** steps 1–3 (build/sign mechanics) are closed — see Closed checks. Steps 4–5
were transferred to consolidated residual RES-010 on 2026-09-27.

**Why deferred:** needs macOS, a signed package, and clean TCC state; none exist in the
headless implementation environment (Linux sandbox, no xcrun/codesign). Resetting TCC on
the operator's machine would revoke Accessibility/Screen Recording from the packaged
Harness app James leaves running to coordinate live sessions — every evidence run from
2026-08-12 through 2026-08-24 reconfirmed that app was still live (most recently pid
`83885`, launched 00:38 on 2026-08-24) and declined to disrupt it. Note: this doc's Check 1
and the macOS-signing doc's checks 3–5 are the same underlying test — running either one
clean closes both (per 2026-07-29 triage).

## Check 2: Real behavior flows (plan Task 9 UI items)

1. With Computer Use disabled, launch Harness: no banner, no chip, no native prompt, no
   System Settings launch.
2. Enable Computer Use with both permissions missing: banner-only state appears at the
   root, above the main content.
3. Dismiss the banner: chip-only state in the title bar (`Computer Use: 2 needed`);
   click the chip and confirm Settings → Computer Use opens (query param `tab=computer-use`).
4. Exercise first-time, denied, granted, and revoked flows for both permissions. After
   changing System Settings, refocus Harness and confirm the banner/chip/settings rows
   refresh without a restart (focus/visibility listener, no polling).
5. Break the exact-pane URL (e.g. run on a macOS version where the pane link fails) or
   simulate rejection, and confirm fallback to Privacy & Security root; if both fail the
   UI shows `Could not open System Settings. Open Privacy & Security manually.`
6. Confirm dismissal is not persisted: relaunch with Computer Use still enabled and
   missing permissions — the banner shows again.

**Expected:** matches the state model table in
`docs/superpowers/specs/2026-07-11-computer-use-permission-onboarding-design_completed.md`.

**Historical status:** step 1 is closed — see Closed checks. Steps 2–6 were transferred to
consolidated residual RES-010 on 2026-09-27.

**Why deferred:** requires the rebuilt Electron renderer + main process, real macOS
permission prompts, and human interaction with System Settings. As of the 2026-08-31
correction, Computer Use is enabled and healthy in the installed runtime, so "enable the
feature" is no longer itself an open product decision — but the granted/denied/revoked
transitions and System Settings interaction in steps 2–6 still need a clean TCC state and
real Accessibility/Screen Recording prompts, which remain hard-denied to an agent.

## Check 3: In-app stale-registration repair

Prerequisite: install a newly signed packaged build containing the permission-repair
IPC and renderer controls. Keep the current stale state intact: System Settings shows
Harness enabled while AIO reports Screen Recording and Accessibility as missing.

1. In AIO's root permission banner, click **Repair permissions**. Repeat the flow from
   Settings → Computer Use using **Repair macOS permissions** if the banner is dismissed.
2. Confirm the Screen & System Audio Recording pane opens from AIO after the repair.
   Do not run `tccutil` manually and do not remove entries with the System Settings
   minus button.
3. Confirm only Harness's Screen Recording and Accessibility decisions were cleared;
   unrelated apps retain their existing permission states.
4. Enable the newly registered Harness Screen Recording entry.
5. Return to AIO and click **Open Accessibility settings**. Enable the entry created by
   the current signed build/helper.
6. Click AIO's **Restart AIO** action from the banner or Settings repair status.
7. After relaunch, open Settings → Computer Use and confirm Screen Recording,
   Accessibility, and Input synthesis all report **Ready** and the root warning is gone.

**Expected:** the complete stale-TCC recovery is initiated and finished through AIO;
no copied shell commands or manual row deletion are required. If Accessibility appears
as a raw `desktop-helper` entry or remains missing after relaunch, record that exact
outcome and stop acceptance because the helper ownership boundary is still wrong.

**Why deferred:** installing and relaunching the packaged app would terminate the AIO
instance coordinating this implementation, and the check intentionally mutates the
operator's live macOS TCC state. No step of this check has been attempted.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Check 1 steps 1–3: packaged arm64 build signs and nests correctly | 2026-07-13 (reconfirmed 2026-08-18, 08-19, 08-24) | `codesign --verify --deep --strict --verbose=4 release/mac-arm64/Harness.app` passed including nested helper; helper + Electron executable both arm64 Mach-O; `Authority=Apple Development: James Lawrence (WZ2PW4Y923)` / `TeamIdentifier=GJL9WJ4S4W` matches on both `Harness.app` and `desktop-helper` |
| Check 2 step 1: disabled-state UI shows no banner/chip/native-prompt/IPC | 2026-08-24, batch F | CDP-driven DOM read on an isolated dev app: `app-computer-use-permission-banner`/chip render only `<!--container-->`; Settings → Computer Use audit log shows a live `computer.list_apps denied/not_run computer_use_disabled` entry; source-traced `ComputerUsePermissionStore.active`/`refresh()` (`src/renderer/app/core/state/computer-use-permission.store.ts:57-60,145-148`) confirms no `desktop.getHealth()` IPC call is made while disabled |

Note: a 2026-07-18 steady-state observation (System Settings already showed `Harness.app`
enabled for both permissions, no raw helper entry) is consistent with the Check 1 result
above but was explicitly *not* a clean-TCC first-prompt test, so it is folded into context
rather than counted as closing steps 4–5.

## Transferred residual

Checks 1 steps 4–5, check 2 steps 2–6, and check 3 were consolidated into RES-010 on 2026-09-27.
No open item remains owned by this completed source document.

Related but separate: [LT-040](../../plans/livetest-remediation-register.md#lt-040-claude-cli-never-connects-to-the-computer-use-mcp-server-for-any-instance)
(Claude CLI never connects to the Computer Use MCP server) was found while investigating
this doc's blocker on 2026-08-12; it is fixed as of 2026-08-12 per the sibling
`2026-07-17-browser-permission-ux_plan_livetest_completed.md` evidence and does not block Checks 1–3,
which are UI-driven, not MCP-tool-driven.
