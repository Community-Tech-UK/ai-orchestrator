# Unattended layer — live pilot next steps (Item 5)

Status 2026-07-10: Items 1–4 of `unattended-layer-remaining_prompt.md` are
implemented and the operator-owned bootstrap is present. The restarted Browser
Gateway is healthy, but the live campaign listing exposed an expiry-renewal bug
and packaged-app vault auto-unlock exposed a stripped-PATH bug. Both are fixed
locally and still need a rebuilt/restarted Harness runtime. The external pilot
has not been executed. This file is not ready for an
`_completed` rename until the managed browser flow below has real runtime
evidence.

## Already done

- Bitwarden `AIO-Agent` folder created (vault re-locked afterwards).
- imap-mcp-server verified built at `/Users/suas/work/mcp/imap-mcp-server/dist/index.js`
  with the shared account `james@communitytech.co.uk` configured; the gateway
  email-code reader pins that account (override: `AIO_BROWSER_EMAIL_ACCOUNT`).

## Full autonomy: operator-owned config (no clicks, no per-session approvals)

`src/main/browser-gateway/browser-autonomy-config.ts` reads
`~/.config/ai-orchestrator/browser-autonomy.json` (override:
`AIO_BROWSER_AUTONOMY_CONFIG`) at gateway startup and idempotently:
- points the auto-unlock env var at `masterPasswordFile` → vault unlocks;
- ensures the declared managed profiles exist (stable ids);
- installs the standing credential authorizations (content-hash idempotent);
- creates the standing campaign(s) if none active with that label.

It is an OPERATOR-OWNED file (chmod 600, your disk) — no MCP/tool surface can
write it, so a rogue agent cannot forge credential authority. The live file is
already created for the In-Tend / West Berkshire target with a small first-run
budget (maxSubmits: 5, maxNewAccounts: 1). Edit it to widen scope/budget or add
portals. After a rebuild + restart the whole pipeline comes up hands-free.

## Pilot steps (after restarting AIO on this build)

1. **Hands-free vault unlock (no UI, no agent).** Auto-unlock fires at gateway
   startup when EITHER is true — both operator-owned, neither agent-writable:
   - the launch env var `AIO_BW_MASTER_PASSWORD_FILE=/Users/suas/work/creds/bitwarden.txt`
     (best for terminal/`npm run dev` launches), OR
   - Settings → Advanced: `browserVaultMasterPasswordFile` +
     `browserVaultAutoUnlock` = on (best for a packaged/Finder-launched app).

   The path is stored, never the password; the BW_SESSION stays in
   main-process memory and is never logged or exported. The master-password
   path and the auto-unlock flag are locked to the UI/launch env — a tool-call
   cannot set them (defence against the autonomous agents editing this tree).
   The Browser-screen "Unlock vault" button remains a manual override.
2. **Verify operator-owned bootstrap.** Confirm the configured managed profile,
   credential authorizations, and campaign appear after startup without creating
   or approving them in the UI. Confirm the vault reports unlocked without
   exposing the password or session token.
3. **Dry-run signup** on a low-stakes target: agent flow =
   `browser.create_agent_credential` → `browser.execute_fill_plan` →
   `browser.fill_credential` (incl. an `email_code` field for the verification
   mail) → `browser.remember_login_fingerprint` after first successful login →
   `browser.check_session` to prove logout detection + auto re-login.
4. **Campaign:** use the campaign created by the operator-owned config. The agent
   claims its lease with
   `browser.claim_campaign_lease`, works, and budget counters tick in the UI.
   Verify a tripped submit budget pauses the campaign and revokes leases.
5. **West Berkshire In-Tend**: finish the registration (Accreditation,
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

## Completion re-audit 2026-07-10

- The operator file exists with mode `0600`, one managed profile, five standing
  credential authorizations, five campaign definitions, and a configured
  master-password file that exists. Secret contents were not read.
- The unattended-layer focused gate passes: 12 files / 152 tests covering
  bootstrap, vault unlock, authorizations, fill plans, email codes, campaigns,
  persistence, credentials, and session relogin.
- The restarted Browser Gateway is reachable and healthy. Its live campaign
  listing contains all five operator-configured campaigns with zero counters,
  but they had passed their expiry while still reporting `active`.
- Root cause: campaign expiry was only applied by `canProceed()`, while the
  standing-renewal timer reads `list()` and therefore treated stale `active`
  rows as blockers forever. `BrowserCampaignService.get()` and `list()` now
  transition elapsed active campaigns to `expired`; an integration regression
  proves the renewal path creates a fresh active campaign without a prior
  `canProceed()` call.
- Vault auto-unlock did run at startup but returned `bw_unlock_failed`. The
  configured password source validates successfully when used locally; the
  installed app inherited Finder's stripped system PATH and could not resolve
  the Homebrew `bw` executable. `createBwRunner()` now reuses the established
  packaged-app CLI environment expansion. A live runner probe with the same
  stripped PATH returns a non-empty session successfully without printing the
  password or session. The combined runner/unlock/services/campaign gate passes
  6 files / 71 tests.
- No evidence was found for a low-stakes signup, logout/relogin proof, submit
  budget tripwire, or the supervised In-Tend registration steps. These are real
  external actions and must be completed from a rebuilt, freshly restarted
  Harness-spawned agent before this file can be marked complete.
