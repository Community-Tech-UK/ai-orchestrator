# GitHub Copilot Account Routing — Live Test

## Status — completed by consolidation 2026-09-27

Open: 0 · Passed / closed: 2 · Transferred residual campaign: 1 · Failed: 0

Checks 10 and 11 passed in the final 2026-09-24 rebuilt-app run below. Checks 1–9 all depend on the
same unavailable prerequisite — two real Copilot-entitled identities and OAuth/profile setup, with
one matching sign-in on the Windows worker — and now form one ordered campaign in
[RES-021](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-021--two-account-copilot-routing-attribution-and-worker-binding).
The current rebuilt dev app still reports no signed-in Copilot account. This source is closed; its
historical failed/fixed LT-631 evidence remains below for auditability.

## Status — 2026-09-24 (verify-final, third pass)

Re-ran after the orchestrator's fix (`.project-actions.visible`/hover/focus-within now use
`transform: none` instead of `translateX(0)`, `instance-list.component.scss`, dev renderer
rebuilt). **Checks 10 and 11 both PASS.** The off-screen containing-block bug is gone: the menu's
`offsetParent` is now `null` (not `.project-actions`), its rect stays fully inside the viewport at
the top row, the bottom row, and a narrowed (<420px) list pane, every item is reachable (via the
menu's own internal scroll where the Copilot-routing sub-component's height forces it), the
rounded corner survives that scroll, keyboard nav keeps the menu open, a real wheel scroll on the
list closes it, and Escape returns focus to the trigger button. Full write-up:
[Evidence run — 2026-09-24 (verify-final, LT-631 third pass)](#evidence-run--2026-09-24-verify-final-lt-631-third-pass).

## Status — 2026-09-24 (verify-final)

Re-ran checks 10/11 a third time against the rebuild done at ~03:45 (working tree, newer than
`verify-ui`'s ~03:xx pass). **The self-close-on-open regression `verify-ui` reported is now
FIXED**: `focus({ preventScroll: true })` (`instance-list.component.ts:840`) stops the ancestor
`.instance-viewport` from scrolling when the menu's first item is focused, so
`onInstanceViewportScroll()` no longer fires spuriously and a real CDP mouse click opens the menu
and it stays open (confirmed 3/3 tries, `openProjectMenuKey()` stable, zero `closeProjectMenu`
calls logged). Check 11 still passes (unaffected). **But check 10 has a NEW regression that
supersedes both prior findings — the project menu now renders completely off-screen for an
ordinary project row, making it fully unusable, not merely visually clipped.** This is a REOPEN of
LT-631, not a new id. Full write-up:
[Evidence run — 2026-09-24 (verify-final)](#evidence-run--2026-09-24-verify-final).

## Status — 2026-09-24 (verify-ui)

Re-ran checks 10 and 11 live against the WORKING TREE's uncommitted LT-631 fix (`position: fixed`
project menu, not HEAD `f04f6748`) — see
[Evidence run — 2026-09-24 (verify-ui)](#evidence-run--2026-09-24-verify-ui). **The original
clipping/positioning defect (LT-631) IS fixed**: the menu is `position: fixed`, sized against the
real viewport, reachable end-to-end, and paints above lower rows. **But check 10 still FAILS**,
for a new reason: opening the menu on a scrollable project list reliably closes it again within
the same interaction, before it can be used. This is a regression in the same fix (the new
scroll-closes-the-menu safeguard fires on the menu's own open sequence, not on a genuine user
scroll) — reported to the orchestrator as a reopen candidate for LT-631, not a new id, since it is
the same check and the same code change.

## Status — 2026-09-24 (settings)

Ran checks 10 and 11 only (the two agent-runnable, no-Copilot-account-needed geometry checks) —
see [Evidence run — 2026-09-24 (settings)](#evidence-run--2026-09-24-settings). **Check 11 PASSES.**
**Check 10 FAILS — new defect (see LT-631 in the batch report).** Checks 1–9 remain untouched
(need real GitHub-Copilot-entitled accounts and a redeployed worker; out of this batch's scope).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Deferred live-validation checks for
> [2026-08-25-copilot-account-routing_plan_completed.md](./2026-08-25-copilot-account-routing_plan_completed.md).
> **Prerequisites:** a rebuilt app from this working tree (`npm run build`), the standalone
> Copilot CLI on PATH (`npm install -g @github/copilot`), and **two real GitHub accounts with
> Copilot entitlement** — a personal one and a work/enterprise one. Checks 7–8 additionally need
> a redeployed worker agent on a connected remote node.
> Rename this doc `_livetest_completed.md` only when every check passes with evidence.

## Status — 2026-09-06

Open: 11 · Closed: 0 · Failed: 0

Needs two real GitHub-Copilot-entitled accounts and a real OAuth round trip for checks 1–9
(check 8 also needs a redeployed worker and a sign-in on that node); checks 10–11 only need an
agent driving a real-size Electron window (CDP), no human required.

## Background

All code, targeted tests, both typecheck gates, lint, the LOC ratchet, `build:main`, and the full
quiet suite pass in-loop (see the completed plan) — none of that is re-litigated here.

While attempting Check 1 on 2026-08-25, every `copilot-account:*` IPC channel (all 15) was found
rejecting every renderer call — a schema-strictness defect (`ipcAuthToken` not declared on 10
`.strict()` payload schemas), filed and fixed as
[LT-522](../../plans/livetest-remediation-register.md#lt-522-every-copilot-account-ipc-channel-rejected-every-renderer-call-because-strict-schemas-did-not-declare-the-preloads-auth-stamp)
with 32 regression tests (mutation-checked: revert fails 13/45, restored passes 45/45). As of
2026-08-31 the fix is confirmed present in current source/dev build, so it is no longer a blocker
for any of the checks below — do not brief this doc as blocked on the old IPC schema defect. The
remaining blocker for checks 1–9 is exactly the two-entitled-accounts/OAuth prerequisite stated
above.

## Closed checks

- Checks 10 and 11 passed in the 2026-09-24 verify-final third pass documented below.
- Checks 1–9 transferred together to RES-021 on 2026-09-27.

## Historical check procedures

### Check 1: Authenticate two isolated profiles (spec §19.7.1)

1. Launch the rebuilt app. Open **Settings › GitHub Copilot Accounts**.
2. Confirm the migration ran: exactly one account is listed, labelled
   **Existing Copilot account**, marked Default, and showing the login you were already
   signed in as (or "Not signed in yet" if you never signed in).
3. Add a second account: label `Enterprise`, kind **Work / enterprise**, host `github.com`
   (or your GitHub Enterprise Server hostname).
4. Press **Sign in** on the Enterprise card. A terminal opens running
   `COPILOT_HOME='<…>/copilot-cli-profiles/enterprise' copilot login`.
5. Complete the GitHub sign-in in the browser as the **work** account.
6. Back in the app, press **Check sign-in** on that card.

**Expected:** the Enterprise card reports `Signed in as <work-login>`; the legacy card still
reports its own, different login. Both directories exist:
`<userData>/copilot-cli-home` and `<userData>/copilot-cli-profiles/enterprise`.

**Why deferred:** requires a real OAuth browser round trip against a second real account.
**Blocker class:** C (account consent / OAuth login).

---

### Check 2: Verify identity metadata independently (spec §19.7.2)

1. Read each profile's own config directly, outside the app:
   `python3 -c "import json;print(json.load(open('<home>/config.json')).get('lastLoggedInUser'))"`
   for both `copilot-cli-home` and `copilot-cli-profiles/enterprise`.
2. Compare against what the Settings cards show.

**Expected:** the two homes name **different** `lastLoggedInUser` logins, and each matches
its card. Do not paste the file contents anywhere — it can contain a plaintext token.

**Why deferred:** needs real authenticated state in both homes.
**Blocker class:** C (depends on Check 1's account state).

---

### Check 3: Simultaneous mapped sessions (spec §19.7.3)

1. Map a work repository to Enterprise: in **Route the current workspace**, enter that
   checkout's path, press **Check**, then **Route everything under &lt;owner&gt;**.
2. Open a personal repository checkout and confirm the composer chip reads
   `Existing Copilot account · the default account`.
3. Open the work checkout and confirm the chip reads `Enterprise · matched
   github.com/<owner>/<repo>`.
4. Start **both** Copilot sessions and send each a prompt at the same time.

**Expected:** both complete. Neither chip changes. The instance header of each shows its own
account badge throughout.

**Why deferred:** needs two entitled accounts and real concurrent model requests.
**Blocker class:** C.

---

### Check 4: Confirm attribution per account (spec §19.7.4)

1. In each running session, ask the agent to run `copilot /user` (or the installed CLI's
   equivalent account-reporting command) in its own terminal, **or** check each GitHub
   account's Copilot usage page after the run.
2. Record which account served which session.

**Expected:** the work session is attributed to the work account, the personal session to the
personal account. Nothing appears against the account that did not run it.

**Why deferred:** authoritative attribution requires provider-side billing/usage evidence.
**Blocker class:** C (needs real accounts and provider-side usage pages).

---

### Check 5: Ambient account state cannot retarget a session (spec §19.7.5)

1. Outside the app, switch the globally active GitHub CLI account
   (`gh auth switch`) and the ordinary Copilot account (`copilot` → `/user switch`)
   to the *other* identity.
2. Re-run Check 3 without changing anything in the app.

**Expected:** both sessions still route to the same accounts as before, and the chips are
unchanged. AIO's routing does not consult host-wide `gh` state.

**Why deferred:** needs real signed-in `gh` and Copilot state to switch.
**Blocker class:** C.

---

### Check 6: Ambient token variables are stripped (spec §19.7.6)

1. Quit the app. Relaunch it from a terminal with all six token variables set to obvious
   placeholders:
   ```bash
   COPILOT_GITHUB_TOKEN=placeholder GH_TOKEN=placeholder GITHUB_TOKEN=placeholder \
   GITHUB_COPILOT_GITHUB_TOKEN=placeholder GITHUB_COPILOT_API_TOKEN=placeholder \
   GITHUB_TOKEN_VARNAME=GITHUB_TOKEN open -a Harness
   ```
2. Start a Copilot session in the work repository.
3. While it runs, inspect the child's environment:
   `ps -eo pid,command | grep copilot` then `ps eww <pid>`.
4. Open **Settings › Doctor** and read the Copilot `authenticated` probe detail.

**Expected:** none of the six variables appear in the Copilot child's environment;
`COPILOT_HOME` and `COPILOT_GH_HOST` do. The session still runs as the mapped account.
Doctor names the six variables as present **by name only**, with no values.

**Why deferred:** needs a relaunched app, live child-process inspection, and (for the "mapped
work repository" part) the Check 1 account setup.
**Blocker class:** C.

---

### Check 7: Restored sessions keep their original account (spec §19.7.7)

1. With both sessions from Check 3 still present, quit and relaunch the app.
2. Restore each conversation from history.
3. Then, in Settings, **delete the owner rule** that mapped the work repository.
4. Send another message in the restored work session.

**Expected:** each restored session shows its original account badge. Deleting the rule does
**not** move the existing conversation — it still runs under Enterprise. A *new* session in
that repository now resolves to the default instead.

**Why deferred:** needs a relaunched app and two real accounts.
**Blocker class:** C.

---

### Check 8: Remote worker node binding (spec §19.7.8)

1. Redeploy the worker agent from this working tree to a connected remote node.
2. Without signing in on that node, force a Copilot session onto it (Settings › Remote Nodes,
   then pick that node for a new session in a mapped work repository).
3. Confirm the failure text, then sign in on the node: on that machine run
   `COPILOT_HOME=~/.orchestrator/copilot-cli-profiles/enterprise copilot login`.
4. Retry the same session placement.
5. While it runs, disconnect and reconnect the node.

**Expected:** step 2 parks with "GitHub Copilot account "enterprise" cannot run on this node:
it is not signed in on this node." — and does **not** run under any other account. Step 4
succeeds. Step 5 does not recalculate or lose the stamped profile. The node's Copilot state
lives under `~/.orchestrator/copilot-cli-profiles/`, never in a temp directory.

**Why deferred:** needs a redeployed worker and a real sign-in on that machine.
**Blocker class:** C (redeploy itself is agent-runnable; the blocking step is the real sign-in).

---

### Check 9: CLI verification dashboard routes, and its server-mode trade

Added after the completion gate found this surface spawning Copilot unrouted.

1. Open the **Verification Dashboard** (its default agent set includes Copilot).
2. Run a verification in the mapped **work** repository.
3. While it runs, inspect the Copilot child: `ps -eo pid,command | grep copilot`, then
   `ps eww <pid>`.

**Expected:** the child carries `--config-dir <…>/copilot-cli-profiles/enterprise` and
`COPILOT_HOME` pointing at the same directory; none of the six token variables are present;
the turn is attributed to the **work** account, not the personal one.

4. Confirm the accepted trade: this session runs exec-per-message, so it has no server-mode
   steering and reports no real context occupancy. Check the app log for
   `Skipping Copilot server mode for a routed account session`.

**Expected:** that log line is present. If the Copilot SDK has since documented an
environment or config-directory option on `CopilotClient`, re-open the decision recorded in
as-built note A14 rather than leaving server mode off indefinitely.

**Why deferred:** needs a rebuilt app, a real entitled work account, and live child-process
inspection.
**Blocker class:** C.

---

### Check 10: The project `⋯` menu can be scrolled when the Copilot section is tall

Added 2026-08-30 after gate rounds 5–6 confirmed the exposure from CSS, but
could not confirm recoverability without a live render. See
[the gate-remediation plan](./2026-08-30-copilot-routing-gate-remediation_plan_completed.md) (D15).

`.project-menu` had `overflow: hidden` and no `max-height`, while the Copilot
section renders an unbounded account list plus discovered-account rows inside
it. `max-height: min(60vh, 420px)` and `overflow: hidden auto` were added.

1. Configure two or more Copilot accounts, with at least one further account
   discoverable but not yet added, so the Copilot section is as tall as it gets.
2. Scroll the instance list so a project row sits near the BOTTOM of the
   viewport.
3. Open that project's `⋯` menu.

**Expected:** every item is reachable — the Copilot account rows, any
"Clear mapping" item, and "Remove project" below it. If the menu is taller than
the space available it scrolls internally; the border radius is still clipped
cleanly and no item is cut off with no way to reach it.

**Also check:** the same menu on a project at the TOP of the list is unchanged,
and menus on projects with a SHORT Copilot section have not gained a stray
scrollbar.

**Why deferred:** needs a real window at a real size; the failure depends on
viewport height and scroll position, which no unit test reproduces.
**Blocker class:** A (agent-runnable via CDP against a real-size Electron window; no
Copilot accounts strictly required, just enough rows to make the section tall).

---

### Check 11: An open project menu paints above every other project row

Reported 2026-08-31: hovering an open project dropdown showed a DIFFERENT
project's row controls (`+ ⋯ ⌄`) painting through it, where the menu overlapped
that row.

Cause: `.project-header-row` is `position: relative; z-index: 1`, making every
row its own stacking context — so the dropdown's `z-index: 100` only ranked it
within its own row, and a row lower in the list won on DOM order.
`.project-header-row.menu-open { z-index: 50 }` now lifts the owning row.

1. Have at least three projects in the list, one directly below another.
2. Open the `⋯` menu on a project that has other projects beneath it, so the
   menu overlaps at least one lower project row.
3. Move the mouse across the overlap.

**Expected:** nothing from the underlying project row is visible through the
menu — no `+`, `⋯` or chevron, no hover highlight bleeding through. The menu is
opaque over every row it covers.

**Also check:** the menu still closes correctly, and the row beneath is
interactive again once the menu closes.

**Why deferred:** paint order needs a real window; the unit test
(`project-menu-stacking.spec.ts`) can only pin the z-index invariant, not the
rendered result.
**Blocker class:** A (agent-runnable via CDP against a real-size Electron window).

---

## Evidence run — 2026-09-24 (settings)

Dev app from HEAD `f04f6748`, isolated profile `/tmp/aio-lt-0924-settings`, CDP on `:9722`. No real
Copilot account was needed: `app-copilot-project-routing-menu`'s `accountsSignal` (a plain class
field, not a private JS closure) was seeded directly with 15 synthetic accounts to make the section
tall, per the check's own note that this is fine. Six real disposable project rows were created via
real `createInstance` calls so the target row had multiple rows both above and below it, and the
list's own scrollable pane (`.cdk-drop-list.instance-viewport`) was scrolled so the target row sat
mid-to-low in the visible area.

**Check 11 (menu paints above lower rows) — PASS.** With the `⋯` menu open on a row with another
project row beneath it, `document.elementFromPoint()` at the geometric overlap between the menu and
the lower row's controls hit a real `.project-menu-item` button (`hitIsInsideMenu: true`), not the
underlying row (`hitIsInsideSkillwsRow: false`) — no paint-through. Closing the menu (click outside)
removed it and the same point then hit the lower row again (`hitIsInsideSkillwsRow: true`) — the row
is interactive again. Matches `.project-header-row.menu-open { z-index: 50 }`
(`instance-list.component.scss:326`) working as intended.

**Check 10 (tall menu scrolls internally, nothing unreachable) — FAILS. New defect, filed as
LT-631 in the batch report, not a reopen of an existing LT id (this exact check was never
previously live-run).** `.project-menu` itself is correctly capped
(`max-height: min(60vh, 420px)`, `overflow: hidden auto`,
`instance-list.component.scss:514-515`) and does need to scroll (`scrollHeight 817 > clientHeight
418` with 15 seeded accounts). But its ANCESTOR, the scrollable project list pane
(`.cdk-drop-list.instance-viewport`, `overflow-y: auto` at `instance-list.component.scss:239`), has
its own real visible clip box that is routinely **shorter than the dropdown's own max-height** at
ordinary window sizes (measured 413px tall in a 900px-tall window, with page chrome — header,
composer, startup-check banners — taking the rest). Because the dropdown is a normal
`position: absolute` descendant of that scrollable ancestor (not a portal/`position: fixed`
overlay), the ancestor's `overflow: auto` visually clips the bottom of the dropdown with a **hard
rectangular edge**, not the dropdown's own rounded corner — confirmed by `elementFromPoint()`
returning `null` (no hit-testable element at all) at a point that is inside the dropdown's own
geometric box but past the ancestor's clip line, and reproduced with the target row **both near the
bottom of the list and at the very top of the list** (the ancestor's shortness is not a
near-bottom-row edge case; the list pane is shorter than 420px steady-state in this profile at
1440×900). Practical effect: the last ~150-160px of the dropdown's own 418px scroll window (visible
"slot") is unusable — content still cycles through by scrolling inside the dropdown, but the
dropdown's border-radius is replaced by an abrupt flat cut and the effective visible area is
noticeably smaller than what `min(60vh, 420px)` implies, in a real, ordinary window size, not an
edge case.

### Cleanup

All 6 disposable project instances terminated; `/tmp/aio-lt-0924-settings-{proj,newproj}*` removed.

---

## Evidence run — 2026-09-24 (verify-ui)

Dev app built from the **working tree** (uncommitted LT-631 fix, not HEAD `f04f6748`), isolated
profile `/tmp/aio-lt-0924-verify-ui`, CDP on `:9731`. 8 real disposable project rows created via
`createInstance` (`provider: 'claude', yoloMode: true`; the first attempt used
`launchMode: 'interactive'`, which self-terminated immediately with `Interactive Claude launch mode
requires the terminal runtime, which is not available in this build` — recreated with the default
`launchMode` and all 8 succeeded). Window 1000×700, `.cdk-drop-list.instance-viewport` measured
207–262px tall against 830px of content (`scrollHeight`/`clientHeight`) — genuinely scrollable at
this size, not an edge case.

**The clipping/positioning fix itself — CONFIRMED FIXED LIVE**, when the menu is opened without
letting its own default focus-on-open behaviour run (see the regression below for why that
qualifier matters): `.project-menu`'s computed style is `position: fixed`, `border-radius: 12px`;
its rect (`top/bottom/left/right`) is computed from `projectMenuPosition()` via
`computeProjectMenuPosition()` (`project-menu-position.ts`), not from the scrolling ancestor's clip
box. With `.project-menu`'s internal `scrollTop` driven to 0 and then to `scrollHeight`,
`elementFromPoint()` hit a real menu descendant at both the first item and the last (`Remove
project`) — no `null` hit past a clip line, which is the exact defect shape LT-631 fixed. A point at
the geometric overlap between the open menu and the project row directly below it hit
`.project-menu`, not the underlying row (check 11's invariant, unaffected by this fix, still holds).

**New regression: the menu closes itself on open, on a scrollable list — reported as a reopen of
LT-631's check 10, not a new id.**

Observed with a **real CDP mouse click** (`Input.dispatchMouseEvent`, not a synthetic
`dispatchEvent`) on the "Project options" trigger of two different rows (index 0 and index 2):
`openProjectMenuKey()` is set correctly for one tick, then immediately reset to `null`. Traced by
wrapping the live component's `closeProjectMenu` method to capture a stack trace at the call site:

```
closeProjectMenu called, stack=... at _InstanceListComponent.onInstanceViewportScroll ...
```

Root cause, read with high confidence: `toggleProjectMenu()`'s existing
`requestAnimationFrame(() => firstMenuItem.focus())` (`instance-list.component.ts:837-841`, present
before this campaign) focuses the first `.project-menu-item` button. That element is still a DOM
descendant of the scrollable `.cdk-drop-list.instance-viewport` (only its *visual* position escapes
via `position: fixed`; its place in the DOM tree does not). Chromium's default "scroll the focused
element into view" behaviour walks the DOM's scrollable-ancestor chain and scrolls
`.instance-viewport` to bring the (visually already-on-screen, fixed-position) focused element into
that ancestor's clip box — confirmed directly: `.instance-viewport.scrollTop` measured `0` before
the click and `431` immediately after the focus-driven native `scroll` event fired. That native
scroll event is exactly what the **new** `onInstanceViewportScroll()` handler
(`instance-list.component.ts:872-876`, added by today's LT-631 fix specifically to close the menu
when the *user* scrolls the list) reacts to — it cannot distinguish a real user scroll from this
self-inflicted, focus-driven one, and closes the menu it just opened.

This reproduces on a plain project row with **no Copilot accounts seeded at all** (the focused
`.project-menu-item` is one of the three always-present buttons — Pin/Open in editor/Open in file
manager — not a `.cpr-item`), so it is not scoped to check 10's "tall Copilot section" scenario: any
project menu opened while the sidebar's project list is taller than its own visible box (a routine
state once a user has more than a handful of projects, not an edge case) closes itself on open.
`groupCount: 8`, `scrollHeight: 830`, `clientHeight: 207` at the time of reproduction.

Note on an earlier, misleading probe in this same session: calling `toggleProjectMenu()` directly
via `ng.getComponent(...)` with a bare, undispatched `new MouseEvent('click')` (not a real event
flowing through the button) sometimes left the menu open, because `event.currentTarget` is `null`
for such a call, so `repositionOpenProjectMenu()` early-returns for want of a trigger element and
the menu falls back to the browser's default (unclamped) static position for a `position: fixed`
box with no inset properties — a harness artifact, not evidence that the real interactive path
works. The measurements above use only real triggered opens (a real DOM `click` reaching the
button, or a real CDP mouse press/release on it) with `projectMenuPosition()` non-null.

Suggested required behaviour for whoever picks this up: either drop the `firstMenuItem.focus()` call
now that the menu no longer needs a manual focus-trap entry point (position:fixed changed how focus
interacts with the scrollable ancestor), or make `onInstanceViewportScroll()` ignore a scroll that
happens within one animation frame of the menu opening, or use `{ preventScroll: true }` on the
`.focus()` call (supported by all Chromium versions this app targets) so focusing the first item
never triggers the ancestor's scroll-into-view behaviour in the first place. `{ preventScroll: true
}` looks like the narrowest fix: it targets the actual mechanism (focus-driven scroll) without
touching the new scroll-close feature's own logic.

Incidental observation, not part of LT-631's scope: at this window width, real hit-testing on the
"Project options" trigger button itself (before any menu logic runs) is unreliable — a
`.resize-handle` (the sidebar/main-content splitter, `z-index: 10`,
`dashboard.component.scss:174-186`) and the main `workspace-shell` sit on top of roughly 20 of the
button's 26px width; only its leftmost ~6px (`btnLeft` to `btnLeft+5`) reliably hit-tested to the
button itself across a pixel-by-pixel scan. This did not block today's checks (the safe 6px zone was
used for every click), and may be specific to this run's unusually long synthetic project directory
names (`aio-lt-0924-verify-ui-proj8`, 27 characters) pushing `.project-actions` further right than a
typical short project name would; it is flagged here for whoever next touches
`instance-list.component.scss`'s `.project-header`/`.project-actions` flex layout, not filed as an
LT id.

### Cleanup

All 8 disposable project instances terminated (`c7rhad43p`, `c2301mp8w`, `cwnc216n0`, `cbbl0cdt4`,
`cs6wufx5n`, `csapis4so`, `cz35019rn`, `cv7wze9vu`); `/tmp/aio-lt-0924-verify-ui-proj{1..8}` removed.

---

## Evidence run — 2026-09-24 (verify-final)

Batch `verify-final`, CDP port 9741, profile `/tmp/aio-lt-0924-verify-final`, driven against the
same **working tree** rebuild the brief describes (dist/main + dev renderer rebuilt ~03:45, newer
than `verify-ui`'s pass). 8 real disposable project rows created via `createInstance`
(`provider: 'claude', yoloMode: true`, no `launchMode` override), window 1000×700,
`.cdk-drop-list.instance-viewport` measured `scrollHeight: 830` / `clientHeight: 207` — genuinely
scrollable.

**The self-close-on-open regression is FIXED.** Reproduced the exact `verify-ui` method (real
`Input.dispatchMouseEvent` click on the "Project options" trigger, `closeProjectMenu` wrapped to
log its call stack) 3 times across different rows: `openProjectMenuKey()` was set and **stayed**
set (`log: []`, zero `closeProjectMenu` calls) every time, `.instance-viewport.scrollTop` was
unchanged before/after the click (e.g. `332` → `332`), and the menu's computed style stayed
`position: fixed`, `border-radius: 12px`. This matches `instance-list.component.ts:840`
(`firstMenuItem.focus({ preventScroll: true })`) exactly fixing the mechanism `verify-ui`
diagnosed.

**New regression found while testing check 10's reachability sub-check — the menu now renders
completely off-screen, reproduced 3/3 times on 2 different project rows.** With the menu open (via
a real click, confirmed staying open per above), `.project-menu`'s own `getBoundingClientRect()`
reported `{ left: -417.9, right: -199.5, top: 41.8, bottom: 422.2 }` in a 1000×700 window —
entirely off the left edge of the viewport. `document.elementFromPoint()` at the first and last
menu item's own coordinates returned `null` both times (not "clipped", but literally not
paintable — no hit-testable element exists at those coordinates because they are off-screen).
Reproduced identically at the app's real native window size (no CDP viewport override at all,
same `window.innerWidth: 1000`), so this is not a narrow-viewport artifact.

Root cause, read with high confidence and confirmed live via direct DOM inspection:
`computeProjectMenuPosition()` (`project-menu-position.ts:44-61`, added today as part of this same
LT-631 fix) computes `right: Math.max(VIEWPORT_MARGIN, viewport.width - anchor.right)` — explicit,
documented math assuming `.project-menu`'s `position: fixed` box is positioned relative to the
**browser viewport**. It is not. `.project-menu`'s DOM parent, `.project-actions`
(`instance-list.component.scss:428-449`), has `transform: translateX(6px)` at rest and
`transform: translateX(0)` when hovered/focused/`.visible` — **every state uses a non-`none`
`transform`** — and per the CSS spec, any ancestor with `transform !== none` becomes the
containing block for a `position: fixed` (and `position: absolute`) descendant, overriding normal
viewport-relative positioning. Confirmed directly: `document.querySelector('.project-menu').offsetParent`
is `.project-actions`, not `<body>`/`<html>`; `getComputedStyle('.project-menu').right` reads the
JS-set `607.875px` inline style, but the browser resolves that `right` against `.project-actions`'s
own box (measured right edge `402.39px` in the same run), not the window's `1000px` — landing the
menu's right edge at `402.39 - 607.875 = -205.5px` (viewport coords), matching the measured
`menuRect.right: -199.5` almost exactly (small residual from a slightly different row's geometry).
This is not a scroll-position or trigger-row edge case: `.project-actions`'s transform is present
in every row's default and hovered/focused state (`instance-list.component.scss:428-449`,
pre-existing hover-reveal styling, not part of today's change), so **every** project's `⋯` menu is
affected whenever the row's `.project-actions` right edge sits meaningfully left of the true
viewport's right edge — which is the normal case for a project list in a sidebar/list column
narrower than the whole window, not an edge case.

**This reopens LT-631 a second time, for a third distinct reason** (original: hard overflow clip
from the scrolling ancestor; first reopen, now fixed: focus-driven self-close; this reopen: wrong
containing block for the `position: fixed` math). Required behaviour: either give `.project-menu`
a containing block that really is the viewport (e.g. render it via a CDK overlay/portal attached to
`<body>` instead of as a normal DOM descendant of `.project-actions`), or remove/neutralise the
`transform` on `.project-actions` (e.g. swap to a non-transform hover reveal, or wrap only the
`transform`-using visual layer in a sibling that isn't an ancestor of `.project-menu`), or have
`computeProjectMenuPosition()` measure and account for the actual containing block's rect instead
of assuming `window.innerWidth`/`window.innerHeight`. Acceptance: with a real CDP mouse click on
any project's "⋯" trigger, `.project-menu`'s `getBoundingClientRect()` must fall entirely within
`[0, window.innerWidth] × [0, window.innerHeight]`, and `elementFromPoint()` at every menu item's
own coordinates must hit that item, not return `null`.

Keyboard navigation and wheel-scroll-closes-the-menu were also exercised (on a short, 4-item menu
with no Copilot accounts seeded, so check 10's own "tall menu scrolls internally" scroll-reachability
sub-check could not be separately exercised past the off-screen defect above): `ArrowDown` moved
focus from "Pin project" to "Open in Editor" without closing the menu; `End` moved focus to "Remove
project"; `Home` returned focus to "Pin project" — all three with zero `closeProjectMenu` calls
logged, so **check 11's implied "keyboard nav does not close the menu" requirement holds**.
Scrolling `.cdk-drop-list.instance-viewport` with a real `Input.dispatchMouseEvent`
`mouseWheel` event (away from the menu's own rect) called `closeProjectMenu({restoreFocus: false})`
exactly once and cleared `openProjectMenuKey()` — **the intended "user scroll closes the menu"
behaviour still works correctly** and is correctly distinguished from the focus-driven scroll fixed
above.

### Cleanup

All 8 disposable project instances plus the `repo1`/`repo3`/`repo4`/`repo5` loop-test instances and
2 secret/ask-questions test chats (10 total; see below) were terminated via `listInstances()` +
`terminateInstance()` in one pass at the end of this batch, confirmed `remaining: 0`. Electron pid
`30969` (matched against its own `--remote-debugging-port=9741` command line, not relaunched under
a new pid) was killed. All `/tmp/aio-lt-0924-verify-final*` paths were removed.

---

## Evidence run — 2026-09-24 (verify-final, LT-631 third pass)

Relaunched the dev app fresh (same isolated-profile approach: new electron pid `56380`,
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-verify-final`, CDP `:9741`, dev renderer on `:4567`
rebuilt renderer-only by the orchestrator with `.project-actions`'s `transform` removed;
`dist/main` unchanged from the earlier pass). Re-onboarded and recreated 8 disposable project rows
exactly as before.

**Menu opens via real click and stays open — PASS.** `Input.dispatchMouseEvent` on the trigger
opened the menu with `openProjectMenuKey()` set and stable; no spurious `closeProjectMenu` calls.

**`.project-menu.offsetParent` is not `.project-actions` — PASS.** `menu.offsetParent === null` in
every measurement (top row, bottom row, narrowed pane) — the correct result for a `position: fixed`
box with no transformed ancestor, confirming the containing-block fix.

**`.project-menu` rect fully inside the viewport — PASS, top row and bottom row.** Top-row menu
(after scrolling the list to top): `{top: 490.1, bottom: 692, left: 0, right: 392.1}`, fully within
a 1000×700 window. Bottom-row menu (after scrolling the list to its end): `{top: 185.4, bottom:
536.1, left: 0, right: 398.1}`, also fully inside. Both cases stayed fully inside after scrolling
the menu's own internal content too.

**Every item reachable via `elementFromPoint`, top and bottom rows — PASS, after correcting an
initial test-methodology miss.** The top-row menu is genuinely tall: `scrollHeight: 348` vs
`clientHeight: 200`, because `<app-copilot-project-routing-menu>` (mounted between "Open in
Finder" and the divider/"Remove project" button, `instance-list.component.html:295-299`) occupies
real layout height even with zero configured accounts in this fresh profile — this is exactly
check 10's designed "tall Copilot section, scroll internally" scenario, not a defect. My first pass
at this hit-tested the last item at its *unscrolled* position and got a false failure
(`elementFromPoint` returned `null`, because the item was genuinely scrolled out of the visible
200px slot). Re-tested correctly by driving `menu.scrollTop` to `0` then to `scrollHeight` before
each hit-test: both the first item ("Pin project") and the last ("Remove project") hit real
`.project-menu-item` elements, never `null`, and the container's own rect stayed unchanged
(still fully inside the viewport) across the scroll. The bottom-row menu had enough room
(`height: 350.7`) that all 4 items fit without needing internal scroll, and all hit correctly too.

**Rounded corner intact after internal scroll — PASS.** `border-radius: 12px` on `.project-menu`,
measured before and after driving `scrollTop`, in both the top-row and narrow-pane cases.

**List pane < 420px — PASS (also true throughout the whole pass by default).** `.cdk-drop-list.
instance-viewport`'s own width measured `362.4px` at the default `sidebarWidth`, and stayed
`362.4px` after explicitly setting `dashboard.component.ts`'s `sidebarWidth` signal to `360` — i.e.
every check in this run already ran with a list pane under 420px; re-confirmed rect/offsetParent/
reachability results in that explicit narrow state (top row): fully inside viewport,
`offsetParent === null`, first/last items both reachable.

**Keyboard nav keeps the menu open — PASS.** `ArrowDown`, `End`, `Home` (real
`Input.dispatchKeyEvent`) each moved focus among items ("Pin project" → "Open in Editor" → …
→ "Remove project" → back to "Pin project") with zero `closeProjectMenu` calls logged, in both the
1000px-wide and narrowed-pane configurations.

**Wheel-scrolling the list closes the menu — PASS, after correcting an initial bad test point.**
My first attempt picked a wheel coordinate that landed on the open menu itself (which has its own
`overscroll-behavior: contain`), so nothing propagated to `.instance-viewport` and the menu
correctly stayed open — a test-point bug, not a product one. Re-picked a point at the very top of
the list pane, confirmed via `coveredByMenu: false` before dispatching: a real
`Input.dispatchMouseEvent` `mouseWheel` there triggered `onInstanceViewportScroll()` →
`closeProjectMenu({restoreFocus: false})`, and `openProjectMenuKey()` went to `null`.

**Escape returns focus to the trigger — PASS.** With the menu open and focus inside it, a real
`Escape` key event closed the menu (`openProjectMenuKey()` → `null`) and left
`document.activeElement` on the `<button aria-label="Project options">` trigger, matching
`closeProjectMenu()`'s restore-focus behaviour.

**Check 11 (paint order) still holds — PASS.** Widened the pane (`sidebarWidth: 500`) to get an
overlap between the open menu and the next row down; `document.elementFromPoint()` at the overlap
hit a real `.project-menu-item` button, not the underlying row — no paint-through regression from
today's transform removal.

**LT-631 is now fully resolved across all three reasons found this campaign** (original overflow
clip, the focus-driven self-close, and this containing-block off-screen bug). Check 10 and Check
11 both pass with current evidence.

### Cleanup

All 8 disposable project instances terminated via one `listInstances()` + `terminateInstance()`
pass, confirmed `remaining: 0`. Electron pid `56380` (matched against its own
`--remote-debugging-port=9741` command line) killed. `/tmp/aio-lt-0924-verify-final` and
`/tmp/aio-lt-0924-verify-final-proj{1..8}` removed.
