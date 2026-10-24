# Browser Gateway keyboard, viewport and zoom controls — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-14-browser-gateway-input-controls_plan_completed.md](2026-10-14-browser-gateway-input-controls_plan_completed.md)

Source spec: `/Users/suas/work/Dingley/dingley-kpi/dingley-kpi-be/docs/handover/2026-10-14-browser-gateway-controls-build-prompt.md`

**Prerequisites (why these checks were deferred on 14-15 October 2026):**

The three tools are implemented and fully verified in-loop (31,723 unit/integration tests,
including an extension-VM harness that drives the real `background.js` command handlers), but the
live Windows path cannot serve them yet:

1. The running coordinator is the packaged production app
   (`/Applications/Harness.app` — `app.asar` + compiled `aio-mcp` bridge). Its bridge and RPC
   server were built before this change: `browser.tool_search` / `browser.tool_describe` return
   the old 51-tool surface and `browser.press_key` reads "Unknown browser tool". A **rebuilt and
   restarted coordinator** running this checkout's code is required (deploy/restart authority —
   not yet given).
2. Windows Chrome loads the Harness extension **unpacked from the PC's repo checkout**
   (`C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator\resources\browser-extension`,
   currently bundle 0.2.40). The new handlers ship in bundle **0.2.41**. The PC must receive the
   updated `background.js` + `manifest.json` (via the worker auto-update pull after an authorised
   push, or a direct file copy) and the extension must reload onto 0.2.41.
3. Everything below runs through the existing Windows shared-tab connection (Browser Gateway,
   `computer: windows-pc`, node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`). No Mac browser.

**Restoration protocol (applies to every check):** before each check capture the current viewport
(`browser.set_viewport` read), window bounds (reported in the `window` field) and browser zoom
(`browser.set_zoom` read). Restore them after each check with `reset: true` — success, failure,
cancellation and timeout alike. Report any `restorationFailed` value verbatim; never claim a
restore that the tool did not confirm.

**Fixture:** use a benign local HTML fixture first (serve it from the PC, e.g. a folder with a
simple page containing several focusable controls, a link, a collapsible menu and a wide table;
open it with `browser.find_or_open`, `computer: "windows-pc"`). Only then the Dingley
development/testing pages **where authorised** — and never change KPI figures to prove these
controls. The deferred Dingley test scripts (keyboard/tablet/zoom sections of Script 03 and
friends) stay deferred until James explicitly authorises rerunning them.

## Check 1 — Tab, Shift+Tab and Enter on a shared tab

1. `browser.press_key` `key: "Tab"` on the fixture tab. The result's `focus` must identify the
   next control (tag/role/id) with no field values exposed.
2. `key: "Tab"` again — focus advances. Then `key: "Tab", modifiers: ["Shift"]` — focus returns to
   the previous control. Focus must stay visibly indicated in the page.
3. `key: "Enter"` with `actionHint: "activate the harmless link"`, `expectUrlChange: true`. The
   link activates (URL changes). Enter carries the activation gate (explicit approval /
   auto-approve) — record which authority satisfied it.
4. Same tab and (where present) logged-in session survive; tab id unchanged.

Expected: every result `applied: true` with a plausible `focus` read-back; no modifier left
stuck (type a character into a text field afterwards to confirm normal keyboard state).

## Check 2 — Tablet-sized viewport

1. Record the original viewport (read mode).
2. `browser.set_viewport` `width: 768, height: 1024` (or the fixture's tablet breakpoint). Result
   must report `mode: "tab_emulation"`, `requested` 768×1024 and `actual` window.innerWidth/
   innerHeight matching the emulation.
3. Verify the page layout responded at that content width: the fixture's menu collapses/operates
   and the wide table scrolls.
4. `reset: true` → `mode: "reset"` and the original dimensions return. Report any
   `restorationFailed`.
5. If window scope is exercised: `scope: "window"` must report `mode: "window_resize"` with the
   affected `windowId`, the OTHER tabs in that window, and retained original bounds; `reset`
   restores them. Never present emulation as a window resize or vice versa.

## Check 3 — Real Chrome zoom 200%

1. `browser.set_zoom` read — record `zoomFactor` and `viewport`.
2. `zoomFactor: 2` → result `zoomFactor: 2`, `zoomPercent: 200` read back as real Chrome zoom
   (the tab's zoom indicator / page scale), `zoomScope` per-tab, viewport dims reported.
   Controls must remain readable at 200%.
3. `reset: true` → zoom returns to the recorded original (and original zoom settings). A lost
   baseline must report `restorationFailed` (e.g. `browser_zoom_baseline_lost`) rather than
   claim success.

## Check 4 — Failure, retry and idempotency honesty

1. Press Enter twice with the SAME `idempotencyKey` on a link that would navigate: exactly one
   activation; the second result is `deduplicated: true` and, if the original had no confirmed
   success, `applied: false` with `outcome: "failed"` and `reason:
   press_key_prior_attempt_outcome_unknown` — it must never claim success and never press again.
2. A deliberate re-press uses a NEW `idempotencyKey` and works.
3. Simulate a failure (e.g. kill the tab mid-press, or use a stale target): the failed call must
   not claim success, and restoration information (viewport/zoom baselines) must not be lost.

## Check 5 — Existing Gateway behaviour unchanged

On the same connection: `browser.navigate`, `browser.click`, `browser.type`/`browser.fill_form`
(benign fixture fields only), `browser.snapshot`, `browser.screenshot` all behave as before;
`browser.health` advertises the new `controls` block; secure login paths (`browser.fill_credential`
gating) untouched.

## Check 6 — Dingley pages where authorised (explicitly NOT run on 14-15 Oct 2026)

The deferred Dingley keyboard / tablet-width / 200% zoom checks (Script 03 scope) run only on
James's explicit instruction, on the Dingley development/UAT pages, without changing any KPI
figures. Record results in the Dingley handover docs, not here.
