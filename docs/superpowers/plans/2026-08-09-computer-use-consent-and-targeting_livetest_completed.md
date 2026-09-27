# Computer Use Consent And Targeting Remediation Live Test

## Status — completed by consolidation 2026-09-27
Open: 0 · Closed: 3 · Transferred: 1 · Failed: 0

The sole remaining check needs one operator-approved Computer Use grant within its 60-second decision
window. It is now part of the already-related multi-window/focus-boundary campaign in
[RES-006](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-006--computer-use-multi-window-activation).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check
> is not automatically a defect; a reproduced defect belongs in that register. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Deferred live-validation checks for
> [2026-08-09-computer-use-consent-and-targeting_plan_completed.md](./2026-08-09-computer-use-consent-and-targeting_plan_completed.md).
> Prerequisites: a rebuilt macOS Harness app from the implementation checkout, Screen Recording
> and Accessibility already granted to that build, and an interactive operator who can approve or
> deny the real in-app Computer Use grant prompt. Rename this document `_livetest_completed.md`
> only when every check passes with evidence.

All code-level regression tests, typechecks, lint, LOC, main-process build, and the full sharded
suite pass in-loop (see the completed plan after closure).

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1 — Desktop grants stay human-controlled in YOLO mode (steps 1-2, 7) | 2026-08-12 batch CU | Real YOLO instance `c8q1l2i8y` got a genuine pending grant (`grant_znv2sv82b2`); Cursor ACP YOLO instance `uphw6ahee` wrote/read a file with no approval pause (step 7) |
| 1 — steps 3-6 (approve/deny UI + `computer.list_grants` fields) | 2026-08-12 batch LT-095 fix | `PendingApprovalsBannerComponent` rendered a real pending request; Deny click → audit `decidedBy:"user"`, denied; Approve click → grant with `scope:"session"`, `duration:"boundedMinutes"`, `minutes:1`, real `expiresAt`; Extend action moved the countdown 36s→1m59s |
| 2 — equivalent macOS window IDs capture successfully | 2026-08-10 | Darwin driver captured iCUE (`darwin-app:com.corsair.cue.main`) helper window `694` exactly as requested; PNG 314×200; Electron capture-source form did not leak into service identity |
| 3 — app-level menu nodes are observable but cannot receive input | 2026-08-10 | Real AX snapshot of iCUE window `694`; `AXMenuItem "Open profile..."` returned `inputEligible:false`; click by uid denied `computer_use_target_outside_approved_window` before any native input call |

Two product defects were found and fixed during this campaign while chasing checks 1 and 4 (kept here
because they explain the check-1 evidence dates above): **LT-040** (no spawned Claude instance could
ever connect to the `computer-use` MCP server — fixed 2026-08-12, renamed the injected server to
`harness-computer-use`) and **LT-095** (no UI existed anywhere to approve/deny a
`computer.request_app_grant` request — fixed 2026-08-12, added `PendingApprovalsBannerComponent` +
`permission-registry:list-pending/resolve/extend`). Both are closed; see the register for full detail.

## Check 4: Tight activation-to-input sequence preserves the fail-closed focus boundary — TRANSFERRED

1. In one uninterrupted orchestration step, activate the approved test window, take a fresh
   accessibility snapshot, query a harmless in-window control, and click it.
2. Confirm the sequence succeeds and record timing from the audit log.
3. Repeat, but deliberately bring another app to the front between observation and input.

**Expected:** the uninterrupted sequence succeeds without an avoidable top-level pause. The
deliberate focus change remains denied by the helper's active-app/window check; Harness does not
silently reactivate the target or steal focus.

**Precondition status:** a real, human/operator-approved grant is reachable in principle (LT-095 is
fixed and was used to approve a grant for Check 1) — but every attempt at Check 4 itself has failed to
get an approved grant in time, or has been blocked by an authorization boundary, or has failed to find
an allowlisted harmless in-window control once a grant existed. None of these are the same defect as
LT-040/LT-095; both of those are closed.

**Progress so far, chronological (do not re-derive):**

- 2026-08-10: a conservative real-helper probe activated Activity Monitor but sent no click — its AX
  snapshot did not expose an allowlisted harmless in-window control through the query path, even at
  the maximum 2,000-node snapshot. The probe stopped rather than clicking an unknown control.
- 2026-08-12 (batch A, batch CU): blocked upstream by LT-040 then LT-095 (both since fixed). Once
  LT-095 was fixed the same session re-confirmed Check 4 additionally needs the native-input
  timing/focus-loss sequence against a real macOS app, independent of the approval-surface fix, and did
  not attempt it (out of scope for that session; avoiding a fabricated pass).
- 2026-08-18 (batch M), 2026-08-19 (batch N5), 2026-08-24 (batch F): re-triaged and re-verified (via
  fresh `git log` checks, not assumption) that Harness's own dev window is still hard-denied as a
  Computer Use target (`HARD_DENY_PATTERNS` / `/\bharness\b/i`,
  `src/main/desktop-gateway/desktop-app-policy.ts:10-14,53-64` — permanent, by design, not a
  workaround target), and that no session-specific local-Mac-UI-control approval had been granted in
  those sessions. No click, activation, or query was attempted in any of these three runs.
- 2026-08-30 evening: with local-Mac live-test authorisation in force and `computer.health` reporting
  Screen Recording/Accessibility/input all available, a bounded 10-minute `observeAndInput` grant was
  requested for the live Activity Monitor window (`grant_5jit2ru1lab`). It reached genuine pending
  state but sat unactioned for its full 60-second decision window and expired — `computer.list_grants`
  stayed empty before and after. No observation token, activation, click, focus change, or native input
  was attempted, because no approved grant ever existed to attempt them with.

**What is still needed:** (1) one operator-approved `observeAndInput` grant actioned inside its 60-second
window (an Approve click on the real banner, by a human or by an agent under explicit per-task
authorisation to click it), and (2) — independently, once a grant exists — locating an allowlisted
harmless in-window control via the existing snapshot/query path against a real macOS app (the one
attempt so far, Activity Monitor at max 2,000-node snapshot, found none). Part (2) may itself warrant a
new LT-NNN if it reproduces against a second or third candidate app once part (1) is available to test
it — not filed yet because it has not been re-attempted since the single 2026-08-10 finding.

This source checklist is closed. Complete the transferred focus-boundary sequence in RES-006 rather
than reopening or duplicating it here.
