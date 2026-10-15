# Live tests — Browser Gateway credential login

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `browser-gateway-credential-login_plan_completed.md`

## Status — 2026-09-06

Open: 2 · Closed: 2 · Failed: 0
James-only: both remaining checks need a real Bitwarden vault unlock and (for check 2) a real
government-portal login/MFA; neither can be run by an agent.

**Prerequisites:**
- A rebuilt and restarted app. The IPC handler, preload bridge, and renderer
  panel changes are already committed (`b7f9885a`, 2026-08-11) but the
  **installed/packaged app** (`/Applications/Harness.app`) predates them, so the
  "Enrol an existing login" form and the shared-tab node-scope selector are not
  live in that install until it is rebuilt and restarted. A locally-launched dev
  app already runs current `main` and can be used for the enrolment-flow checks
  below, but NOT for the real-world submission check (item 2), which must use
  James's real Chrome profile / real vault.
- Real, human interaction: unlocking the Bitwarden CLI vault
  (`browserVaultAutoUnlock` or an interactive `browser.vault_unlock`), and — for
  item 2 only — a real login on a real government portal.
- **Never attempted by an agent:** no agent session may read, print, log, type
  outside the page, or otherwise expose a real credential value. Item 2 is a
  James-only action; an agent may prepare the authorization record but must not
  drive the login itself with real data.

Why deferred: these checks need a genuinely unlocked vault against a real
Bitwarden folder, a rebuilt/restarted app, and (for item 2) a real login to a
real government service with real data. None of that is reachable from unit
tests, the CLI, or a synthetic dev-app profile.

---

## 1. Enrol an existing (hand-registered) login and confirm it becomes fillable

Verifies change A end-to-end: `CredentialVault.enrolExistingCredential()` wired
through `BROWSER_ENROL_CREDENTIAL` IPC, the renderer "Enrol an existing login"
form, and that a subsequent `getSecretForFill` no longer throws
`origin_binding_missing` for that item.

1. Rebuild and restart the app (`npm run build` then relaunch, or restart the
   packaged app once repackaged).
2. Unlock the credential vault (Settings → Browser → Vault, or
   `browser.vault_unlock` with the master password entered interactively — not
   by an agent).
3. Open the Browser panel → Credential Authorizations. Confirm the "Enrol an
   existing login" form is present with fields: vault item (id or exact name),
   origin, and a "move into folder" toggle (`data-testid="enrol-item-input"`,
   `enrol-origin-input`, `enrol-move-toggle`, `enrol-submit`).
4. Pick a real, already-registered Bitwarden item that lives OUTSIDE the
   `AIO-Agent` jail folder (any of James's personal logins used only for this
   read-only structural check — do not use one of the five live procurement
   authorizations for this step). Enter its id/name and a test origin. Leave
   "move into folder" unchecked.
5. **Expected:** submission is refused with `item_outside_agent_folder` (visible
   in `enrolError()` / the `.error-banner`), because the item is not in the
   jailed folder and the move flag was not set. This proves the jail refusal is
   live, not just tested in isolation.
6. Re-submit with "move into folder" checked.
7. **Expected:** `data-testid="enrol-result"` shows `Bound <username>
   (<vaultItemRef>) · moved into the vault folder`. The item now appears inside
   `AIO-Agent` in Bitwarden (folder move confirmed via the vault UI/CLI, not by
   reading the password).
8. Confirm origin binding took effect: attempt (or inspect via
   `select * from browser_vault_item_bindings` on the RLM sqlite DB) that a row
   now exists for that `vaultItemRef` + origin. Do not read or print the
   password column (there isn't one — bindings hold only `vaultItemRef`,
   `origin`, `username`, `createdAt`).
9. Move the item back out of `AIO-Agent` afterwards if it was only a test item,
   so this check leaves no residue in James's real vault structure.

**Blocker class: C (James-only)** — needs a real, interactive Bitwarden vault
unlock and a real personal vault item; never attempted by an agent per the
prerequisites above.

## 2. Real end-to-end: file the overdue Report MI return

The original trigger for this plan. Needs the operator gate
(`browserAllowSharedTabCredentialFill`) on, the Report MI vault item enrolled
(item 1's flow, for real, on that item), a live authorization created in the
panel for `auth.reportmi.gca.gov.uk` with `allowedSenderDomains:
['notifications.service.gov.uk']` (verifies change D), and a real login.

1. James (not an agent) turns on `browserAllowSharedTabCredentialFill` in
   Settings → Advanced.
2. James (not an agent) enrols the Report MI Bitwarden item via the form built
   in item 1.
3. James or an agent creates the credential authorization in the panel,
   targeting the `local` shared-tab node scope (verifies change C — the target
   selector now offers shared-tab scopes, not only managed profiles), origin
   `auth.reportmi.gca.gov.uk`, purpose `login` + `email_code`, and
   `allowedSenderDomains: ['notifications.service.gov.uk']`.
4. Drive an authorized fill on James's real Chrome tab against the live Report
   MI login page. **Expected:** the login fills and the one-time code sent from
   `notifications.service.gov.uk` is accepted for the `auth.reportmi.gca.gov.uk`
   origin (proves change D's cross-domain sender allowance actually resolves).
5. Submit the overdue July RM6094 nil return and capture the confirmation
   screen/reference number.

**This step must not be attempted by an agent with real data.** It needs
James's own click-through for the login and MFA, per the task boundary ("do not
perform a real login to any real service").

**Blocker class: C (James-only)** — explicit task boundary; a real login/MFA to
a real government service.

---

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Code-level prerequisites for items 1–2 (IPC wiring, jail/bindings logic, no MCP exposure, gates) | 2026-08-19 | Evidence run (Plan Agent P4): 6 spec files / 93 tests passed; `tsc`/spec-`tsc`/lint/`check:ts-max-loc`/`build:main` clean; `verify:ipc` 1126/1126/1126 |
| Completion Fresh-Eyes Gate on the implementation (9 passes; 15 actionable coverage gaps found and fixed, 2 gaps deliberately accepted and recorded) | 2026-08-19 | Pass 9 verdict **PASS**; full suite 1751 files / 18,444 tests passed; feature-targeted 95 files / 1,001 tests; `git diff --stat` across every change A–D production file empty (all fixes test-only); no `it.skip`/`.todo` across the 9 touched spec files |

OUTSTANDING (nothing else): both remaining checks are items 1 and 2 above, kept
in full. The completion gate is closed; the live test is not.

## Evidence run — 2026-10-04 (orchestrating session, packaged app built 19:06, restarted 20:45:59)

The "James-only" classification of 2026-09-06 is partly stale: the packaged app now auto-unlocks
the credential vault (`app.log` 23:23:06 `BrowserUnattendedServices` → `Browser credential vault
auto-unlocked`), and `$AIO_MCP browser-credentials enrol` drives the same enrolment backend as the
form.

- **Check 1, step 5 (jail refusal) — PASS through the CLI.** A vault login outside the `AIO-Agent`
  folder was chosen by id only through the `bw` CLI (no name, username or secret read or printed;
  vault locked again immediately). 23:30:59: `browser-credentials enrol --item d0240dad-… --origin
  https://aio-livetest.invalid --json` → exit 1, "Vault item d0240dad-… is not inside the AIO-Agent
  folder. Pass --move-into-folder …". `browser_vault_item_bindings` has 0 rows for that item or
  origin afterwards.
- **Check 1, steps 3 and 6–9 — not run.** Step 3 is the packaged UI form (hard-denied for Computer
  Use). Steps 6–9 move a real personal login into the agent folder and back; that is a deliberate
  widening of what fills can reach in James's real vault and was not done unattended.
- **Check 2 — not run.** A real government return submission under James's identity remains his
  action.

## Status — 2026-10-04

Open: 2 · Closed: 2 · Failed: 0. Check 1's refusal path is now live-confirmed; its form and
move-into-folder halves remain.

## LT-703: embedded cross-origin login form

Added 2026-10-10 after the 2026-10-09 LCN sign-in attempt (`https://www.lcn.com/login`, shared
`windows-pc` tab `771575145`) reproduced a fill failure whose cause was invisible at every layer.
The defect is registered as [LT-703](livetest-remediation-register.md#lt-703) and fixed in the
working tree (extension + main). The checks below are its live closure.

**Prerequisites**

- The Browser Gateway extension rebuilt/redeployed **on `windows-pc`** (and the local Chrome
  extension), so `runOriginBoundType`, `browserCommandErrorMessage` and the
  `read_control.__frameOrigin` reply are the new code. The main-process half is current `main`.
- A credential whose vault binding **and** `request_credential_access` authorization name the
  FORM's origin (`https://login.lcn.com`), not the embedding page (`https://www.lcn.com`). The item
  created on 2026-10-09 (`0f10ee9c-…`) is bound and authorized to `https://www.lcn.com`;
  re-scoping it is James's decision (re-bind the existing item, or register a new one).
- James's explicit OK before any fill attempt. **At most ONE live fill attempt**, and "Log in" is
  never pressed without his instruction — CAUK's real LCN account, and the page has reCAPTCHA.

**Checks**

1. With the `login.lcn.com`-scoped credential: `browser.fill_credential` on the shared tab at
   `https://www.lcn.com/login` types `#username` and `#password` in the embedded form and reports
   `filled: 2`. Expected: the fields visibly hold the values, no `credential_*` failure is audited,
   and the target's write journal shows both `type` entries with `outcome: succeeded`.
2. With the CURRENT `www.lcn.com`-scoped item: `browser.fill_credential` refuses **before resolving
   any secret**, naming the form's origin — expect the pre-dispatch denial
   `credential_not_authorized: … https://login.lcn.com …` (or `vault_resolve:origin_mismatch` if
   only the binding disagrees), never `credential_fill_failed`, and no `type` entry in the write
   journal. The audit row's `reason` column carries that denial code (pair-prefixed
   `credential_not_authorized:<code>: …`), or a `<step>:<code>` pair on the exception path and on
   the probe-refusal denial (`resolve_field_origin:…`) — the two shapes are both expected here.
3. Negative (no real login needed), with an authorized + bound credential **whose fill origin
   resolves** (use a two-field request where one field is correct, or a page-origin-scoped
   credential): a wrong selector must come back as `dispatch:credential_selector_not_found`, and a
   selector that matches only outside the resolved fill origin's frames (the page changed between
   the two probes) as `dispatch:credential_selector_outside_authorized_origin` — never
   `credential_fill_failed`, never "No element matches selector". The audit `reason` must carry
   that `<step>:<code>` pair and the write journal's `type` entry must show the same fixed
   extension code. (A LONE wrong selector resolves no frame origin and falls back to the page
   origin, so with a form-scoped credential it is denied at authorization instead — that is
   correct behaviour, not a failure of this check.)

**Implementation status** is recorded in the LT-703 register section (fixed + regression-tested in
the working tree, 2026-10-10). Deliberately NOT added to
`2026-07-19-livetest-failure-remediation_plan_completed.md`: that plan is `_completed`, and the
repo rule forbids adding content to a completed plan (LT-643/665/666/700-702 follow the same
register-only practice).

**Why deferred:** these need a redeployed extension on another machine, a re-scoped real credential
(a vault/grant change only James may authorise), and at most one real login attempt against a live
service with reCAPTCHA. None of that is reachable from unit tests or the dev app alone.

**Status — 2026-10-11:** open · check 1 attempted once and failed at the extension write; checks 2
and 3 unrun. Record per-check evidence here; a reproduced defect goes to
`livetest-remediation-register.md` as a new `LT-NNN`.

### Evidence — 2026-10-11, after James restarted `windows-pc`

Shared restored LCN tab, pageId `771576274`. The form was not submitted.

1. The first read of the restored tab returned `textUnavailableReason: "host_permission_denied"`.
   `browser.query_elements` failed with "Cannot access contents of the page. Extension manifest
   must request permission to access the respective host."
2. `browser.navigate` reloaded that tab. The permission failure cleared and the tab's page text
   became readable.
3. `browser.fill_credential` for the same vault item, with the standing approval still valid, then
   failed. Reason: `dispatch:credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state`.
   Audit `19d7214e-0b22-4e35-a528-66a1b512714b`.
4. A read-back afterwards showed `#username` empty and the password field visibly empty.

**What this settles.** The `dispatch:` prefix is the coordinator's step label, so vault lookup and
authorization had already passed and `driverType` had called the extension. The failure is the
write on `windows-pc`, not the vault. The code after the colon is the extension's unclassified
fallback (`browserCommandErrorMessage` in `resources/browser-extension/background.js`), not one of
the origin-bound codes (`credential_selector_not_found`,
`credential_authorized_origin_not_in_frames`, `credential_selector_outside_authorized_origin`, or
`credential_write_dispatch_failed_…`). Those specific codes are what the current writer throws, and
they would have passed through unchanged. Empty fields mean this attempt did not land a value; the
fallback's "may have applied" wording does not match the page.

**Check 1 is not closed.** One live fill was used. Do not retry until the extension actually
deployed on `windows-pc` is confirmed to be the build that emits those specific codes, and James
approves another attempt.

**Restored-tab readability (same family as LT-665).** The snapshot correctly carried
`host_permission_denied`, and the inventory still said the tab was readable. That stamp is fixed
in extension 0.2.39: the tab is `inspection_unavailable` and keeps its URL and title. Chrome will
not script a tab restored at startup until something reloads it, even though the manifest already
has `http://*/*` and `https://*/*`; `browser.navigate` is what cleared it on this run. Detail is
on [LT-665](livetest-remediation-register.md#lt-665). The extension on `windows-pc` has to be
0.2.39 before that inventory line can be re-checked live.
