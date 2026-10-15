# MiMo usage login/refresh token persistence — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section in `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file. Never record cookie values, tokens or login screenshots containing
> secrets.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [MiMo usage login/refresh token persistence](2026-10-14-mimo-usage-login-token-persistence_plan_completed.md).

Status: pending. Prerequisites: a rebuilt and restarted Harness app containing this fix
(`npm run build:main` + `npm run build:renderer` pass in the checkout; install/restart through the
normal pipeline), James's existing MiMo account configuration and saved usage sessions, and a
natural console-session expiry (the Token Plan console cookies expire on their own — the app's own
quota probe hitting 401/403 is the trigger).

Why deferred: these checks need the rebuilt app, a real Xiaomi session and a natural expiry/rotation
to observe. Nothing here can be forced safely — deliberately breaking James's console session or
signing him out is not an acceptable test step. All agent-runnable gates pass in-loop.

## Check 1 — a natural console expiry renews without a sign-in

- Steps: use the rebuilt app normally on a `xiaomi-token-plan-*` model until the console session
  expires naturally (the probe logs a rejected quota read). Watch `app.log` around the next probe.
- Expected: a `MiMo console session renewed through Xiaomi SSO` info line; **no**
  `MiMo session renewal left the Xiaomi hosts` and no `MiMo session renewal stopped before a
  non-https hop` warning; the OpenCode/MiMo quota row returns to live numbers without the
  `needsReauth` warning and without clicking **Sign in to usage again**.
- Evidence to record: the two log lines (timestamps only) and the quota row state before/after.

## Check 2 — the rotated login/refresh cookies survive renewal

- Steps: after Check 1 has passed once, wait for a second natural expiry (hours to days) and observe
  the next renewal.
- Expected: the second renewal also succeeds with no sign-in. This is the proof that the rotated
  SSO ("refresh") cookies were persisted on the first renewal; without that the second walk would
  fail and surface the sign-in state.
- Evidence to record: both renewal log lines with timestamps and that no sign-in happened between.

## Check 3 — no manual re-login over several expiry cycles

- Steps: over the following days, note any appearance of "MiMo usage login expired" /
  "Sign in to usage again" in Accounts or the quota chip.
- Expected: none while James remains signed in to the Xiaomi account in principle (SSO valid).
  A real Xiaomi logout/password change may still require one manual sign-in — that is expected and
  out of scope.
- Evidence to record: date-stamped observation (or "none seen since \<date\>").

## Check 4 — genuine reauth still works when SSO is gone

- Steps: if it happens naturally (e.g. a real Xiaomi logout), confirm the app shows the existing
  reauth guidance and that **Sign in to usage again** restores the session.
- Expected: unchanged behaviour — the fix must not paper over a truly dead SSO login.
- Evidence to record: the guidance text seen and that the sign-in flow saved the session again.
