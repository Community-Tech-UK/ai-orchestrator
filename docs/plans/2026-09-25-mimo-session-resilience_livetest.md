# MiMo session resilience — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: none — chat-directed implementation (2026-09-25, "all" of the four
session-resilience fixes). Related open plan's checks:
[2026-09-23-mimo-token-plan-allowance_livetest.md](2026-09-23-mimo-token-plan-allowance_livetest.md)
(Checks 1 & 2 were blocked on the console session; the renewal work below is
what unblocks them).

## What was implemented (in-loop verified; unit/integration level)

1. **Probe throttling** — the OpenCode console-API probe now has a 5-minute
   floor (`OPENCODE_QUOTA_PROBE_MIN_INTERVAL_MS`, `ThrottledAccountQuotaProbe`
   wrapper) instead of running on every 60s idle tick; the chip's Refresh
   button bypasses it via `force`.
2. **Session auto-renewal** — on 401/403 the probe walks the platform's own
   `loginUrl` (Xiaomi SSO, host-whitelisted to `account.xiaomi.com`, max 6
   hops, 30-min attempt cooldown) with the persistent account cookies from
   Chrome and re-pulls the quota once before surfacing reauth
   (`mimo-console-session-renewer.ts`). Verified live in research on 2026-09-25
   (a rejected session accepted the same cookies again after the walk).
3. **Stale numbers are marked** — cached bars under an expired login now carry
   `needsReauth` + the instruction (chip renders "X% ⚠" + a reauth row;
   ordinary transient failures stay quiet), and a one-shot `quota-reauth`
   notification fires on the expiry transition.
4. **Monitor cookie reads are lock-proof** — `poller.py` (and AIO's
   `MimoConsoleCredentialsReader`) fall back to a temp-file snapshot of
   Chrome's Cookies DB (+ rollback journal, opened read-write for journal
   recovery) when the live store is locked. Keychain access was verified
   healthy (`~/.usage/keychain_blocked.json` empty; no grant prompt needed).

## Prerequisites

- A rebuilt, restarted Harness app from this checkout (`npm run build:main` +
  `npm run build:renderer` pass; restart so main-process probe wiring and the
  renderer chip ship together).
- token-usage-monitor's poller restarted or next tick (its copy-read fix is in
  `~/work/token-usage-monitor/poller.py`).
- For the renewal checks only: the MiMo console session may be dead or alive;
  both paths are checkable.

## Check 1 — OpenCode row is present and live

- Steps: open the app; click the provider quota chip strip; find the OpenCode
  row (code `OC`, last in the list, after Grok — the popover scrolls).
- Expected: **Plan** and **Monthly** windows in real token counts
  (`unit: tokens`, e.g. `2831074720/38000000000`), the plan name (e.g. **Pro**),
  and a reset date. NOT the cached `percent` shape (`1.047%`).
- Related: this also closes Checks 1 & 2 of the
  [2026-09-23 mimo-token-plan livetest](2026-09-23-mimo-token-plan-allowance_livetest.md).

## Check 2 — Stale session is marked, not hidden

- Steps: with the app open, sign OUT of the MiMo console in Chrome (or wait for
  a natural rejection), click the OpenCode row's **Refresh**.
- Expected, if renewal cannot save it: the strip shows `OC <n>% ⚠` and the
  popover shows "⚠ Reauth needed — Click Refresh to renew the session via
  Xiaomi SSO, or sign in to the MiMo console in Chrome"; one OS notification
  ("opencode usage numbers are stale") fires once, not on every refresh. The
  cached bars stay visible with an old "updated …" age.

## Check 3 — Auto-renewal heals without a sign-in

- Steps: same starting point as Check 2 (rejected session), then click
  **Refresh** on the OpenCode row while still signed in to the Xiaomi account
  in Chrome (`account.xiaomi.com` cookies present).
- Expected: within a few seconds the row returns to live token counts and the
  ⚠/reauth row disappears — no login typing, no new tab required. A log line
  `MiMo console session renewed through Xiaomi SSO` appears in the app log.

## Check 4 — Polling is throttled; Refresh still instant

- Steps: leave the app idle ~10 minutes with the OpenCode model on a
  `xiaomi-token-plan-*` setting; then click the OpenCode row's **Refresh**.
- Expected: console-API traffic (proxy/log or firewall view) shows the quota
  probe at ≤ 1 request per 5 minutes while idle; the Refresh click returns
  updated numbers immediately (force bypass).

## Check 5 — Monitor cache un-freezes

- Steps: after the poller's next tick (≤10 min), inspect
  `~/.usage/state.json`'s `mimo` entry `updated_at`.
- Expected: `updated_at` is within the last ~10 minutes (it was frozen at
  2026-09-23 03:04 before the fix), and `~/.usage/poller.log` no longer shows
  `chrome cookie db busy … OperationalError` as a persistent state.

## Status

Not yet run — requires the rebuilt/restarted app (out of loop). All in-loop
verification (unit suites: renewer/probe/reader/composite/service specs +
30 monitor `unittest` tests) is green; the renewal walk itself was demonstrated
live during research (2026-09-25).

## Status — 2026-10-04

Open: 3 of 5. Check 1 PASS, Check 4 PASS. Checks 2 and 3 NOT RUN: they need a rejected console session, and the session is
currently valid (a live quota read succeeded), so producing one would mean signing James out of the MiMo console or
tampering with his Chrome cookies. Check 5 is BLOCKED by a macOS permission on the token-usage-monitor side that needs
James. The 2026-09-25 "Not yet run" status above is superseded. Evidence:
[Evidence run — 2026-10-04 (batch C)](#evidence-run--2026-10-04-batch-c).

## Evidence run — 2026-10-04 (batch C)

Dev app (isolated profile `/tmp/aio-lt-1004-c`, port 9481, focus emulation on, HEAD `3d05e250e` working tree), with
`defaultModelByProvider.opencode = xiaomi-token-plan-ams/mimo-v2.6-pro` during the checks (restored to the original `{}`
and re-read afterwards). Evidence copies in `_scratch/lt-2026-10-04/c/` (`throttle-samples.log`, `popover-dom.json`,
`poller-mimo-tail.log`, screenshots).

### Check 1 — OpenCode row present and live: PASS

The chip strip shows `OC 90%` (OpenCode is last, after Grok, in both strip and popover). The native console probe
returned `source: "admin-api"`, `unit: "tokens"`, plan `Pro`, Plan and Monthly windows 34,071,234,280 of 38,000,000,000,
`resetsAt` 2026-10-22 23:59:59 UTC, **not** the cached `percent`/`1.047%` shape. Where the numbers show on screen: the
strip tooltip (`OpenCode: Plan: 34071234280 of 38000000000 tokens`) and Settings -> Provider Quota (`Signed in · Pro`, token
counts). The chip popover itself renders percentages only (`provider-quota-chip.component.ts:480`), so the doc's "real
token counts" wording applies to the tooltip and Settings, not the popover rows. Judged against intent: PASS.

### Check 2 — stale session marked, not hidden: NOT RUN

Requires a rejected console session. The session is valid today, so there is nothing to mark. No safe way to force a
rejection exists in the isolated dev profile: the console cookies come from James's real Chrome. I did not sign him out.

### Check 3 — auto-renewal heals without a sign-in: NOT RUN

Same precondition as Check 2 (a rejected session). I did not find a `MiMo console session renewed through Xiaomi SSO`
log line in the window, consistent with the session never having been rejected during this run.

### Check 4 — polling throttled, Refresh still instant: PASS (probe cadence inferred from snapshot timestamps)

Method: sampled `quotaGetProvider('opencode').takenAt` every 20 s (`throttle-samples.log`, 45 samples) as the proxy for "a
console probe ran" (a throttled probe returns null and stores nothing). I did not have a proxy or firewall view of the
console API traffic, so this is indirect.

- Forced refresh at 22:34:22Z (the chip/Settings Refresh path): fresh numbers immediately. Three forced refreshes within
  about 70 s (22:33:13Z, 22:34:14Z, 22:34:22Z) each returned a new `takenAt` at once.
- Then idle. A 60 s-debounced turn-complete refresh at 22:36:05Z (my "pong" turn) and another at 22:39:13Z both produced
  **no** new snapshot. The next new snapshot was 22:39:53Z, then 22:44:53Z, exactly 5:00 later. Probes in the whole
  ~16 minute window: 22:34:22 (forced), 22:39:53, 22:44:53 only, which is <= 1 per 5 minutes.
- Caveat: no probe appears at about 22:49:53Z. At 22:45:10Z the dev app's pause state switched to
  `isPaused: true, reasons: ["vpn"]` (automatic VPN detection on the host), so idle ticks stopped; the missing 22:49:53
  probe is therefore not evidence either way.

### Check 5 — monitor cache un-freezes: BLOCKED (macOS permission, needs James)

`~/.usage/state.json` `mimo` entry: `updated_at` 2026-10-03T17:23:05Z (about 30 hours old at test time),
`attention: "chrome_cookie_access_needed"`. `~/.usage/poller.log` (copy in `poller-mimo-tail.log`) shows every cycle, for
example 23:32:41 BST: `mimo: chrome cookie db unreadable (OperationalError: unable to open database file) — retrying from
a snapshot`, then `chrome cookie snapshot copy failed (PermissionError: [Errno 1] Operation not permitted: '.../Google/Chrome/
Default/Cookies')`, `mimo: helper copy exited 3`, and `macOS denied this process access to Chrome's cookie store
(/opt/homebrew/opt/python@3.14/bin/python3.14). Grant Full Disk Access to /Users/suas/Applications/Token Usage Monitor
Helper.app ...`. So the poller cannot read Chrome's cookies at all right now. That is a different failure from the
"database busy" lock this fix targets (the snapshot copy never succeeds because macOS blocks the read), so the expected
`updated_at` within about 10 minutes cannot be reached until Full Disk Access is granted to the helper (it is installed at
`~/Applications/Token Usage Monitor Helper.app`, built 2 Oct). Not attempted from here: it is a System Settings (TCC)
change. Not a code defect found in the lock-proofing itself; the lock-proofing path is never reached.
