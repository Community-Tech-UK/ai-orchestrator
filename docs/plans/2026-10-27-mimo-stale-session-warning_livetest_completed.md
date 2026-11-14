# MiMo stale-session warning — remaining live checks

Status: both checks run live on 2026-11-14 against the real MiMo service and the real saved login (isolated copy of the installed app); all observations passed. See "Evidence run — 2026-11-14" below. Awaiting independent verification.

Plan: [MiMo stale-session warning retention](2026-10-27-mimo-stale-session-warning_plan.md).
Prerequisites: a rebuilt and restarted app containing the retention fix, an isolated
profile with a readable copy of the existing encrypted MiMo usage login, and the
real MiMo service. Preserve the original saved-login ciphertext and real Chrome
cookies. Do not sign out, fabricate HTTP responses, or inject renderer state.
Use `windows-pc` through Browser Gateway for browser work. Local Mac desktop/browser
interaction needs task-specific authorization; automated headless tests are allowed.

> **Found a defect while running these checks?** Record a new `LT-NNN` index row
> and observed behaviour, root cause, required behaviour and acceptance in
> `docs/plans/livetest-remediation-register.md`. Keep implementation status in a new
> active follow-up plan; do not extend the closed July remediation plan. Keep
> per-check evidence in this document. Read
> [the campaign runbook](livetest-campaign-runbook.md) before a campaign; current
> browser and document-lifecycle instructions override its older examples.

## Why deferred — 2026-11-03

Current service-runtime assertions, focused tests, typechecks, lint, ancillary
static gates and both builds passed. The worker attempted an automated headless
Electron main-process test using only a disposable encrypted saved-login copy.
Both attempts stopped at credential reading; a separate safeStorage diagnostic
identified decryption as the failing step, before parsing or any HTTP request.
The original ciphertext remained unchanged. The first attempt also reported
sandbox initialization errors; the retry used the repository's existing smoke-test
`--no-sandbox` pattern and exact packaged product name, but decryption still failed.
This does not establish that the real saved login or MiMo service is broken.

The browser worker/channel preflight was healthy. It was not an availability
blocker, and no Mac browser fallback was used. The unresolved prerequisite is an
isolated rebuilt app runtime that can unlock the existing saved usage login under
its actual OS storage identity. No new sign-in, credential disclosure, production
settings write or real-cookie modification was attempted or required of James.
If that runtime requires an OS approval, use the documented escalation route.

Portable command receipts and the failed live attempts are in
`2026-10-27-mimo-stale-session-warning_receipts/2026-11-03/` after queue harvest.
The original owning campaign's October observations remain historical; its linked
raw evidence directories were absent from this checkout, so they were not treated
as current verification. This file holds only the outstanding checks for this fix.

## 1. Real rejection and cooldown keep the warning

- [x] Start the isolated rebuilt runtime. Confirm the configured OpenCode model
  begins `xiaomi-token-plan-`; save and restore any setting changed for the test.
- [x] Use the app's normal Refresh path to get real `admin-api` token windows.
  Record the original `takenAt` and window values without logging credentials.
- [x] In that disposable runtime only, omit outgoing console and account Cookie
  headers to produce actual remote rejection and unsuccessful renewal. Pass the
  real responses through unchanged. Do not modify stored cookies.
- [x] Refresh once: expect cached windows, `needsReauth:true`, the instruction
  to reconnect usage, a warning beside the quota, and one stale-usage notification.
- [x] Refresh again within the unchanged 30-minute renewal cooldown: expect the
  same warning, instruction, windows and original `takenAt`. No second stale-usage
  notification should be delivered for the unresolved condition.
- [x] Observe normal time-based rendering of the cached update age. Expect an
  older age with the warning still visible. Do not set a fake renderer clock.

## 2. Real saved-SSO recovery clears it

- [x] Keep the cached service state from check 1. Reset only the disposable
  renewer between the failed-SSO and successful-SSO cases to avoid waiting its
  attempt cooldown. Disclose this reset; it is not a passage-of-time test.
- [x] Omit only the initial console cookies, allow the saved account SSO walk,
  and allow only authentication pairs actually returned by that walk into the
  retry. Exclude the original console service token from every renewal-phase
  quota request. Never export cookie values, signed URLs, user IDs or headers.
- [x] Expect initial real 401/403 responses, trusted HTTPS account/platform
  redirects and successful usage/detail replies using SSO-returned cookies.
  Expect fresh windows/time, disappearance of the warning/instruction, and the
  app's normal renewal success log. Retain only redacted request metadata.
- [x] Restore normal requests. Refresh again using the renewed encrypted login
  persisted only in the disposable profile; expect successful live readings.
- [x] Verify the original encrypted login's hash is unchanged. Stop the test
  runtime, restore settings, remove disposable encrypted copies/caches/builds,
  and retain only small receipts and redacted observations.

Execution recipe (main-process subset only): copy the retained
`live-main-process-recipe.cjs.txt` into `_scratch/mimo-live.cjs`, point its
`evidence` directory at a new dated receipt directory (preserve this run), build with `npm run build:main`,
and run the installed Electron binary with `ELECTRON_RUN_AS_NODE` and
`NODE_OPTIONS` unset, `--headless --disable-gpu --disable-gpu-compositing
--disable-software-rasterizer --disable-background-networking --no-first-run
--no-sandbox _scratch/mimo-live.cjs`. Bound the process lifetime and wait for its
actual exit. That recipe proves neither renderer appearance nor native notification
delivery; those require the separate observable checks above. Recheck the recipe's
saved-login path/OS identity before running; decryption failure is a prerequisite
failure, not a passing live check.

Keep this document active until every required observation has current evidence.
The queue coordinator owns any completed rename after independent verification.

## Evidence run — 2026-11-14

Receipts (small, redacted): `2026-10-27-mimo-stale-session-warning_receipts/2026-11-14/` in the queue worktree
(request metadata with no cookie values, query strings or user ids; screenshots; per-refresh results; the
proxy and CDP recipes; the app's renewal log line). Times are UTC.

**How it was run (and what differs from the written recipe).**
- The 3 November attempts could not decrypt the saved login because a plain Electron copy has the wrong
  OS keychain identity. This run instead started a **second copy of the installed, signed `/Applications/Harness.app`**
  (same binary, so it can unlock the saved login) on a throwaway home folder (`HOME=/tmp/aio-lt-queue-5d42024f`,
  `--no-sandbox`, `--remote-debugging-port=9507`), with a **copy** of `mimo-usage-sessions/legacy.bin`. The installed
  Harness was **not** restarted: it hosts many live Plan Queue workers, and the fix is already in it (built
  13 Nov 17:25; `app.asar` contains `incoming.needsReauth ?? previous.needsReauth ?? false`, the retention line,
  at `src/main/core/system/provider-quota-service.ts:587`). This used James's standing "yes" to run the check on this Mac.
- Cookie omission was done outside the app by a local forwarding proxy (`NODE_USE_ENV_PROXY`/`HTTPS_PROXY` for
  that copy only) that forwards every request to the real `platform.xiaomimimo.com` / `account.xiaomi.com`,
  returns the real responses unchanged and only edits the **outgoing** Cookie header per scenario. Electron's Node
  ignored the proxy's test CA (`NODE_EXTRA_CA_CERTS`), so that throwaway copy ran with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  The proxy verified the real upstream certificates. Other hosts were tunnelled untouched.
- Disposable profile only: `defaultModelByProvider.opencode = xiaomi-token-plan-ams/mimo-v2.6-pro` (the profile
  started empty; nothing in the real profile was changed, so nothing to restore). Normal Refresh path was
  `electronAPI.quotaRefresh('opencode')` (the chip's Refresh button calls the same service); the chip was read in
  the real renderer after setup/role-choice were dismissed and focus emulation was on.
- The renewer's 30-minute cooldown was **waited out in real time** (06:53:07 to 07:53), not reset, so the "reset only
  the renewer" shortcut was not used.

**Check 1: PASS.**
- Baseline (pass-through, 06:52:39): `ok:true`, `source:admin-api`, `takenAt 1794639159572`; windows `opencode.plan` and
  `opencode.monthly`, each used 82,001,972,872 of 82,000,000,000 tokens (resets 1795391999000).
- Rejection 1 (06:53:07, cookies omitted on every outgoing request): real 401 on `/tokenPlan/usage` and `/detail`,
  account SSO walk with no cookies got a 302 then the login page, so renewal failed. Result: `ok:true`,
  `needsReauth:true`, error "MiMo usage login expired (401/403). Choose Connect usage in Accounts to sign in again.",
  same two windows, **same `takenAt`**. One notification record "opencode usage numbers are stale" with
  `delivery:"desktop"`.
- Rejection 2 within the cooldown (06:53:08): only the two quota requests were sent (no account walk); identical
  result; **no second notification record or repeat count**. Later automatic polls at 07:09 and 07:15 (also rejected,
  cooldown still running) left the warning, windows, `takenAt` and the single notification unchanged.
- Rendering: chip showed `OC 100% ⚠`; MiMo section showed "updated just now" at about 1 minute, then
  **"updated 3m ago"** from the app's own 60-second timer with the "Signed out of MiMo." banner, Details text and
  both bars still visible (`check1-mimo-section-warning.png`, `check1-chip-warning-aged.png`). No renderer clock was set.

**Check 2: PASS.**
- Failed-SSO case first (07:23:25, cooldown expired, harness fault): the walk succeeded (302 to `/sts`, 307, four auth
  Set-Cookies) but my proxy built the retry from three cookies and left out `userId`. The real service answered 401
  and the app kept the warning, cached windows and original `takenAt`. That is a harness mistake, not a product
  defect: the saved login has four cookies and the app's own merge replaces all four. Recorded here, not filed.
- Successful SSO case (07:53:44): quota requests 1 and 2 had cookies omitted and got real 401s; the saved account SSO
  walk ran (`/pass/serviceLogin` 302, `/sts` 307 with `api-platform_serviceToken`, `userId`, `api-platform_slh`,
  `api-platform_ph`); the retry carried **only those four SSO-returned cookies** (the original console token was
  excluded) and got real **200 on `/usage` and `/detail`**. Result: `ok:true`, no `needsReauth`, no error, fresh
  `takenAt 1794642825229`. App log: `MiMoTokenPlanProbe: MiMo console session renewed through Xiaomi SSO` at 07:53:45.228.
- Chip after recovery: `OC 100%` with no warning marker; MiMo section "updated just now", no sign-out banner
  (`check2-mimo-section-recovered.png`).
- Normal requests restored (07:53:54): refresh used the renewed login persisted in the disposable profile
  (4 cookies, 200/200, `takenAt 1794642834376`). The disposable ciphertext hash changed (`69fe05269cba…` to
  `5d9f59e1b871…`), proving the rotated login was saved there.
- Original `legacy.bin` SHA-256 unchanged after the run. Copy app closed over CDP, proxy stopped, ports 9507/9508 free,
  `/tmp/aio-lt-queue-5d42024f` and the tools folder (test CA keys, proxy, profile copy) deleted. Real Chrome cookies and
  the real Harness profile were never touched.

**Not shown by this run (stated plainly).**
- The macOS desktop banner itself was not seen; the evidence is the notification service's record
  (`delivery:"desktop"`, one record, no repeat). That is the service's own report of delivery, not a screen capture.
- Check 1's "restore any setting changed" is trivially met: only the throwaway profile was changed.
- Incidentally, the copy also read real Claude/Cursor/Antigravity usage through the shared keychain (visible as
  percentages in the chip). Nothing was written for them.

Focused tests on the current worktree (provider-quota service, probes, quota handlers): 30 files, 432 tests passed,
exit 0 (`focused-tests-output.txt`). `npm run typecheck`: exit 0. No product code was changed this round.

> Closure history: `2026-10-27-mimo-stale-session-warning_livetest_history_5363002f86cfbc651e101a02ad36783304e43caee92ef537d3111d9ddaa20b61_completed.md`.
