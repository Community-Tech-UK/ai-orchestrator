# Live tests — emailed code fill and the code-box two-factor stop (2026-11-05)

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-11-05-one-time-code-field-stop_plan_completed.md](2026-11-05-one-time-code-field-stop_plan_completed.md)
(also covers the emailed-code fill fix from the same session; brief:
`/Users/suas/work/communitytech/harness-email-code-fill-fix-2026-11-05_prompt.md`).

## Status — 2026-11-12

On main: yes (this landing commit)
Open: 0 · Closed: 4 · Failed: 0. All four ran on `windows-pc` on 2026-11-12 against the installed
Harness (built 2026-11-11); evidence is in "Evidence run — 2026-11-12" below. No defect reproduced, so
nothing was added to the remediation register. Two expectation wordings in checks 1 were wrong and are
corrected in the evidence (sender-domain count is 2, not 1; the imap startup banner is logged at warn).
One test escalation (`two_factor_unavailable`, status `pending`) from check 4 is left for James to dismiss.

**Prerequisites (as written 2026-11-05, kept for the record):**
- Harness rebuilt and reinstalled from a tree containing both changes, then restarted. James decides
  how to rebuild (the main checkout carries other sessions' uncommitted work) and when to restart
  (a restart stops every live session). Never restart without asking him.
- `windows-pc` online, its worker updated to a build that ships Browser Gateway extension **0.2.50**,
  and the extension reloaded onto it (check the reported extension version in `browser.health` /
  the extension status before starting). Checks 3 and 4 need 0.2.50; checks 1 and 2 do not.
- Saved login `Report MI - RM6094 Spark DPS (GCA)` with its `login` + `email_code` permission (exists).
- All browser work on `windows-pc` through the Browser Gateway; never the Mac.

**Why these cannot run now:** every check needs the rebuilt and restarted app, and 3–4 also need the
new extension on windows-pc.

**Hard limits for every check:** do not report anything or press any filing button on Report MI
(October is filed; November's return waits for December). Do not submit any British Council
registration, declaration or form. Never print a code, email body, password or token.

## 1. Report MI emailed code fills by itself

Steps:
1. `browser.find_or_open` `https://www.reportmi.gca.gov.uk` on windows-pc; sign in with the saved
   login via `browser.fill_credential` (username, password); press Continue.
2. On the code page, `browser.fill_credential` with one field `{ selector: '#code', kind: 'email_code' }`
   and **no** `emailCode.senderDomains`.
3. `browser.click` Continue. Confirm `/tasks` loads. Sign out.

Expected:
- Step 2 `allowed` / `succeeded`; `app.log` has `Mailbox search completed` with `senderDomains: 1`
  and no `imap MCP server stderr` / `Email code read failed` line.
- The default sender resolved to `gca.gov.uk` (the mail comes from `report-mi@gca.gov.uk`).
- If it fails, the reason is one of `vault_resolve:email_code_no_matching_message`,
  `…not_found_in_message`, `…mailbox_unavailable`, `…mailbox_timeout` (never the bare
  `credential_fill_failed`) and `app.log` has `Email code read failed` with the category.

## 2. British Council code fill reaches a successful fill

Steps: on `https://tap.tcsapps.com/tap2/#/bc-supplier-registration`, type the email, click Validate
Email, then `browser.fill_credential` an `email_code` field on the OTP input. Stop there.

Expected: the fill is `allowed` / `succeeded` (sender `britishcouncil.org` from the permission).
Do not press Validate OTP unless James has said to continue the registration.

## 3. The submit after a Harness code fill is released (needs 0.2.50)

Part of check 1, step 3. Expected in `browser_audit_entries` (Harness `rlm/rlm.db`) for that tab: one
row `reason = 'one_time_code_submit_after_gateway_fill'`, the Continue click `allowed` / `succeeded`
with a grant, and no `two_factor_unavailable_parked_to_escalation_queue` row.

## 4. A self-typed code is stopped (needs 0.2.50)

Steps: on the Report MI code page (fresh sign-in), `browser.type` any made-up 6-digit value into `#code`.
Do not click anything afterwards; sign out or close the tab.

Expected: the type is not run — `requires_user` / `not_run`, reason
`two_factor_unavailable_parked_to_escalation_queue` — and an escalation appears for James to dismiss.
Also confirm that typing the email on the British Council page (check 2) was NOT parked.

## Evidence run — 2026-11-12

Run by a Plan Queue livetest worker, 08:24–08:30 UTC, all browser work on `windows-pc` through the
Browser Gateway (never the Mac). The app under test is the installed Harness
(`/Applications/Harness.app`, `app.asar` dated 2026-11-11 08:39, after the fix commits of 2026-11-05 to
2026-11-07 in `browser-one-time-code-submit.ts`). Not separately confirmed: the extension version
*on windows-pc* (`browser.health` reports `extensionVersion` only for the local channel, 0.2.51; the
windows-pc node reported `registration: ok`, `channelState: fresh`). Checks 3 and 4 behaved as the
0.2.50+ behaviour describes, which is the evidence that the gateway and extension in use have it.
Audit ids below are rows in `browser_audit_entries` (Harness `rlm/rlm.db`, read-only). No code, mail
body, password or token was printed.

Route notes (not defects): `browser.request_credential_access` on `www.reportmi.gca.gov.uk` returns
`origin_mismatch`; the saved login is bound to `https://auth.reportmi.gca.gov.uk`, so press Sign in
first. The sign-in is two steps (identifier then `#password`), so username and password fill on
separate pages. Both authorisations resolved as `existing_permission`, no human approval needed.

### 1. Report MI emailed code fills by itself — PASS
- Signed in with the saved login (`fill_credential` username, then password, `allowed`/`succeeded`),
  reached the code page, then `fill_credential` `{ selector: '#code', kind: 'email_code' }` with no
  `emailCode.senderDomains`: `allowed` / `succeeded`, `filled: 1` (audit `e4a1a02a-7239-4e32-9220-73096a780f81`).
- Continue click `bbffd824-5d53-44d6-ad7d-acc06d2399a8` `allowed`/`succeeded`; snapshot showed
  `https://www.reportmi.gca.gov.uk/tasks` ("Your reporting tasks", "All your tasks are complete").
  Signed out (`53e1c55b-41cf-4e5e-a4ff-f705fe846257`). Nothing was filed.
- `app.log` (production profile) 2026-11-12 08:26:18Z: `Mailbox search completed`
  `{"senderDomains":2,"candidates":1,"withinWindow":1}`; no `Email code read failed` line.
- **Expectation corrected:** `senderDomains` is 2, not 1. `resolveEmailSenderDomains`
  (`browser-credential-email-senders.ts:42`) returns the default registrable domain plus the
  authorisation's declared senders, de-duplicated. Authorisation `8943440e-…` declares
  `notifications.service.gov.uk` and `gca.gov.uk`, so the set is `gca.gov.uk` + `notifications.service.gov.uk`.
  The default `gca.gov.uk` was in the set and the code matched.
- **Expectation corrected:** one `imap MCP server stderr` line was present at 08:26:17Z, but its content
  is the normal startup banner ("server started on stdio with 8 account(s) …"), not an error. The reader
  logs every stderr chunk at `warn` (`browser-imap-mailbox-reader.ts:134`). Recorded as a follow-up
  (log level), not a failure of this check.

### 2. British Council code fill reaches a successful fill — PASS
- On `https://tap.tcsapps.com/tap2/#/bc-supplier-registration` (authorisation `d6562da0-…`, sender
  `britishcouncil.org`): filled the saved username into the email box with `fill_credential`
  (`8e660b34-31f5-40b6-9513-c57eebd390b2`), clicked Validate Email (page said "OTP has been sent to
  your registered mail Id."), then `fill_credential` `email_code` on the OTP input:
  `allowed` / `succeeded`, `filled: 1` (`4f169f0d-8ef7-43f5-8442-d7018d7d515c`).
- `app.log` 08:28:48Z `Mailbox search completed` `{"senderDomains":2,"candidates":1,"withinWindow":1}`
  (default `tcsapps.com` + declared `britishcouncil.org`); no `Email code read failed`.
- Stopped there. Validate OTP and Register were not pressed.

### 3. The submit after a Harness code fill is released — PASS
For the Check 1 tab (`…:771596241:771596622`): the Continue click produced one audit row
`9a4ae1e9-88e0-4f47-beea-7b888485abb5`, `reason = 'one_time_code_submit_after_gateway_fill'`
(`allowed`, outcome `not_run`; summary "…checked as an ordinary submit and still needs a submit grant"),
immediately followed by the click itself `bbffd824-…` `allowed`/`succeeded` with a grant
(`grant_id` set). No `two_factor_unavailable_parked_to_escalation_queue` row exists for that tab in
that window. The release row is an annotation row with outcome `not_run`; the document's wording
"one row with that reason" is met, the executed click is the next row.

### 4. A self-typed code is stopped — PASS
Fresh sign-in (landing page, Sign in, username, password) to the code page, then `browser.type`
`#code` with a made-up 6-digit value: `requires_user` / `not_run`, reason
`two_factor_unavailable_parked_to_escalation_queue` (audit `6ec5d62c-6118-4f0c-baa9-9c45a40bd74c`).
Nothing was submitted. `browser_escalations` row `40578599-de72-40e4-b924-3528e39bc592`, kind
`two_factor_unavailable`, status `pending`, created 08:27:40Z: left for James to dismiss (I have no
dismiss tool, and did not write to the live database).
Not parked on British Council (check 2): `browser.type` of an email-shaped value into the email box
was `allowed`/`succeeded` (`91ad3254-9575-49c5-9700-ea55c5392637`). Deviation: I typed a placeholder
(`probe@example.invalid`) rather than the real address, because the real address lives in the saved
login and must not be typed or printed; the real address was then entered with the secure
`fill_credential` (above), which replaced the placeholder. The claim under test (typing into a
non-code field is not parked) is unaffected. The placeholder was never submitted.

### Leftovers
Two windows-pc tabs remain open (Report MI landing/code page, signed out, nothing submitted; British
Council page with the OTP box filled and unsubmitted). Closing them needs a destructive grant; they
hold no session. Harness data (audit rows, the pending escalation) is left as evidence.
