# Emailed-code verify click: plan

Prompt: [2026-11-01-emailed-code-verify-click_prompt_completed.md](2026-11-01-emailed-code-verify-click_prompt_completed.md)

Status: implemented and verified 2026-11-01. The two live checks (saved-login request for emailed
codes, and the British Council registration itself) need a restarted Harness and James's Approve
click, so they are deferred to
[2026-11-01-emailed-code-verify-click_livetest.md](2026-11-01-emailed-code-verify-click_livetest.md).

## Evidence gathered

- Audit rows (Harness `rlm.db`, `browser_audit_entries`), 30 Oct 2026, shared Chrome tab on
  windows-pc (node `bb62e3ee…`), origin `https://tap.tcsapps.com`:
  - 18:38:49 `browser.type` (email address), 18:38:53 `browser.click` submit "Validate Email"
    allowed under autonomous grant `4a5e22c2`.
  - 18:39:05 `browser.type` allowed: the agent typed the emailed code by hand (it had read the
    mail through the IMAP MCP). Shared tabs classify only from the agent's own hint.
  - 18:39:13 `browser.click` "Validate OTP" classified `credential` / `two_factor_challenge`,
    parked: `two_factor_unavailable_parked_to_escalation_queue`.
- The code mail (M365 INBOX uid 10452) came from `noreply.procurement@britishcouncil.org`,
  HTML only, code alone in an `<h1>`. `ImapMcpMailboxReader` strips HTML to lines and
  `extractVerificationCode` rule 3 (standalone digit line) picks it up.
- The imap MCP resolves `james@communitytech.co.uk` by exact email to the first configured
  account, `communitytech` (M365). Correct today.
- No credential authorization covers `tap.tcsapps.com`. The sender is not related to the
  origin, so the authorization must declare `britishcouncil.org`.

## Changes

1. New `browser-one-time-code-submit.ts`: an in-memory, per-tab, single-use record of a
   one-time code (email_code or totp) that `fill_credential` typed under a live credential
   authorization; and the guard helper that turns the following `browser.click` classified as
   `two_factor_challenge` on the same tab and page origin within 10 minutes into an ordinary
   `submit`, with an audit note `one_time_code_submit_after_gateway_fill`.
2. `fill_credential` records the fill on success (all fields typed, at least one code field).
3. Action guard applies the helper on both the managed and shared-tab paths. Everything else
   (typed-by-hand codes, `browser.type` into a 2FA field, captcha, passwords, payment, legal
   declarations) is unchanged.
4. A parked 2FA step now says the code expires and points at the sanctioned path, in both the
   tool result and the escalation shown in the queue.
5. Tool description for `browser.fill_credential` explains the follow-up click, and the shared
   agent browser guidance says to fill codes with `fill_credential`, never `browser.type`.
6. Agents could not ask for an `email_code` permission at all: `browser.request_credential_access`
   accepted only `login` and `totp`, and the session CLI refuses `authorize`
   (`operator_credential_approval_required`). So every new emailed-code portal needed James to fill
   the operator form by hand. The request now accepts `email_code` plus `senderDomains` (organisation
   domains only; a public suffix is refused), the approval banner and session card name the senders,
   approval writes them into the authorization's `allowedSenderDomains`, standing consent is reused
   only when it already names every requested sender, and pending requests are matched on senders.
   `aio-mcp browser-credentials request` gained `--sender-domain`. A missing `email_code` permission
   now points the agent at the request instead of the refused CLI command.

Review fixes (first fresh-eyes pass returned FAIL, 2026-11-01):
- The classifier stops at its first match and two-factor words come before password and
  declaration words, so a "Verify OTP and set new password" or "I declare … Enter OTP" click would
  have been released. The click is now classified again with the two-factor words ignored
  (`ignoreTwoFactor`), and it stays parked if that finds a hard stop or a destructive action.
- The fill is spent only when the guard actually releases the click (`has` at classification,
  `consume` in `prepareMutatingAction`), so a click that first waits for a submit approval can be
  retried. The ledger key includes the session (`instanceId`).
- `CredentialAuthorizationService.check` now combines `allowedSenderDomains` across every live
  match, so an older email_code grant without senders cannot hide a newer one that names them.

Decision: raw `browser.type` of a code on a shared tab stays possible (the guard only sees the
agent's hint there; closing it needs element inspection through the extension). It no longer
matters for this flow because the submit click is only released after a Harness fill, so a
hand-typed code still ends in a park.

## Work-finder side

- Instructions for triage and tender runs (Community Tech `AGENTS.md` "Emailed sign-in codes are
  agent work", and a pointer from `work-finder/triage-rules.md`): create the Bitwarden item with
  `bw` for a new account, `request_credential_access` (login + email_code, sender domains),
  `fill_credential` with an `email_code` field, then click verify. Never type an emailed code by
  hand. The card question becomes "approve the saved-login permission", not "register yourself".
  (`create_agent_credential` is not used: it needs a `register` permission agents cannot request.)
- Bitwarden item "British Council MyProcurement".
- Retry the British Council registration after the Harness build is running: recorded in
  [2026-11-01-emailed-code-verify-click_livetest.md](2026-11-01-emailed-code-verify-click_livetest.md)
  because Harness cannot be restarted with live sessions and the running build rejects the
  `email_code` request. The Bitwarden item is created in that run, when the account is made.

## As built: verification (2026-11-01)

- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`: pass.
- `npm run test:quiet` full suite: 36,308 of 36,311 pass. The 3 failures are outside this change:
  two in `scripts/__tests__/dependency-compatibility.spec.ts` (expect
  `node_modules/glob/node_modules/minimatch`, absent from this install) and one in
  `src/shared/types/model-token-guard.spec.ts` (model ids in `src/main/rlm/frontier-cost-attribution.ts`,
  which another session has staged).
- After the last small review edits: browser gateway, CLI, adapter, banner and contracts schema
  tests 420 files / 5,488 tests pass; tsc, lint, size ratchet and `build:main` pass.
- Fresh-eyes review: first pass FAIL (three findings, fixed as above); second independent pass
  `VERDICT: PASS`. Its optional nits were applied: a click whose re-check comes back `unknown`
  stays parked, agent wording says "checked as an ordinary submit, once", the
  `browser-mcp-tools.ts` ceiling is recorded.
- The British Council card (`british-council-bcms-103054-2026-10`, version 4) carries a note
  explaining the fix and the next steps; its question to James stays until the live check runs.

## Verification plan

- Reproduction test: "Validate OTP" click parks without a gateway fill (true before and after).
- New tests for the allowed path, single use, other tab, other origin, expiry, `browser.type`
  unchanged, captcha unchanged; fill records only on full success with a code field; HTML-only
  British Council mail shape yields its code.
- AGENTS.md gate list, then a fresh-eyes review.
