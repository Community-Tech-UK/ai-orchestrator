# Unattended layer — live pilot next steps (Item 5)

Status 2026-07-07: Items 1–4 of `unattended-layer-remaining_prompt.md` are
implemented, typechecked, linted, and tested (full suite: 11,740 tests green).
Nothing committed. The live pilot is blocked ONLY on restarting the AIO app
onto this build — the currently running app is an older build (its MCP bridge
does not expose fill_credential/execute_fill_plan, let alone campaigns), and
restarting it would kill the live loop agents, so it needs James's go-ahead.

## Already done

- Bitwarden `AIO-Agent` folder created (vault re-locked afterwards).
- imap-mcp-server verified built at `/Users/suas/work/mcp/imap-mcp-server/dist/index.js`
  with the shared account `james@communitytech.co.uk` configured; the gateway
  email-code reader pins that account (override: `AIO_BROWSER_EMAIL_ACCOUNT`).

## Pilot steps (after restarting AIO on this build)

1. **Configure the vault password source** (one-time): Settings → Advanced →
   "Credential vault master-password file" → `/Users/suas/work/creds/bitwarden.txt`
   (or launch with `AIO_BW_MASTER_PASSWORD_FILE=...`). The path is stored, never
   the password.
2. **Unlock the vault** from the Browser screen → Unattended Automation →
   Unlock vault. Expect `unlocked: true`; the BW_SESSION stays in main memory.
3. **Create a managed profile** for the pilot target (Browser screen), plus a
   **credential authorization**: purposes `login, register, email_code`, vault
   folder `AIO-Agent`, origins = the pilot site, expiry ~90 days.
4. **Dry-run signup** on a low-stakes target: agent flow =
   `browser.create_agent_credential` → `browser.execute_fill_plan` →
   `browser.fill_credential` (incl. an `email_code` field for the verification
   mail) → `browser.remember_login_fingerprint` after first successful login →
   `browser.check_session` to prove logout detection + auto re-login.
5. **Campaign**: create in the UI (label, profile, origins, action classes
   `navigate,input,submit`, budgets, ≤14h). Agent claims its lease with
   `browser.claim_campaign_lease`, works, and budget counters tick in the UI.
   Verify a tripped submit budget pauses the campaign and revokes leases.
6. **West Berkshire In-Tend**: finish the registration (Accreditation,
   Insurance, Categories, Summary tabs) using tender-radar `radar fill-plan`
   output fed to `browser.execute_fill_plan`. Supervised for the first ~5
   submits, then overnight under the campaign.

## Notes

- Escalation pushes reach the phone via the mobile gateway (APNs category
  `AIO_BROWSER_ESCALATION`); morning triage lives in the Browser screen's
  escalation queue.
- Login fingerprints are in-memory per app run — re-record after a restart
  (`browser.remember_login_fingerprint`).
- Campaign create/resume/kill and credential authorizations are renderer-only
  by design; agents can read campaigns, claim leases, pause (tripwire), and
  raise escalations.
