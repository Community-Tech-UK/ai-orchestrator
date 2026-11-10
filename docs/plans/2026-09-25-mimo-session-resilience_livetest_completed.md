# MiMo session resilience — Live Test

**Current worker status — 2026-10-27 (partial correction, verification blocked):**
all five live checks retain their dated passing evidence and disclosed limits.
The pre-commit correction is implemented: documentation-only changes skip build/tests;
source changes build workers before related tests. Both real hook paths, focused tests,
static gates and both builds passed. The full suite exited 1 on one unchanged queue
case, which then passed in isolation. Shared-host load subsequently exceeded 100;
a clean full-suite result and fresh independent review remain pending under the
campaign load limit. This is not completion or a new live observation. Coordinator
closure/integration and completed renames remain pending. Cleanup is recorded below.

**Update 2026-11-08:** the queue branch's merge with `main` was repaired (register ID collision and hook build placement), targeted hook checks passed, and a fresh read-only monitor reading was taken. The five live checks keep their dated evidence; the full-suite pass and fresh independent review above are still open. See the last section.

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

On main: yes (this landing commit)
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

## Evidence run — 2026-10-27 (Plan Queue, saved-session path)

**Result: Check 5 PASS. Checks 2 and 3 remain OPEN because no rejected session was observed.**
Check 1 was also rechecked successfully. Check 4 retains its dated 2026-10-04 idle-cadence
evidence; this run rechecked only its manual Refresh bypass. Overall: **3 of 5 checks passed,
2 open**. This supersedes the earlier classification of Check 5 as needing James.

The selected path was “Check current saved-session renewal and monitor readings without
signing out.” No logout, cookie modification, credential entry, browser sign-in, or permission
change was performed. The missing rejection is a test precondition, not a human-authority
blocker. No action from James is required for the checks completed here.

### Environment and retained evidence

- Built and launched from the assigned queue worktree at `80412201a`, with
  `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-71493f81` and debug port `9822`.
  Renderer HTTP port: `4579`. Only the encrypted `legacy.bin` saved usage login was copied
  into the disposable profile; no decrypted cookies or account identifiers were exported.
- Both `npm run build:main` and `npm run build:renderer` passed. The final app used the
  freshly built production renderer served from this worktree. Ordinary `ng serve` hit the
  already-recorded `_PlatformLocation` JIT/linker failure, so its empty DOM was excluded from
  assertions (same harness issue documented in
  `docs/superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest_completed.md`).
- The agent-shell launch required the test-only `--no-sandbox` flag documented in
  `docs/testing.md`, plus the normal 8 GiB main-process heap flag supplied directly to avoid
  the blocked Electron relaunch. No application source or production sandbox setting changed.
- Focus emulation was enabled before every assertion. This Chromium did not implement
  `Emulation.setPageVisibilityOverride`; each capture independently asserted
  `document.hidden === false` and `visibilityState === 'visible'`. DOM captures awaited
  animation frames and used normal Angular rendering, without forced change detection.
- Retained receipts and observations are in
  [`2026-09-25-mimo-session-resilience_evidence/2026-10-27/`](2026-09-25-mimo-session-resilience_evidence/2026-10-27/)
  in the queue worktree. `command-receipts.jsonl` records actual command exits;
  `verification-seal.json` records hashes. This owning document is the report and remains
  at its supplied absolute path in the root checkout; it was not copied into the worktree.

### Check 1 — OpenCode row is present and live: PASS (rechecked)

At 02:33:36 UTC, the native `admin-api` snapshot reported `ok: true`, plan `Max`, and
Plan/Monthly windows of **76,748,728,372 / 82,000,000,000 tokens**, both with reset
`2026-11-22T23:59:59Z`. At 02:33:45 UTC the actual chip showed `OC 94%`; the OpenCode
popover showed both Plan and Monthly rows with reset countdowns, and no reauth row.
See `app-live-refresh.json` and `live-dom.json`. As the 2026-10-04 evidence already noted,
the popover renders percentages; the native snapshot carries the full token counts.

### Check 2 — stale session is marked, not hidden: OPEN (precondition not observed)

Two actual OpenCode-row Refresh button clicks at 02:34:11 and 02:34:43 UTC produced
fresh `admin-api`, `ok: true` snapshots with token windows. Neither response had
`needsReauth`, and neither rendered a reauth warning. See `ui-refresh-one.json` and
`ui-refresh-two.json`.

This proves that the current saved login is usable, not that cached figures and the one-shot
OS notification behave correctly after rejection. No real 401/403 rejection occurred in the
observed path, and no artificial response or renderer state was substituted. Cached-bars
retention, stale age, warning wording, and notification deduplication therefore remain untested
live. Rerun those assertions when a natural rejected-session/failed-renewal transition occurs.
There is no remaining credential lookup or permission task identified for James.

### Check 3 — auto-renewal heals without a sign-in: OPEN (precondition not observed)

The saved login returned live counts directly. The final isolated app's captured log contained
zero `MiMo console session renewed through Xiaomi SSO` lines and zero renewal-failure lines
(`renewal-log-scan.json`). That is consistent with the successful direct reads; it is not proof
that renewal succeeded. No SSO walk, cookie rotation persistence, or warning-clear transition
was observed. Rerun when a naturally rejected quota response supplies the renewal URL, then
require both fresh native counts and the success log. The selected no-sign-out path did not
provide that starting state. This remains an unmet runtime precondition, not “needs James.”

### Check 4 — polling is throttled; Refresh still instant: prior PASS retained

The 2026-10-04 five-minute cadence observations remain the evidence for the idle half; a new
ten-minute idle campaign was not run because this was already closed. The manual bypass was
rechecked: two UI Refresh clicks about 32 seconds apart each advanced `takenAt` and returned
fresh native token counts, taking **191 ms** and **1,401 ms** respectively. No API proxy or
firewall traffic capture was made, so this run adds no claim about idle request counts.

### Check 5 — monitor cache un-freezes: PASS

Read only the MiMo entry in the existing monitor state and the matching poller log lines.
At 02:31:31 UTC, `updated_at` was `1793067725.272871`
(`2026-10-27T02:22:05.272871Z`, age 566 seconds). The next observation at 02:33:29 UTC
showed `updated_at: 1793068330.719637`
(`2026-10-27T02:32:10.719637Z`, age 78 seconds), an advance of approximately 605 seconds.
The reading reported plan `Max`, Plan/Monthly **93.58105128292684%** used, without an
`attention` field. See `monitor-before.json` and `monitor-after.json`.

The retained log excerpts show repeated successful `[direct]` polls at 02:01:55, 02:11:59,
02:22:05 and 02:32:10 UTC, including:

```text
[2026-10-27 02:32:10] mimo: ok (Max; plan 93.6%, monthly 93.6%) [direct]
```

The observable frozen-cache condition and persistent cookie-access failure from October 4
are absent on the current monitor path. No permission change or poller restart was needed.
This verifies fresh monitor readings; it does not claim that a locked Chrome database or the
snapshot-recovery branch was exercised in this run.

### Verification, defects and handoff

- `npx tsc --noEmit`, `npm run typecheck:spec`, and both builds exited 0.
- The focused probe, renewer, saved-session persistence/recovery, quota-handler and quota-chip
  suites passed (6 files, 120 tests). These are supplementary regression evidence and do not
  close the two unexercised live transitions.
- No product source or tests changed, and no new product defect was reproduced. The known
  dev-server linker problem and agent-shell sandbox restrictions were harness setup issues,
  so no new remediation-register item was created. Full-suite/lint gates were not rerun for
  this evidence-only task. No real expired-session notification, Chrome-lock recovery,
  external browser, or real-profile app UI was tested.
- The historical `livetest-backlog.md` now explicitly says not to add current status there;
  this owning document holds the current result instead.
- Restored the disposable model setting to `{}` and read it back (`settings-restored.json`).
  The final dev app and renderer server stopped at 02:35:29 UTC. No provider sessions,
  automations, branches or worktrees were created, and nothing was committed or staged.
- Evidence retention and runtime cleanup receipts follow in the evidence directory. The
  coordinator owns independent verification and any eventual document rename. Checks 2
  and 3 must remain open unless a later run actually observes their required transitions.

Cleanup confirmed at 02:38:33 UTC: all eight recorded Electron/server process IDs were gone,
both test ports refused connections, and the disposable profile, generated `dist/` tree,
Angular cache, scratch helper directory and this run's raw test artifacts were removed.
No dependencies or browser binaries were installed. Pre-existing dependencies and the
AIO-managed worktree were preserved. See `runtime-stopped-check.json` and
`cleanup-receipt.json`. Retained command output uses `*-output.txt` filenames so it is not
lost to the repository's log-file ignore rule. The evidence directory is currently under
the assigned queue worktree; its relative links resolve from the repository after harvest.


## Evidence run — 2026-10-27 (verification follow-up, controlled live rejection)

**Live result: Checks 2 and 3 PASS after repairing LT-782. All five checks now have
passing evidence.** Checks 1 and 5 were rechecked in this run; Check 4 retains its
passing dated observations above. This supersedes the previous run's two unmet
rejection preconditions. Project gates and the fresh independent review passed; cleanup is recorded below.

### Method, authority and evidence access

Used the assigned worktree, isolated profile `/tmp/aio-lt-queue-71493f81`, renderer
port 4579, renderer debugging port 9822 and loopback-only main-process debugging
port 9823. Both production builds passed. The app loaded the built renderer through
a disposable Node static server; the earlier Python server reset concurrent module
connections and its blank screen was excluded from assertions. Focus emulation was
enabled before every renderer observation; captures asserted `document.hidden:false`
and `visibilityState:visible`, awaited animation frames, and used normal Angular
rendering. No forced change detection or renderer-store seeding was used.

The selected no-sign-out path was preserved. Copied only the existing OS-encrypted
saved login into the disposable profile. A temporary main-process fetch wrapper
omitted outgoing console Cookie headers to induce **real MiMo HTTP 401 responses**.
For the failed-renewal case it also omitted outgoing Xiaomi account cookies. It
returned the actual remote responses unchanged: no fake HTTP status/body, fabricated
quota snapshot or warning injection. No Chrome cookie or real saved-login file was
modified, and no logout, login typing or credential disclosure occurred. Network
receipts retain only host, path, status and cookie-omission/count metadata; signed
URLs, query strings, user IDs and cookie values were not exported.

Between independent failed-SSO and successful-SSO scenarios, replaced only the
disposable probe's renewer with a fresh production renewer to reset its 30-minute
attempt budget. Cached quota, warning state and notification history were retained.
This tests actual renewal I/O and recovery, **not** the passage of the cooldown
interval. The repeated-failure test itself uses the real unchanged cooldown.

Evidence is in [the follow-up evidence directory](2026-09-25-mimo-session-resilience_evidence/2026-10-27-round2/).
All document links use repository-relative paths. Evidence files are retained in
the assigned queue worktree until the coordinator harvests them into the root checkout;
the root document's evidence links therefore become available there after harvest. No copy of this owning document or of runtime/dependencies was
placed in a plan directory. Some initial setup retries reused an output filename;
their command receipts explicitly mark the overwritten logs while preserving every
recorded nonzero exit. Passing evidence uses the final successful attempts.

### Check 1 — OpenCode row present and live: PASS, rechecked

At 02:53:55 UTC, `baseline-fixed.json` recorded native `admin-api`, `ok:true`, plan
Max, Plan and Monthly **77,099,894,112 / 82,000,000,000 tokens**, reset
`2026-11-22T23:59:59Z`. The real chip showed `OC94%` and both window rows. Full
counts are in native snapshots; the popover still displays percentages as described
in the earlier evidence, rather than the original procedure's implied raw counts.

### Check 2 — stale session marked and cached bars retained: PASS after LT-782 fix

Before the fix, `rejected-refresh-one.json` and `rejected-network-one.json` show a
real rejected quota read, the unsuccessful Xiaomi walk and a rejected quota retry.
The chip correctly showed `OC94% ⚠`, retained both bars and emitted a
`quota-reauth` notification with `delivery:desktop`. The next real Refresh again
received 401 but **cleared** `needsReauth` and the warning while renewal was on its
cooldown (`rejected-refresh-two.json`, `rejected-network-two.json`). Filed this as
[LT-782](livetest-remediation-register.md#lt-782).

The smallest fix is in `retainLastKnownQuotaWindows`: a windowless failure without
an authentication verdict preserves the existing warning and original instruction.
An authoritative successful snapshot, explicit false verdict or normal source/config
invalidation still replaces it. After rebuilding and restarting the actual app:

- At 02:54:05 UTC, rejection rendered the warning and both cached bars.
- At 02:54:21 UTC, a second actual Refresh during the real renewal cooldown kept
  `needsReauth:true`, the original instruction, the same two token windows and the
  original `takenAt:1793069634931`. See `rejected-refresh-one-fixed.json` and
  `rejected-refresh-two-fixed.json`.
- `rejected-network-fixed.json` records **exactly one** `quota-reauth` notification
  for that unresolved expiry, titled `opencode usage numbers are stale`, with
  `delivery:desktop`. This is native delivery evidence; the macOS banner's visual
  presentation was not separately observed.
- A separate aged-cache observation at 02:56:58 UTC displayed **updated 1m ago**,
  with `needsReauth:true`, two bars and unchanged `takenAt:1793069737768`, aged
  80,453 ms (`stale-age-visible.json`). Focus stayed emulated while waiting for
  the component's normal minute timer; no clock or state was injected.

Current saved-login wording is **Reauth needed — MiMo usage login expired
(401/403). Choose Connect usage in Accounts to sign in again.** The old procedure's
Chrome-specific instruction predates saved account logins. Current production code
uses the saved-login instruction (`mimo-usage-credentials-reader.ts`,
`reauthError('rejected')`); the expiry warning, retained figures and one-shot behavior
are the acceptance intent. This wording difference is recorded, not hidden.

### Check 3 — saved SSO renewal restores live counts: PASS

`renewed-network.json` records initial real usage/detail **401** responses at
02:55:36 UTC, then the saved Xiaomi account request to `/pass/serviceLogin`
(**302**) and platform `/sts` (**307**, five Set-Cookie entries), followed by real
usage/detail **200** responses at 02:55:37 UTC. Only the initial console requests
omitted cookies; account SSO and the quota retry used the application's normal
credential handling. No browser or credential entry was involved.

The final probe returned live Plan and Monthly **77,103,518,412 /
82,000,000,000 tokens** with `takenAt:1793069737768` (02:55:37.768 UTC).
`renewed-refresh.json` captures the transition from a cached warning to a fresh
native snapshot: `needsReauth` is absent, both bars remain and the warning row
disappears. `renewal-log.json` retains the app's exact timestamped success line:

```text
[2026-10-27T02:55:37.768Z] [INFO] [MimoTokenPlanProbe] MiMo console session renewed through Xiaomi SSO
```

The production reader persisted the rotated session in the disposable encrypted
blob, including five rotated SSO pairs. Its ciphertext changed while the original
real-profile ciphertext remained byte-identical (`persistence` in
`renewed-network.json`). After the separate aged-cache case, an ordinary Refresh
with request omissions disabled read the saved session successfully again and
cleared the warning (`persisted-session-refresh.json`, `final-network.json`).

### Check 4 — prior passing evidence retained; Check 5 — PASS, freshly rechecked

Check 4's idle cadence remains the 2026-10-04 timestamp-based observation; this
follow-up does not claim a new ten-minute traffic campaign. Neither check was open
on resume.

At 03:14:13 UTC, a further read-only monitor check found an updated timestamp of
2026-10-27T03:12:34.432166Z, age 98.64 seconds, plan Max and Plan/Monthly
94.21675011219513% used (77.3B/82.0B), with no attention flag. Its timestamp advanced
beyond the earlier 02:32 reading, and retained poller success lines cover 03:02:28
and 03:12:34 UTC. See `monitor-followup.json`. This is current live freshness
evidence without restarting or changing the monitor. No locked Chrome database
recovery was exercised here.

### Implementation, verification and cleanup

- LT-782 is the only product fix. Added service regressions for provider-level
  and account-level warning retention/recovery, explicit-false replacement and
  account isolation, after the real fixed UI was verified. Existing assertions
  were preserved. Focused service/source-invalidation checks passed.
- The new implementation-status document is the untracked root-checkout
  `2026-10-27-mimo-stale-session-warning_plan.md`. The closed July plan was not
  extended with new work, in accordance with the completed-document rule.
- Verification status: all canonical project gates and the fresh independent review passed with no actionable findings. See command-receipts.jsonl, full-suite-pinned-summary.json and independent-review.txt.
- Runtime status: app and temporary file server stopped; settings restored to
  the original empty model map (`settings-restored.json`). Runtime deletion and
  final seal: complete (cleanup-receipt.json, verification-seal.json). The temporary dependency install and downloaded Electron binary were deleted; the original linked dependencies were restored.
- No commits, staging, branch/worktree changes, automations or provider sessions
  were created. The owning live-test document remains at its supplied root path
  and has not been renamed. The coordinator owns final verification and closure.

### Verification environment follow-up — 2026-10-27

The first full suite exited 1: 3 failures among 35,382 tests (`full-suite-output.txt`,
actual command receipt retained). The dependency-compatibility check correctly
rejected the original shared install because the root checkout had added the SDK
as a direct dependency while this branch retained its older manifests. This was
not bypassed or suppressed: the original links were moved temporarily into the
worktree scratch area and this branch received its own exact `npm ci` install.
The install used `--ignore-scripts` to avoid the project postinstall changing global
Git hooks/ignore files; the documented native preparation was run separately and
verified Electron 42.11.18 ABI 146. No manifest or lockfile was edited. The dependency
check then passed (`dependency-check-exact-output.txt`).

The other two failures were existing native-finality CLI timing cases,
`partial-no-native-cost` and `partial-native-error`. Both passed when their unchanged
file ran alone (`native-finality-isolated-output.txt`); host load had risen during
the suite. No unrelated test or production code was changed to accommodate them.
A further full run with the exact branch install follows; its result must be
recorded explicitly, rather than calling the first run green.

`dependency-environment-receipt.json` records the temporary installation and
`dependency-versions.json` compares the original and exact trees. The temporary
install (including its downloaded Electron binary) will be deleted and the original
links restored during final cleanup. The earlier live observations and their
controlled-request method remain retained.

### Pinned Node follow-up — 2026-10-27

The exact-install full run also exited 1 (`full-suite-exact-output.txt`). Its
JSON listed no failed assertions, but two SEA packaging checks remained pending and
Vitest raised an unhandled source-map parsing error; it was not accepted as green.
Those two checks were also pending in the first full report. A log-only diagnostic
identified TSX source-map parsing in stack formatting; the temporary dependency
instrumentation rethrew the original exception and was restored byte-for-byte
(`diagnostic-instrumentation-receipt.json`). No test/configuration was changed.

A direct build (`sea-direct-diagnostic.json`) exposed the actual packaging
prerequisite: the shell's Homebrew Node 26.12.1 lacks the executable-packaging
SEA fuse. This repository pins v24.22.1 in `.nvmrc`; its already-installed
self-contained Node has the required support (`pinned-node-capability-output.txt`).
Both unchanged SEA packaging checks pass with that pinned Node
(`sea-repeatability-pinned-output.txt`). Child-command PATH selection is local
to this campaign; the user's shell/default installation was not changed. The
final canonical gates use the pinned Node and exact branch dependencies.

The final pinned-Node full run exited **0**: 2,792 files and 35,373 tests passed
(`full-suite-pinned-output.txt`, command receipt and raw JSON report retained until
cleanup). All canonical gates also passed under the pinned runtime. No assertions,
skips, timeouts or test-runner configuration were changed. Independent completion
review and final runtime deletion follow.

Final pinned-Node, exact-install full suite: PASS, exit 0, with the machine summary
retained in `full-suite-pinned-summary.json`. Both earlier full runs remain recorded
as failures; their dependency/runtime prerequisites were corrected, and the two
unchanged CLI timing cases also passed in isolation. All canonical gates were rerun
with the pinned Node and branch-exact install. The independent reviewer returned
**VERDICT: PASS** with no unresolved actionable findings (`independent-review.txt`).
Slow/load tiers were not run: this quota-state change is covered by the live
transitions, focused regressions and the default full suite.

Final cleanup removed the disposable profile/databases, generated build, temporary
Electron/dependency installation, private caches, helper source and this run's raw
test artifacts. The original dependency links and pre-existing shared caches were
preserved. The retained report, observations, method receipt, command receipts and
seal remain available. No source checkout was copied, no real account was signed
out, nothing was committed/staged, and no document received a completed rename.



## Evidence run — 2026-10-27 (resumed item, retained-evidence audit)

**All five checks already have passing evidence; no open check remains.** On this
resume, read the entire report and compared the two committed queue checkpoints
against their starting revision. The second checkpoint contains the warning fix,
its regressions and the completed verification evidence. No new product change or
live-test scenario was required.

- [x] Check 1: retained native Plan/Monthly token windows and visible OpenCode row
  agree (`baseline-fixed.json`, previous follow-up directory).
- [x] Check 2: replayed assertions confirm warning, instruction, original timestamp
  and both bars survive a repeated rejected Refresh; one native desktop-notification
  delivery is recorded. The retained aged-cache capture shows the old reading age.
- [x] Check 3: replayed assertions confirm actual rejected requests, saved-account
  SSO redirects, successful quota retry, persisted rotated login and warning removal.
- [x] Check 4: retains the explicitly indirect 2026-10-04 cadence evidence and
  October 27 manual-Refresh evidence. No new idle traffic capture is claimed.
- [x] Check 5: retained monitor reading was fresh at its recorded observation,
  with successful poller lines and no attention flag. It was not sampled anew.

All 86 files in the previous final evidence seal match their hashes. Both source
files match the bytes covered by the previous independent `VERDICT: PASS`. The
root follow-up plan also matches its sealed version. The root report matches its
sealed version after excluding only the coordinator's subsequently appended parked
status footer. Final pinned-runtime command receipts all record exit 0, including
the full suite; no tests, builds or independent review were rerun on this resume.
The previous failed attempts remain recorded as failures.

Fresh cleanup checks confirmed all three owned test ports closed and the disposable
profile, generated build and scratch helpers absent. No new app, browser, dependency
install, provider session or automation was started. Nothing was staged, committed,
renamed or switched. The original shared dependency links were left in place.
No additional defect was reproduced and no action from James is needed.

Resume receipts and a new seal are in
[2026-10-27-resume evidence](2026-09-25-mimo-session-resilience_evidence/2026-10-27-resume/).
This is an audit of the already completed live run, not a new live observation.
The earlier limits remain explicit: no natural expiry, visual macOS banner check,
locked Chrome database recovery, new idle capture or slow/load tier run. The queue
coordinator still owns verification, document closure and integration; this document
remains at its supplied root path and active filename.


## Evidence run — 2026-10-27 (verifier findings, SSO-only retry)

**All three verifier findings addressed; the five live checks have passing evidence,
with the limits below.** This run supersedes the renewal-confidence claim in the
round-2 and retained-evidence-audit sections. The previous successful retry used
normal credentials after SSO, so it did not by itself exclude the original valid
console session as the reason for success. Those historical receipts are preserved.

### Defect numbering and durable links

Renumbered only the MiMo stale-warning defect from the conflicting LT-708 to
[LT-782](livetest-remediation-register.md#lt-782), including this report, the register,
the [follow-up plan](2026-10-27-mimo-stale-session-warning_plan.md) and regression-test
titles. Before choosing the replacement, scanned Markdown references in both this
queue checkout and the root plans directory. The initial scan at approximately 04:23 UTC found other active campaigns referring
to LT-710 through LT-714 and LT-780/LT-781; LT-782 was unallocated. A later fresh
review found a newer LT-790 reservation in a separate campaign, with no LT-782 conflict.
This avoids reusing the benchmark's LT-708 reservation. No other defect was renamed.

All Markdown link targets in this report and the MiMo register entry now use
repository-relative paths. The evidence lives in the assigned queue worktree until
harvest. Its links from this root-checkout document become available in the root
checkout when the coordinator brings the evidence across; none points through the
temporary worktree's absolute path. The new evidence is in
[2026-10-27-review-fixes](2026-09-25-mimo-session-resilience_evidence/2026-10-27-review-fixes/).

### Stronger Check 3: SSO-returned authentication independently succeeds — PASS

Built and launched the assigned worktree with isolated profile
`/tmp/aio-lt-queue-71493f81`, renderer port 4579, renderer debugging port 9822 and
loopback main-process debugging port 9823. Only the existing OS-encrypted saved
login was copied into the disposable profile. The real login file and Chrome
cookies were never edited. Focus emulation preceded every DOM assertion, and every
capture records `hidden:false`, `visibility:visible`; ordinary animation frames
rendered the UI without forced change detection.

Temporary fetch instrumentation only removed outgoing cookies; it never fabricated
a response, replaced a status/body, wrote a quota snapshot or seeded renderer state.
During the renewal phase it removed all console authentication until the real
production renewer returned cookies from its SSO walk. On the quota retry it deleted
every cookie except the three authentication pairs whose values matched that returned
overlay and the account's `userId` identity cookie. The production merger, retry,
parser, encrypted persistence and IPC/UI notification path all ran normally.
Cookie values, account identifiers, signed URLs and response bodies were not exported.
The retained method receipt contains the instrumentation source and assertions.

At **04:26:39 UTC**, the real request sequence was:

1. `/api/v1/tokenPlan/usage` and `/detail`: **401**, no authentication cookies.
2. Saved-account `/pass/serviceLogin`: **302**; platform `/sts`: **307**, five
   Set-Cookie entries. All three console authentication pairs were minted.
3. Quota retry: both endpoints **200**, each carrying only SSO-returned
   authentication. In-memory equality checks record that the returned service token
   differs from the original and that the original service token was never sent
   anywhere in the renewal phase. See `renewed-network.json` and `final-network.json`.

The native snapshot advanced to `takenAt:1793075199539` and returned Plan/Monthly
**77,889,659,492 / 82,000,000,000 tokens**, plan Max. The actual row retained both
bars, cleared `needsReauth` and removed the warning (`renewed-refresh.json`).
`renewal-log.json` retains the owned Electron process's timestamped success line:

```text
[2026-10-27T04:26:39.539Z] [INFO] [MimoTokenPlanProbe] MiMo console session renewed through Xiaomi SSO
```

At **04:26:51 UTC**, separate read-only negative-control requests retained the same
account identity and omitted all authentication pairs: both quota endpoints returned
**401** (`negative-control.json`). A subsequent real row Refresh reread the persisted
login, retained the SSO-only authentication filter, returned **200** twice and kept
the warning absent (`persisted-refresh.json`, `final-network.json`). No additional
SSO walk was used for that persisted reread. Thus neither the original service token
nor account identity alone explains the successful retry.

The isolated encrypted login changed, five rotated SSO pairs were persisted, and the
real encrypted login stayed byte-identical throughout. The failed-SSO scenario and
successful-SSO scenario used separate production renewers only to reset the attempt
budget between independent cases. The repeated-failure case itself retained the
normal cooldown. This verifies live SSO minting, quota recovery and saved-session
reuse under controlled outgoing-cookie exclusion. **Natural server-side expiry was
not induced or observed**, and no sign-out or manual sign-in was performed.

### Other checks and verification

- [x] Check 1: fresh baseline at 04:25:57 UTC returned native Plan/Monthly
  **77,888,716,512 / 82,000,000,000 tokens**, Max; the real row displayed OC 95%
  with two quota windows (`baseline.json`). Full counts remain in the native
  snapshot; the popover displays percentages, as previously disclosed.
- [x] Check 2: real rejected reads at 04:26:05 and 04:26:21 UTC preserved the
  warning, instruction, both token windows and original timestamp through cooldown.
  One native desktop notification delivery was recorded (`rejection-one.json`,
  `rejection-two.json`, `final-network.json`). The earlier aged-cache observation
  remains retained. The visual macOS banner was not inspected.
- [x] Check 3: SSO-only successful retry, negative controls and persisted reread
  above remove the original-session ambiguity.
- [x] Check 4: earlier indirect idle-cadence evidence and forced-Refresh evidence
  retained. No new ten-minute idle request capture was made.
- [x] Check 5: earlier successful monitor timestamps retained; the monitor was not
  resampled during this correction run. No locked Chrome database recovery was tested.

The focused baseline and post-renumber service/renewer/probe suites passed without
changing any assertion, test configuration, timeout, skip or production code. Both
builds, both type checks, lint and source/UI checks passed with the pinned Node.
A broader dependency check found pre-existing extra installed packages; the failed
receipt is retained. The original install was preserved inside worktree scratch,
and a temporary branch-exact install is used for final verification. No manifest
or lockfile changed. An initial shared-log lookup also failed because it expected a
plain-text prefix; the actual success line was retained from the owned app stdout.
Neither failure was counted as a successful check.

Final independent verification, command receipts, current seal and runtime cleanup
are recorded below. Previous seals describe historical bytes: this correction
intentionally changes the report, follow-up plan, register and test titles, so their
old hashes are not represented as hashes of the corrected version. No document has
been renamed, nothing has been committed or staged, and the queue coordinator owns
closure and integration.


### Independent verification scheduling — 2026-10-27

The first fresh unfiltered full suite used a conservative single-worker limit.
It was deliberately stopped with SIGTERM to restart at four workers after a
resource check, because its serial run would take substantially longer than the
normal campaign. The owned process group was checked separately from the shared
agent/app processes and confirmed gone. The actual exit was **143**, recorded in
`fresh-full-suite-interruption.json`; the complete interrupted raw output was
retained after a successful secret scan. This attempt is **not** a passing suite
and does not establish a failed-assertion result. The final full-suite command has
its own `fresh-full-suite-final` receipts; no output was overwritten, and no test,
assertion, skip, timeout, runner configuration or dependency manifest was changed.


### Final fresh verification — 2026-10-27

All canonical project commands passed independently with the pinned Node and the
branch-exact temporary dependencies: renderer typecheck, spec typecheck, lint,
source-size/UI-hint checks, both production builds and the complete default suite.
The final unfiltered, uncached four-worker suite exited **0**: **2,792 files,
35,373 passed, zero failed and nine existing pending tests**. The machine summary
retains the distinction between passed and pending tests; no skip was added.
See `fresh-full-suite-final-output.txt` and `fresh-full-suite-final-summary.json`.
Its owned process group is confirmed gone in `fresh-full-suite-final-process.json`.
Focused service/source-invalidation/probe/renewer/persistence checks, live-evidence
assertions and both secret scans also passed. The earlier dependency failure,
log/process-list lookup failures and interrupted serial run remain honestly
recorded as non-passing attempts.

The independent review's corrected numbering wording was the only actionable
finding during this pass. It was fixed without changing production code or test
assertions. The subsequent fresh review, current seal and final cleanup receipt
will be retained beside these command receipts before handoff. The previously stated limits remain:
controlled exclusion rather than natural expiry, no visual macOS banner check,
no locked-database recovery, no new idle capture or monitor sample, and no
slow/load-tier suite. No action from James is needed for the completed scope.


### Handoff and cleanup confirmed — 2026-10-27T05:11:50.429051+00:00

Both fresh independent passes returned **VERDICT: PASS**, with no unresolved
actionable findings (`independent-review.txt`, `independent-correction-review.txt`).
The second pass rechecked the corrected documentation and current evidence after
the first review's wording finding; it did not repeat unchanged heavy gates.
The complete final suite output is retained compressed, with a passing secret
scan and verified decompression in `fresh-full-suite-final-log-receipt.json`.

Cleanup is complete: the test app/server and verification process groups are gone;
the disposable profile/databases, temporary exact dependency install, downloaded
Electron binary, generated builds, private caches, scratch helpers and raw runtime
artifacts were removed. The pre-existing dependency directory was moved back
intact, with the same directory identity and install-lock hash. See
`runtime-stopped.json`, `process-groups-stopped.json`,
`fresh-full-suite-final-process.json` and `cleanup-receipt.json`.
`verification-seal.json` covers the corrected report/plan/register/source and all
retained evidence. No commit, staging, branch/worktree change or document rename
was performed. The follow-up plan remains untracked in the root checkout. Evidence
is ready for the coordinator's verification and document closure.


## Evidence run — 2026-10-27 (post-merge pre-commit recovery)

This resume addresses the coordinator's post-merge hook failure. It does not
replace or repeat the five live MiMo observations above. No dev app, browser,
provider session, login or monitor was started during this repair.

The missing-worker error was reproduced from the cleaned worktree before edits
(`baseline.log`, exit 1). The previous cleanup had correctly removed `dist`, but
the pre-commit sequence ran related tests without rebuilding their real worker
entry. A normal `build:main` restored that entry and all four affected worker
spec files passed, with their existing assertions unchanged (`worker-tests.log`).
The hook now runs `build:main` after generation and before `test:staged`, so
required cleanup cannot recreate the missing-build prerequisite on the next
commit. A new regression checks both successful ordering and propagation of a
nonzero build status; its initial red and subsequent green outputs are retained.

A broader hook replay then found a separate existing race in
`default-loop-native-finality.spec.ts`: `partial-zero` failed, and an isolated
run failed four cases at `finalWritten`. Controlled sequential measurements
showed child startup at roughly 117–129 ms, followed by a 25 ms write delay,
racing the parent's fixed 150 ms deadline. The test now waits for the real
child's final-write marker before advancing the parent watchdog clock. It also
advances the existing 250 ms native-result grace period for the regular-error
case. No assertion, case, timeout setting, production adapter or skip changed.
The real subprocess, paused stdout, close-before-completion, drained bytes, exact
costs and kill-signal assertions remain. An after-test cleanup owns the child
even if a case fails. All eight finality cases and both hook-script suites
passed together (`focused-final.log`).

The first clock-control attempt omitted that regular-error grace advancement
and timed out; its output is retained as a failure. Its child was recognized
using an exact fixture-argument match and a start time within that failed run,
then stopped with SIGTERM and confirmed gone (`owned-fixture-cleanup.json`).
General `ps` enumeration was denied; `lsof` and targeted native process reads
succeeded without exposing arguments or environment values. Unrelated processes
were untouched.

All hook replays use a disposable Git index and invoke the actual pre-commit
script without committing. The first selected only the hook scripts, so its
passing hook result was insufficient for the original failure. Its additional
index-byte comparison failed, while subsequent checks confirmed no real staged
content changed. Corrected replays explicitly select the original MiMo source
pair plus the new repairs, compare staged entries rather than mutable index
file bytes, and start without `dist`. One cleanup attempt encountered only a
remaining `.DS_Store` and succeeded on a bounded retry. An initial standalone
startup measurement contained a quoting error and is labelled invalid; the
corrected measurement and actual test failures support the diagnosis.

Fresh type checks, lint, source/UI checks and both production builds have passed.
The final hook replay, unfiltered full suite, independent review and final
cleanup are still pending at the time of this entry. Their actual outcomes will
be appended below; this entry makes no completion claim. Evidence is retained
in `2026-09-25-mimo-session-resilience_evidence/2026-10-27-post-merge-hook/`
in the queue worktree. Nothing was committed, staged in the real index,
renamed or switched; the coordinator still owns document closure.


### Verification environment follow-up — 2026-10-27 (post-merge repair)

The final pre-commit replay passed from an absent `dist`: 312 files and all
6,375 selected tests, exit 0. The real staged entries stayed identical.
The first unfiltered suite was interrupted after its startup load reading
exceeded the runbook threshold (actual exit 143; both owned runner PIDs are
confirmed gone). The subsequent unfiltered suite ran to completion: one of
35,384 tests failed, in the existing installed-dependency compatibility check;
The raw summary records 35,372 passed and nine pending; counts are retained
verbatim rather than inferred from the total. This is a failed suite, not a pass.

Fresh `npm ls` inspection found twelve extraneous local package directories,
all absent from this branch's lockfile, reproducing the previously documented
condition in the preserved dependency installation. No missing or invalid
required package was reported. A dry-run prune would remove 38 packages, so
no prune or install was performed. Only the twelve confirmed extras were
renamed into worktree scratch for verification. Original package directory
identities, manifest hashes, the install marker and repository manifests were
recorded for restoration. The original directory will be restored after review;
that pre-existing environment limitation must not be described as repaired by
these source changes. The dependency assertion and all test configurations
remain unchanged. Final verification under the branch-declared dependency set
is pending below.


### Runtime follow-up — 2026-10-27 (post-merge repair)

The second full run, with extras isolated, still exited 1 despite zero reported
assertion failures. Vitest reported an unhandled source-map parsing error.
The raw JSON's `success: true` is therefore insufficient: the real process
exit remains authoritative and this attempt is not a pass. Its two pending
assertions were the SEA build-repeatability cases, rather than added skips.
The first complete run also carried this runner error alongside the visible
dependency failure; its earlier error accounting above is incomplete.

The SEA file reproduced the same runner error in isolation. A standalone build
exposed the underlying capability refusal: the default Homebrew Node 26.12.1
lacks the SEA sentinel. The already-installed Node 24.22.1 pinned in `.nvmrc`
contains it (`pinned-runtime.json`). The earlier shell version check did not
pin subsequent command environments. Verification now explicitly prepends the
pinned runtime directory for every parent and child command. No runtime was
downloaded, global setting changed, or build test edited. All previous failed
outputs remain preserved; only subsequent pinned commands can establish a pass.


### Final repair verification — 2026-10-27T06:55:24.158493+00:00

The full unfiltered, uncached suite passed with the twelve confirmed extras
isolated, as did all canonical builds, type checks, lint and source/UI checks.
Actual counts are retained verbatim in `full-suite-pinned-summary.json`.
The independent review returned **VERDICT: PASS** with no unresolved actionable
findings (`independent-review.txt`). The pre-commit hook separately passed on
the original installation from an absent build directory. All existing native
finality assertion lines and the dependency compatibility spec are unchanged.
The normal hook also refreshed one generated inventory line count for the
already-committed remediation register; its actual counting convention is
recorded in `generated-inventory-receipt.json`. No new live check was performed.

The original packages will now be restored and generated runtime removed.
The original installation's extraneous-package condition is pre-existing and
is intentionally preserved, not represented as fixed by this source repair.
Prior failed/interrupted attempts remain recorded with their actual exits.


### Repair handoff and cleanup — 2026-10-27T06:55:26.667897+00:00

Original package directories were restored with identical directory identities
and package-manifest hashes; the original install marker and repository
manifests are unchanged. Owned builds, helper scripts and test runtime output
were removed after sealing; compressed raw receipts remain as evidence.
The pre-existing dependency/Vite cache and unrelated data were preserved.
No dev app or browser was launched during this resume, and the earlier orphaned
fixture was stopped and confirmed gone. The real index is unstaged, the branch
is unchanged, and no commit, stash, branch/worktree creation or document rename
was performed. The coordinator owns closure and integration.

The source repair and actual hook replay pass. Full-suite verification passes
with the twelve extraneous packages isolated; the restored original install
retains its known dependency-compatibility failure. That environment limitation
is explicit and is not a claim that the original install now passes the suite.
The earlier live-test limits remain unchanged; none of the five live checks
was rerun as part of this post-merge repair.

## Coordinator correction handoff — 2026-10-27

The accepted round-3 verdict is FAIL; preserve the live evidence and correct the
reviewed branch through the existing Plan Queue item. A prior accepted live-test
PASS does not override this later source-review failure. The installed queue has
parked the item at its round limit; a supported resume starts a fresh correction
round and must not be represented as accepting or integrating the work.

- Investigate the unconditional `build:main` in the pre-commit hook against the
  repository's fast-commit convention. Preserve the real worker build prerequisite
  for the staged tests that need it, without making documentation-only commits
  rebuild the whole main process. Read the complete executing scripts, callers and
  hook tests before editing; reproduce both paths and retain nonzero-exit behavior.
- Preserve portable evidence for the hook repair. Its cited `.log` files are
  ignored and will not be harvested. Keep small tracked receipts and usable links;
  retain full command output locally without claiming ignored logs were integrated.
- Review the approximately 10 MB of committed raw verification output. Reduce
  repository bloat without losing the authoritative verification receipts or the
  only evidence for an acceptance claim. Describe any retention changes explicitly;
  old seals remain historical, not hashes of revised files.
- Keep Check 4's indirect October 4 cadence evidence and its limits explicit. Do
  not call it a fresh traffic capture. Likewise retain the controlled-cookie
  exclusion, unobserved visual notification and unexercised locked-database limits.
- Keep the current status above accurate, preserve every earlier dated result and
  unrelated owner's work, and leave the linked LT-782 follow-up plan active until
  independent review and supported integration permit coordinator closure.

After correcting source, run the applicable focused and canonical gates with the
pinned runtime and branch-exact dependencies, obtain a fresh independent
`task-completion-gate` PASS, and record cleanup. Do not weaken assertions, bypass
hooks, claim a failed/interrupted suite passed, edit queue metadata, restart the
installed app, create a branch/worktree, or commit/rename documents manually. The
queue owns its managed checkout and integration. This coordinator note changes
only the handoff and current status; it certifies no new test or source result.


## Evidence run — 2026-10-27 (fast-commit correction, in progress)

The coordinator correction handoff is the remaining work. All five live checks
already have passing dated evidence above; none is reopened or represented as a
fresh observation here. No dev app, browser, monitor restart or login operation
was started. Check 4 remains the **indirect October 4 snapshot-cadence evidence**,
not a current API-traffic capture. Controlled outgoing-cookie exclusion, rather
than natural expiry, underlies Check 3; the macOS banner and locked-cookie-database
recovery remain unobserved.

The current hook was reproduced calling `build:main` unconditionally. The build
now runs in `test-staged.js` only after the existing selection finds staged source.
Documentation/generated-only selections skip both build and Vitest. Every source
selection rebuilds conservatively because indirect related tests may launch real
workers. No dependency-graph approximation or stale-build fallback was added.
The hook no longer has its separate unconditional build. Build status, spawn
errors and signals stop before tests; related-test failure propagation is retained.

Focused baseline passed. The new regression phase failed on the old implementation,
as expected. The first implementation run also failed on an incorrect argument-array
match in a new test; that expectation was corrected to include all spawn arguments.
The final focused hook/staged/dependency suites passed. All attempts, including the
two non-passing results, are in `focused-attempts.json`. No existing production
assertion, timeout, skip or runner configuration was weakened.

Current evidence: [hook-correction receipts](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/).
The active untracked root-checkout plan is
[the correction plan](2026-10-27-mimo-hook-correction_plan.md). The LT-782 plan remains
active. Command outputs are kept locally under worktree `_scratch/hook-correction/`;
portable receipts retain exact exits, hashes and usable result excerpts. Those local
full logs are explicitly **not** claimed to be harvested.


### Historical evidence retention — 2026-10-27

Nine duplicative raw suite files (8,910,490 bytes) were preserved locally with
verified original and decompressed hashes and replaced by
[portable summaries and a retention manifest](2026-09-25-mimo-session-resilience_evidence/README.md).
All other 256 historical files, including live observations, command receipts and
historical seals, remain byte-identical. The portable historical evidence occupies
618,713 bytes instead of 9,462,835 bytes, excluding this correction's new receipts.
This reduces the current evidence tree, not existing Git-history storage.
Historical failures and interruptions retain their actual exits; JSON success
never overrides a nonzero process exit.

The cited historical hook `.log` outputs were already absent from this checkout
and the matching root evidence directory. Their recorded exits and hashes survive;
retained smaller runner outputs support their own focused results. The historical
replay's reported 312-file/6,375-test counts cannot independently be extracted from
that absent output. No missing excerpt was recreated. Old seals describe historical
bytes; the retention manifest maps relocated entries to their local archive and
portable summary. The ignored raw archive is not harvested and may be removed by
ordinary scratch cleanup. No live observation or unique authentication/notification
acceptance evidence was removed.

### Actual hook paths — 2026-10-27

The documentation-only replay invoked the actual `.githooks/pre-commit` with a
disposable index and no `dist` tree. It exited 0 in approximately three seconds,
skipped both compilation and tests, and left `dist` absent. It used a documentation
index change plus the hook's generated artifacts. The real staged entries were
unchanged. See [the portable documentation-hook receipt](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/docs-hook-receipt.json).
The source replay and remaining gates are still pending below; a documentation-only
pass is not substituted for source-worker coverage.


### Source hook and canonical static gates — 2026-10-27

The actual source pre-commit replay exited **0**, starting with no `dist` tree.
Its selected source paths include the original MiMo service/tests, native-finality
spec and current hook/staged-runner repairs. It built main-process workers before
related tests; **313 files / 6,387 tests passed**. The source index started from the
local base and added the current repair scripts; normal `test:staged` tested current
worktree files. Unrelated base-branch documentation visible in that disposable
index was excluded by source selection. The real staged entries stayed identical,
and the disposable index was removed. See
[the portable source-hook receipt](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/source-hook-receipt.json).
Full local output is retained by hash, with its actual test footer portable in the
receipt. This is a current correction replay, not reconstruction of the missing
historical hook output.

With the pinned Node and twelve branch-unlocked packages temporarily isolated,
`npx tsc --noEmit`, `npm run typecheck:spec`, lint, source-size and UI-hint checks,
`build:main` and `build:renderer` all exited 0. Exact command/output receipts are
beside the hook receipts. No dependency manifest or compiler/test configuration
changed. The full default suite and fresh independent review are pending at this
point; neither is inferred from the focused/hook results.


### Full-suite result and load investigation — 2026-10-27

The first complete default suite for this correction exited **1**, with one failed
assertion among 35,386 tests. The failure was the unchanged
`Cancel arriving during Git promotion retries a subsequent failed landed-worker stop`
case in `plan-queue-retirement-control.spec.ts`, waiting for the checker ID in
`normalPassLanding`. The file is byte-identical to the base. No MiMo or hook
assertion failed. The full failed result remains in
[the command receipt](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/full-suite-receipt.json).
It is not counted as a passing suite.

Following the runbook, checked load before diagnosing: the three averages were
37.59 / 40.21 / 32.69 immediately after the suite; a later retained reading was
88.01 / 57.56 / 40.23. The original failed file then passed in isolation: **26 tests,
exit 0**, without any source, assertion, timeout or configuration change. See
[the isolated command receipt](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/retirement-isolated-receipt.json)
and [the load investigation](2026-09-25-mimo-session-resilience_evidence/2026-10-27-hook-correction/full-suite-failure-investigation.json).
The runbook treats a failure that disappears in isolation under these conditions
as an invalid loaded run; this does not turn its actual exit into 0.

Further full verification and fresh independent-agent dispatch are paused until
load is below the runbook threshold. This is a technical verification prerequisite,
not a new human-authority requirement or an action for James. The full suite and
independent completion verdict remain pending; no completion claim is made.


### Capacity blocker and handoff — 2026-10-27

After the failed full suite and passing isolated file had both stopped, retained
load readings continued upward: 109.14 / 66.85 / 45.36 at 10:37:56 UTC, then
117.82 / 88.94 / 56.66 at 10:39:29 UTC. All recorded owned full-runner process IDs
were gone at the latter observation. See `load-wait.jsonl` and
`post-suite-process-check.json`. The campaign runbook says to wait above roughly
30 before another full suite or agent dispatch. No further heavy test or fresh
agent was launched into that load. The initial retention subagent is finished;
it did not implement or independently certify the source change.

**Remaining required verification: a default full-suite exit 0 with the pinned
runtime and branch-declared dependency set, then a fresh `task-completion-gate`
review returning PASS.** Neither exists for the final hook correction yet. The
worker's source review and earlier independent reviews are not substitutes. No
fresh review was attempted and no inability of the subagent tool is asserted.
This is a machine-capacity prerequisite, not “needs James”; no credential, approval,
physical-device or missing-human-fact step has been identified. Resume those two
checks when load is below the runbook threshold. If either finds a real defect,
fix and verify it before coordinator closure. Do not mark this item completed on
the strength of the five earlier live passes.

Current correction checklist:

- [x] Preserve the five passing live observations and every prior qualification.
- [x] Documentation/generated-only hook skips compilation and tests.
- [x] Source hook builds workers first; focused error/ordering cases and actual related tests pass.
- [x] Portable evidence retains real exits/excerpts; historical raw duplicates reduced with verified hashes.
- [x] Both typechecks, lint, source/UI checks and both production builds pass.
- [ ] Full default suite passes: first attempt failed; original failing file passes alone.
- [ ] Fresh independent completion review passes: not dispatched because of the campaign load limit.
- [x] Restore original dependencies, remove owned runtime, and finish the final cleanup receipt/seal below.

No dev app, browser, provider session, automation, login operation or monitor
restart was performed during this correction. No new DOM assertion was made,
so focus emulation was not needed. The earlier app's stopped state was preserved.
No new product defect was reproduced; the unchanged full-suite case was not
edited or filed as a MiMo defect merely because of this loaded run.


### Final cleanup and resource evidence — 2026-10-27

The original twelve package directories were restored with identical directory
identities and manifest hashes. The original installation marker, parent directory
and repository manifests remain unchanged. Its pre-existing unlocked-package
condition is intentionally restored, not claimed fixed. See
`dependency-restoration.json`.

The first generated-build removal exited 1 when `dist/src` was not empty. Inspection
showed `.DS_Store` in that directory; the aborted traversal also left ordinary
compiled files in other directories. The next bounded removal succeeded. This
failed cleanup attempt is retained in `cleanup-initial-failure.json`, not hidden.
`cleanup-receipt.json` confirms the generated build and helper scripts are gone,
the temporary profile and Angular cache are absent, and ports 9822/9823/4579 have
no listener. The pre-existing Vite cache is preserved. No dependency install,
browser download or checkout copy was created during this correction.

Own full raw test outputs remain compressed locally with verified original hashes
and decompression round trips (`raw-output-retention.json`). These local files are
not harvested; portable command receipts preserve actual results and useful excerpts.
Historical evidence remains covered by its unchanged seals plus the retention map.
The pre-cleanup seal is historical; the final seal explicitly records **incomplete
verification**, with hashes of the final report, active plans, source and portable
evidence. No independent PASS is claimed.

The short load average later fell, so current availability was checked directly
using the same CPU tick-delta calculation as the repository's test-pool sizing.
At 10:44:16 UTC the sample showed **16.87 busy cores of 18**, with load averages
19.99 / 49.67 / 47.98 (`current-resource-check.json`). This supports continuing
to defer heavy verification; the longer averages alone are not being treated as
proof of present CPU use. The earlier full-suite failure remains exit 1 and the
unchanged isolated file remains exit 0.

Final state: five dated live checks retained; hook correction implemented and
focused/real-hook/static/build checks passed; **full-suite PASS and fresh independent
review still required**. No staged changes, commit, stash, branch/worktree change,
queue-metadata edit or completed-document rename was performed. Both follow-up
plans remain active in the root checkout. Coordinator closure is not authorized
by this partial handoff. Slow/load test tiers, a new live app/UI run, natural
session expiry, visual macOS notification delivery, locked-database recovery and
a new idle-traffic capture were not run; the earlier live qualifications remain.

## Evidence run — 2026-11-08 (merge repair, targeted checks, monitor reading)

Scope: this resume repaired a merge of `main` into the queue branch, ran targeted checks,
and took one read-only monitor reading. No dev app, browser, provider session, sign-in,
cookie, setting or permission change was made, so no live check was re-run here. The
five checks keep their dated 2026-10-27 evidence and limits (Check 4 remains the
indirect 2026-10-04 cadence observation).

### Merge repair

- `scripts/run-git-hook.js`: kept the branch's design, in which `scripts/test-staged.js`
  rebuilds main workers before related tests only when a source selection is staged, and
  doc-only commits skip both the build and Vitest. `main`'s unconditional `build:main`
  pre-commit step is not kept; its rationale now sits in the comment. The matching
  expectation and its hook-level build-failure test were removed from
  `scripts/__tests__/run-git-hook.spec.ts`. The same guarantees are asserted in
  `scripts/__tests__/test-staged.spec.ts` (build before source tests, build status
  propagated, no Vitest for a doc-only selection).
- `docs/plans/livetest-remediation-register.md`: both sides' rows and sections are kept.
  `main` had added context-fill and RLM-pragma defects under LT-732 and LT-733, which the
  base already used for sidechat defects. Those two defects are renumbered to **LT-1013**
  and **LT-1014** (no existing reference in any document, in the root, worktree or `main`
  trees), with in-text references and a renumbering note updated. No defect was added or
  closed by this repair.
- `node scripts/next-lt-id.mjs` prints LT-708, which is already in use. The script reads only
  the first index table, so its output was not used; the next free ID was found by scanning
  every `LT-` reference in the register.
- Both conflict files are staged with no unmerged entries left, and the merge is still in
  progress for the coordinator to finish. Nothing was committed or stashed.

### Targeted checks

- `npm run test:quiet` on `run-git-hook.spec.ts`, `test-staged.spec.ts` and
  `generated-artifacts.spec.ts`: 3 files, 42 tests passed, exit 0.
- `node --check scripts/run-git-hook.js` passed, and the resolved pre-commit list was printed
  and matches the design above.
- ESLint on the two hook files reports 5 `Array<T>` style errors, all in the spec's existing
  code. The `HEAD` and `main` versions of that spec report the same 5 errors, so they predate
  this repair and were not changed here.

### Monitor reading (read-only, no sign-out)

- The MiMo entry in the monitor state was last updated at 2026-11-08T02:42:35Z, 146 seconds
  before the reading, with no `attention` flag. Its plan is Max, with plan and monthly both at
  100.0% used.
- The poller lines at 02:42:35 UTC show successful `[direct]` polls for the default account
  and for `comtechspare-f7a6`, so the saved login was readable at that time. This is fresh
  evidence for Check 5's freshness only; it does not test a locked Chrome database, and it
  does not exercise the saved-session renewal walk, which runs only after a 401/403.
- A 100% reading means the plan's quota is exhausted; any dev-app quota read taken now would
  show that state.

### Still open

- The default full suite under the pinned runtime and branch-declared dependencies, and the
  fresh independent `task-completion-gate` review, are unchanged from the 2026-10-27
  correction handoff. Neither was run in this turn; both belong to the coordinator's
  verification.


## Evidence run — 2026-11-10 (Plan Queue, fresh live pass of all five checks)

**Result: all five checks PASS on a freshly built dev app, with the limits stated below.** No product
source, test or configuration changed and no new defect was reproduced, so no register item was
created. Evidence: [2026-11-10 evidence directory](2026-09-25-mimo-session-resilience_evidence/2026-11-10/)
(in the queue worktree until harvest).

### Method

- Built `build:main` and `build:renderer` from the queue worktree (both exit 0, Node v24.22.1 from `.nvmrc`;
  `command-receipts.jsonl`). Launched Electron with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-612ef172`,
  renderer debug port 9853, loopback main-process inspector 9854, built renderer served by a disposable
  Node static server on 4581. Only the OS-encrypted saved MiMo usage login was copied into the disposable
  profile; the real file and Chrome cookies were not touched, no sign-out, no typed credentials.
- Focus emulation was enabled before every renderer assertion; each capture records
  `hidden:false, visibility:visible`. `Emulation.setPageVisibilityOverride` is absent in this Chromium and
  is tolerated by the helper. No forced change detection and no store seeding.
- Controlled rejection (same method as the 2026-10-27 runs, source in `method-setup-fetch-wrapper.js.txt`):
  a main-process `fetch` wrapper only removes outgoing `Cookie` headers, so the remote server returns
  **real HTTP 401s**. It never fabricates a status, body or snapshot. The defaultModelByProvider setting
  for OpenCode was set to `xiaomi-token-plan-ams/mimo-v2.6-pro` for the run and restored to `{}`
  (`settings-restored.json`).

### Check 1 — OpenCode row present and live: PASS

At 02:34:09 UTC `baseline.json`: native `source: admin-api`, `ok:true`, plan **Max**, Plan and Monthly windows
**82,001,972,872 / 82,000,000,000 tokens** (unit tokens, not the cached percent shape). The strip showed
`OC 100%` and the OpenCode popover row showed Plan and Monthly with reset countdowns (`resets in 12d 21h`)
and no reauth row. 100% means the monthly allowance is used up; that is the account's real state. As in
earlier runs, the popover renders percentages; full counts are in the native snapshot.

### Check 2 — stale session marked, cached bars kept: PASS

With cookies omitted, `report-after-one.json`/`report-after-two.json` record real 401s on both quota
endpoints, the Xiaomi account walk (`/pass/serviceLogin` 302 then a 200 page, no usable session) and a 401
retry. Two actual Refresh clicks (`rejection-one.json`, `rejection-two.json`): strip `OC 100% ⚠`, reauth row
visible, 2 bars retained, `needsReauth:true`, identical `takenAt` 1794278048991 (the old reading) both
times, i.e. the second Refresh during renewal cooldown kept the warning (the LT-782 fix holds).
Exactly **one** `quota-reauth` notification, title `opencode usage numbers are stale`,
`delivery: desktop`, across both refreshes. Current wording: "MiMo usage login expired (401/403). Choose
Connect usage in Accounts to sign in again." (the saved-login wording replaced the original Chrome-specific
text; intent is unchanged). Limits: the macOS banner was not visually inspected; the aged-cache "updated
Nm ago" label was not re-observed here (covered by 2026-10-27 `stale-age-visible.json`).

### Check 3 — saved SSO renewal restores live counts: PASS

Fresh production renewer (`renewal-mode.json`). `renewed-network.json`: usage/detail **401** with no cookies,
then `account.xiaomi.com/pass/serviceLogin` **302**, platform `/sts` **307**, then usage/detail **200** twice,
each carrying only the three SSO-returned auth cookies (`allSentAuthFromSso:true`,
`originalServiceTokenSent:false`, `serviceTokenChanged:true`, all three auth cookies minted). The retry
therefore cannot have succeeded on the original session. `renewed-refresh.json`: warning gone, 2 bars,
`needsReauth` absent, `takenAt` advanced to 1794278083208. Log line (`renewal-log-line.txt`):

```text
[2026-11-10T02:34:43.208Z] [INFO] [MimoTokenPlanProbe] MiMo console session renewed through Xiaomi SSO
```

Negative control (`negative-control.json`): identity-only cookie, both endpoints **401**. A later ordinary
Refresh (`persisted-refresh.json`, `final-network.json`) read the persisted rotated login with 200s and no
further SSO walk. The disposable encrypted login changed (5 rotated SSO pairs) and the real one stayed
byte-identical. Limit: this is controlled outgoing-cookie exclusion, not natural server-side expiry, and the
attempt budget was reset with a fresh renewer only between independent scenarios (the 30-minute cooldown
interval itself was not waited out).

### Check 4 — polling throttled, Refresh immediate: PASS (now with direct request timestamps)

This replaces the earlier indirect snapshot-cadence evidence with the real console requests, timestamped by
the same wrapper (policy `production`, nothing omitted). Idle window 02:35:19 to 02:45:45 UTC
(**10 min 26 s**, no clicks, no turns; `idle-start.json`, `idle-end.json`): console quota traffic was
**one probe at 02:39:57 and one at 02:44:57** (usage plus detail pair each), exactly 5:00 apart, i.e. at most
one per 5 minutes against a 60 s idle tick. My pause-state probe returned null (no such accessor in this build), so it proves nothing about VPN pause;
the probes arriving on schedule in the window show the idle ticks were running (the 2026-10-04 run was paused by VPN detection). Then a Refresh click at
02:45:51 UTC, only 54 s after the last probe (inside the floor), returned a fresh snapshot in **1,341 ms**
(`force-refresh.json`) and sent a new request pair at 02:45:52 (`force-report.json`), proving the force
bypass. Limit: measured in-process at the app's `fetch`, not with an external proxy or firewall view.

### Check 5 — monitor cache un-freezes: PASS

Read-only. `~/.usage/state.json` mimo `updated_at` 1794277714.69 (2026-11-10T02:28:34Z) when read at 02:35:07Z
(age 392 s, no `attention` flag, plan Max). The reading at the start of this run (about 00:59 local) was
1794272254, so it advanced about 5,460 s across the run's preparation. Poller log shows successful
`mimo: ok (Max; plan 100.0%, monthly 100.0%) [direct]` lines at 02:18:28 and 02:28:34, and zero
`OperationalError` lines. Limit: this proves fresh readings; the locked-Chrome-database snapshot branch
was not exercised (the poller reads directly now).

### Verification, cleanup, handoff

- No source changed (`git status --short` clean before the evidence files); typecheck, lint and the test
  suite were therefore not rerun for this evidence-only pass. The earlier 2026-10-27 and 2026-11-08 sections
  still state the open full-suite and fresh independent review items, which belong to the coordinator.
- Dev app closed over CDP (`Browser.close`; ports 9853/9854 refuse connections). The loopback static file
  server (pid 21052, port 4581) could not be stopped from this resumed session: signals to it return EPERM.
  It serves only the built renderer and can be stopped by the owner with `kill 21052`.
- Disposable profile `/tmp/aio-lt-queue-612ef172`, generated `dist/` and the scratch helpers were deleted
  after sealing. Dependencies were not touched. Nothing committed, staged, stashed, branched or renamed.
- No step needs James. Remaining untested items are the same disclosed limits: natural expiry, visual
  macOS banner, locked-database recovery.
