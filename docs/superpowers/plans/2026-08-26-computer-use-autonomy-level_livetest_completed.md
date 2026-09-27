# Computer Use Autonomy Level — Live Test

> **Found a defect while running this check?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-26-computer-use-autonomy-level_plan_completed.md](2026-08-26-computer-use-autonomy-level_plan_completed.md)

## Status — completed by consolidation 2026-09-27

Open: 0 · Closed: 2 · Transferred: 3 · Retired as obsolete: 1 · Failed: 0

Checks 3, 4 and 6 now share the human-approved grant campaign in
[RES-006](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-006--computer-use-multi-window-activation).
Check 2 is retired: current global policy keeps Terminal, System Settings security panes, password
managers, provider apps and Harness itself hard-denied at every autonomy level. An old expectation
that `trusted` makes Terminal/System Settings controllable must not be run or treated as a missing
pass.

## Prerequisites

- A rebuilt and restarted Harness app running this checkout (`npm run build:main`,
  then relaunch Electron). The already-open installed app predates this change.
- macOS Accessibility and Screen Recording granted to that app. **This is the
  separate blocker James was told about**: his 2026-08-26 authorisation covers
  agent behaviour, not OS-level TCC, which still needs a human at the prompt.
  (Confirmed already granted on the installed runtime as of 2026-08-30 —
  `screenCapture`, `accessibility`, and `input` all report `available`.)
- `computerUseEnabled: true`.

Why deferred: every check needs a restarted Electron main process, a real
accessibility driver and real foreground applications. Unit and integration
coverage proves the policy decisions (43 app-policy cases, 24 hotkey cases, and
end-to-end service cases at `trusted` and `unrestricted`), but cannot prove that
a real keystroke reaches a real application.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1. Setting renders and is operator-only | 2026-08-30 (operator-only refusal) / 2026-08-31 (renderer + restart-persistence) | `get_setting` returned `writable: false`, `policyTier: "read-only"`; agent-side `set_setting` refused with an authorization message, not a value-shape error. Rebuilt dev runtime rendered Guarded/Trusted/Unrestricted select; value survived a full Electron stop+restart. Found and fixed [LT-529](../../plans/livetest-remediation-register.md#lt-529-generic-settings-selects-displayed-their-first-option-instead-of-the-persisted-value) (select displayed first option instead of the persisted value) — regression test guards it. |
| 5. The self-control guard holds in the real app | 2026-08-30 | `computer.list_apps {includeDeniedMetadata: true}` showed Harness (`darwin-app:com.ai.orchestrator`) as `policyStatus: "denied"`, `blockedReason: "harness self-control denied"`; a grant request for it returned `decision: "denied"`, `reason: "computer_use_app_denied"`. |

## Transferred / retired checks

### Check 2 — A previously-denied app is now reachable at `trusted` — RETIRED
**Steps:** With the level at `trusted`, run `computer.list_apps`, then
`computer.request_app_grant` for **Terminal**, and approve it at the prompt.

**Expected:** Terminal appears with `policyStatus: needs_approval` rather than
`denied`, and the grant can be created. Before this change it reported
`blockedReason: built-in hard deny` and no grant was possible.

Repeat for **System Settings** — this is the one that matters for the clean-TCC
work, since Accessibility and Screen Recording grants cannot be scripted.

**Current status (2026-09-06):** Never run. 2026-08-30's session requested bounded grants
for two other safe apps (Activity Monitor, Chrome) and both expired unapproved after
their full 60-second window — no grant materialized. Terminal and System Settings were not
even attempted this session because they remain hard-denied without an approved grant.
**Blocker class: C** — needs James physically present to click "Approve" on the real prompt
inside the window; an agent cannot approve its own grant without defeating the check.

**2026-09-27 correction:** do not request these grants. Terminal and System Settings remain
hard-denied targets under the current control policy, regardless of this historical plan's former
expectation. The safe invariant is that listing may expose denied metadata, but observation/input
authorization can never be granted for them.

### Check 3 — Enter and Space actually reach an application — TRANSFERRED
**Steps:** Grant input on a disposable app (TextEdit). Take an accessibility
snapshot, then `computer.hotkey` with `["space"]` and with `["enter"]`.

**Expected:** both allowed, and the character/newline visibly appears. Before
this change both were denied unconditionally, which is what made the tools
unusable for real work.

**Current status (2026-09-06):** Never run — blocked on the same unapproved-grant issue as
check 2 (no app has ever received an approved grant in any run of this doc).
**Blocker class: C** — needs a human-approved grant for TextEdit before the hotkey portion
becomes agent-runnable.

### Check 4 — Quit is still refused at `trusted` — TRANSFERRED
**Steps:** Same app, `computer.hotkey` with `["cmd","q"]`.

**Expected:** denied with `computer_use_sensitive_action_blocked`. Then set the
level to `unrestricted` and repeat.

**Expected:** allowed, and the app quits. **Use a disposable app** — this really
does quit it.

**Current status (2026-09-06):** Never run — same unapproved-grant blocker as checks 2/3.
**Blocker class: C.**

### Check 6 — Secret-like text is permitted but stays out of the audit log — TRANSFERRED
**Steps:** At `trusted`, `computer.type_text` a long random high-entropy string
into a disposable text field. Then read the Computer Use audit log.

**Expected:** the action is allowed (it was denied before), and the audit row
shows `"text": "[redacted]"`. The value must not appear anywhere in the log.

**Current status (2026-09-06):** Never run — same unapproved-grant blocker as checks 2/3/4.
**Blocker class: C.**

This source checklist is closed; finish the three harmless-app assertions through RES-006.
