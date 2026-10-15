# MiMo Token Plan allowance — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-23-mimo-token-plan-allowance_plan_completed.md](2026-09-23-mimo-token-plan-allowance_plan_completed.md)

## Current status — 2026-09-25 (session-resilience work)

The expired-console-session blocker behind Checks 1 & 2 is addressed by the
2026-09-25 session-resilience work: the probe now auto-renews the console
session through the platform's own Xiaomi SSO URL on 401/403 and re-pulls, and
a rejected session that cannot be renewed is marked on the chip instead of
hidden behind cached numbers. Re-run Checks 1 & 2 against a rebuilt app
together with
[2026-09-25-mimo-session-resilience_livetest.md](2026-09-25-mimo-session-resilience_livetest.md).

## Current status — 2026-09-24 (after commit `39d245ba`)

Open: 3 (Checks 1 and 2 blocked; Check 4 DOM confirmation outstanding) · Closed: 1

Checks 1 and 2 still need a renewed MiMo console session; the last direct
console probe returned 401/403, so cached percentage windows cannot prove the
real token counts, plan name, or strip preference. Check 3's settings copy passed.
The LT-650 `notApplicable` gate fix is committed in `39d245ba` and Check 4
passed live through the app's IPC: switching away cleared the stored snapshot,
and switching back restored the cached windows. The cleared Settings row and
chip strip were **not independently confirmed in the DOM**; their behaviour was
inferred from source and a component test. Keep this live-test plan open until
that on-screen clause and Checks 1 and 2 have passing evidence.

**Prerequisites:**

- A rebuilt, restarted Harness app from this checkout (`npm run build:main` +
  `npm run build:renderer` already pass; restart the app so the main-process probe
  registration and the renderer chip ship together). The restart replaces the process
  hosting the implementing session — that is why these UI checks could not run in-loop.
- James's Chrome on this Mac signed in to the MiMo console
  (`platform.xiaomimimo.com`) — the session cookies are the quota source.
- The configured OpenCode model is `xiaomi-token-plan-*`
  (settings `defaultModelByProvider.opencode`, e.g. `xiaomi-token-plan-ams/mimo-v2.6-pro`).
- token-usage-monitor running (its `~/.usage/state.json` `mimo` entry is the fallback
  source; the native probe is the primary).

In-loop evidence for everything else already exists (keep it in mind while checking):
the Python path wrote a live `mimo` snapshot rendered by `./usage` / `menubar.py`
("MiMo Code", `MC 1%`), and the AIO probe chain ran live under `tsx` with the real
Chrome cookie store, real Keychain read and real console fetch (`ok: true`, `plan: "Pro"`,
`opencode.plan` / `opencode.monthly` token windows, `resetsAt` 2026-10-22 23:59:59 UTC,
`overage: false`). Unit suites: 333 (token-usage-monitor) + 70 (AIO feature specs).

## Check 1 — Quota chip shows the Token Plan windows

- Steps: open the app; click the provider quota chip strip; find the OpenCode row
  (code `OC`).
- Expected: the row lists **Plan** and **Monthly** with real token counts
  (used/limit in tokens, e.g. `1403400780/38000000000 tokens`), the plan name
  **Pro**, and a reset at 2026-10-22 23:59:59 UTC ("resets in ~29d"). A
  **Compensation** row appears only when the console reports a non-zero limit
  for `compensation_total_token`.
- Why deferred: renderer + main-process surfaces in a rebuilt/restarted app.

## Check 2 — Strip headline prefers the Plan window

- Steps: look at the collapsed chip strip without opening the popover.
- Expected: the OpenCode entry's summary percentage comes from the
  `opencode.plan` window (`PREFERRED_SUMMARY_WINDOW_IDS`), not Monthly or
  another row.
- Why deferred: same rebuilt-app renderer surface.

## Check 3 — Settings copy names the console source

- Steps: Settings → Provider usage → OpenCode row.
- Expected: the description explains the MiMo console session source (Chrome
  cookies; API key cannot read quota) and the degraded behaviour — NOT the old
  "OpenCode does not report plan usage… check the console" text.
- Why deferred: same rebuilt-app renderer surface.

## Check 4 — Non-Token-Plan models stay quiet (gate)

- Steps: temporarily set the OpenCode default model to a non-Token-Plan one
  (e.g. `opencode/mimo-v2.6-flash-free`), refresh provider quota, then restore
  the setting.
- Expected: while the model is not `xiaomi-token-plan-*`, the OpenCode row
  shows **no** Token Plan numbers (both the native probe and the
  token-usage-monitor fallback are gated). After restoring the model, the
  numbers return on the next refresh.
- Why deferred: needs the running app's quota service + settings; the gate
  logic itself is unit-tested (`isTokenPlanModelSetting`, `gatedUsageMonitor`).

## Status — 2026-09-24 (runtime)

Checks 1 and 2 are **BLOCKED by a naturally-expired MiMo console session** (a real 401 from the
console API, verified directly — not a code defect). Check 3 (settings copy) **PASSES**. Check 4
(gate) reproduced a genuine live defect: switching away from a Token-Plan model does not clear the
previously-shown Token Plan numbers. See
[Evidence run — 2026-09-24 (runtime)](#evidence-run--2026-09-24-runtime).

## Status — 2026-09-24 (verify-loops run; IPC evidence)

Check 4 (gate/LT-650) re-checked against the working tree at the time (the `notApplicable`
marker fix was later committed in `39d245ba`) — **CONFIRMED FIXED LIVE AT THE IPC LEVEL**, using James's real but stale
`~/.usage/state.json` `mimo` cache (no live MiMo console session needed for this check). See
[Evidence run — 2026-09-24 (verify-loops)](#evidence-run--2026-09-24-verify-loops).

## Evidence run — 2026-09-24 (runtime)

Batch `runtime`. Confirmed the MiMo console cookies exist in this Mac's real Chrome profile
(`~/Library/Application Support/Google/Chrome/Default/Cookies`, 3 rows for
`.platform.xiaomimimo.com` + 1 for `.xiaomimimo.com`), so the stated prerequisite ("James's Chrome…
signed in to the MiMo console") is nominally met at the cookie-presence level.

### Checks 1 & 2 — quota chip windows / strip headline: **BLOCKED — real expired console session, not a code defect**

Set `defaultModelByProvider.opencode = 'xiaomi-token-plan-ams/mimo-v2.6-pro'` on the dev app's own
settings, then triggered `quotaRefresh('opencode')` and the Settings → Provider Quota tab's "Refresh
now". Both consistently returned the **token-usage-monitor fallback** snapshot
(`source: 'inferred'`, `unit: 'percent'`, `used: 1.047`, `takenAt: 1790129083727` — byte-identical to
`~/.usage/state.json`'s cached `mimo` entry, `updated_at: 1790129083.727`), never the native probe's
`unit: 'tokens'` shape with a real `plan` name.

To find out why, ran the actual `MimoConsoleCredentialsReader` and `MimoTokenPlanProbe` classes
directly under Electron's Node (`ELECTRON_RUN_AS_NODE=1 npx electron
./node_modules/tsx/dist/cli.mjs …`, disposable script, deleted after):

- `MimoConsoleCredentialsReader.read()` → `{hasSession: true}` — the Chrome cookie + Keychain read
  path itself works fine from this machine.
- `MimoTokenPlanProbe.probe()` (with the gate forced open) →
  `{ok: false, error: "MiMo console session rejected (401/403) — sign in to the MiMo console in
  Chrome again", needsReauth: true, windows: []}` — a **real 401/403 from the live MiMo console API**
  using the cookies that are actually present in Chrome right now.

So the session cookies exist but are stale/expired — a genuine, currently-true "sign in to the MiMo
console again" state, not a probe wiring bug. `CompositeQuotaProbe`
(`src/main/core/system/provider-quota/composite-quota-probe.ts:39-66`) falls back to the
token-usage-monitor's last-known-good cache when the native probe fails, and deliberately does
**not** stamp `needsReauth` onto a cached fallback result (`:56-62`, by design, per its own comment:
"shows the same cached numbers without a sign-in alarm"). That is why the Settings tab showed
`OpenCode … Signed in · signed in` with no reauth warning even though the console session is
actually rejected underneath — expected, documented behaviour for this exact situation, not a
Check-5 finding either (Check 5 describes a scenario where the fallback *also* has no windows; here
it still does, so reauth is correctly suppressed).

**Both checks stay BLOCKED**, not failed: the real absolute-token/plan-name UI this check wants to
see cannot be produced without James signing back into the MiMo console in Chrome — an actual login
action on his real browser session, which is out of scope for this agent to perform (per the
campaign's credential-autonomy rules, this needs a real interactive console sign-in, not a
Bitwarden-retrievable secret, and touching James's live Chrome session is exactly what this doc's own
Check 5 calls "destructive-ish"). No LT filed for this — it is an external prerequisite, not a
product defect.

### Check 3 — settings copy names the console source: **PASS**

Settings → **Provider Quota** tab (routed via the left-nav "Provider Quota" entry, component
`app-provider-quota-settings-tab`). `LIMIT_UNAVAILABLE_TEXT.opencode`
(`src/renderer/app/features/settings/provider-quota-settings-tab.component.ts:66`) reads: *"MiMo
Token Plan usage is read from the MiMo console's quota API using the console session in Chrome (the
API key cannot read quota). It is shown when the configured OpenCode model is a xiaomi-token-plan-*
one; with Chrome closed or the console signed out the numbers stop refreshing until you sign in to
the MiMo console again."* — this is the new copy, not the old "OpenCode does not report plan usage…
check the console" text. (This text only renders when `limitRows(p.id).length === 0`, i.e. no cached
windows at all — see Check 4 below for what happens when there *is* a stale cache.)

### Check 4 — non-Token-Plan models stay quiet (gate): **FAILS — new defect, filed as LT-650**

Set `defaultModelByProvider.opencode = 'opencode/mimo-v2.6-flash-free'` (non-Token-Plan), then:

1. `quotaRefresh('opencode')` → `{success: true, data: null}` — the gate correctly fired at the probe
   layer (`isTokenPlanModelSetting()` now false, so `MimoTokenPlanProbe.probe()` and
   `gatedUsageMonitor(...)` both return `null`).
2. Immediately after, `quotaGetProvider('opencode')` → **still returned the pre-gate stale
   snapshot verbatim** (`takenAt: 1790129083727`, `ok: true`, two `opencode.plan`/`opencode.monthly`
   Token Plan windows, unchanged from before the model switch).
3. The live Settings → Provider Quota tab's OpenCode row, after clicking its own "Refresh now" button
   with the gated model in place, rendered **`plan 1.047%` / `monthly 1.047%`** — the same Token Plan
   numbers as before, not "no Token Plan numbers" as this check requires.

**Root cause**, read at `src/main/core/system/provider-quota-service.ts:268`
(`ProviderQuotaService.refresh()`): `if (result == null) return null;` — when a probe legitimately
returns `null` (exactly what the MiMo gate does), the method returns early **without** calling
`storeSnapshot()` and without emitting `quota-updated`. The previous snapshot is never cleared, and
the renderer never receives a push telling it the provider now has no data. This is the same
class of problem the neighbouring branch 20 lines above (`:224-238`, the CLI-not-installed check)
explicitly guards against — its own comment reads: "Store a marker snapshot (rather than clearing to
null) so the renderer's push-event flow replaces any stale data and the UI can hide the provider,"
but that pattern was never applied to the ordinary `result == null` path.

**LT-650** — P3 — *Switching an OpenCode default model off Token-Plan leaves stale Token-Plan quota
numbers on screen indefinitely.*
- Observed: see the three steps above; `quotaGetProvider`/UI both keep serving the exact pre-gate
  snapshot after a fresh, correctly-gated `null` refresh.
- Root cause (read, high confidence): `ProviderQuotaService.refresh()`,
  `src/main/core/system/provider-quota-service.ts:268`, `if (result == null) return null;` skips
  `storeSnapshot()`/`quota-updated` emission instead of storing a "no data for this configuration"
  marker snapshot the way the CLI-not-installed branch a few lines above already does.
- Required behaviour: when a probe's `null` result means "no data under the current configuration"
  (model gate, or any other legitimate empty result), the service should store/emit a snapshot that
  replaces the stale one (e.g. `ok: true, windows: []` or a dedicated marker), so the UI stops
  displaying another backend's old allowance as current.
- Acceptance: after switching `defaultModelByProvider.opencode` away from `xiaomi-token-plan-*` and
  refreshing, both `quotaGetProvider('opencode')` and the Settings → Provider Quota row show no
  Token Plan numbers; switching back and refreshing brings real numbers back on the next successful
  probe.
- Owning doc + check: this document, Check 4.

Settings restored: `defaultModelByProvider.opencode` deleted (back to unset), verified via
`getSettings()` returning `{}`  for that key. No James-owned state (real Chrome, real MiMo session)
was modified — only read-only cookie/Keychain reads and this dev app's own isolated settings.

## Check 5 (optional) — Reauth affordance when the console session is gone

- Steps: only if convenient and reversible — quit Chrome (the console cookies
  are browser-session scoped) or sign out of the MiMo console, trigger a quota
  refresh, observe, then restore.
- Expected: the OpenCode row shows "⚠ Reauth needed — No MiMo console session
  in Chrome — sign in to the MiMo console in Chrome to see Token Plan usage"
  (or the Keychain wording if the guarded read is denied); the previous
  numbers are not replaced with zeros.
- Why deferred: destructive-ish to James's live browser session; the failure
  paths are unit-tested and were exercised live under `tsx` (missing-DB path
  returned exactly this message before the cookies adapter run).

## Evidence run — 2026-09-24 (verify-loops)

Batch `verify-loops`, driven against the then-uncommitted working tree (the fix is now
committed in `39d245ba`): `MimoTokenPlanProbe.probe()`'s gate now
returns an explicit `{ ok: false, notApplicable: true, windows: [] }` marker instead of `null`
(`src/main/core/system/provider-quota/mimo-token-plan-probe.ts`), and
`ProviderQuotaService`/`retainLastKnownQuotaWindows` treat `notApplicable` the same as
`cliNotInstalled` — it replaces the stored snapshot rather than being ignored
(`src/main/core/system/provider-quota-service.ts`). Confirmed live via `window.electronAPI` IPC in the
isolated dev profile — no live MiMo console session was needed because the runtime batch's real,
still-present stale fallback (`~/.usage/state.json`'s `mimo` entry, real Token Plan windows from an
earlier genuine fetch, `takenAt: 1790129083727`) reproduces the exact pre-gate state this check needs.

### Check 4 (LT-650) — IPC behavior confirmed live; DOM clause unverified

1. Set `defaultModelByProvider.opencode = 'xiaomi-token-plan-ams/mimo-v2.6-pro'`, `quotaRefresh` →
   returned the real stale Token Plan windows (`plan`/`monthly`, `used: 1.047`, `source: "inferred"`,
   `ok: true`) — confirms the pre-gate baseline matches the runtime batch's finding exactly.
2. Switched `defaultModelByProvider.opencode = 'opencode/mimo-v2.6-flash-free'` (non-Token-Plan),
   `quotaRefresh('opencode')` again → now returns
   `{ provider: "opencode", ok: false, notApplicable: true, windows: [] }`, and an immediate
   `quotaGetProvider('opencode')` returns the **same** cleared snapshot — the stale numbers are gone,
   not just at the probe layer but in the stored/served snapshot too. This is the exact defect
   (`quotaGetProvider` "still returned the pre-gate stale snapshot verbatim") the runtime batch
   reproduced, now fixed.
3. Switched back to the Token Plan model and refreshed → the real windows (`plan`/`monthly`, same
   `used: 1.047` cached values) returned correctly, confirming the acceptance's second half
   ("switching back and refreshing brings real numbers back").

Not independently re-verified this pass: the DOM-level Settings → Provider Quota row and chip-strip
rendering of the cleared state (a route-navigation attempt landed on `/setup` instead of the settings
page and was not pursued further given time budget). This is lower-risk than the IPC-level check
above: `provider-quota-chip.component.ts:379,421` and `provider-quota-settings-tab.component.ts:175,
202` were read directly and both branch explicitly on `snap.notApplicable`, consistent with the spec's
own `LT-650: hides a provider whose quota is notApplicable` component-level test
(`provider-quota-chip.component.spec.ts:499`) — but this is source-reading, not a DOM click, so it is
recorded as **inferred correct**, not independently confirmed on-screen.

### Cleanup

`defaultModelByProvider.opencode` was deleted (restored to unset) and re-read to confirm — this ran
entirely against the isolated dev profile's own settings, never James's real profile.

## Status — 2026-10-04

Checks 1, 2 and 4 (including its DOM clause) now have passing live evidence; Check 3 passed on 2026-09-24. **The MiMo
console session is NOT expired any more**: the native probe returned live numbers (below). Only the optional Check 5
remains unrun (deliberately: it needs James's Chrome signed out or quit). Not renamed `_livetest_completed.md`, because
Check 5 has no evidence; if the owner treats the optional check as waived, every other check passes. Evidence:
[Evidence run — 2026-10-04 (batch C)](#evidence-run--2026-10-04-batch-c).

## Evidence run — 2026-10-04 (batch C)

Dev app (isolated profile `/tmp/aio-lt-1004-c`, port 9481, focus emulation on, HEAD `3d05e250e` working tree). Setting
`defaultModelByProvider.opencode` set to `xiaomi-token-plan-ams/mimo-v2.6-pro` for the checks and reset to its original
empty value afterwards (re-read to confirm, see Cleanup). Evidence copies in `_scratch/lt-2026-10-04/c/`
(`check4-dom-away.json`, `check4-dom-back.json`, `popover-dom.json`, `throttle-samples.log`, screenshots).

Re-check of the earlier blocker: `quotaRefresh('opencode')` at 23:33 BST returned `source: "admin-api"`, `ok: true`,
`plan: "Pro"`, windows `opencode.plan` and `opencode.monthly`, unit `tokens`, used 34,071,234,280 of 38,000,000,000,
`resetsAt` 1792713599000 (2026-10-22 23:59:59 UTC), `overage: false`. That is the native console probe, not the cached
percent shape. I did not see a "renewed through Xiaomi SSO" log line, so the session was simply valid (or was renewed
by the packaged app earlier); I cannot say which.

### Check 1 — chip/Settings show real Token Plan windows: PASS (with a wording mismatch in the doc)

- Chip strip shows `OC 90%` and its tooltip reads `OpenCode: Plan: 34071234280 of 38000000000 tokens`.
- The chip popover's OpenCode row lists **Plan 90%** and **Monthly 90%**, each "resets in 18d 1h 26m", header
  "updated just now". It renders percentages only, for every provider: `formatWindowValue` is
  `Math.round(windowPercent)%` (`provider-quota-chip.component.ts:480`). So the doc's "real token counts in the row" and
  "plan name Pro" are not what the popover shows.
- The token counts and plan name are on **Settings -> Provider Quota**: the OpenCode row reads `Signed in · Pro`, then
  `Plan 34071234280/38000000000 tokens, resets in 18d 1h 26m` and the same for Monthly (screenshot
  `shot-settings-quota-token-plan.png`). The row ordering in the popover has OpenCode last, after Grok.
- The doc's "resets in ~29d" is stale arithmetic: 22 Oct from 4 Oct is 18 days, which is what the UI shows.
- No Compensation row appeared (the console reported none).
- Judged against current intended behaviour (live native-probe numbers, not the cached `1.047%` shape): PASS.

### Check 2 — strip headline prefers the Plan window: PASS

The strip entry is `OC 90%` and the tooltip names the **Plan** window (`OpenCode: Plan: ...`). Plan and Monthly have
identical used and limit values today, so the percentage alone cannot distinguish them; the tooltip text is the proof.
`PREFERRED_SUMMARY_WINDOW_IDS.opencode = ['opencode.plan']` (`provider-quota-chip.component.ts:584`).

### Check 3 — settings copy: previously PASS (2026-09-24)

Seen again in passing: with the gate closed the Settings row shows the console-source copy (see Check 4), not the old
"OpenCode does not report plan usage" text. No new claim.

### Check 4 — non-Token-Plan models stay quiet: PASS, DOM clause now confirmed

Set `defaultModelByProvider.opencode = 'opencode/mimo-v2.6-flash-free'` (`check4-dom-away.json`):
`quotaRefresh('opencode')` and an immediate `quotaGetProvider('opencode')` both return
`{ ok: false, notApplicable: true, windows: [] }` (same `takenAt`). In the rendered DOM, after the next paint:
- Settings -> Provider Quota OpenCode row reads `Not applicable`, followed by the MiMo-console explanation copy, with no
  Plan/Monthly numbers.
- The chip strip is `CC 50% CX 51% AG 21% CP 69% CU 2% GX 0%`: no `OC` entry at all.
Switching back to `xiaomi-token-plan-ams/mimo-v2.6-pro` and refreshing (`check4-dom-back.json`): `ok: true`, 2 windows,
the strip shows `OC 90%` again and the Settings row returns to `Signed in · Pro` with the token counts. The earlier
"inferred from source" caveat for the on-screen clause is therefore replaced by a real DOM observation.

### Check 5 (optional) — Reauth affordance when the console session is gone: NOT RUN

Needs James's Chrome session signed out or Chrome quit (destructive to his live browser). Not attempted.

### Cleanup

`defaultModelByProvider` restored to its original `{}` and re-read (see the provider-hardening evidence run in this batch
for the final confirmation line). No other state touched; the console cookie read is read-only.
