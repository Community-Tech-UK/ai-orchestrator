# Plugins page cleanup and global connectors

Status: implemented and verified, uncommitted. All five phases and canonical gates pass; the final fresh independent review returned VERDICT: PASS. Real account consent checks remain in the linked live-test document. Native keyboard traversal remains explicitly unverified because the Windows gateway did not deliver a valid Tab event.

## Goal

1. Remove the half of the Plugins page that does nothing (provider plugins) and make the page
   describe only what works (runtime packages).
2. Let James define a connector once (Linear, several Microsoft 365 accounts, any tool server)
   and have every session that can take one use it: Claude, Codex, Gemini, Copilot, Cursor,
   Grok and OpenCode. Sign-in happens once, in Harness, per account.

## Decisions (answered by James, 2026-10-26)

1. **Add the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`): approved.** Harness's
   own remote client is a 106-line POST-only transport (`src/main/mcp/transports/http-transport.ts`)
   that cannot handle Linear's streaming replies or OAuth with automatic app registration.
2. **Microsoft 365 accounts: Community Tech, EBRD, Fortitude, Adapt and Dingley.** All five are
   organisation accounts, and no personal Outlook/Hotmail account is wanted. Consequences:
   - The Graph app registration (`graphClientId`) must be switched in Microsoft Entra to
     "Accounts in any organizational directory (multitenant)". Personal accounts are not needed.
     This is a manual step for James; Phase 4 gives him exact steps before any live check.
     Today's authority is the Community Tech tenant (`settings-defaults.ts:371`).
   - Sign-in for a new account uses the `organizations` authority. Each stored account keeps its
     own tenant for token refresh.
   - Any of the four other organisations may block user consent and require their IT admin to
     approve the app. EBRD is the most likely to. A blocked consent is reported to James in
     plain words with the tenant's own message. Harness never tries to work around it.
   - Agent writes (calendar changes, sending mail) stay limited to the existing writable list,
     currently `james@communitytech.co.uk` only. The other four start read-only until James adds
     them on the connector.
3. **Retire the "Shared" tab: approved.** Existing Shared entries convert into connectors. The
   copies already in the AI tools' own settings files are left alone.
4. **Microsoft 365 served by Harness itself: left to the implementer; chosen.** Build on
   Harness's existing multi-account Graph sign-in (`src/main/graph/`). The alternatives:
   - Third-party servers (softeria `ms-365-mcp-server`, elyxlz, ForIT) each need their own
     sign-in per account and keep tokens in their own files. The biggest exposes about 300
     tools.
   - Microsoft's own server needs a Microsoft 365 Copilot licence.

Assumed (not contested by James):

- On screen the feature is called **Connectors**: a tool server plus the account it signs in
  as. The existing "Tool servers" term stays for raw servers. Both get vocabulary and glossary
  entries.
- Remote computers (for example `windows-pc`) do not get connectors in this plan. Sessions there
  get no Harness-provided tool servers today either (`spawn-config-builder.ts:141-143`). The
  connector screen says so. Follow-up plan if wanted.
- Antigravity and the direct Anthropic API provider cannot take tool servers at all today. The
  connector screen says so instead of hiding it.

## Baseline observations (recorded before implementation, 2026-10-26)

### Plugins

- **Provider plugins are a dead end.** `src/main/providers/provider-plugins.ts`: Load runs the
  file and stores it in a map (`:239`). Nothing outside the IPC handlers reads that map, and
  nothing registers it with `ProviderAdapterRegistry`. The model list and session spawn never see
  it. Nothing persists across restart. The "sandbox" is a `vm` context (`:263-290`), which is not
  a security boundary, and `sandbox: false` hands the plugin `require`. All three app data
  `provider-plugins` folders on this Mac are empty.
- **Runtime hook wiring exists.** The compiled custom-provider proof below found a worker activation defect; do not interpret source wiring as proof that a newly installed package activates. About 25 hook events are emitted from real code paths: session
  spawn, input, removal, automations, orchestration, file edits and cleanup. Examples are
  `instance-manager.ts` and `orchestration-handler.ts`. Notifier, tracker and telemetry slots are
  dispatched from `plugin-manager.ts:1093/1267/1299`. A package with the `provider` slot
  registers through `providerAdapterRegistry` (`plugin-manager.ts:434`,
  `plugin-worker-host.ts:396-412`). That path is not yet proven end to end; see Phase 1.
  Nothing is installed: `~/.orchestrator/plugins` does not exist.

### Connectors (tool servers)

There are three existing mechanisms:

| Mechanism | Where | How it reaches sessions | Problems |
|---|---|---|---|
| Harness list ("Orchestrator" tab), table `orchestrator_mcp_servers` | `orchestrator-mcp-repository.ts`, per-record `injectInto` | Injected at every spawn by `SpawnConfigBuilder.getMcpConfig` | Only Claude, Codex, Copilot, Grok and OpenCode (`ORCHESTRATOR_INJECTION_PROVIDERS`, `mcp-scopes.types.ts:51-57`). No sign-in, only static headers. |
| Shared tab, table `shared_mcp_servers` | `shared-mcp-coordinator.ts` | One-time write into `~/.claude.json`, `~/.codex/config.toml`, etc. on "Fan out" | Edits and deletes never re-sync (`cli-mcp-config-service.ts:61-71`). Secrets written in plain text (`shared-mcp-coordinator.ts:26-30`). Claude file gets `transport` instead of `type` (`json-mcp-config.ts:74`), so Claude ignores remote entries. The drift report sends secret values to the renderer (`shared-mcp-coordinator.ts:158-165`). |
| Workspace connectors, table `workspace_mcp_connectors` | `workspace-mcp-connector-*.ts` | Injected at spawn, per project and per provider | Project-scoped by design. Unchanged by this plan. |

Per-provider delivery at spawn (all local sessions):

| Provider | Channel | Takes remote (HTTP) servers? |
|---|---|---|
| Claude | `--mcp-config` temp file | Yes |
| Codex | private `CODEX_HOME/config.toml` | Yes, but our writer emits `transport`/`headers`. Codex expects `http_headers`/`env_http_headers`/`bearer_token_env_var` (OpenAI Codex MCP docs), so auth headers are likely not sent (`codex-toml-editor.ts:226-237`). |
| Copilot | `--additional-mcp-config` temp file | **No**, stdio only (`adapter-spawn-helpers.ts:497-513`) |
| Cursor, Grok, OpenCode | ACP `session/new` `mcpServers` | If the agent advertises it |
| Gemini | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` temp file | Only Harness's four built-in bridges are written there today |
| Antigravity, Anthropic API | none | No |

Other relevant facts:

- **Codex drops James's own servers.** `codex-home-manager.ts:153-156`
  (`prepareHomeWithMcpConfig`) strips every `[mcp_servers]` table from `~/.codex/config.toml`
  whenever Harness adds any server of its own. That is nearly always, because of the browser
  bridge. This conflicts with the recorded decision not to strip James's servers from
  machine-started Codex (`docs/decisions/rejected/provider-and-account-policy.md:11`). Connectors
  would make it permanent, so Phase 2 fixes it.
- Server names are the identity everywhere. The reserved names `browser-gateway`,
  `chrome-devtools`, `mobile-mcp` and `maestro` are silently dropped for ACP and Codex
  (`acp-mcp-server-convert.ts:28-33`).
- Harness already has a stdio forwarder inside the bundled `aio-mcp` executable that relays tool
  calls to the main process over an authenticated local socket
  (`orchestrator-tools-mcp-forwarder.ts`, `orchestrator-tools-rpc-capability.ts`). Connectors
  reuse it.

## Design

**A connector is a record in the existing Harness list, extended with an account and a
sign-in.** There is no third table. The "Orchestrator" tab becomes "Connectors", and "Orchestrator"
is a word the wording guide bans on screen anyway.

Each connector has:

- a name unique across connectors, such as `linear-comtech`, `m365-communitytech` or
  `m365-ebrd`. Two accounts of the same service are two connectors with different names, so
  the agent sees separate tool sets.
- a kind: **local program** (command + args + env, as today), **remote server** (URL + sign-in),
  or **Microsoft 365 account** (served by Harness).
- a sign-in: none, API key/bearer token (stored encrypted), or OAuth (Harness runs the browser
  sign-in once and holds and refreshes the token).
- on/off, plus which providers receive it (existing `injectInto`, extended to Gemini and Cursor).

**Remote and Microsoft 365 connectors reach every AI tool as a local program.** At spawn,
Harness hands the AI tool an `aio-mcp connector <name>` stdio entry instead of the URL. That
forwarder:

- connects to the remote server itself, or for Microsoft 365 calls Harness's Graph tools.
- asks Harness over the existing authenticated socket for a current access token on each
  upstream connection or refresh. The token never lands in a settings file, a temp file, the
  command line, or the AI tool's own token store.
- is issued tokens only for connectors that were given to that session, using the existing
  session capability.

Why this shape:

- One sign-in per account serves every provider.
- Copilot works even though it only takes local programs.
- Tokens refresh centrally, so long sessions and unattended automations keep working.
- No provider-specific header formats.
- If a token cannot be refreshed, the tool call fails with "Sign in to <connector> again in
  Settings → Connectors" and Harness shows one notice. An automation never opens a sign-in
  window.

**Local program connectors** (an API key in env) keep today's direct injection, with secrets
hydrated from encrypted storage at spawn as now.

## Phases

### Phase 1: Plugins page cleanup

Delete:

- `src/main/providers/provider-plugins.ts`
- the provider-plugin handlers and event forwarding in `src/main/ipc/handlers/provider-handlers.ts`
  (`PLUGINS_*` handlers about 213-475, events about 560-575)
- channels `PLUGINS_DISCOVER/LOAD/UNLOAD/GET/GET_ALL/GET_LOADED/GET_META/INSTALL/UNINSTALL/CREATE_TEMPLATE/LOADED/UNLOADED/ERROR`
  in `packages/contracts/src/channels/provider.channels.ts`, then run `npm run generate:ipc`
- their payload schemas in `packages/contracts/src/schemas/provider.schemas.ts`
- `src/preload/domains/provider.preload.ts` methods
- `main-event-bus.ts:97-99`
- `renderer-event-validation.ts:226-228` and the schemas used only there
- `plugin-ipc.service.ts` provider methods and `onPluginUnloaded`, plus any
  `provider-ipc.service.ts` duplicates
- the related specs

Do not touch the empty `provider-plugins` folders in app data; they are harmless.

Rework `plugins-page.component.ts` into one view of runtime packages:

- installed list with uninstall
- install from folder/.zip/URL with Validate
- prune
- project plugin trust

Remove the Loaded/Available/Installed tiles, the Discover tab, the provider install-from-path
row and Create Template. Rewrite the intro in plain words: packages react to things that happen
in Harness (sessions, messages, automations, file edits) and can send notifications or record
activity.

Update `integrations.help.ts:190-215` to match.

Prove the runtime-package custom-provider route. Write a minimal `provider`-slot test package,
install it in the dev app, and confirm it appears as a provider and can answer a session. If it
works, the page and help mention it. If it does not, the wording omits it and a register item
records the defect. Do not advertise an unproven route.

Checks:

- page spec updated
- `npm run verify:ipc`
- lint, `check:ui-hints`, renderer build
- dev-app look at the page

Progress (2026-10-26):

- Code done. Removed the provider-plugin manager, its handlers and its 13 channels. Removed
  its payload/event schemas, preload and renderer service methods and event-bus entries. The
  page is rewritten as installed packages, install a package, and project plugin trust. Help text
  is rewritten; the old help claimed loaded plugins appeared in provider pickers, which was never
  true. Three hover texts for the removed counter tiles are retired in the ui-hints ledger.
- Found while removing: the old Load button could never have worked. The preload sent
  `{ pluginId, options }` but the handler's schema required `idOrPath`.
- Checks green:
  - `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints` (also
    `--against HEAD`)
  - `verify:ipc`, `verify:architecture`, `check:dead`, `verify:ipc-usage`, `verify:exports`,
    `check:contracts`
  - `build:main`, `build:renderer`
- Historical Phase 1 `test:quiet` (superseded by the final passing run below): 9 of 35391 failed, all in `plan-queue-retirement-control.spec.ts` and
  `rlm-process-ownership.spec.ts`, under load average about 70 from other sessions' suites. Both
  files pass alone (86 tests). Plan-queue files are being edited by another session.
- Independent review: four fresh reviewer passes. The first three found real issues and all
  were fixed:
  - false empty-state text
  - raw backend text and `[managed]/id` paths on screen
  - errors hidden behind an empty list
  - unused payload types, stale names, dead CSS
  - plain error sentence first, raw message behind Details
  - one validation message per line

  The fourth returned VERDICT: PASS. Non-blocking advisories left as they are:
  - a thrown (not returned) IPC error has an empty Details
  - only the last of two simultaneous section errors shows
  - the help, not the page, warns that installing runs code
- Updated implementation evidence: the actual Plugins and Connectors components were rendered with synthetic IPC state on the Windows worker through Browser Gateway. No Mac window or real account settings were used. Runtime evidence is in `_scratch/plugins-connectors-ui/`.
- The compiled custom-provider package proof was run without a GUI in a disposable profile. Installation succeeds, activation fails before registration, and normal session creation rejects a custom provider name. Recorded as **LT-709**, open, in [the register](livetest-remediation-register.md#lt-709) and [active follow-up plan](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-709). The page and Help omit a custom-provider claim, as this phase requires. This defect remains for its own remediation; it was not hidden by a skipped normal-suite test.

### Phase 2: Connectors reach every provider

- Rename the "Orchestrator" tab to "Connectors". Add vocabulary (`src/shared/copy/ui-vocabulary.ts`)
  and glossary entries.
- Add `cursor` and `gemini` to the injection targets (`ORCHESTRATOR_INJECTION_PROVIDERS`, the
  contracts enum, `SpawnConfigBuilder`).
  - Gemini: write connectors into the temp system-settings file already built in
    `adapter-spawn-helpers.ts:463-495`. Verify with a live Gemini spawn that this file merges
    with, not replaces, the user's `~/.gemini/settings.json` servers. Gemini names cannot contain
    `_`, so validate names on save.
  - Cursor: ACP list (`adapter-factory.ts:536-590`). Note that `--approve-mcps` is only passed
    in YOLO mode, and check what a non-YOLO session does with a new server.
- **Codex: keep James's own servers.** `prepareHomeWithMcpConfig` merges Harness's tables over
  the user's instead of stripping them; Harness wins on a name clash. This follows the recorded
  decision. Exec mode (`prepareMcpFreeHome`) keeps stripping user servers for startup cost and
  carries only Harness and connector servers.
- Fix the Codex HTTP keys (`codex-toml-editor.ts` and the spawn-time TOML builder): `http_headers`
  / `env_http_headers`, no `transport`. Confirm against the installed Codex with a live
  `codex mcp list` on a generated home.
- Name rules on save: unique among connectors, not a reserved bridge name, and the Gemini/Codex
  character limits. A collision is refused with a plain message instead of being dropped silently.
- Each connector shows which providers will and won't receive it and why (Antigravity, Anthropic
  API, remote computers).
- Tests:
  - `spawn-config-builder` per-provider injection specs, including Gemini and Cursor
  - Codex home merge spec
  - TOML key spec

### Phase 3: Harness-held sign-in for remote connectors

- Add `@modelcontextprotocol/sdk`. Use its streamable HTTP client transport and OAuth client
  provider:
  - PKCE
  - dynamic client registration and client-ID metadata documents
  - loopback redirect, reusing the pattern in `src/main/graph/graph-loopback-client.ts`
- New `ConnectorAuthService` (main-process singleton, `getConnectorAuthService()`,
  `_resetForTesting()`):
  - sign in
  - store tokens and client registration encrypted (`getMcpSecretStorage()`, new table via
    migration)
  - refresh before expiry
  - sign out
  - status per connector
- `aio-mcp connector <name>` forwarder mode:
  - stdio server toward the AI tool, MCP client toward the remote URL
  - lists and relays tools, resources and prompts
  - gets tokens through a new RPC on the existing socket, gated by the session capability
  - reconnects on token refresh
- Spawn: a remote connector is emitted as the forwarder's stdio entry for every provider.
- API key option: same forwarder, static bearer stored encrypted. This covers Linear's
  read-only key use.
- Health check: the existing Test button runs `tools/list` through the forwarder.
- Tests:
  - auth service (fake authorisation server)
  - forwarder relay and token-refresh specs
  - RPC capability denial for a session that was not given the connector
- Live checks:
  - sign in to Linear (`https://mcp.linear.app/mcp`) once
  - confirm a Claude, a Codex and a Copilot session can each list Linear issues

### Phase 4: Microsoft 365 accounts as connectors

- First, give James exact Entra steps to make the existing app registration multitenant
  (organisations only, no personal accounts). The sign-in authority default moves from the
  Community Tech tenant to `organizations`, which is a settings-default change. A stored custom
  `graphAuthority` is respected.
- "Add Microsoft 365 account" signs in through the existing `GraphAuthManager` and creates one
  connector per account, named from the organisation (`m365-comtech`, `m365-ebrd`,
  `m365-fortitude`, `m365-adapt`, `m365-dingley`). Token refresh uses each account's own tenant.
  A tenant that refuses consent is shown with its own message and a note that its IT admin must
  approve the app.
- Move the calendar tools out of the always-on Harness tool set into the per-account connector,
  served by `aio-mcp connector m365-<name>`. The tool calls no longer take an `account` argument,
  because the connector is the account.
- Add mail tools: search, read, list folders, create draft and send. Scopes `Mail.ReadWrite` and
  `Mail.Send` are added to the consent for accounts that turn mail on.
- Writing (calendar events, sending mail) stays limited to accounts on the existing writable list
  (`graphAgentWritableAccountsJson`), shown on the connector as "Agents may write: yes/no". Only
  Community Tech starts writable.
- Tests: the existing Graph specs plus per-connector routing, writable-policy denial, and mail
  tool schemas.
- Live check: Community Tech and at least one other organisation signed in. A session reads both
  calendars and drafts mail only in the writable one. Each remaining organisation is recorded as
  signed in, or as blocked by its admin.

### Phase 5: Retire Shared

- A migration converts each `shared_mcp_servers` row into a connector (targets become
  `injectInto`), refusing name collisions with a logged reason.
- Remove the Shared tab, the shared IPC handlers, `SharedMcpCoordinator` and
  `SharedMcpRepository`. Leave the table read-only for one release, then drop it in a follow-up
  migration.
- The per-provider tabs keep their read/write view of each AI tool's own settings file. Fix
  their Claude writer key (`json-mcp-config.ts:74`, `transport` → `type`) and stop sending secret
  values in drift text.
- Tests: migration spec and handler removal.

## Not in this plan

- Connectors on remote computers.
- Antigravity and Anthropic API tool servers.
- Per-session connector switches in the session header. The wording guide says tool servers
  never become persistent header toggles. Choosing which providers get a connector is done on the
  connector.
- Workspace connectors stay as they are.

## Verification gate (every phase)

Run targeted specs, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run verify:ipc`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

Then do a dev-app check of the changed screens, and pass an independent task-completion-gate
review. Checks that need James's real sign-ins (Linear, Microsoft accounts) go into
`2026-10-26-plugins-cleanup-and-global-connectors_livetest.md` under the live-test deferral rules.


## Implementation record (2026-10-26, verified)

- Phase 1 cleanup was already present when this implementation resumed and was preserved. Compiled custom-provider failure is recorded as LT-709, rather than advertised as supported.
- Phase 2: distinct Gemini/Cursor connector injection targets, real Gemini provider resolution, merged Gemini system settings, preserved Codex user servers in app-server mode, deliberate MCP-free exec mode, corrected Codex HTTP keys and Claude `type` writer. Installed Codex and Gemini probes accepted generated fixture settings; Gemini connected both the fixture user's server and the injected connector. Non-automatic Cursor accepted connector configuration at session creation.
- Phase 3: official SDK, encrypted account-bound OAuth/client registration/bearer storage, PKCE with a bounded state-checked loopback callback, central refresh, one sign-in notice, session-specific connector grants and authenticated socket RPC. Remote upstream tokens stay out of AI-tool configurations. Tools, resources and prompts pass through the local relay. A real bundled-process regression caught and fixed premature relay exit; a fake streaming server and fake authorisation server cover relay/refresh without real credentials.
- Phase 4: organisation-only default sign-in authority, tenant-bound refresh, optional mail consent, per-account calendar/mail tools, dynamic write-policy controls and explicit approval for calendar changes/mail sends. The old global calendar catalog and routes were removed. Entra setup and real multi-organisation consent checks remain in the live-test document.
- Phase 5: Shared UI/IPC/classes/types retired. Shared rows migrate once into the existing connector list, preserving ciphertext and provider targets, retaining the old table and AI-tool settings files. Reserved/duplicate/invalid names are refused with a reason; deleted migrated connectors do not reappear.

Rulings: the existing provider-settings adapter list remains separate from connector-injection targets, so Cursor delivery does not invent a Cursor settings-file adapter. Gemini's legacy Antigravity alias was corrected because the accepted plan requires actual Gemini sessions. The remediation register uses its current active follow-up plan; the stale original path in older guidance was not recreated.

Live checks: [real account checklist](2026-10-26-plugins-cleanup-and-global-connectors_livetest.md). Account and external-provider checks remain there; a separate section records the human keyboard check blocked by gateway key delivery. No real Linear/Microsoft sign-in, Entra change or mail/calendar write was performed.

Final canonical commands and independent verdict: **PASS**. The fresh reviewer independently ran both typechecks, lint, file-size/UI-hint/IPC checks, main and renderer builds, the bundled executable build and the complete default test suite. Architecture, exports, contracts, IPC usage and dead-export gates also exited zero. The complete suite passed 35,477 tests with zero failures and eight pre-existing skips; all 128 reviewed source hashes matched before, during and after verification. The separate slow/soak/live tiers were not run.

Authoritative evidence: `_scratch/plugins-connectors-final-gate.md`, `_scratch/plugins-connectors-final-gate-evidence/canonical-summary.json`, `_scratch/plugins-connectors-final-gate-evidence/full-tests-summary.json` and the complete per-command logs in that directory. Earlier failed or mixed-source runs are historical evidence only; `_scratch/plugins-connectors-verification.json` is not the final result. The production renderer retains its existing initial-bundle-size warning. Production dependency audit reported zero vulnerabilities. Verification used the existing shared dependency installation, with the SDK installation checked against its lock pin, rather than replacing the shared installation.

The actual rebuilt standalone executable answered initialization, remained alive until stdin closed and exited successfully. Source-component rendering, accessible labels and high-zoom layout were checked on Windows using synthetic IPC state; this was not a real-account Electron session. Native keyboard traversal remains unverified because of malformed gateway key delivery. No Mac fallback was used. No commit, push, deployment or real account change was performed.

Completion checklist:

- [x] Phase 1: Plugins cleanup, runtime package controls, and the explicitly permitted custom-provider failure registration (LT-709).
- [x] Phase 2: seven local-provider injection paths, provider configuration fixes and installed-CLI configuration probes.
- [x] Phase 3: encrypted central sign-in, streaming relay, refresh, capability enforcement and executable runtime checks.
- [x] Phase 4: per-account Microsoft calendar/mail routing, consent scopes, write controls and approval/cancellation checks. Real account checks are deferred to the live-test document.
- [x] Phase 5: Shared retirement and one-time encrypted migration, retaining old tables and provider settings files.
- [x] All required agent-runnable gates and fresh independent review.
- [ ] Deferred real account and external provider-service checks in the linked live-test document.
- [ ] Native keyboard traversal, blocked by gateway key delivery; steps are in the live-test document and no product pass is claimed.


## Independent review remediation (26 October 2026)

The first fresh gate returned FAIL with four reproduced findings. All four were implemented with failing-then-passing regressions. A second genuinely fresh gate independently reproduced their corrected behavior and returned PASS after the complete canonical run:

1. Pending Microsoft mutations now recheck the current connector, account, mail setting, enabled state, session grant and live provider generation after approval and after token acquisition, immediately before the HTTP request. Writable policy is rechecked at that final boundary as well. Cancellation travels from the MCP request to the parent socket and Graph operation; interrupted, terminating and restarted sessions cannot finish old requests.
2. Graph operations have a bounded deadline covering fetch, response reading and GET backoff. Mutations are not retried after an ambiguous result.
3. Microsoft connector Test now authenticates the bound account and performs read-only calendar access, plus mail-folder access when mail is enabled. Missing/expired accounts produce the connector's sign-in instruction.
4. A calendar-only sign-in for an already mail-enabled account preserves its broader consent/cache. A new calendar-only account still requests no mail permission; an expired preserved cache requires a mail-enabled sign-in rather than silently losing mail access.

The initial independent report is `_scratch/plugins-connectors-fresh-gate.md`; the final passing report is `_scratch/plugins-connectors-final-gate.md`. Both reviews' fake-service probes are retained beside their evidence. The integrated focused run passed (`_scratch/plugins-connectors-remediation-focused.log`), followed by the independent complete passing run documented above. The review found no weakened surviving assertions, secret disclosure, or unsupported Gemini migration requirement. The security-sensitive changes also received the skill-required broader review of the affected architecture, persistence and state paths; this is not a whole-repository health certification.

Non-blocking review advisory: connector lookup currently reads the saved connector list, which decrypts unrelated stored env/header entries before choosing the granted record. No cross-session return or material latency was reproduced. A targeted metadata lookup is a possible follow-up; no new cache or shadow policy was added for it.

Native keyboard traversal remains unverified: the Windows gateway produced a malformed Tab event on both error and ordinary test documents. Labels, source-component rendering and high-zoom layout were checked. This is recorded as a verification limit, not evidence of a product keyboard trap. No Mac fallback was used without permission.
