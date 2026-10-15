# Browser Login Recipe Persistence: Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-23-browser-login-recipe-persistence_plan_completed.md](2026-09-23-browser-login-recipe-persistence_plan_completed.md)

## Current status — 2026-09-24 (after commit `39d245ba`)

Open: 3 · Closed: 0 · Last live run failed: 1 (Check 3 on extension 0.2.34)

Checks 1 and 2 remain unrun; they need the packaged-app restart and a real In-tend
login described below. Check 3's LT-617 failure was fixed in the command store and
committed with extension 0.2.35 in `39d245ba`, but the latest recorded
`windows-pc` run used 0.2.34. Deploy/reload 0.2.35 there, confirm its reported
version, and re-run Check 3 before calling it passed. The [LT-617 register entry](livetest-remediation-register.md)
still describes the original failure and awaits that live re-check.

**Prerequisites:**

- Rebuild and restart Harness on the Mac from this checkout (`npm run build:main`, then
  `npm run build:aio-mcp-dist` so the MCP bridge exposes the two new recipe tools, then restart).
  James approves the restart because it stops live agents. The restart replaces the process that
  hosts the implementing session, which is why these checks could not run in-loop.
- Check 3 needs extension 0.2.35 on `windows-pc`. That version is committed locally
  in `39d245ba`; the last live evidence below is from 0.2.34. Deploy the commit
  through the normal worker update route, then reload the unpacked extension in
  Chrome on `windows-pc` (`chrome://extensions`, Harness Browser Gateway, Reload).
  Confirm with `list_remote_nodes` → `extensionRelay.extensionVersion` = `0.2.35`.
- Target windows-pc by nodeId `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be` with `browser_find_or_open`.
  Never the `computer` alias.
- Do not flip `browserSecretObservationProtectionEnabled`. It is James's setting (expected `false`).
- READ ONLY on In-tend. Do not reply, express interest, modify a return, accept a declaration or
  send anything.
- Coordinator log: `~/Library/Application Support/Harness/logs/app.log`.

## Check 1: Recipe survives a restart and reaches a new tab

Why deferred: needs the rebuilt coordinator and a Harness restart.

Before the restart:

1. `browser_find_or_open` nodeId `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`,
   url `https://supplier.in-tend.co.uk/publicagroup/home`.
2. Re-verify the recipe selectors on the live page with `browser.query_elements` (read only):
   username `#labelledby-account-email-login`, password `#labelledby-account-password-login`,
   the form's Login button (record its selector), logged-in marker `Logout`.
3. `browser.remember_login_fingerprint` with that tab's profileId, origin
   `https://supplier.in-tend.co.uk`, loginUrl `https://supplier.in-tend.co.uk/publicagroup/home`,
   loggedInMarkers `["Logout"]`, relogin `{ vaultItemRef: <Publica In-Tend item id from the
   AIO-Agent folder>, usernameSelector, passwordSelector, submitSelector }`.
   Expected: `{ remembered: true, scope: "bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be", scopeKind: "node" }`.

After James approves and the Harness restarts:

4. `browser.list_login_recipes` with origin `https://supplier.in-tend.co.uk`.
   Expected: the row from step 3 is still there (scope = windows-pc nodeId).
5. Open a NEW In-tend tab (`browser_find_or_open` with a URL that no existing tab matches, for
   example `https://supplier.in-tend.co.uk/publicagroup/correspondence`).
6. `browser.check_session` on the new tab, `autoRelogin: true`.
   Expected: `recipeScope` = the windows-pc nodeId, never `no_fingerprint`. If the portal session
   had expired: `reloggedIn: true`, `state: "logged_in"`, `page.title`/`page.url` are the real
   In-tend page (not `Secret-filled tab`, not origin `/`). If the session was still live:
   `state: "logged_in"`, `reason: "fingerprint_matched"`. Record which one happened.

## Check 2: Read after sign-in, WODC0653P Correspondence

Why deferred: depends on Check 1.

1. On the same tab, navigate to the Publica Correspondence page and filter/open tender WODC0653P.
2. `browser.snapshot`. Expected: live page text (audit summary "Captured fresh snapshot", not
   "Read cached snapshot"), title not `Secret-filled tab`.
3. Record the Correspondence content for WODC0653P verbatim in the evidence section below, for
   Work Finder card `west-oxfordshire-witney-digital-map-2026-09`.

## Check 3: browser.health shows the extension's protection state

Why deferred: the LT-617 fix needs extension 0.2.35 deployed and reloaded on
`windows-pc`; the last recorded run used 0.2.34.

1. `browser.list_targets` nodeId windows-pc with `refresh: true` (sends a stamped
   `report_inventory`).
2. `browser.health`. Expected: `remoteExtensions.nodes[windows-pc].secretObservation` =
   `{ reported: true, protectionEnabled: false, taintedOriginCount: 0, ... }` and
   `secretObservationProtection.settingEnabled: false`. No "secret observation" warning.
3. If `protectionEnabled` is true or `taintedOriginCount` > 0 while the setting is false, that is
   a defect: register it.

## Evidence

(none yet)

## Status — 2026-09-24 (0.2.34 run; superseded for code status)

Open: 3 · Closed: 0 · Failed: 1
Check 3 was run on 2026-09-24 and **failed**; it is filed as
[LT-617](livetest-remediation-register.md). Checks 1 and 2 were not run. They need a restart of the
packaged Harness (step 4, "after James approves and the Harness restarts"), which would stop James's
live sessions, and a real In-tend login via the vault item. The prerequisites are otherwise met: the
packaged app built 2026-09-23 21:12 contains the recipe tools (`remember_login_fingerprint` is present
in `app.asar`), and `windows-pc` reported extension 0.2.34 during this run. The
later 0.2.35 code fix has no Windows live re-check recorded here.

## Evidence run — 2026-09-24 (orchestrating session)

- **Check 3 — FAIL.**
  - `list_remote_nodes`: `windows-pc` `extensionRelay.extensionVersion: "0.2.34"`,
    `extensionReloadedAt: 1790198452169`.
  - `browser.list_targets {nodeId: "bb62e3ee-…", refresh: true}` succeeded (audit `8ab0c3c8…`,
    every live row confirmed at `1790212085xxx`, so the stamped `report_inventory` round-tripped).
  - `browser.health` 2 s later (audit `4a0a58e2…`): `secretObservationProtection.settingEnabled:
    false` as expected, but `remoteExtensions.nodes[windows-pc].secretObservation` is
    **`{reported: false}`**, where `{reported: true, protectionEnabled: false, taintedOriginCount: 0,
    …}` was expected. It was identical on two earlier refresh/health pairs in the same session.
  - The setting was not touched.
- Checks 1 and 2: not run (see status).

## Evidence run — 2026-10-04 (orchestrating session, packaged app built 19:06, restarted 20:45:59)

`windows-pc` extension **0.2.37** (reloaded 2026-10-02), relay `registration: ok`, channel `fresh`.
Audit rows and log lines copied to `_scratch/lt-2026-10-04/orch/{browser-audit.txt,relogin.log}`.

### Check 3 — PASS (LT-617 confirmed fixed live)

`browser.list_targets {nodeId: bb62e3ee-…, refresh: true}` (audit `dfa46acd`), then
`browser.health` (audit `43daf511`): `remoteExtensions.nodes[windows-pc].secretObservation =
{reported: true, protectionEnabled: false, taintedOriginCount: 0, taintedTabCount: 0, observedAt:
1791152608367}`, `secretObservationProtection.settingEnabled: false`, `warnings: []`.

### Check 1 — steps 4 and 6 (scope) PASS; re-login FAILS (LT-665, LT-666)

Steps 1–3 were not repeated: a recipe already existed, created 2026-10-04 ~17:22 BST
(`createdAt 1791130962618`) by an earlier session — scope `bb62e3ee-…` (`node`), origin
`https://supplier.in-tend.co.uk`, loginUrl `…/cpcatapult/home`, `loggedInMarkers ["My Tenders",
"Current"]`, vault ref, the email/password selectors and a positional submit selector. Its markers
differ from the doc's `["Logout"]`.

- **Step 4 — PASS.** `browser.list_login_recipes {origin: https://supplier.in-tend.co.uk}` at 23:22
  still returns that row after the 20:45 restart.
- **Step 5 — deviation.** `browser.find_or_open` for `…/publicagroup/correspondence` did not open a
  new tab: by design (`browser-gateway-target-utils.ts:23`) it fell back to an existing same-origin
  tab, James's `…/educationportal/tenders/current` (tab `771568875`). There is no agent operation
  that forces a new tab on an origin that already has one, so the check ran on that other tab
  (not the one the recipe was recorded on).
- **Step 6 — `recipeScope` PASS, outcome FAIL.** `browser.check_session {autoRelogin: true}` →
  `{state: logged_out, reason: relogin_failed, attempts: 2, recipeScope: bb62e3ee-…, escalationId:
  33e4ab9a-3996-4a99-84a7-630c6cb6f953, parked: true}`. Audit sequence 23:23:54–23:24:07: snapshot
  `page text could not be read (host_permission_denied)`, `query_elements` failed `Cannot access
  contents of the page`, then `navigate` (to the login URL) and `fill_credential` → `denied/failed
  after filling 0 field(s)` twice; `app.log` `BrowserSessionRelogin` `relogin credential fill
  refused: credential_fill_failed` ×2. A snapshot straight afterwards showed the tab on
  `…/cpcatapult/home` reading **"Hello, James … User: James Lawrence | Company: Community Tech Ltd"**
  — James was signed in throughout. `check_session {autoRelogin: false}` on the other In-tend tab
  (`771568863`, a tender details page) also reports `logged_out / fingerprint_markers_missing`.
  Two defects: LT-665 (an unreadable page is judged logged out and drives a credential re-login) and
  LT-666 (page-specific markers make the recipe unrecoverable and the failure is misreported as a
  credential-fill refusal). Cleanup: tab `771568875` was navigated back to
  `…/educationportal/tenders/current`. The parked `relogin_failed` escalation `33e4ab9a-…` is a
  false alarm and has no agent-facing resolve operation; it needs dismissing in the app.

### Check 2 — BLOCKED by check 1

Not attempted: it depends on a confirmed sign-in through the recipe, which check 1 cannot produce
until LT-665/LT-666 are fixed and the recipe's markers are re-recorded.

## Status — 2026-10-04

Open: 2 (checks 1 and 2) · Closed: 1 (check 3) · Failed: 1 (check 1, LT-665/LT-666).
