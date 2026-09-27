# Session-Scoped Computer Use Autonomy — Live Test

> **Found a defect while running this check?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md](./2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md)

## Status — completed by consolidation 2026-09-27

Open: 0 · Closed: 4 · Transferred: 1 · Failed: 0

The sole remaining timing check needs the same human-approved safe-app grant as the consolidated
Computer Use campaign and is now part of
[RES-006](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-006--computer-use-multi-window-activation).

## Prerequisites

- A rebuilt and restarted Harness app running this checkout (`npm run build:main`, then relaunch
  Electron). The already-open installed app predates this change.
- macOS Accessibility and Screen Recording granted to that app.
- `computerUseEnabled: true` and the global Computer Use autonomy level set to `trusted`.
- Two simultaneously live agent sessions, called **elevated** and **sibling** below.

Why deferred: these checks require a rebuilt/restarted Electron main process, two real live session
contexts, the renderer UI, the macOS accessibility driver, and Harness's own foreground window.
The unit and integration suites cover policy isolation, immediate per-call resolution, in-flight
attribution, lifecycle cleanup, trusted-renderer IPC, and restore non-persistence, but cannot prove
the packaged runtime and real UI are wired together.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1. The per-session control renders and explains its lifetime | 2026-08-31 | Real renderer control exercised through Global/Guarded/Trusted/Unrestricted; classes `lowered`/neutral/`elevated`; lifetime text `next call · no restart · session only`; IPC-failure injection left the displayed level unchanged and surfaced via `role=status`/`aria-live=polite`. |
| 2. Two live sessions resolve independently | 2026-08-31 | Two concurrent Codex sessions resolved independently (`unrestricted/session` vs `trusted/global`) with no cross-session inheritance and no respawn. Harness stayed `needs_approval`/denied under the corrected self-control contract at every level. Found and fixed [LT-528](../../plans/livetest-remediation-register.md#lt-528-warm-started-codex-sessions-ignored-requested-yolo-launch-permissions) (warm-started Codex sessions ignored requested YOLO launch permissions). |
| 4. Override changes and allowed actions are attributable | 2026-08-31 | Audit log showed a `computer.set_session_autonomy` row (`trusted/global` → `unrestricted/session`, `decidedBy: user`) followed by the elevated session's `computer.list_apps` row at `unrestricted/session`; sibling's row remained `trusted/global`, no misattribution. |
| 5. Ending and restoring a session do not persist elevation | 2026-08-31 | Elevated session set to Unrestricted, terminated, restored (`computerUseMode: null`); repeated after a full Electron stop+restart against the same isolated profile with the same result. |

## Transferred check

### Check 3 — The next decision changes without disturbing an in-flight call — TRANSFERRED
**Steps:** Start a deliberately slow but safe Computer Use observation in elevated. While it is in
flight, change the session control from Unrestricted back to Global, then issue a second Harness
observation after the first finishes.

**Expected:** The in-flight call completes according to the level captured when it began and its
audit row retains that level/source. The next call uses `trusted/global` and denies Harness. The
agent process, turn, and session remain alive throughout.

**Current status (2026-09-06):** Not run (2026-08-31 evidence run). A deliberately slow observation
requires an approved, safe app grant — the campaign did not create or assume a desktop grant, and
Harness itself cannot be used for this step (hard-denied self-control target).

**Blocker class: C** — needs James to approve a Computer Use grant for a safe disposable app at the
real prompt before the in-flight-call timing behaviour can be exercised; an agent approving its own
grant would defeat the same self-control guard this doc's checks 2 and 5 rely on.

This source checklist is closed; complete the exact timing assertion in RES-006.
