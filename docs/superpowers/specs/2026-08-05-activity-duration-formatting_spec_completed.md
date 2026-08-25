# Activity Duration Formatting Spec

**Status:** Completed and independently verified on 2026-08-05

**Implementation plan:** [2026-08-05-activity-duration-formatting_plan_completed.md](../plans/2026-08-05-activity-duration-formatting_plan_completed.md)

## Problem

The active-session status badge formats every duration over one minute as total minutes plus seconds. Long-running work therefore produces labels such as `2630m 45s`, which are difficult to scan.

## Required Behaviour

- Keep the current `Ns` display below one minute.
- Keep the current `Nm Ns` display from one minute through 59 minutes 59 seconds.
- At one hour, switch to `Nh Nm` and omit seconds.
- At 24 hours, switch to `Nd Nh Nm`.
- Floor partial units so the label never reports time that has not elapsed.
- Preserve the current three-second visibility delay and active-status behaviour.

Examples:

- `59s` stays `59s`.
- `59m 59s` stays `59m 59s`.
- `60m 00s` becomes `1h 0m`.
- `2630m 45s` becomes `1d 19h 50m`.
- `24h` becomes `1d 0h 0m`.

## Design

Keep formatting local to `ActivityStatusComponent`, where it is currently used. Extend the existing pure `formatElapsed` helper with hour and day branches; do not change timer cadence, component inputs, or any caller. Exercise the rendered component with fixed `Date.now()` values so the tests cover the user-visible output rather than private implementation structure.

## Verification

- Focused component spec covering seconds, minutes, the one-hour boundary, the screenshot-scale duration, and the 24-hour boundary.
- Project TypeScript, lint, LOC, main-process build, and full quiet-test gates.

## As Built

`ActivityStatusComponent` now retains seconds below one hour, emits hours and
minutes from one hour, and emits days, remaining hours, and minutes from 24
hours. The rendered component spec covers the exact boundaries and the
screenshot-scale example. No caller, timer, visibility, or active-status logic
changed.

Both TypeScript configurations, lint, the LOC ratchet, and `build:main` passed.
The unsharded full test run exhausted a Vitest worker's 4 GB heap without an
assertion failure; the documented four-way shard fallback then passed all
1,730 files and 18,020 tests. A fresh completion-gate reviewer independently
returned `VERDICT: PASS` with no findings.
