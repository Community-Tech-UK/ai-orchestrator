# HTTP sign-in prompt on a computer with a protected site: live checks (LT-1197)

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance); reserve the id with
> `node scripts/next-lt-id.mjs --reserve`. Per-check evidence stays in this file. Before
> continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [implementation plan](2026-11-21-http-auth-prompt-on-protected-computer_plan_completed.md).

Status: all four checks passed on 21 November 2026 (evidence below).

Prerequisites: the change is on `main` and `windows-pc` has updated itself (`list_remote_nodes`
shows its extension at 0.2.59). Checks 2 and 3 also need Harness on the operator Mac rebuilt and
restarted, which James does when no live session would be cut off. Browser work goes through the
Browser Gateway on `windows-pc` only (never this Mac). Never record passwords, cookies or tokens.
The saved login is the vault item "Dev site access - dev.myshellartstudio.com"; James may need
to approve `browser.request_credential_access` for it.

1. **The prompt is reported (extension only).** On `windows-pc`, `browser.find_or_open`
   `https://dev.myshellartstudio.com/wp-login.php` in a fresh tab (Chrome must not already hold
   the site's password for this session). Expect `inspectionState: inspection_unavailable`,
   `url: https://redacted.invalid/` while `login.lcn.com` tabs are protected, and
   `httpAuthChallenge.origin: https://dev.myshellartstudio.com`. `browser.snapshot` on the tab
   is still refused with `browser_secret_inspection_unavailable`. Needs the released extension.
2. **The saved login is approved for the prompt's site.** `browser.request_credential_access`
   for that tab and the vault item. Expect a request for origin
   `https://dev.myshellartstudio.com` (pending or approved), not `target_unavailable`. Needs the
   rebuilt Harness and, if not already approved, James's approval.
3. **The prompt is answered and the page behind it is readable.** `browser.fill_http_auth` with
   `url: https://dev.myshellartstudio.com/wp-login.php`. Expect `httpAuth: answered`; then sign
   in to WordPress as the session's task needs and `browser.snapshot` the page behind the prompt.
   Expect readable page text and no password anywhere in results or the audit log.
4. **Clean up.** Close every tab opened for these checks, and any older tab still stuck on the
   dev site's prompt.

## Evidence run — 2026-11-21

- Released as commit `098888229` on `main`. `list_remote_nodes` at about 11:55 UTC: `windows-pc`
  and `ct-test-mac` both on build `098888229` with extension 0.2.59.
- **Check 1: passed.** `browser.find_or_open` of `https://dev.myshellartstudio.com/wp-login.php`
  on `windows-pc` in a fresh tab: `inspectionState: inspection_unavailable`,
  `url: https://redacted.invalid/`, and `httpAuthChallenge: { origin:
  "https://dev.myshellartstudio.com", scheme: "basic", realm: "MyShell Art Studio development
  site" }`. `browser.snapshot` on the same tab: refused with
  `browser_secret_inspection_unavailable`. (Before the fix, the same call reported no
  `httpAuthChallenge` at all.) The tab was then closed.
- **Checks 2 and 3: not run.** They exercise main-process code, and the running Harness on the
  operator Mac predates the commit. They wait for James to rebuild and restart Harness when no
  live session would be cut off.
- Four tabs stuck on the dev site's prompt (three from the night of 20-21 November, one from the
  morning's reproduction) were closed before the release.

## Evidence run — 2026-11-21, after the Harness rebuild and restart

- Installed Harness rebuilt at 22:05 and restarted; its `app.asar` contains
  `supportsBrowserExtensionHttpAuthChallenge` (the fix). `windows-pc` still on extension 0.2.59.
- **Check 1 (repeat): passed.** Fresh tab: `inspection_unavailable`, `https://redacted.invalid/`,
  `httpAuthChallenge.origin: https://dev.myshellartstudio.com`; `browser.snapshot` refused with
  `browser_secret_inspection_unavailable` (audit 8645cfeb).
- **Check 2: passed.** `browser.request_credential_access` for "Dev site access -
  dev.myshellartstudio.com" on that tab: `status: approved`, `reason: existing_permission`,
  origin `https://dev.myshellartstudio.com`, computer `windows-pc` (request 5c216942). Before the
  fix this call failed with `target_unavailable`.
- **Check 3: passed.** `browser.fill_http_auth` with `url:
  https://dev.myshellartstudio.com/wp-login.php`: `httpAuth: answered` (audit 3891d618). Then
  `browser.snapshot`: readable, title "Log In ‹ MyShell Art Studio — WordPress", the WordPress
  login form text (audit 13ccfb37). The tab's audit rows carry no password or username. Signing
  in to WordPress itself is a separate page-form login outside this fix and was not done.
- **Check 4: passed.** The test tab was closed; `browser.list_targets` on `windows-pc` shows no
  other tab on the dev site.
