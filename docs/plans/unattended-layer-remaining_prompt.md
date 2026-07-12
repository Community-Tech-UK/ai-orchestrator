# Prompt: finish the AIO unattended browser-automation layer (5 items)

You are implementing the final integration tranche of the AIO Browser Gateway's
"unattended overnight operation" layer in
`/Users/suas/work/orchestrat0r/ai-orchestrator`. The **core engine is already
built, wired, and tested** — your job is the surfaces and adapters that make it
usable in the running app. Read this whole prompt before starting.

## Ground rules
- Read `AGENTS.md` + `CLAUDE.md` first. Angular = standalone, OnPush, signals,
  `inject()`, `input()`/`output()` (see `~/.claude/angular.md`).
- **Secret hygiene**: never put a password/session/token into a log, tool
  result, renderer payload, repo file, test fixture, or committed example. The
  credential vault already enforces this — preserve it.
- After each change: `npx tsc --noEmit -p tsconfig.electron.json`,
  `npx tsc --noEmit -p tsconfig.spec.json`, `npm run check:ts-max-loc`, and
  `npm run test:quiet -- <changed spec>`. Lint changed files with
  `npx oxlint <files>`. Reserve the full suite for a final gate.
- **Do NOT commit.** The working tree has hundreds of unrelated files from live
  loop-writer agents; only ever stage the specific files you touch. Don't
  `git add -A`.
- Follow the existing patterns exactly (they're proven and tested).

## What already exists (built + tested this session — do NOT rebuild)
All under `src/main/browser-gateway/` unless noted:
- `browser-credential-vault.ts` — `CredentialVault` (`createAgentCredential`,
  `getSecretForFill`; folder-jailed + origin-bound + anti-phishing). `BwRunner`
  interface (its `run(args,{session?,env?,input?})`), `VaultOriginBindingStore`.
- `browser-bw-runner.ts` — `createBwRunner()` (execFile, session/env via child
  env only).
- `browser-credential-authorization-store.ts` — `CredentialAuthorizationService`
  (`create`, `revoke`, `list`, `check`), `CredentialAuthorization`,
  `CredentialPurpose = 'login'|'register'|'totp'|'email_code'`,
  `InMemoryCredentialAuthorizationStore` + `CredentialAuthorizationRecordStore`.
- `browser-credential-session.ts` — `getBrowserCredentialSession()`
  (`unlock`/`lock`/`getToken`/`locked`). In-memory only; unset on launch.
- `browser-credential-unlock.ts` — `unlockCredentialVault({runner, session,
  getMasterPassword})`.
- `browser-campaign-store.ts` — `BrowserCampaignService` (`create`,
  `recordAction`, `canProceed`, `pause`/`resume`/`kill`/`complete`,
  `approveDeclarationHash`/`isDeclarationApproved`), `BrowserCampaignStore`.
- `browser-escalation-store.ts` — `BrowserEscalationService` (`raise` →
  `{escalationId, parked:true}`, `list`, `resolve`, `skip`, `pending`),
  `EscalationRecordStore`, `notify?` hook.
- `browser-email-code-reader.ts` — `BrowserEmailCodeReader.fetchCode(request)`,
  `MailboxReader` interface (`search({sinceMs,limit})`), `extractVerificationCode`.
- `browser-session-sentinel.ts` — `SessionSentinel` (`remember`, `evaluate`,
  `planRelogin`).
- `browser-unattended-sqlite-stores.ts` — SQLite impls:
  `SqliteVaultOriginBindingStore`, `SqliteCredentialAuthorizationStore`,
  `SqliteEscalationRecordStore`, `SqliteBrowserCampaignStore`. Tables in
  migration `040_browser_unattended_tables`
  (`src/main/persistence/rlm/rlm-migrations-036-040.ts`).
- `browser-form-fill-operations.ts` — `executeFillPlanOperation`,
  `fillCredentialOperation`, `createAgentCredentialOperation`, `FillOperationDeps`.
- MCP tools already live: `browser.execute_fill_plan`, `browser.fill_credential`,
  `browser.create_agent_credential`.
- App-root: `browser-gateway/index.ts` → `buildCredentialServices()` constructs
  the vault + authorization service with the SQLite stores and injects them.

### Pattern references (copy these)
- **New MCP tool**: add name to `TOOL_NAMES` + schema to `TOOL_SCHEMAS` in
  `browser-mcp-tools.ts`; add to `ALLOWED_TOOLS` in `browser-mcp-tools.spec.ts`;
  add both switch cases in `browser-gateway-rpc-server.ts` (method dispatch +
  validation-schema); add the request interface to
  `browser-gateway-service-types.ts`; add the service method; add a Zod schema in
  `packages/contracts/src/schemas/browser-form-fill.schemas.ts` and re-export it
  from `browser.schemas.ts` (keep that file ≤700 lines — the fill-plan re-export
  is a single line with inline `type` modifiers; extend it the same way).
- **New service method**: mirror `fillCredential`/`createAgentCredential` in
  `browser-gateway-service.ts` (thin delegators to
  `browser-form-fill-operations.ts`; managed-profile-only guard;
  `this.result({...})` with no secret).
- **Renderer IPC**: channels in `packages/contracts/src/channels/browser.channels.ts`,
  preload methods in `src/preload/domains/browser.preload.ts`, main handlers in
  `src/main/ipc/handlers/browser-gateway-handlers.ts`. (Note the packaging gotcha
  for any new `@contracts/schemas/...` subpath — 3 alias files + vitest.config.)
- **SQLite store**: `browser-grant-store.ts` is the canonical example; tests set
  up an in-memory DB via `createTables`/`createMigrationsTable`/`runMigrations`
  (see `browser-unattended-sqlite-stores.spec.ts`).

---

## Item 1 — Trigger surfaces for unlock + authorization/campaign creation
The unlock logic and the authorization/campaign services exist but have no way to
be invoked. Build:
- An IPC path (channel + preload + handler) to **unlock the vault**: calls
  `unlockCredentialVault` with `runner: createBwRunner()`,
  `session: getBrowserCredentialSession()`, and a `getMasterPassword` that reads
  the master password from a secure local source (env var / OS keychain /
  configured file path — NOT hardcoded, NOT logged). Return only `{unlocked,
  reason?}` — never the token. Add a "vault locked/unlocked" status query too.
- IPC paths to **create + list + revoke credential authorizations**
  (`CredentialAuthorizationService`) and **create + list + pause/resume/kill
  campaigns** (`BrowserCampaignService`), backed by the SQLite stores. These are
  the write side the dialogs (Item 2) call. Construct both services in
  `browser-gateway/index.ts` alongside `buildCredentialServices()` and expose
  singleton getters. Authorizations/campaigns are **user-approved only** — never
  an MCP tool, never auto-approved.
- Tests: handler-level unit tests for unlock success/failure and
  authorization/campaign CRUD.

## Item 2 — Renderer approval dialogs (interactive, James-only)
Two Angular standalone components:
- **Credential authorization dialog** — create a `CredentialAuthorization`
  (profile picker, origin patterns, purposes checkboxes, vault folder, expiry),
  list existing + revoke. Calls Item 1's IPC.
- **Campaign dialog** — create a `BrowserCampaign` (label, profile, allowed
  origins, allowed action classes [block credential/payment/destructive in the
  UI], budgets, declaration-hash pre-approval, ≤14h expiry), list + pause/resume/
  kill, and a **live budget/counter + escalation-queue view** for morning triage.
- Also a small **"Unlock vault"** control surfacing locked/unlocked state.
- Follow existing renderer feature structure; signal-based store; OnPush.
- Tests: component specs for the store logic + IPC calls (Jasmine/vitest per repo).

## Item 3 — Production IMAP MailboxReader
Implement a real `MailboxReader` (see `browser-email-code-reader.ts`) over the
project's IMAP capability (there is an `imap` MCP server;
`mcp__imap__{list_accounts,search_messages,read_message}`). Investigate first
whether the main process can reach it or needs a direct node IMAP client — the
`MailboxReader.search({sinceMs,limit})` contract must return recent messages
newest-first as `MailboxMessage[]`. Wire a `BrowserEmailCodeReader` instance into
the gateway. Remember: **no plus-addressing** — disambiguation is by
sender-domain + recency only (already implemented in the reader). Then add
`email_code` support to `fill_credential` (resolve the code via the reader and
type it) gated by an `email_code` authorization purpose. Tests against a fake
mailbox; do not hit a real inbox in CI.

## Item 4 — Expose escalation + campaign at runtime + wire budgets/notify
- New MCP tools: `browser.raise_escalation` (agent parks a hard-stop and keeps
  going → returns `{escalationId, parked:true}`) and campaign read/pause tools.
  (`kill`/`resume`/`create` stay user-only via Item 1's IPC.)
- **Budget enforcement**: in the gateway's audit/mutation path, when a mutation
  runs under a campaign grant, call `BrowserCampaignService.recordAction`;
  `submit` increments both submit+action; on `{paused:true}` revoke the
  campaign's child grants and stop.
- **Campaign lease renewer**: a timer that re-issues short (~60min) autonomous
  grants (`browser-grant-store.ts` `createGrant`) ~10min before expiry while the
  campaign is active + within budget + no tripwire. Do NOT raise the 24h grant
  cap; the campaign is the standing authority.
- **Escalation push**: add `sendBrowserEscalationPush` beside
  `sendMobilePromptPush` in `src/main/mobile-gateway/mobile-gateway-push.ts` and
  pass it as the escalation service's `notify` hook.
- **Session sentinel**: after each navigation/section, evaluate; on logged-out
  with a fingerprint, run the auto re-login (navigate loginUrl → `fill_credential`
  → 2FA via Item 3 → re-verify), max 2 attempts then `raise_escalation`.
- Tests for budget-pause, lease renewal/expiry, escalation notify, sentinel
  re-login decision.

## Item 5 — Live pilot + Bitwarden bootstrap
Only after 1–4 are green. James has confirmed you may write to Bitwarden (master
password path in `~/work/creds`; unlock `bw` non-interactively per the global
CLAUDE.md recipe — never print the password/session):
- Create the `AIO-Agent` Bitwarden folder.
- Create a managed browser profile + a credential authorization for one
  low-stakes target, unlock the vault, and run a **real end-to-end signup**:
  `create_agent_credential` → `execute_fill_plan` for the form → `fill_credential`
  → email-code 2FA → verify login fingerprint. Fix whatever reality breaks.
- Then the real target: **finish the West Berkshire In-Tend registration**
  (Accreditation, Insurance, Categories, Summary tabs) using the tender-radar
  `radar fill-plan` output fed to `browser.execute_fill_plan`. Supervised first
  (~5 submits), then overnight.

## Definition of done
Vault unlockable from the UI; James can approve an authorization + a campaign in
the UI; an agent can register + fill + 2FA + submit on a managed profile with no
human in the loop; budgets/kill-switch/escalation-queue all enforce; one real
signup and the West Berks registration completed. All new code typechecks, lints,
stays under size ceilings, and is unit-tested. Nothing committed without James's
explicit go-ahead, and only the specific touched files staged.
