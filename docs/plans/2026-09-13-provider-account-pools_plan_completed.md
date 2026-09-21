# Provider Account Pools: Implementation Plan

**Status:** IMPLEMENTED (2026-09-15). All phases built and verified in-loop; live checks deferred to [2026-09-13-provider-account-pools_livetest.md](2026-09-13-provider-account-pools_livetest.md). See **As-built notes** below.
**Spec:** [2026-09-13-provider-account-pools_spec_completed.md](../superpowers/specs/2026-09-13-provider-account-pools_spec_completed.md)
**Mechanics reference:** [2026-09-13-multi-account-mechanics-research.md](../research/2026-09-13-multi-account-mechanics-research.md)
**Precedent to mirror:** [2026-08-25-copilot-account-routing_plan_completed.md](../superpowers/plans/2026-08-25-copilot-account-routing_plan_completed.md)

> **For agentic workers:** work phase by phase, task by task, with the checkboxes. Before
> editing any file, read it whole plus its callers and its `.spec.ts`. Line numbers below
> were verified on 2026-09-13 and will drift; treat them as "look here first", then confirm.
> Every task ends with the targeted tests it names. Every phase ends with the canonical
> gates in `AGENTS.md`. Never commit unless James asks. Never write a token, a home path or
> a credential body into a test fixture, a log line or an IPC response.

**Goal:** multiple Claude and Codex account profiles per provider, isolated by
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, with automatic same-provider failover on usage limits,
per-profile limit tracking and quota, and zero behaviour change while only the legacy
profile exists.

**Architecture in one paragraph.** A `ProviderAccountProfile` is metadata plus a derived
home directory. `ProviderAccountRoutingService.resolveRouteForSpawn()` picks one profile
before any spawn and attaches a wire-safe `ResolvedAccountRoute` to `UnifiedSpawnOptions`;
the synchronous adapter factory only enforces its presence and sets the env. Limits are
recorded in the ledger against the profile. `AccountFailoverCoordinator` sits in the
existing provider-limit funnel and, before parking, moves the conversation to another
eligible profile through the runtime reconciler's handoff path. Quota and identity are
observed per profile: passively from live instances, actively from per-profile probes.

**Tech stack:** Electron main (TypeScript), Angular 22 signals, Zod 4, Vitest, better-sqlite3.

---

## Verified findings that shape this plan

**F1: `provider-notice.ts` misses Codex's real limit text.** The eight patterns at
`src/main/cli/provider-notice.ts:21-30` were run against the strings in
`codex-rs/protocol/src/error.rs` (`You’ve hit your usage limit. … try again at 3:45 PM.`,
U+2019 apostrophe). All Codex variants miss; the Claude variants match. The loop
classifier (`src/main/core/loop-error-classification.ts:59`) has a looser
`usage\s+limit` regex and the Codex runtime error classifier
(`src/main/cli/adapters/codex/app-server-runtime-errors.ts:71`) sets
`kind: 'provider-limit'`, but `detectErrorProviderLimit()`
(`src/main/instance/instance-provider-limit-detection.ts:43-68`) checks only
`diagnostics.rateLimit`, `diagnostics.quota`, `isProviderNotice(text)` and Claude telemetry.
Phase 0 fixes this and adds a regression test with the exact strings.

**F2: `CLAUDE_CONFIG_DIR` is set nowhere.** The only reference is
`src/main/core/system/debug-commands.ts:134`. `createClaudeAdapter()`
(`src/main/cli/adapters/adapter-factory.ts:185-219`) passes `options.env` straight through
without `mergeSpawnEnv`, and `ANTHROPIC_API_KEY` is on the trusted allowlist
(`src/main/security/env-filter.ts:296`), so it reaches every Claude child today.

**F3: Codex already has per-instance homes, all sharing `~/.codex/auth.json`.**
`symlinkCodexHomeEntries()` (`src/main/cli/adapters/codex/codex-home-manager.ts:152-193`)
links every `~/.codex` entry except session artifacts. The change is narrow: link
`auth.json` from the profile home instead. Session history already lives in the shared
`~/.ai-orchestrator/codex` store (`linkSessionStore`, L206-235), so Codex native resume is
already independent of which home created the thread.

**F4: `codex app-server` does not hot-reload `auth.json`.** `AuthManager::reload()` runs
only from its own login/logout RPCs and refuses an account-id mismatch. Failover must spawn
a new process with a different `CODEX_HOME`, which is how Harness spawns Codex anyway.

**F5: The ledger has no account dimension.** `provider_limit_events` is keyed
`(provider, model)` (`src/main/core/system/provider-limit-ledger.ts:26-38`) and the three
failover vetoes call `getActive({provider, model: null})`
(`src/main/instance/instance-failover.ts:168`, `src/main/orchestration/loop-failover.ts:143`,
`src/main/instance/instance-lifecycle.ts:670-674` and `:731-733`).

**F6: The park funnel is the insertion point.**
`InstanceProviderLimitHandler.maybePark()`
(`src/main/instance/instance-provider-limit-handler.ts:134-177`) records the ledger row at
L157-166 even when the park feature is disabled, and only then calls `park()`. Account
failover goes between those two, so a successful switch leaves no durable park state and
works even with `instanceProviderLimitResumeEnabled` (default false) off.

**F7: `account/rateLimits/read` and `account/rateLimits/updated` are unused.** They exist
only as strings in `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts:104`
and `:173`. `usageLimitExceeded` appears nowhere. Codex limits are currently
text-classified.

**F8: The resume fingerprint already has the conditional-segment trick.**
`computeResumeConfigFingerprint()` (`src/main/instance/lifecycle/session-recovery.ts:43-63`)
appends `copilotProfileId` only when non-empty. A Claude/Codex profile id can use the same
slot: an instance never carries both.

**F9: `codex-auth-mode.ts` reads the Electron process's `CODEX_HOME`**
(`src/main/providers/codex-auth-mode.ts:28`) with a global 60 s cache. It must accept a
home path and cache per home.

**F10: Keychain service name is `sha256(NFC(rawEnvString))[0:8]`.** The raw string, not
the realpath. Derive the home once, realpath it, and export that exact string everywhere.
A unit test pins known vectors so drift is caught.

**F11: `codex login` revokes whatever is already in the target home.** The launcher must
only ever target a fresh profile home that contains no `auth.json`, and must refuse
otherwise.

---

## Phase 0: Detection gaps (ships value on its own)

### Task 0.1: Fix `provider-notice.ts` for Codex wording
- [x] Read `src/main/cli/provider-notice.ts` and `provider-notice.spec.ts`.
- [x] Change the first pattern to accept both apostrophes and the "have" form:
  `/you(?:['’]?ve|\s+have)\s+hit\s+your\s+\w+\s+limit/i`.
- [x] Add `/\btry\s+again\s+(?:at\s+\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|later)\b/i` guarded so it
  only counts when the same text also contains `limit` or `credits` (avoid matching generic
  transport errors). Implement as a two-regex conjunction, not one giant pattern.
- [x] Add `/\bout of credits\b/i` and `/\bhit your spend cap\b/i` (Codex workspace variants).
- [x] Tests: exact strings from the research reference §2.5 (all four Codex variants, both
  Claude variants), plus negatives: `Error: connection reset, try again later` must NOT
  match.

### Task 0.2: Structured Codex limit signal
- [x] Read `src/main/cli/adapters/codex-app-server-notification-adapter.ts:209-231`,
  `src/main/cli/adapters/codex/app-server-errors.ts`, `app-server-runtime-errors.ts`,
  `src/main/instance/instance-communication.diagnostics.ts`.
- [x] When `errorDetails.codexErrorInfo === 'usageLimitExceeded'` (also accept the snake
  case `usage_limit_exceeded`), attach `quota: { exhausted: true, message }` to the thrown
  `CodexAppServerRuntimeError` so `extractProviderErrorDiagnostics()` sees it without text
  matching. Keep the existing `[codex_error_info: …]` suffix for logs.
- [x] Tests: a scripted `error` notification with `codexErrorInfo: 'usageLimitExceeded'`
  produces `detectErrorProviderLimit(...) !== null` even with an unrecognisable message.

### Task 0.3: Structured Claude limit signal
- [x] Read `src/main/cli/adapters/claude-cli-adapter.ts` `case 'result'` (from L1606) and
  `claude-cli-adapter.types.ts`.
- [x] Add `api_error_status?: number` to the result message type. When `is_error === true`
  and `api_error_status === 429`, attach `quota: { exhausted: true, resetAt }` to the
  completion error, with `resetAt` from `this.lastRateLimitInfo.resetsAt * 1000` when
  present.
- [x] Tests: scripted stream with `rate_limit_event {status:'rejected', resetsAt}` followed
  by `result {is_error:true, api_error_status:429, subtype:'success'}` yields a limit signal
  with the reset time; `subtype:'success'` alone must not be treated as success.

### Phase 0 gate
- [x] `npm run test:quiet -- src/main/cli/provider-notice.spec.ts src/main/instance/instance-provider-limit-detection.spec.ts` plus the adapter specs touched.

---

## Phase 1: Types, schemas, settings, store, migration

### Task 1.1: Shared types
- [x] Create `src/shared/types/provider-account.types.ts` with the §6 shapes from the spec:
  `PooledProvider`, `AccountAutomationPolicy`, `ProviderAccountProfile`,
  `ProviderAccountPoolPolicy`, `AccountRouteSource`, `ResolvedAccountRoute`,
  `AccountBindingStatus`, `AccountRouteFailureCode`
  (`'no-profiles' | 'profile-missing' | 'profile-disabled' | 'profile-not-bound-on-node' |
  'profile-unauthenticated' | 'profile-identity-mismatch' | 'automation-disallowed' |
  'all-profiles-parked' | 'ownership-not-acknowledged'`),
  `AccountInvocationOrigin` (reuse the Copilot origin union by re-export),
  `PROVIDER_ACCOUNT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/`,
  `LEGACY_ACCOUNT_PROFILE_ID = 'legacy'`, and
  `DEFAULT_ACCOUNT_POOL_POLICY` (`failoverMode: 'ask'`, `continuation: 'shared-store'`,
  `preemptive: { newSessions: true, liveSessionsAtTurnBoundary: false, thresholdPct: 90 }`,
  `switchCooldownMs: 300_000`, `maxSwitchesPerTurn: 3`, `acknowledgedOwnershipAt: null`).
- [x] Tests: `provider-account.types.spec.ts` for the id pattern and defaults.

### Task 1.2: Zod schemas
- [x] Create `packages/contracts/src/schemas/provider-account.schemas.ts` mirroring
  `copilot-account.schemas.ts`: `ProviderAccountProfileSchema` (`.strict()`),
  `ProviderAccountProfilesSchema` with invariants (unique ids; unique `priority` within a
  provider; at most one `isLegacy` per provider; `MAX_PROFILES_PER_PROVIDER = 8`),
  `ProviderAccountPoolPolicySchema`, `ProviderAccountPoolsSchema`
  (`Record<PooledProvider, policy>`), and the IPC payload schemas (Task 7.1), every one
  declaring `ipcAuthToken: z.string().optional()` (see the LT-522 note in the Copilot plan).
- [x] Register the subpath: `tsconfig.json`, `tsconfig.electron.json`,
  `src/main/register-aliases.ts`, `vitest.config.ts`, then `npm run check:contracts`.
- [x] Tests: `packages/contracts/src/schemas/__tests__/provider-account.schemas.spec.ts`.

### Task 1.3: Settings keys, defaults, surfacing, metadata, policy
- [x] `src/shared/types/settings.types.ts`: add `providerAccountProfiles: ProviderAccountProfile[]`
  and `providerAccountPools: Record<PooledProvider, ProviderAccountPoolPolicy>`.
- [x] `settings-defaults.ts`: `[]` and `{ claude: DEFAULT_ACCOUNT_POOL_POLICY, codex: DEFAULT_ACCOUNT_POOL_POLICY }`.
- [x] `settings-surfacing.ts`: `'bespoke'`. `settings-metadata-review-network.ts`: hidden rows.
- [x] `src/main/core/config/settings-control-policy.ts`: add both keys to
  `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` and to the table as `readOnly(false, Schema)`.
- [x] Tests: extend `settings-control-policy` specs.

### Task 1.4: Store with invariants
- [x] Create `src/main/providers/account-pool/provider-account-store.ts` modelled on
  `src/main/providers/copilot/copilot-account-store.ts`: `read()`, `persist()`,
  `createProfile(input)`, `updateProfile`, `setPriorityOrder(provider, ids[])`,
  `removeProfile(id)` (refuses when a live instance uses it), `getPoolPolicy(provider)`,
  `setPoolPolicy`, `acknowledgeOwnership(provider)`, `deriveProfileId(label)`.
  Enforce: enabling a second non-legacy profile requires `acknowledgedOwnershipAt`.
- [x] Tests: `provider-account-store.spec.ts`.

### Task 1.5: Legacy migration
- [x] `src/main/core/config/settings-migrations.ts`: `migrateProviderAccountLegacyProfiles()`
  guarded by `PROVIDER_ACCOUNT_LEGACY_MIGRATION_KEY`. Creates
  `{ id: 'legacy', provider: 'claude', isLegacy: true, priority: 0, enabled: true, label: 'Existing Claude account', automationPolicy: 'allow-routed' }`
  and the Codex twin. Identity is left `null` (verified lazily by the binding service; no
  file reads here).
- [x] Tests: `__tests__/settings-migrations.provider-account.spec.ts` (runs once, idempotent).

### Phase 1 gate
- [x] `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run check:contracts` and the specs above.

---

## Phase 2: Homes, spawn env, route attachment, stamping

### Task 2.1: Generic state root and home resolver
- [x] Read `src/main/cli/adapters/adapter-spawn-helpers.ts:204-257` and
  `src/main/cli/adapters/copilot/copilot-account-home-resolver.ts`.
- [x] Add `getProviderStateRoot()` in `adapter-spawn-helpers.ts` with the same resolution as
  `getCopilotStateRoot()`; make `getCopilotStateRoot()` delegate to it (no behaviour change).
- [x] Create `src/main/cli/adapters/account-pool/provider-account-home-resolver.ts`:
  `CLAUDE_PROFILES_ROOT_DIR = 'claude-cli-profiles'`, `CODEX_PROFILES_ROOT_DIR = 'codex-cli-profiles'`,
  `resolveAccountProfileHome({provider, profileId})` returning
  `{ kind: 'legacy' } | { kind: 'derived', home: string }`. Copy the Copilot resolver's
  slug re-validation, pre-mkdir containment, `mkdirSync` + `realpathSync`, post-mkdir
  containment, and error re-wrapping. The returned `home` is the realpath with no trailing
  separator; it is the ONLY string ever exported as `CLAUDE_CONFIG_DIR`.
- [x] Add `claudeKeychainServiceName(home)` = `` `Claude Code-credentials-${sha256(home.normalize('NFC')).hex.slice(0,8)}` ``
  (diagnostics only; never used to read the Keychain except by the D6 probe).
- [x] Tests: containment (symlink escape refused), legacy returns no path,
  service-name vectors: `undefined → 'Claude Code-credentials'`,
  `'/Users/james/.claude-work' → 'Claude Code-credentials-c5a8e3ae'`,
  `'/Users/james/.claude-work/' → '…-20db9c00'`, `'~/.claude-work' → '…-250d1b22'`.

### Task 2.2: Claude profile home seeding
- [x] Create `src/main/providers/account-pool/claude-profile-seed.ts`:
  `seedClaudeProfileHome(home, opts: { legacyClaudeDir })`. Idempotent. Creates the dir;
  symlinks `settings.json`, `CLAUDE.md`, `commands`, `skills`, `agents`, `plugins` from
  `~/.claude` when they exist and the target does not; symlinks `projects` to
  `~/.claude/projects` when pool policy `continuation === 'shared-store'`; writes
  `.claude.json` with `{"hasCompletedOnboarding": true}` only if absent. Never touches
  `.credentials.json`. Never follows an existing symlink out of the root.
- [x] Tests: idempotency; refuses to overwrite a real file; `projects` link only under
  `shared-store`.

### Task 2.3: Codex profile home seeding
- [x] Create `codex-profile-seed.ts`: `seedCodexProfileHome(home)` writes `config.toml`
  containing `cli_auth_credentials_store = "file"` if absent, and nothing else. Provide
  `codexProfileHasAuth(home)` (existence of `auth.json`, no parse).
- [x] Tests.

### Task 2.4: Claude spawn env
- [x] Read `src/main/cli/adapters/adapter-factory.ts:185-219`, `claude-env-pack.ts`,
  `base-cli-adapter.ts:570-631`, `security/env-filter.ts`.
- [x] In `adapter-spawn-helpers.ts` add
  `CLAUDE_STRIPPED_AUTH_ENV_VARS = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_SECURESTORAGE_CONFIG_DIR','CLAUDE_CONFIG_DIR']`
  (the last so an ambient value cannot leak into a legacy spawn either).
- [x] In `createClaudeAdapter()`: when `options.accountRoute` is present and resolves to a
  derived home, set `env.CLAUDE_CONFIG_DIR = home` and `envRemove = CLAUDE_STRIPPED_AUTH_ENV_VARS`
  minus `CLAUDE_CONFIG_DIR`; when it resolves to legacy, set `envRemove` to the full list
  and do not set the variable. Thread `envRemove` through `ClaudeCliSpawnOptions` into the
  adapter config (the base adapter already honours it at L593-595). Do not pass `--bare`
  for a profile-routed spawn: assert and throw if `options.bare` is set with a derived
  route.
- [x] Tests: `adapter-factory-claude-account.spec.ts`: derived route → exact
  `CLAUDE_CONFIG_DIR`, stripped vars absent even when set on `process.env`; legacy → no
  variable, stripped vars still absent; `bare` + derived route throws.

### Task 2.5: Codex spawn env and home manager
- [x] Read `codex-home-manager.ts`, `codex-base-adapter.ts:129-143`,
  `codex/codex-app-server-spawn-policy.ts:22-27`, `codex-exec-adapter.ts:63-90`.
- [x] `CodexHomeManager`: add constructor option `authSourceDir?: string`. In
  `symlinkCodexHomeEntries` skip `auth.json` when `authSourceDir` is set, then link
  `<authSourceDir>/auth.json` into the temp home (symlink, `copyFileSync` fallback on
  Windows exactly as today). Also skip `.credentials.json`? No: MCP OAuth stays shared
  from `~/.codex`.
- [x] `buildIsolatedAppServerArgs` and the exec `buildArgs`: add
  `-c cli_auth_credentials_store=file` when a derived route is present.
- [x] `adapter-spawn-helpers.ts`: `CODEX_STRIPPED_AUTH_ENV_VARS = ['CODEX_API_KEY','OPENAI_API_KEY','CODEX_ACCESS_TOKEN','CODEX_SQLITE_HOME']`;
  set `envRemove` on profile-routed Codex adapters.
- [x] `codex-auth-mode.ts`: `readCodexAuthMode(homeDir?: string)` with a per-home cache.
  Update callers to pass the profile home when known.
- [x] Tests: temp home links `auth.json` from the profile; the `-c` flag is present;
  stripped vars absent; `readCodexAuthMode` caches per home.

### Task 2.6: Route on `UnifiedSpawnOptions`, preflight, factory backstop
- [x] `src/main/cli/adapters/adapter-factory.types.ts`: add `accountRoute?: ResolvedAccountRoute`
  next to `copilotAccountRoute` (L162) with the same "factory only enforces" doc.
- [x] Create `src/main/instance/lifecycle/account-route-preflight.ts` modelled on
  `copilot-route-preflight.ts`: `attachAccountRoute(options, {instance?, origin, explicitProfileId?})`
  is a no-op for providers other than claude/codex, keeps an already-attached route, calls
  `ProviderAccountRoutingService.resolveRouteForSpawn()` (Task 3.3) and stamps the
  instance. `AccountRoutingError` carries the failure code and remedy text.
- [x] Add the call beside every `attachCopilotRoute` call site (13 sites listed in the
  codebase map: `providers/copilot-cli-provider.ts:136`, `orchestration/multi-verify-coordinator.ts:1028`,
  `orchestration/cross-model-review-service.ts:579`, `orchestration/default-invokers.ts:297`,
  `orchestration/default-loop-invoker-helpers.ts:49`, `orchestration/consensus-coordinator.ts:227`,
  `review/review-execution-host.ts:169`, `instance/auto-title-service.ts:378`,
  `instance/instance-lifecycle.ts:836`, `instance/lifecycle/instance-spawn-preflight-chain.ts:99`,
  `compare/council-provider-invoke.ts:105`, `magic-prompts/magic-prompt-service.ts:142`).
  `ProviderRuntimeService.createAdapter()` (`providers/provider-runtime-service.ts:69`) is
  the chokepoint for non-interactive invokers; attach there too so nothing bypasses it.
- [x] Create `src/main/cli/adapters/account-pool/account-adapter-guards.ts`:
  `requireAccountRoute(options, where)` throws when the store reports any non-legacy
  profile for that provider and no route is attached. Call it at the top of
  `createClaudeAdapter`, `createCodexAdapter`, and in the remote branch
  (`adapter-factory.ts:690-698`) beside `requireCopilotAccountRoute`.
- [x] Tests: `account-route-preflight.spec.ts`, `adapter-factory-account-route.spec.ts`
  (fail-closed with profiles, pass-through without).

### Task 2.7: Stamp on Instance, SessionState, history, fingerprint, reconciler
- [x] `src/shared/types/instance.types.ts`: first-class `accountProfileId?: string`,
  `accountRoutingSource?: AccountRouteSource`, `accountSwitches?: number` on `Instance`;
  `accountProfileId?` on `InstanceCreateConfig`; copy in `createInstance()` (L771);
  `DesiredRuntime` gains `accountProfileId?: string` and
  `accountHandoffKind?: 'explicit' | 'failover' | 'preemptive'`.
- [x] `src/main/session/session-continuity.ts` `instanceToState()` (L1218-1220): copy the
  new fields explicitly (F9 in the Copilot plan: `metadata` is not copied).
- [x] `instance-lifecycle.ts:2076-2082` restore path; `history.types.ts`,
  `history-manager.ts:275-280`, `history-restore-coordinator.ts` (L273, L425, L633): carry
  the field.
- [x] `session-recovery.ts`: rename the parts field to `profileId` with `copilotProfileId`
  kept as a deprecated alias mapped onto the same slot; `resume-cursor-capture.ts:28-35`,
  `continuity-revival.ts:238`, `interrupt-respawn-handler.ts:840,1181`,
  `deferred-permission-handler.ts:171`, `instance-lifecycle.ts:2114` feed
  `accountProfileId ?? copilotAccountProfileId`. Hash must be byte-identical for existing
  cursors (test with a pinned vector).
- [x] `runtime-reconciler.ts` (L104, L215-228): compute `accountProfileChanged`; when
  `accountHandoffKind` is `'failover'` or `'preemptive'` no confirmation is required
  (pool ownership was acknowledged); when `'explicit'` require
  `accountHandoffConfirmed` like Copilot. Continuity: `native-resume` when the pool policy
  is `shared-store` and `oldAdapterCapabilities.supportsResume`, else `replay`. Emit the
  transcript system note `Account switched: <from> → <to> (<reason>)`.
- [x] Renderer mirror: `src/renderer/app/core/state/instance/instance.types.ts` (L119-121, L246).
- [x] Tests: `session-continuity.provider-account.spec.ts`, fingerprint vectors,
  reconciler handoff (confirmation rules, continuity choice, note emitted).

### Phase 2 gate
- [x] Full canonical checklist. `npm run build:main` is mandatory here (it exercises `sync-dist`).

---

## Phase 3: Binding, identity, login, routing service

### Task 3.1: Binding service
- [x] Create `src/main/providers/account-pool/provider-account-binding-service.ts`
  (`LOCAL_NODE_ID = 'local'`, 30 s cache keyed `(provider, profileId, nodeId)`):
  - Claude: `execFile('claude', ['auth','status','--json'], { env: {...safeEnv, CLAUDE_CONFIG_DIR?}, timeout: 8000 })`
    via `buildCliEnv()`; parse `loggedIn`, `email`, `subscriptionType`, `configDirectory`.
    `configDirectory` must equal the derived home for a derived profile, else
    `unavailable` with `errorCode: 'config-dir-mismatch'` (catches byte-drift, F10).
    Exit 1 → `unauthenticated`. Timeout → `unavailable`.
  - Codex: `auth.json` absent → `unauthenticated`; present but not parseable as
    `{auth_mode}` at the top level (field-pick, size-bounded 64 KiB, never log) →
    `unavailable`; `auth_mode !== 'chatgpt'` → `unavailable` with `errorCode: 'not-chatgpt-auth'`;
    otherwise `authenticated` with identity from the cached Codex identity probe (Task 3.2)
    when known.
  - Identity compare case-folded; `expectedIdentity === null` means not yet verified.
- [x] Tests with a scripted `execFile` and temp dirs.

### Task 3.2: Codex identity and rate-limit probe over app-server
- [x] Read `src/main/cli/adapters/codex/app-server-client.ts` (spawn at L424) and the
  generated protocol table.
- [x] Create `src/main/providers/account-pool/codex-account-probe.ts`: spawns
  `codex -c cli_auth_credentials_store=file app-server` with `CODEX_HOME=<home>`, performs
  `initialize`, then `{"method":"account/read","id":1,"params":{"refreshToken":false}}`
  and `{"method":"account/rateLimits/read","id":2}`, closes within 10 s. Returns
  `{ identity: { email, planType, accountId }, rateLimits: RateLimitSnapshot, ordinaryUsageAllowed }`.
  Never logs the raw responses. Concurrency: one probe per home at a time.
- [x] Tests with the scripted app-server test helpers
  (`codex-cli-adapter.test-helpers.ts`).

### Task 3.3: Routing service
- [x] Create `src/main/providers/account-pool/provider-account-routing-service.ts`
  modelled on `copilot-account-routing-service.ts`: `resolveRouteForSpawn(request)` with
  the §8.1 order (persisted → explicit → default-by-priority skipping parked/over-threshold
  → legacy synthesis), then `admit()`. Pure selection lives in
  `provider-account-selector.ts`:
  ```ts
  selectAccount({ provider, profiles, policy, exclude, origin, model, now,
                  parkedProfileIds, bindings, quotaByProfile, lastUsedAt })
    : { profileId: string; reasons: string[] } | { profileId: null; considered: Array<{ profileId; vetoReason }> }
  ```
  Eligibility in order: enabled → automation policy for origin → not excluded → binding
  `authenticated` → not parked → quota 5h `< 100` if known → (preemptive) `< thresholdPct`
  if requested. Ordering: `priority` asc → soonest weekly `resetsAt` asc → `lastUsedAt` asc.
  Named veto reasons: `disabled | automation-disallowed | excluded | unbound | parked |
  exhausted | over-threshold`.
- [x] Events file `provider-account-events.ts`: `account_route_resolved`,
  `account_route_blocked`, `account_binding_checked`, `account_login_launched`,
  `account_failover_performed`, `account_failover_offered`, `account_pool_exhausted`.
- [x] Tests: selector table tests over the matrix in spec §14; routing service
  `admit()` never substitutes.

### Task 3.4: Login launcher
- [x] Read `src/main/providers/provider-login-launcher.ts:40-150`.
- [x] Add `buildClaudeProfileLoginCommand(profileId)` → `CLAUDE_CONFIG_DIR=<quoted home> claude auth login`
  (POSIX) / `set "CLAUDE_CONFIG_DIR=…" && claude auth login` (win32), after seeding the
  home (Task 2.2). Add `buildCodexProfileLoginCommand(profileId)` →
  `CODEX_HOME=<quoted home> codex login --device-auth`, after seeding (Task 2.3) and
  **refusing when `auth.json` already exists** (F11) with a message telling the user to
  remove the profile and add it again rather than re-login.
- [x] Extend `launchProviderLogin(provider, opts)` to accept `{ accountProfile: { provider, profileId } }`;
  extend the preload/IPC exposure (Task 7.1).
- [x] Tests: command rendering through `quotePathForTerminal`; refusal on existing Codex auth.

### Task 3.5: Doctor
- [x] Create `provider-account-doctor.ts`: per-profile binding, identity, priority,
  policy, default validity, ambient auth variables present in the Electron env (names
  only), Codex profiles sharing an `accountId` (workspace-shared limit warning), pool
  acknowledgement state. Wire into the existing Doctor report alongside the Copilot
  section.

### Phase 3 gate
- [x] Canonical checklist.

---

## Phase 4: Ledger with an account dimension

### Task 4.1: Schema and queries
- [x] Read `provider-limit-ledger.ts` whole and its specs; find the migration that
  created the table (search `createProviderLimitLedgerSchema`).
- [x] Add column `account_profile_id TEXT NOT NULL DEFAULT ''` via an idempotent
  `ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`. Replace the index with
  `(provider, account_profile_id, model, resume_at DESC, detected_at DESC)`.
- [x] `RecordProviderLimitEvent` and `ProviderLimitEvent` gain `accountProfileId: string | null`
  (null ↔ '' on disk, meaning legacy).
- [x] `getActive({provider, model, accountProfileId, now})`: filter on the profile.
  `getParkedProfileIds({provider, model, now}): string[]`.
  `isProviderFullyParked({provider, model, eligibleProfileIds, now})` = every eligible id
  is in `getParkedProfileIds`.
  `clearActive` and `clearAfterSuccessfulTurn` take the profile id.
- [x] Tests: migration on an existing DB keeps rows readable as legacy; per-profile
  isolation; fully-parked semantics.

### Task 4.2: Callers
- [x] `instance-provider-limit-handler.ts`: pass `accountProfileId` from the instance in
  `maybePark`, `maybeParkKnown`, `clearKnownLimitGate`; `getQuotaSnapshot(provider, profileId)`.
- [x] `instance-provider-limit-runtime.ts:13`: pass `instance.accountProfileId ?? null`.
- [x] Loop twin: `orchestration/loop-provider-limit-handler.ts`, `loop-quota-throttle.ts`.
- [x] The three vetoes (`instance-failover.ts:166-170`, `loop-failover.ts:141-145`,
  `instance-lifecycle.ts:670-674`, `:729-735`): `provider_limit_parked` now means
  `isProviderFullyParked` over the enabled, bound profiles of that provider (legacy-only
  pools reduce to today's behaviour).
- [x] Tests: veto returns parked only when all eligible profiles are parked.

### Phase 4 gate
- [x] Canonical checklist.

---

## Phase 5: Per-profile quota and Codex rate-limit wiring

### Task 5.1: Quota service composite key
- [x] Read `provider-quota-service.ts` and `shared/types/provider-quota.types.ts`.
- [x] `ProviderQuotaSnapshot.accountProfileId?: string`. Internal maps keyed by
  `quotaKey(provider, profileId)` = `provider` when legacy/undefined else
  `${provider}:${profileId}`. Public API gains an optional `profileId` parameter on
  `getSnapshot`, `refresh`, `startPolling`, `stopPolling`, `registerProbe`; the
  no-argument forms keep today's meaning. `'quota-updated'` payload carries the profile id.
- [x] `quota-auto-refresh.ts`: derive the profile id from the adapter's route and debounce
  per `(provider, profileId, eventClass)`.
- [x] Tests.

### Task 5.2: Claude per-profile probe (decision D6)
- [x] `claude-credentials-reader.ts`: accept `{ configDir?: string }`; Keychain service
  name from Task 2.1's helper; file path `<configDir>/.credentials.json`. Keep the
  read-only discipline (never refresh; expired → skip).
- [x] `claude-usage-endpoint-probe.ts`: one probe instance per profile; total cadence
  divided by profile count (`provider-quota/index.ts` registration reads the store and
  re-registers on profile changes).
- [x] If D6 is decided as "passive only", skip this task and register no active Claude
  probe for derived profiles; the legacy probe stays as it is.

### Task 5.3: Passive Claude telemetry into the snapshot
- [x] In the Claude adapter's `rate_limit_event` handler (L1847-1897) emit an adapter
  event `rate-limit-telemetry` with the full `rate_limit_info`; `quota-auto-refresh.ts`
  (or a small `account-telemetry-bridge.ts`) converts `utilization`, `resetsAt`,
  `rateLimitType` into a window on the profile's snapshot (`five_hour` → 5-hour window,
  `seven_day*` → weekly) and marks `status`.
- [x] Tests.

### Task 5.4: Codex `account/rateLimits/updated` and on-limit `read`
- [x] In `codex-app-server-notification-adapter.ts` handle `'account/rateLimits/updated'`:
  merge `rateLimits.primary/secondary` (classify by `windowDurationMins`: 300 → 5-hour,
  10080 → weekly, else by name) into the profile snapshot via the same bridge.
- [x] On `usageLimitExceeded` (Task 0.2) call `account/rateLimits/read` through the live
  client before the error propagates; put the soonest `resetsAt` among windows with
  `usedPercent >= 100` (else primary) into `quota.resetAt`. Time-box to 3 s; on failure
  fall back to text parsing as today.
- [x] Register the Codex active probe (Task 3.2) for idle derived profiles at 15 min.
- [x] Tests with scripted notifications.

### Task 5.5: Chip and store
- [x] `src/renderer/app/core/state/provider-quota.store.ts` and
  `shared/components/provider-quota-chip/provider-quota-chip.component.ts`: group rows
  by provider, one row per profile (label), provider-level value = default profile's,
  parked profiles show the reset countdown. Keep the collapsed strip one entry per
  provider.
- [x] Tests.

### Phase 5 gate
- [x] Canonical checklist including `npm run build:renderer`.

---

## Phase 6: Account failover coordinator

### Task 6.1: Coordinator
- [x] Create `src/main/providers/account-pool/account-failover-coordinator.ts`:
  ```ts
  tryFailover(params: {
    instanceId; provider: PooledProvider; model: string | null;
    exhaustedProfileId: string; resumeAt: number | null; origin; reason;
    resumePrompt: string | null;
  }): Promise<
    | { outcome: 'switched'; toProfileId: string; continuity: 'native-resume' | 'replay' }
    | { outcome: 'offered'; toProfileId: string }
    | { outcome: 'not-switched'; reason: 'mode-off' | 'cap-reached' | 'cooldown' | 'no-candidate'; considered }>
  ```
  Per-provider `Promise` lock (a simple async mutex; do not add a dependency). Inside the
  lock: re-read ledger, `selectAccount(...)` excluding the exhausted profile, then apply
  `DesiredRuntime { provider, accountProfileId: to, accountHandoffKind: 'failover' }`
  through the runtime reconciler dependency, bump `instance.accountSwitches`, stamp
  `accountRoutingSource: 'failover'`, `lastUsedAt` bookkeeping, emit
  `account_failover_performed`, notify once. On `'ask'` mode return `'offered'` and let
  the caller park with the offer notification (reuse the WS7 offer shape from
  `instance-failover.ts:78-99`).
- [x] Storm ramp: when a profile was selected as a failover target within the last 30 s,
  delay additional switches to it by 250 ms each (in-process), never longer than 5 s.
- [x] Tests: one switch under N concurrent failures; `ask` offers; `off` parks; cap and
  cooldown; no candidate → `'no-candidate'` with named reasons; second rejection within
  60 s counts as a switch.

### Task 6.2: Integrate with the park funnel
- [x] `instance-provider-limit-handler.ts` `maybePark()`: after the ledger `record` (L157-166)
  and before `park()` (L176), call `deps.tryAccountFailover?.(…)`. On `'switched'`:
  clear waitReason, re-send `resumePrompt` (through `deps.resendInput`), return
  `'switched-account'`. On `'offered'`: park, then attach the offer. Otherwise fall
  through unchanged. Extend the return union and every caller
  (`instance-communication.types.ts`, `instance-provider-limit-runtime.ts`).
- [x] Wire `tryAccountFailover` in the InstanceManager deps where `onParked` is wired.
- [x] `maybeParkKnown()` (pre-send): if the instance's profile is parked but another is
  eligible and mode is `automatic`, switch before sending instead of holding.
- [x] Tests with the scripted Claude adapter: limit on profile A → instance continues on
  profile B and the prompt is re-sent once.

### Task 6.3: Loops (decision D9)
- [x] `orchestration/loop-provider-limit-handler.ts` and `loop-failover.ts`: the same
  coordinator call before the loop parks; loop state records `accountProfileId` per
  iteration; the loop invoker respawns under the new route. `loop-quota-throttle.ts`
  reads the profile snapshot.
- [x] Tests: loop parity with the instance path.

### Task 6.4: Pre-emptive (decision D5)
- [x] New sessions: covered by the selector in Task 3.3.
- [x] Live sessions (only when `preemptive.liveSessionsAtTurnBoundary` is on): in the send
  preflight, if the profile snapshot shows `allowed_warning` or 5-hour `>= thresholdPct`,
  call the coordinator with `accountHandoffKind: 'preemptive'`.

### Phase 6 gate
- [x] Canonical checklist. Add a soak entry to `scripts/soak-long-loop.ts` if it supports
  scripted adapters.

---

## Phase 7: IPC, preload, renderer

### Task 7.1: Channels, schemas, handlers, preload
- [x] `packages/contracts/src/channels/provider-account.channels.ts` (`provider-account:*`):
  `list`, `create`, `update`, `set-priority-order`, `remove`, `verify`, `launch-login`,
  `pool-read`, `pool-update`, `acknowledge-ownership`, `bindings`, `doctor`,
  `resolve-preview` (returns the profile a new session would get, with reason). Register
  in `channels/index.ts` (three places).
- [x] Payload schemas in `provider-account.schemas.ts` (Task 1.2), all `.strict()` with
  `ipcAuthToken`.
- [x] `src/main/ipc/handlers/provider-account-handlers.ts` with the `assertNoPathOrSecret`
  gate extended with markers `claude-cli-profiles`, `codex-cli-profiles`, `.credentials.json`,
  `auth.json`, `sk-ant-`, `refresh_token`, `access_token`. Register from the IPC bootstrap.
- [x] `src/preload/domains/provider-account.preload.ts` + `preload.ts` wiring;
  `npm run generate:ipc && npm run verify:ipc && npm run verify:ipc-usage`.
- [x] Renderer `core/services/ipc/provider-account-ipc.service.ts`.
- [x] Tests: `provider-account-handlers.spec.ts` exercising the payload shape the preload
  actually sends (LT-522 lesson).

### Task 7.2: Settings tab
- [x] `src/renderer/app/features/settings/provider-accounts-tab.component.ts` (standalone,
  `OnPush`, signals, `input()`/`output()`), registered in `settings.component.ts`. Two
  sections (Claude, Codex). Profile cards; Add account (creates the profile, seeds the
  home, launches the login terminal, then polls `verify`); Verify; rename; drag or
  up/down priority; enable toggle (gated by acknowledgement); automation policy; Remove
  (blocked while in use). Pool policy: failover mode, continuation, pre-emptive
  toggles and threshold, cooldown. Ownership acknowledgement with the §5 wording.
- [x] Tests.

### Task 7.3: Session surfaces
- [x] New-session draft: `accountProfileId` in `new-session-draft.types.ts`,
  `new-session-draft.service.ts`, `instance-create-payload.ts`, `instance-list.store.ts`,
  `input-panel.component.ts` (picker behind provider controls showing
  `Max A · default` / `Max B · Max A parked until 18:30`).
- [x] `instance-header.component.ts`: `app-provider-account-chip` badge (label + source),
  generalising `copilot-account-chip.component.ts`.
- [x] Notifications and transcript notes (from Phase 6) rendered.
- [x] Tests.

### Phase 7 gate
- [x] Canonical checklist including `verify:renderer-events` and `build:renderer`.

---

## Phase 8: Remote workers (decision D10)

- [x] `remote-cli-adapter.ts:195-206`: send `accountRoute: { provider, profileId, expectedIdentity, source }`.
- [x] `remote-node/rpc-schemas.ts:234-252`: optional `accountRoute` with the slug regex.
- [x] `worker-agent/local-instance-manager.ts:234-269`: `assertAccountBinding()` using the
  binding service with `nodeId: 'worker'`; re-materialise the route with
  `source: 'persisted'`, `executionNodeId: 'worker'` before `createCliAdapter`.
- [x] `worker-node.types.ts:155` and `worker-node-registry.ts:169`: advertise and match
  `accountProfileIds`.
- [x] Tests: `remote-node/__tests__/provider-account-remote-spawn.spec.ts`.

---

## Phase 9: Verification and live tests

- [x] Full canonical checklist from `AGENTS.md`, plus `npm run check:provider-parity`,
  `check:contracts`, `verify:ipc`, `verify:ipc-usage`, `verify:renderer-events` (one
  pre-existing uncovered channel, see as-built note 24) and `build:worker-agent`.
- [x] Live checks (Keychain name, fresh-home onboarding, cross-profile native resume, Claude
  and Codex limit failover, pool exhaustion, ambient API key, remote worker binding) moved to
  [2026-09-13-provider-account-pools_livetest.md](2026-09-13-provider-account-pools_livetest.md).
- [x] Spec and plan renamed to `_completed` after every agent-runnable check passed and the
  livetest doc existed.

---

## As-built notes (2026-09-15)

Every Phase 0–8 task is implemented and covered by tests; the live checks are deferred to
[2026-09-13-provider-account-pools_livetest.md](2026-09-13-provider-account-pools_livetest.md).
Where the build differs from the task text above, this section is authoritative.

1. **No `isLegacy` on `ResolvedAccountRoute`.** A route is legacy exactly when
   `profileId === 'legacy'`; the profile schema enforces `isLegacy === (id === 'legacy')`.
   Profile IDs are unique per provider (`legacy` exists once for each). Derived IDs always
   carry a random 4-hex suffix, so a removed profile's home is never reused.
2. **No pool, no route.** `attachAccountRoute()` returns the options unchanged while a
   provider has only its legacy profile, so those spawns are byte-identical to before. The
   factory guard throws only when a pool is active and no route was attached.
3. **Ambient auth stripping follows the route, not the pool.** A route is only attached
   while a pool is active, so any legacy route strips `CLAUDE_STRIPPED_AUTH_ENV_VARS` /
   `CODEX_STRIPPED_AUTH_ENV_VARS`, including on a worker node that has no pool settings.
   Unrouted spawns strip nothing (the task text stripped on every legacy spawn).
4. **Resume fingerprint not extended** (Task 2.7 `session-recovery.ts` rename not done). D3
   wants native resume across profiles through the shared store, and existing cursor
   hashes must stay identical; adding the profile would break both. An unstamped resume is
   persisted as `legacy`.
5. **`ProviderRuntimeService.createAdapter()` is synchronous**, so it cannot resolve a
   route. Every caller attaches first (`attachProviderRoutes()` replaced `attachCopilotRoute()`
   at the shared call sites; `instance-lifecycle`, the spawn preflight chain and the
   Claude/Codex CLI providers call `attachAccountRoute()` directly), and the factory guard is
   the fail-closed chokepoint. `createAdapter()` records the route per adapter
   (`adapter-account-routes.ts`) and attaches the passive telemetry bridge. Warm start is
   skipped for providers with a pool.
6. **`readCodexAuthMode(now, homeDir?)`** caches per home; existing callers were left on the
   default home because profile-routed Codex spawns require ChatGPT auth, which the binding
   check already enforces.
7. **Ownership and creation.** `acknowledgeOwnership` also moves `failoverMode` from `ask`
   to `automatic` (D8). A new profile is created disabled while another is enabled and
   ownership is unacknowledged. The legacy profile cannot be removed and one profile must
   stay enabled.
8. **Routing when every profile is parked.** A new spawn routes to the signed-in profile
   with the soonest reset and the send gate parks it, rather than failing the create.
   Remote placement skips local binding checks; the worker checks its own (Phase 8).
9. **Ledger.** `ProviderLimitEvent.accountProfileId` is optional (`''` on disk = legacy).
   With a pool active, a limit with no reset time records an assumed one-hour row
   (`ASSUMED_ACCOUNT_LIMIT_MS`) so the selector can skip the profile.
10. **Coordinator shape.** Instead of one `tryFailover()`, `plan()` (synchronous, cached
    bindings, unknown counts as signed in) decides in the limit handler and `perform()`
    (per-provider lock, re-plan, dedupe when the instance already left the exhausted
    profile, verified bindings, wait up to 5 s for a switchable status, storm ramp,
    `applyAccountHandoff`, notify, resend) runs it. The limit handler returns
    `'switching-account'`; a failed switch falls back to parking, or to a system message
    when parking is disabled. `ask` parks and posts the offer; the user accepts through the
    session header account chip. Cooldown is literal, and the per-turn cap is
    `min(maxSwitchesPerTurn, profiles − 1)`.
11. **Pre-emptive live-session switch** runs in `maybeParkKnown()` when no limit is known,
    with a skip-once guard so the resent turn does not switch again.
12. **Loops.** `LoopAccountFailover` reads the iteration adapter's route, benches the
    profile, recycles the persistent adapter and returns `'switched-account'`. Error
    routing fails over only for plan limits (provider notice text or quota diagnostics).
    Loops that borrow an instance adapter are not switched by the loop path. A switch
    requests a loop context reset, so the next attempt on the new account (a brand-new CLI
    session) gets the full bootstrap prompt: goal re-anchor and parent-chat replay. A thrown
    plan limit that switches returns the `switched-account` route, which retries at once on
    the new account outside the degraded-retry budget. The adapter's structured `quota`
    signal reaches the loop on both paths, so detection does not depend on wording: a thrown
    error carries it across the invocation error boundary, and a cleanly completed turn
    (Claude's 429 `result`, often with no assistant text) sets
    `LoopChildResult.providerQuotaExhausted`, which is never classified as a degraded turn and
    takes the same limit handling as a notice. A burst throttle with neither signal parks and
    never rotates accounts.
13. **Quota.** Account snapshots are keyed `provider:profileId` and published separately
    (`accountSnapshots`); the provider-level (legacy) snapshot and the collapsed chip strip
    are unchanged, and the popover lists account rows under each provider with their
    windows and reset times. Claude account probes are throttled to 60 s × profile count;
    Codex account probes run every 15 minutes through the app-server; a probe that
    times out while the app-server is still starting closes it as soon as it comes up.
14. **Doctor** gained an `account_pool` probe that is skipped when no pool exists.
15. **Draft choices are per provider.** Changing the draft provider clears the explicit
    account choice (both providers have `legacy`).
16. **Remote workers.** The worker re-validates the wire route (its dispatcher does not
    re-parse), checks its own binding with `nodeId: 'worker'` and runs a `persisted` route.
    Heartbeats advertise `accountProfileIds` (profile homes present on the node, a
    placement hint only), and an explicitly chosen account adds a +40 placement preference.
17. **Not done, by design.** No soak entry: `scripts/soak-long-loop.ts` only reruns
    `long-loop-resilience.spec.ts` and has no scripted-adapter mode.
18. **IPC channel set.** Task 7.1 lists a `bindings` channel; it was not built. Binding
    state is returned per profile by `list` (and summarised by `doctor`), so a separate
    channel would duplicate it. `provider-account:switch-session` was added instead, for the
    session header's explicit account handoff. The set is still 13 channels.
19. **Draft preview context.** `resolve-preview` takes the draft's model and target worker
    node (`executionNodeId`), so the composer chip reflects model-specific parking and the
    node the session will run on. The Settings tab marks the first *enabled* account in
    priority order as Default (the configured default; routing still skips it while it is
    signed out or at its limit).
20. **Failover ordering and caught turns.** A report naming a profile the instance has
    already left returns `already-moved` before the cooldown and cap guards run (through the
    per-provider lock, so an in-flight switch finishes first), so a late or duplicate limit
    report never parks a session that is healthy on its new account. Only the turn that
    triggered a switch is re-sent, once. Any other turn caught by a concurrent switch is
    never sent automatically (it could race the turn now running, or repeat a turn the user
    cancelled); the transcript asks the user to send it again (`account-failover-notes.ts`).
    If the pool switches to asking while a switch waits for the lock, `perform()` returns
    `offered`; the handler then parks (when it can) and always adds a note, exactly as for a
    failed switch, so no turn is dropped without a trace. The coordinator remembers the last
    16 turns it re-sent per instance for 60 s, so a duplicate report of one of them produces no
    note; identical text reported later counts as a new, unsent turn. `InstanceProviderLimitHandler.release()` clears
    the coordinator's per-instance state on termination.
21. **Heartbeat tolerance.** A malformed `accountProfileIds` advertisement is dropped by the
    capabilities schema (`.catch(undefined)`) instead of rejecting the whole heartbeat.
22. **Persisted accounts and forks (spec §8.1).** A restored, respawned or resumed session
    stays on its stamped account even if that account was since disabled or its automation
    policy tightened: step 1 says changed pool settings never move a live thread. A removed
    or signed-out account fails with a typed error instead. A fork starts a new session and
    is routed like one (explicit choice, then the pool default), so it may land on a
    different account from the conversation it was forked from.
23. **Removed profiles keep their home on disk.** `removeProfile()` deletes the profile's
    settings entry only; its `claude-cli-profiles/<id>` / `codex-cli-profiles/<id>` directory
    (including that account's sign-in) stays until deleted by hand. IDs are never reused, so
    it cannot be picked up by a later profile. Deleting the home on removal is a follow-up.
24. **Pre-existing, unrelated.** `npm run verify:renderer-events` reports one uncovered
    channel, `local-ai-guard:status-delta`, from an unmodified committed file.

---

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Keychain service-name drift (trailing slash, tilde, NFC) makes a profile look logged out | Single resolver, realpath'd, pinned vectors in CI, binding check compares `configDirectory` |
| Two Codex processes refresh the same `auth.json` → `refresh_token_reused` | Pre-existing (shared `~/.codex` today); refresh is rare (8-day cadence or 5 min before expiry); one lineage per profile; never restore backups; documented in Doctor |
| `codex login` in a populated home revokes it | Launcher refuses; UI says remove-and-re-add |
| Symlinked `projects/` not honoured by Claude Code | Livetest 3; `replay` fallback already exists |
| Fresh config dir triggers onboarding in `-p` | Livetest 2; seed `.claude.json` |
| Usage endpoint budget shared per account | Cadence divided by profile count; passive telemetry preferred |
| Per-request alternation looks like relay traffic | Stay-put policy, switch cooldown, per-turn cap, no round-robin |
| Codex profiles in the same workspace share a limit | Doctor warns when `accountId` repeats |
| Automatic handoff sends conversation context through another account | Pools require the ownership acknowledgement; `ask` mode available |
| Existing resume cursors invalidated by a fingerprint change | Segment appended only when non-empty, pinned vector test |
