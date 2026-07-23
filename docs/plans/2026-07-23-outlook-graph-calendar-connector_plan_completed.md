# Outlook / Microsoft 365 Graph calendar connector for the orchestrator MCP

Status: IMPLEMENTED AND AGENT-VERIFIED; rebuilt-app and external Microsoft/calendar checks are deferred to the linked live-test document. Untracked per plan lifecycle. Author: agent for James, 2026-07-23.

## Why

James lives across three calendars: a personal Hotmail/Outlook.com account
(`shutupandshave@hotmail.com`, used as the shared **family** calendar), a Google
calendar (`shutupandshave@gmail.com`, personal), and an M365 business account
(`james@communitytech.co.uk`, Comtech work). Claude now has the first-party
Anthropic Microsoft 365 connector, but that connector:

- only attaches to an **Entra/business** tenant (works for communitytech.co.uk, cannot
  attach to a consumer Hotmail account), and
- is **Claude-only**. Codex, Grok and any other MCP client get nothing.

Decision (James, 2026-07-23): build **one** Microsoft Graph calendar connector into
AIO's orchestrator MCP so every MCP client (Claude, Codex, Grok, future agents)
shares it. Because it uses delegated Graph via the `/common` authority, a single
connector can reach **both** consumer Outlook.com/Hotmail accounts **and** M365
business accounts, which the first-party Claude connector cannot.

## Goals

- A reusable `graph_calendar_*` tool group on the orchestrator MCP: connect an account,
  report status, list accounts, list calendars, list/search events, create, update,
  delete events.
- Delegated OAuth2 (auth-code + PKCE) with user consent, working for consumer **and**
  business Microsoft accounts.
- Tokens encrypted at rest and never returned to any agent.
- Mutations (create/update/delete) pass through the operator permission gate, matching
  the existing release-tool authorization pattern and the project's "one approval, one
  send" rule for anything a human contact could see (calendar invites qualify).

## Non-goals (this iteration)

- Mail, Teams, Contacts, or Drive/SharePoint. Calendar only; design leaves room to add
  siblings later.
- Multi-user / shared-mailbox delegation. Single interactive user, N of their own
  accounts.
- Replacing the Google Calendar path already available via the Claude/Google connector.

## Architecture constraints discovered (must respect)

Anchors are `src/main/...` under `ai-orchestrator`.

1. **Two-process split.** The shipped `aio-mcp` binary (`build-aio-mcp-cli.ts` →
   `src/main/mcp/aio-mcp-dispatcher.ts`) is a thin stdio↔Unix-socket **forwarder** with
   `electron`, `better-sqlite3`, `@sqlite.org/sqlite-wasm` deliberately externalised. The
   real work runs in the Electron main process behind
   `src/main/mcp/orchestrator-tools-rpc-server.ts`. **Therefore all OAuth, token storage,
   token refresh and Graph HTTP live in Electron main. The CLI never sees a token.** The
   interactive consent (opening a browser) must also run in main (it owns
   `app`/`shell`/`BrowserWindow`), triggered by an RPC method.

2. **No MCP SDK.** Tools are hand-rolled `McpServerToolDefinition`
   (`src/main/mcp/mcp-server-tools.ts`): `{ name, description, inputSchema (raw JSON
   Schema), handler }`. Schemas are declared twice on purpose — JSON Schema for the wire,
   a parallel Zod schema to `.parse()` in the handler.

3. **Three edit points per tool**, unless we use the generic-dispatch idiom:
   - forwarder proxy (`orchestrator-tools-mcp-forwarder.ts`) → `client.call('orchestrator_tools.<x>', args)`
   - RPC dispatch (`orchestrator-tools-rpc-server.ts`)
   - parent impl (a new `orchestrator-*-tools.ts` group file)
   The **RPC spec-array idiom** (`EVIDENCE_RPC_SPECS` in `orchestrator-tools-rpc-evidence.ts`,
   `FILE_TRANSFER_RPC_SPECS` in `orchestrator-tools-rpc-file-transfer.ts`) auto-dispatches
   via `dispatchValidatedTool()` at `orchestrator-tools-rpc-server.ts:283-290` with **no
   per-method `switch` case** — use this for the read-only calendar tools. Mutations still
   want an explicit `case` so they can run through the permission gate (see the
   `authorizeReleaseMutation` block at `orchestrator-tools-rpc-server.ts:418-431`).

4. **Dependency injection.** Parent handlers receive everything through
   `OrchestratorToolRuntimeContext` (`orchestrator-tools.ts:347-368`); real singletons are
   wired in `src/main/app/orchestrator-tools-step.ts:184` via
   `initializeOrchestratorToolsRpcServer({...})`. The Graph client + token store get
   injected there, and stubbed in tests.

5. **Secret storage.** `McpSecretStorage` (`src/main/mcp/secret-storage.ts`) wraps Electron
   `safeStorage` and **hard-refuses to persist when encryption is unavailable** (no
   plaintext fallback). Encrypted blobs are stored base64 in **SQLite**, following the
   `*_secrets_encrypted_json` column convention in `mcp-record-storage.ts`. Only works in
   Electron main. `settings.json` (via `SettingsManager`) is **not encrypted** — use it
   only for non-secret Graph config (client id, tenant/authority, chosen account email,
   scopes), never for tokens.

6. **HTTP.** No shared client. Convention: a per-client class taking an injectable
   `FetchLike`, injecting `authorization: Bearer` by hand, doing its own token caching with
   an expiry skew (`GoogleServiceAccountTokenProvider` in
   `src/main/release/play-developer-client.ts` is the template).

7. **LOC lint.** `check:ts-max-loc` caps new files at **700 lines**;
   `orchestrator-tools.ts` is already at its 771 ceiling — do not grow it beyond the tiny
   spread line. Keep each concern in its own file.

8. **Build/ship.** Parent-side changes need `build:main` + app restart. Any
   **forwarder** change (new tool name / inputSchema / handler on the CLI side) needs
   `npm run build:aio-mcp-dist` (esbuild + SEA + postject + codesign) and a restart of the
   connected Claude/Codex client. Plan forwarder tool names up front to avoid repeated SEA
   rebuilds.

## Prerequisite (Phase 0): Azure app registration

Manual, one-time, done by James (or by an agent driving the Entra portal in his
authenticated browser). Needed before any code can authenticate.

- Register an app in the **communitytech.co.uk Entra tenant** (he owns it).
- Supported account types: **"Accounts in any organizational directory and personal
  Microsoft accounts"** (`AzureADandPersonalMicrosoftAccount`) → authority
  `https://login.microsoftonline.com/common`. This is what lets one connector serve both
  the M365 business account and consumer Hotmail.
- Platform: **Mobile and desktop / public client**. Redirect URI:
  `http://localhost` (loopback; the port is chosen at runtime) plus
  `https://login.microsoftonline.com/common/oauth2/nativeclient` as a fallback.
- Enable **"Allow public client flows"** (needed for PKCE without a client secret).
- Delegated Graph permissions: `Calendars.ReadWrite`, `offline_access`, `openid`,
  `profile`, `User.Read`. No admin consent required for these delegated scopes on a
  personal account; James self-consents for the business account.
- Record the **Application (client) ID** into AIO settings (non-secret). No client secret
  is created (public client + PKCE).

Deliverable of Phase 0: a client ID stored in `AppSettings`, and the redirect URI(s)
registered.

### Phase 0 AS-BUILT (registered 2026-07-23)

App registration created in the communitytech.co.uk Entra tenant, signed in as
`james@communitytech.co.uk`:

- Display name: **AIO Graph Calendar Connector**
- **Application (client) ID: `fdbb0672-4089-48dc-bcc5-7121a331fcfc`**
- Object ID: `3ee01415-cba8-487b-969b-ff3234f4eb39`
- Directory (tenant) ID: `60b0a25e-b75d-4d9e-b797-1805ec311dfb`
- Platform: Mobile and desktop. Redirect URIs registered:
  `http://localhost` (loopback for MSAL) and
  `https://login.microsoftonline.com/common/oauth2/nativeclient` (native fallback).
- Allow public client flows: **Yes** (`isFallbackPublicClient: true` confirmed in manifest) — enables PKCE without a client secret.
- Delegated Graph permissions granted: **Calendars.ReadWrite** and **User.Read** (both "no admin consent required").

Deliberately deferred (non-blocking, decisions recorded):
- **Supported account types = single tenant (`AzureADMyOrg`)**, NOT multitenant+personal.
  Chosen so the connector can only authenticate the communitytech M365 tenant, which
  matches the calendar-routing rule (Comtech -> M365; the personal Hotmail is a hands-off
  family calendar already covered by Google for personal use). To later enable the
  consumer Hotmail account, flip `signInAudience` to `AzureADandPersonalMicrosoftAccount`
  and change `graphAuthority` back to `https://login.microsoftonline.com/common`. The
  redirect URIs and public-client flag are already personal-account compatible. The
  current single-tenant registration uses its tenant-specific authority because Microsoft
  rejects `/common` for single-tenant apps with `AADSTS50194`.
- **`offline_access`** not pre-registered: MSAL requests it implicitly for refresh tokens
  and it is granted by dynamic consent at first sign-in. Add to the app registration only
  if a no-prompt/admin-consent flow is later required.
- **Admin consent** not pre-granted: Calendars.ReadWrite is user-consentable, so James
  consents once at first `graph_calendar_connect`. Click "Grant admin consent for
  Community tech" later only to suppress that one-time prompt.

No client secret was created (public client + PKCE), so nothing sensitive to store from
Phase 0; only the non-secret client ID above goes into `AppSettings`.

## Phase 1: Graph auth core (Electron main only)

New module dir `src/main/graph/` (mirrors `src/main/release/`).

- **`graph-auth.ts`** — `GraphAuthManager`.
  - Recommended: `@azure/msal-node` `PublicClientApplication` with auth-code + PKCE. MSAL
    handles refresh, multi-account, and `/common` authority correctly (the security-hard
    part). Use raw `fetch` for the Graph REST calls afterwards, matching repo style — i.e.
    MSAL for the token lifecycle only.
  - Custom `ICachePlugin` backed by `McpSecretStorage`: MSAL's serialized token cache is
    encrypted via `safeStorage.encryptString` and persisted to a new SQLite table (below).
    This keeps refresh tokens out of `settings.json`.
  - Interactive consent: `connectAccount()` opens the system browser via
    `shell.openExternal(authCodeUrl)`, runs a short-lived **loopback HTTP listener** on
    `127.0.0.1:<ephemeral>` to capture the `code`, exchanges it, stores the account.
    Fallback: **device-code flow** for headless/no-browser contexts (MSAL supports it).
  - `getAccessToken(accountKey)`: silent acquisition (MSAL `acquireTokenSilent`) with the
    in-memory + skew cache pattern; falls back to refresh; surfaces a
    `reauth_required` error the tool maps to a friendly "run graph_calendar_connect".
  - `listAccounts()` / `removeAccount()`.
  - Alternative if we want zero new deps: hand-rolled PKCE + `/token` POST against
    `https://login.microsoftonline.com/common/oauth2/v2.0/token`, refresh managed like
    `GoogleServiceAccountTokenProvider`. More code, more security surface we own; MSAL
    preferred. **Open decision — see Risks.**

- **`graph-token-store.ts`** — new SQLite table `graph_accounts` (or reuse the
  encrypted-column convention): columns for `account_key` (homeAccountId), `username`
  (email, non-secret, for display/selection), `tenant`, `token_cache_encrypted_json`
  (`EncryptedSecret`). Table creation mirrors `ensureMcpTables` in
  `mcp-record-storage.ts`. Reads/writes go through `getMcpSecretStorage()`.

- **Config surface** — add to `AppSettings` (`src/shared/types/settings.types.ts`) and
  `settings-control-policy.ts`:
  - `graphClientId` (open or read-only tier), `graphAuthority` (default `/common`),
    `graphScopesJson`, and an **`graphAgentWritableAccountsJson`** allowlist (see Security)
    — all non-secret config. No token material here.

## Phase 2: Graph HTTP client

- **`src/main/graph/graph-client.ts`** — `GraphClient({ tokenProvider, fetch? })`.
  - `authorization: Bearer` injection; base `https://graph.microsoft.com/v1.0`.
  - Methods: `listCalendars(account)`, `listEvents(account, {calendarId?, start, end,
    top, filter})` with `@odata.nextLink` pagination, `getEvent`, `createEvent`,
    `updateEvent`, `deleteEvent`.
  - Recurrence: pass through Graph `recurrence` (pattern + range) objects so monthly
    reminders like the Spark MI return are expressible.
  - Retry/backoff on 429/503 honouring `Retry-After`; own the skew constant like the
    release clients. No shared wrapper exists to reuse.
  - Consumer vs business: both use `graph.microsoft.com/v1.0`; keep to v1.0 endpoints
    (avoid `/beta`, which diverges for consumer accounts). Timezone via
    `Prefer: outlook.timezone="Europe/London"` header.

## Phase 3: Calendar tool group

- **`src/main/mcp/orchestrator-calendar-tools.ts`** — export:
  - `CALENDAR_TOOL_SPECS` (description + JSON Schema per tool),
  - parallel Zod arg schemas,
  - `CalendarToolDependencies` (inject `GraphAuthManager` + `GraphClient`),
  - `createCalendarToolDefinitions(deps): McpServerToolDefinition[]`.
- Tools (names final at design time to avoid SEA re-rolls):
  - `graph_calendar_connect` — start interactive consent for an account (mutation-ish;
    opens browser). Returns the connected account email, never a token.
  - `graph_calendar_status` — which accounts are connected, token validity, scopes.
  - `graph_calendar_list_accounts`
  - `graph_calendar_list_calendars` — for an account.
  - `graph_calendar_list_events` — account + calendar + window + optional filter/search.
  - `graph_calendar_create_event` — mutation, permission-gated.
  - `graph_calendar_update_event` — mutation, permission-gated.
  - `graph_calendar_delete_event` — mutation, permission-gated.
- Handlers `throw new Error(msg)` on failure (maps to JSON-RPC error). Never echo tokens.

## Phase 4: MCP wiring

- **Forwarder** (`orchestrator-tools-mcp-forwarder.ts`): add a
  `createCalendarForwarderTools(client)` factory (like `createFileTransferForwarderTools`)
  that maps `CALENDAR_TOOL_SPECS` names to `client.call('orchestrator_tools.<name>', args)`
  proxies, with the standard object-guard.
- **RPC read tools**: add `CALENDAR_READ_RPC_SPECS` (list_accounts, list_calendars,
  list_events, status) to the generic `dispatchValidatedTool` registration at
  `orchestrator-tools-rpc-server.ts:283-290` — no per-method case.
- **RPC mutations**: add explicit cases for `connect`, `create`, `update`, `delete` that
  call `authorizeReleaseMutation`-style permission gating
  (`getPermissionRegistry().requestPermission(...)`) before dispatch. This is the
  enforcement point for "one approval, one send."
- **Toolset scoping**: add the 8 tool names to the `orchestrator-tools-full` list in
  `ORCHESTRATOR_TOOLSETS` (`orchestrator-tools-rpc-server.ts:74-77`) or they'll be scoped
  out.
- **Context + wiring**: add `calendarTools` to `OrchestratorToolRuntimeContext`
  (`orchestrator-tools.ts:347-368`), spread `...createCalendarToolDefinitions(context.calendarTools)`
  into the master list (~`orchestrator-tools.ts:718`, keep it a one-liner for LOC), and
  inject the real `GraphAuthManager`/`GraphClient` in
  `orchestrator-tools-step.ts:184`.

## Phase 5: Tests

- vitest, co-located `*.spec.ts`, run via `npm run test:quiet` (never raw `vitest`).
- Unit-test `createCalendarToolDefinitions` with a fake `GraphAuthManager` + `GraphClient`
  (pattern: `orchestrator-settings-tools.spec.ts` `toolByName()` helper). Assert: schema
  validation rejects bad args; tokens never appear in any returned payload; mutations
  require the permission gate; `reauth_required` maps to a friendly message.
- Test `GraphClient` with an injected `FetchLike` fake (pattern:
  `play-developer-client` tests): pagination, 429 retry, timezone header, recurrence
  passthrough.
- Test the token store round-trips through a fake `safeStorage` and refuses when
  encryption is unavailable.
- Update any roster-asserting specs (forwarder / rpc-server) that count total tools.

## Phase 6: Build, ship, live-test

- `npm run typecheck` + `check:ts-max-loc` + `test:quiet` green.
- `npm run build:aio-mcp-dist` (SEA rebuild) so the forwarder ships the new tool names;
  restart the connected Claude/Codex client.
- Rebuilt-app consent, calendar mutation, recurring-reminder, and optional future Hotmail
  checks are recorded in
  [2026-07-23-outlook-graph-calendar-connector_livetest.md](./2026-07-23-outlook-graph-calendar-connector_livetest.md).

## Security & privacy

- Tokens: encrypted at rest via `safeStorage` → SQLite; never returned by any tool; never
  logged (forwarders already run `enableConsole:false`).
- Mutations gated by the operator permission registry — an agent cannot silently create or
  delete an event.
- **Family-calendar guard**: the connector *can* technically reach
  `shutupandshave@hotmail.com`, but `graph_calendar_create/update/delete` must refuse any
  account not in `graphAgentWritableAccountsJson`. Default allowlist:
  `james@communitytech.co.uk` only. This encodes the global calendar-routing rule
  (Comtech → M365; personal → Google; Hotmail = family, hands off) at the tool boundary,
  not just in prose.
- Minimal scopes (`Calendars.ReadWrite`, not `Calendars.ReadWrite.Shared` or Mail/Teams).
- Public client + PKCE, no client secret to leak.

## Risks / open decisions

1. **MSAL-node vs hand-rolled PKCE.** MSAL is the safer, less-code path for the OAuth
   lifecycle and handles `/common` + multi-account + refresh correctly; cost is a new
   dependency and adapting its `ICachePlugin` to `safeStorage`. Hand-rolled matches the
   repo's raw-fetch style but we own more security surface. **Recommend MSAL-node for auth,
   raw fetch for Graph REST.** Confirm before Phase 1.
2. **Loopback redirect port** must be ephemeral and registered as `http://localhost`
   (Entra allows any port on `localhost` for public clients). Device-code fallback covers
   headless.
3. **Who owns the Azure app.** Registering in the communitytech tenant is cleanest (James
   is admin). A consumer-only app registration is also possible but the business tenant is
   the natural home.
4. **Consumer-account Graph quirks.** The current app registration is deliberately
   single-tenant. If personal-account support is enabled later, restore the `/common`
   authority, stick to `/v1.0`, and run the optional read-only Hotmail check in the live-test
   document.
5. **SEA rebuild discipline.** Lock the 8 tool names before building so forwarder changes
   (and SEA rebuilds) happen once.
6. **Grok/other clients.** They consume the same MCP server, so no per-client work — but
   confirm each client is pointed at the orchestrator MCP config
   (`buildOrchestratorToolsMcpConfig`).

## File change summary

Create:
- `src/main/graph/graph-auth.ts`
- `src/main/graph/graph-token-store.ts`
- `src/main/graph/graph-client.ts`
- `src/main/mcp/orchestrator-calendar-tools.ts`
- `src/main/mcp/orchestrator-tools-rpc-calendar.ts` (RPC specs)
- spec files alongside each

Edit:
- `src/main/mcp/orchestrator-tools-mcp-forwarder.ts` (forwarder proxies)
- `src/main/mcp/orchestrator-tools-rpc-server.ts` (generic read specs + mutation cases + toolset list)
- `src/main/mcp/orchestrator-tools.ts` (context field + one spread line)
- `src/main/app/orchestrator-tools-step.ts` (inject real deps)
- `src/shared/types/settings.types.ts` + `src/main/core/config/settings-control-policy.ts` (config keys)
- `package.json` (add `@azure/msal-node` if MSAL path chosen)

## Verification gates (definition of done)

- typecheck + `check:ts-max-loc` + `test:quiet` all green.
- SEA rebuilt with all 8 tool definitions embedded.
- Checks requiring a restarted app, fresh MCP client, delegated Microsoft consent, or live
  calendar mutation are deferred to the linked live-test document.

## AS-BUILT (2026-07-23)

- Added MSAL Node delegated auth using MSAL-owned PKCE/state/code exchange plus a bounded
  localhost listener, operator-visible device-code fallback, silent refresh, actual granted
  scope reporting, encrypted per-account caches, and account removal.
- Added a Graph v1.0 client for calendars/events with London timezone preference,
  same-origin pagination, token-redacted errors, GET-only 429/503 retries, and one-attempt
  mutation behavior. Creates include a per-invocation Graph `transactionId` as an additional
  duplicate guard.
- Added all eight `graph_calendar_*` tools with parallel JSON/Zod schemas, strict local
  date-time and recurrence validation, token-result sanitization, friendly reauth errors,
  and a fail-closed writable-account allowlist.
- Wired the forwarder roster, generic read RPCs, explicit mutation RPCs, full/leaf toolsets,
  Electron runtime dependencies, safe settings metadata/defaults, and explicit-user-only
  permission decisions. `auto_approve` cannot authorize a calendar mutation.
- The registered public client ID and tenant-specific authority ship as non-secret defaults.
  Microsoft documents that `/common` is invalid for this single-tenant registration
  (`AADSTS50194`); future personal-account support requires both an Entra audience change and
  restoring `/common`.

### Agent-run evidence

- Connector/integration slice: **10 files, 142 tests passed**.
- `npm run typecheck`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed.
- Final unsharded `npm run test:quiet`: **15,494 passed, 1 skipped, 2 failures**. It exposed
  one stale renderer MCP-settings roster assertion, which was fixed. The other failure was
  the heap-snapshot spec exceeding Node's single-string limit only after the 10-minute
  process-wide run. The two affected specs then passed together in isolation: **2 files,
  17 tests passed**. An earlier isolated heap-snapshot run also passed **3/3**.
- `npm run build:main`: passed.
- `npm run build:aio-mcp-dist`: passed; all eight tool definitions were confirmed in the
  generated JavaScript bundle and the SEA executable.
- Independent code review: approved after remediation, with no remaining Critical or
  Important findings.

### Deferred live evidence

All remaining checks require a rebuilt/restarted app, fresh MCP client, delegated Microsoft
consent, a live Graph service, or James's final Spark MI reminder details. They are recorded
in [2026-07-23-outlook-graph-calendar-connector_livetest.md](./2026-07-23-outlook-graph-calendar-connector_livetest.md).
