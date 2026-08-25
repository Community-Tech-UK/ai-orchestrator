# Browser Gateway: make credential login actually usable

Status: **COMPLETED 2026-08-19** — implementation was already merged in `b7f9885a`; verified path-by-path
and passed an independent completion gate on 2026-08-19 (no actionable findings: no secret-leak path, enrolment
confirmed MCP-unreachable, shared trusted-sender gate genuinely applied, migration 058 backward-compatible,
`allowedSenderDomains` fails closed when absent, and no alternate fill route bypasses authorization).
Two deferred checks live in `browser-gateway-credential-login_livetest.md` — both need a real unlocked vault
and a real portal login, so they are James-only.
Created: 2026-08-10
Owner: James / agent session
Trigger: the overdue RM6094 Spark DPS "Report MI" return could not be filed. Every
attempt to drive the Auth0 login on a shared Chrome tab hard-stopped, and no route
existed to get the password in without exposing it to the model.

## What is actually broken

Verified against the live install, not inferred:

1. **No pre-existing login can ever be filled.** `CredentialVault` refuses any secret
   read unless `browser_vault_item_bindings` holds an origin binding for the item
   (`resolveJailedItem`, `browser-credential-vault.ts:255`). The ONLY code path that
   writes a binding is `createAgentCredential` (`browser-credential-vault.ts:206`) —
   which creates a brand-new account with a generated password. An account that
   already exists (every portal James registered by hand) can never be bound, so
   `getSecretForFill` always throws `origin_binding_missing`.
   Live DB confirms it: `select count(*) from browser_vault_item_bindings` = **0**.

2. **The five existing authorizations can therefore never fire.** The live DB holds 5
   `browser_credential_authorizations`, all `profile_id = 'aio-procurement'`
   (in-tendhost, uktrade.app.jaggaer, constellia, procontract.due-north,
   publiccontractsscotland). Each names vault folder `AIO-Agent`, but with zero
   bindings none of them can resolve a secret. The feature has never worked end to end.

3. **Shared-tab authorizations cannot be created at all.** Per
   `browser-credential-authorization-store.ts:13-19`, a shared tab is keyed by NODE
   scope (`local` or the node id) because its `profileId` is ephemeral. The renderer
   panel only offers a dropdown of managed profiles
   (`browser-credential-authorization-panel.component.ts:36,56`), so a node-scoped
   record cannot be created through the UI.

4. **Third-party MFA senders are rejected.** `resolveEmailSenderDomains`
   (`browser-form-fill-operations.ts:445-472`) requires the sender domain to share a
   registrable domain with the live origin. Report MI is served from
   `auth.reportmi.gca.gov.uk` (registrable `gca.gov.uk`) but its one-time codes come
   from GOV.UK Notify (`notifications.service.gov.uk`, registrable `service.gov.uk`).
   Not related, so the code is refused. Every GOV.UK service that uses Notify — most
   of them — is affected.

5. Operator gate (expected, not a bug): `browserAllowSharedTabCredentialFill` is
   `false` and read-only to agents by design, so fills on James's own tabs stay off
   until he opts in.

Net effect: the credential-fill subsystem is structurally unusable for any account a
human created, which is all of them.

## Changes

### A. Enrol an existing login (core fix)
- `CredentialVault.enrolExistingCredential({ item, origin, moveIntoFolder })`
  - resolve the Bitwarden item by id or exact name;
  - refuse when it is outside the jail folder unless `moveIntoFolder` is set, in which
    case move it (folderId edit only — password never read, never returned);
  - write the origin binding;
  - return `{ vaultItemRef, username, movedIntoFolder }` and nothing else.
- Never exposed as an MCP tool. Human-initiated only, matching the standing-consent
  model in `browser-credential-authorization-store.ts:8`.

### B. IPC + renderer surface
- `BROWSER_ENROL_CREDENTIAL` channel, zod schema, handler beside the existing
  authorization handlers in `browser-unattended-handlers.ts`.
- "Enrol an existing login" form in the credential authorization panel: vault item
  name/id, origin, move-into-folder confirm. Shows the resulting reference + username.

### C. Node-scoped authorization targets
- Panel target selector offers managed profiles **and** shared-tab node scopes
  (`local`, plus each connected node). Same record shape; only the `profileId` value
  differs, which is what the store already expects.

### D. Authorization-scoped MFA sender domains
- `allowedSenderDomains?: string[]` on `CredentialAuthorization`, persisted (migration
  + store read/write), settable in the panel.
- `resolveEmailSenderDomains` accepts a requested domain when it is origin-related
  (unchanged default) **or** listed on the live authorization for that origin.
- Anti-phishing posture is preserved: the allowance is explicit, human-granted,
  per-origin, and never inferred from the page.

## Out of scope (James's clicks, cannot be done by an agent by design)
- Turning on `browserAllowSharedTabCredentialFill` (Settings → Advanced).
- Unlocking the credential vault (or enabling `browserVaultAutoUnlock`).
- Creating the Report MI authorization record in the panel.

## As built (2026-08-10)

All four changes are implemented:

- **A.** `CredentialVault.enrolExistingCredential()` +
  `moveItemToFolder()` (`browser-credential-vault.ts`). The item body is decoded
  in-process only to change `folderId`; the password is never returned, logged,
  or placed in an error.
- **B.** `BROWSER_ENROL_CREDENTIAL` channel, `BrowserEnrolCredentialRequestSchema`,
  handler in `browser-unattended-handlers.ts`, preload bridge, renderer IPC
  method, store action, and an "Enrol an existing login" form in the panel.
  Renderer-only — never an MCP tool.
- **C.** Panel target selector now offers shared-tab node scopes (`local` plus a
  scope per node discovered from live targets) alongside managed profiles.
- **D.** `allowedSenderDomains` on the authorization: type, zod schema, migration
  `058_credential_authorization_scope_fields`, SQLite persistence, returned on the
  authorized decision, and honoured by `resolveEmailSenderDomains`.

Also fixed in passing: the SQLite store never persisted `allowedSelectors` or
`allowedSecretTypes`. Losing `allowedSelectors` on reload silently WIDENED an
authorization (the control allowlist disappeared). Both now round-trip, and an
unrecognised secret kind is dropped rather than trusted, which can only narrow.

The shared `getBrowserCredentialVault()` singleton means an item enrolled in the
dialog is fillable immediately, with no restart.

## Verification
Done:

- New unit tests: 7 for enrolment (binds in-folder items, refuses out-of-folder
  without the move flag, moves and preserves the password, turns a previously
  unfillable hand-registered login into a fillable one, still refuses a
  wrong-origin fill, refuses an empty password, refuses when locked); 7 for
  authorization-declared senders; 2 for authorization-decision plumbing; 2 for
  scope-field persistence; 6 contract-schema tests; 5 renderer panel tests.
- `npx tsc --noEmit`: clean. `npm run verify:ipc`: 1123 channels synchronized,
  handler contract passed.
- Full suite run in three chunks (the single-process run OOMs on this machine,
  which predates this change): main 1215 files / 13,386 tests, renderer 284 files
  / 2,636 tests, contracts+preload+shared 128 files / 1,244 tests. Zero failures.

Outstanding:

- **Independent completion-gate review has NOT run.** Required before this is
  called done. This is the sole remaining blocker on renaming this plan
  `_completed` — everything else below is either verified or deferred to the
  livetest doc.
- Live/rebuild-dependent checks (enrolling an existing login live, the shared-
  tab/authorization/MFA-sender end-to-end run, and re-confirming the installed
  app once rebuilt) are recorded in
  `browser-gateway-credential-login_livetest.md`, with exact steps, expected
  results, and why they cannot run from this session.

## Verification — 2026-08-19 (Plan Agent P4)

Re-confirmed the 2026-08-10 "as built" claims against the current tree rather
than trusting the prior write-up:

- All of A–D are present and wired end-to-end (main handler → preload →
  renderer store → panel form/HTML), already committed to `main` at `b7f9885a`
  ("Browser permission fixes", 2026-08-11 10:18:43 +0100) — this predates
  today's session. File:line detail is in the livetest doc's evidence section
  to avoid duplicating it here.
- `BROWSER_ENROL_CREDENTIAL` is registered only as a renderer IPC handler
  behind the shared trusted-sender gate and has no MCP tool wrapper — confirmed
  by reading `browser-unattended-handlers.ts` and grepping `src/main/mcp/`.
- The password is never returned, logged, or placed in an error by
  `enrolExistingCredential`/`moveItemToFolder` — confirmed by reading both
  functions in full.
- Targeted tests (93 tests across 6 files covering the vault, authorization
  store, form-fill sender-domain logic, SQLite persistence, IPC handler, and
  renderer panel) pass. Full gate set passes: `tsc --noEmit` (root + spec),
  `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run
  verify:ipc` (1126/1126/1126 channels synchronized).
- Did not perform any real login or read/print any real credential value, per
  this session's task boundary. Items needing that are in the livetest doc and
  were not run.

## Follow-up
- Report MI monthly return is due within 5 working days of the 1st. Once this works,
  it should be an automation, not a manual reminder chase.
