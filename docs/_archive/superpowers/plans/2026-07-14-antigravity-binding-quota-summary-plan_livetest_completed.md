# Antigravity Binding Quota Summary Live Test

Prerequisites: use a rebuilt or restarted Harness instance containing the
changes from
[the completed implementation plan](./2026-07-14-antigravity-binding-quota-summary-plan_completed.md).
The currently running packaged app predates this source change.

## Verify the binding Gemini headline

1. Quit the existing Harness instance.
2. From the repository root, run `npm run dev` and wait for the Electron window
   to open.
3. Open the provider quota popover and press **Refresh** beside Antigravity.
4. Find the `Gemini · 5-hour` and `Gemini · weekly` percentages.
5. Confirm the compact `AG` percentage equals the higher of those two values.
6. If one Gemini window is `0%` and the other is `100%`, confirm the compact
   strip reads `AG 100%`, not `AG 0%`.
7. Confirm the popover still lists all four Antigravity windows: Gemini
   five-hour, Gemini weekly, Claude/GPT five-hour, and Claude/GPT weekly.

Expected result: the compact headline reports the binding Gemini quota window,
while the detailed model-family windows remain unchanged.

Why deferred: verifying Electron main-process quota data and the rendered app
requires restarting the application hosting the current task. Automated
component coverage and clean-worktree project verification are recorded in the
implementation plan.

## Evidence — 2026-07-18

**Status: PASS.**

Observed in the running signed `/Applications/Harness.app` build (`0.1.0`) using
macOS Computer Use:

- Startup diagnostics reported `10 / 10 ready`.
- After opening Provider quota details, the refreshed Antigravity values were:
  `gemini · 5h 58%`, `gemini · weekly 10%`, `claude/gpt · 5h 0%`, and
  `claude/gpt · weekly 100%`.
- The compact quota strip read `AG 58%`, exactly the higher of the two Gemini
  windows (`max(58, 10) = 58`).
- All four detailed Antigravity windows remained visible in the popover.
- The conditional 0%/100% Gemini edge case was not present in the live account
  state, so step 6 was not applicable to this run.

Every applicable live acceptance check passed. This checklist is complete.
