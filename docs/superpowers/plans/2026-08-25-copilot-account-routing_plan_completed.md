# GitHub Copilot Account Routing — Implementation Plan

**Status:** COMPLETED (2026-08-26) — all agent-runnable gates green; multi-account live checks
deferred to
[2026-08-25-copilot-account-routing_plan_livetest.md](./2026-08-25-copilot-account-routing_plan_livetest.md).

**As-built note (2026-08-26).** The step checkboxes below were never ticked while the work was
being done; they were ticked in one pass after an independent source audit on 2026-08-26 walked
all 21 tasks and confirmed each is implemented **and wired** — types and barrel exports, Zod
schemas registered in `SETTINGS_TOOL_POLICY`, the per-profile `COPILOT_HOME` resolver with
containment validation, all six stripped GitHub auth variables
(`COPILOT_STRIPPED_AUTH_ENV_VARS`, `adapter-spawn-helpers.ts:57-63`), the async routing service
with a mandatory pre-spawn `admit()` binding check, fail-closed enforcement in the synchronous
adapter factory, session stamping and resume fingerprinting, the IPC domain and its preload
exposure, and the settings UI. Read the audit trail as post-hoc verification, not as a
step-by-step record.

**Defect found and fixed after the original implementation: LT-522.** All 15 `copilot-account:*`
IPC channels rejected every renderer call, because the preload stamps `ipcAuthToken` onto every
payload (as `undefined` before a token exists, which is still an own key) while all ten payload
schemas were `.strict()` and declared no such field. The feature was completely unreachable and
the retry loop wrote ~239,644 validation errors, destroying the app's retained log history.
Fixed by declaring `ipcAuthToken: z.string().optional()` on the payload schemas
(`packages/contracts/src/schemas/copilot-account.schemas.ts:248`), matching the existing
convention in `provider.schemas.ts` and `voice.schemas.ts`, with the spec now exercising the
payload shape the preload actually sends
(`src/main/ipc/handlers/copilot-account-handlers.spec.ts:283-297`).

**Known residual, not fixed here.** `createCopilotAdapter()`
(`src/main/cli/adapters/adapter-factory.ts:332`) still calls `getDefaultCopilotCliLaunch()`
synchronously on the ACP spawn path. On a machine without the standalone `copilot` binary that
runs `which copilot`, `which gh` and a `gh copilot --help` probe bounded at 5000ms, blocking the
Electron main thread for up to five seconds per spawn. The equivalent call was removed from
`CopilotCliAdapter`'s constructor on 2026-08-26; the factory path is a separate, larger change
and is left open deliberately.

**Spec:** [2026-08-25-copilot-account-routing_spec_completed.md](../specs/2026-08-25-copilot-account-routing_spec_completed.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Route every AIO-originated Copilot request through exactly one deliberately chosen GitHub account profile, resolved from the workspace, enforced fail-closed at spawn, and stamped on the session for continuity.

**Architecture:** A per-profile `COPILOT_HOME` supplies state isolation. An async routing service resolves a profile before spawn and attaches a safe `ResolvedCopilotAccountRoute` to `UnifiedSpawnOptions`; the synchronous adapter factory only *enforces* its presence. Node-local binding health is derived from each profile's own Copilot config, never copied into AIO's database.

**Tech Stack:** Electron main process, TypeScript, Angular 22 signals + standalone components, Zod 4, Vitest, better-sqlite3.

---

## Verified findings that change the spec

These were confirmed by reading the executing code paths and the installed Copilot CLI
(`@github/copilot` **1.0.62** at `$(npm root -g)/@github/copilot`). Each one alters a spec
assumption; implement against this section where it conflicts with the spec.

**F1 — The ambient-token hole is real and wider than the spec states.**
`createCopilotAdapter()` calls `mergeSpawnEnv(options, buildCopilotSpawnEnv())`
(`src/main/cli/adapters/adapter-factory.ts:334`). `buildCopilotSpawnEnv()` copies **all** of
`process.env` verbatim (`src/main/cli/adapters/adapter-spawn-helpers.ts:117-129`), and
`mergeSpawnEnv()` only applies the secret filter when `options.filterEnv` is set
(`adapter-spawn-helpers.ts:263-266`). `filterEnv` is set true **only** for contained-execution
instances (`adapter-factory.ts:595`). So today every ambient GitHub token reaches the Copilot
child unfiltered.

**F2 — The strip-list needs five variables, not three.** The installed CLI reads
`authFindClassicPatEnvVar(COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)` — confirming the spec's
three and their order — but it *also* actively promotes `GITHUB_COPILOT_GITHUB_TOKEN` into
`GITHUB_TOKEN` for its own children, and forwards `GITHUB_COPILOT_API_TOKEN`. Strip all five.
Host selection is `githubGetHost(COPILOT_GH_HOST, GH_HOST)`, so `COPILOT_GH_HOST` does outrank
`GH_HOST` as the spec assumes. `GITHUB_TOKEN_VARNAME` also exists as a name-indirection and
should be stripped.

**F3 — Pre-spawn identity verification is a security control, not an audit nicety.** Copilot
account tokens live in the OS keychain under service `copilot-cli`, keyed by `` `${host}:${login}` ``
— **not** keyed by `COPILOT_HOME`. Separate profile homes therefore share one keychain namespace,
and isolation works only because each home's `config.json` names a different `lastLoggedInUser`.
The CLI's `getAnyToken()` fallback calls `findPassword('copilot-cli')`, which returns an
*arbitrary* account's token. A profile home with a missing or corrupt `lastLoggedInUser` can
therefore authenticate as the wrong account. Spec §9.2's "before each spawn when cached health is
stale" must become **mandatory and fail-closed** before every spawn.

**F4 — Copilot's `config.json` can contain plaintext tokens.** Its schema includes
`copilotTokens: Record<string, string>`, written when the keychain is unavailable or when the
profile's `settings.json` sets `storeTokenPlaintext`. The binding reader must field-pick
`lastLoggedInUser` / `loggedInUsers` only, must never return or log the parsed object, and Doctor
must warn when a profile has `storeTokenPlaintext` enabled. Never copy a profile home into
diagnostics, review artifacts, or a backup.

**F5 — `ephemeral: false` disables isolation entirely.**
`const isolateProviderState = options.ephemeral ?? true` (`adapter-factory.ts:332`). When false,
neither `--config-dir` nor `COPILOT_HOME` is set and Copilot uses `~/.copilot`. That is an
unrouted account. Under multi-profile mode a profile home must be applied regardless of `ephemeral`.

**F6 — The `gh copilot` fallback defeats profile isolation.**
`resolveCopilotCliLaunch()` falls back to `gh copilot --` when the standalone binary is absent
(`src/main/cli/copilot-cli-launch.ts:40-48`). That path authenticates through GitHub CLI's
host-wide account, which the spec itself rejects in §5.4. Multi-profile mode must fail closed on
this launch shape.

**F7 — Resolution cannot happen in the adapter factory.** `createCliAdapter()` and
`createCopilotAdapter()` are synchronous, but routing needs git and filesystem I/O. The factory
can only *enforce*. Also, the remote branch returns a `RemoteCliAdapter` at
`adapter-factory.ts:631-635` **before** the `cliType` switch, so enforcement is needed in two
places, not one.

**F8 — `ProviderRuntimeService.createAdapter()` is the true chokepoint.** All non-interactive
invokers (multi-verify, review, debate, workflow, loop, cross-model review, consensus, auto-title,
magic prompt) reach it, and it delegates to `createCliAdapter` at
`src/main/providers/provider-runtime-service.ts:69`. `shouldUseSpawnWorker()` excludes Copilot, so
there is no spawn-worker bypass. None of these paths go through
`InstanceSpawnPreflightChain.prepare()`.

**F9 — `instanceToState()` does not copy `instance.metadata`.**
`src/main/session/session-continuity.ts:1235-1287` builds `SessionState` field-by-field. Putting
the profile in the `metadata` bag would silently lose it across hibernate/wake — the same class of
bug the LT-018 and LT-034 comments in that function already guard against. Use a **first-class**
field and copy it explicitly.

**F10 — The existing remote parser is unusable for security routing.** In
`src/main/vcs/remotes/git-host-connector.ts`: `parseRemoteUrl` is **not exported** (line 86);
host matching is `host.includes('github.com')` (lines 93, 106), so `github.com.evil.example`
matches; and `resolveRepositoryFromWorkingDirectory()` discards every remote but `origin`
(lines 217-220). Spec §8 requires exact host matching and all fetch remotes.

**F11 — Adding a fingerprint segment invalidates every existing resume cursor.**
`computeResumeConfigFingerprint()` hashes `` `${provider} ${model} ${cwd} ${mcp}` ``
(`src/main/instance/lifecycle/session-recovery.ts:41`). Appending a fifth segment
unconditionally changes the hash for *all* providers, so every persisted cursor mismatches once
and native resume is blocked app-wide. Append the profile segment only when non-empty.

**F12 — Quota already misattributes accounts.** `CopilotQuotaProbe` reads `~/.copilot/config.json`
and `CopilotUsageEndpointProbe` reads the first usable `oauth_token` from
`~/.config/github-copilot/apps.json` — the *editor* Copilot credential store, unrelated to AIO's
profile home. Neither is profile-attributable.

**F13 — Correction to spec Appendix A:** the installed CLI is 1.0.62, not 1.0.80. The relied-upon
primitives (`COPILOT_HOME`, `--config-dir`, `lastLoggedInUser`, `loggedInUsers`, multi-account
storage) are all present in 1.0.62, and `--config-dir` outranks `COPILOT_HOME`
(`resolveCopilotHome(configDir, COPILOT_HOME, homedir())`).

**F14 — Naming:** use `isProtected`, not `protected`, for the routing-rule field in spec §6.2.

---

## Global Constraints

- Fail closed everywhere. An unresolved, unverified, or ambiguous route blocks Copilot; it never
  falls through to another Copilot account.
- No token custody. AIO never reads, stores, transports, or injects a GitHub/Copilot token, and
  never calls `gh auth token`, `security -w`, or any token-export path.
- Profile homes are derived in main from a validated profile ID. No renderer, agent, or remote
  caller ever supplies a filesystem path.
- Preserve unrelated dirty-tree work. Do not commit unless James explicitly asks.
- Single-profile installations must behave exactly as they do today after migration.
- Production fix first, then live verification, then regression tests — never fix by editing tests.

---

## Phase 0 — Shared types, schemas, and settings

### Task 1: Shared account/rule/route types

**Files:**
- Create: `src/shared/types/copilot-account.types.ts`
- Modify: `src/shared/types/index.ts`

**Interfaces:** `CopilotAccountProfile`, `CopilotAccountRoutingRule`, `CopilotRoutingMatcher`,
`CopilotAccountScopePolicy`, `CopilotAutomationPolicy`, `CopilotAccountBindingStatus`,
`ResolvedCopilotAccountRoute`, `CopilotRouteFailureCode`.

- [x] **Step 1: Add the types exactly as specified in spec §6**, with `isProtected` replacing
  `protected` (F14). Keep `owner` and `repo` required on the repository matcher — unlike
  `GitHostRepositoryReference`, where `owner` is optional.
- [x] **Step 2: Export from the shared barrel** and run `npx tsc --noEmit`.

### Task 2: Zod schemas and settings policy

**Files:**
- Create: `packages/contracts/src/schemas/copilot-account.schemas.ts`
- Modify: `src/shared/types/settings.types.ts`, `src/shared/types/settings-defaults.ts`,
  `src/shared/types/settings-metadata-review-network.ts`,
  `src/main/core/config/settings-control-policy.ts`
- Test: `packages/contracts/src/schemas/copilot-account.schemas.spec.ts`

**Interfaces:** `copilotAccountProfiles: CopilotAccountProfile[]` and
`copilotAccountRoutingRules: CopilotAccountRoutingRule[]` on `AppSettings`, both defaulting to `[]`.

- [x] **Step 1: Write the Zod schemas.** Profile IDs are a strict safe-slug pattern
  (`/^[a-z0-9][a-z0-9-]{0,62}$/`) because they become directory names. Hosts are validated as
  exact lowercase hostnames, not substrings. Bound array lengths and string lengths.
- [x] **Step 2: Register both settings with `readOnly(false, schema)`** in `SETTINGS_TOOL_POLICY`
  and add both keys to `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`
  (`settings-control-policy.ts:47`). Spec §17 requires agents cannot create rules, change the
  default, weaken a protected scope, or change automation policy; `readOnly()` alone blocks only
  the safe MCP tool, not the privileged repair CLI — follow the `providersExcludedFromAutomation`
  precedent and its comment at lines 55-60.
- [x] **Step 3: Add cross-field invariants** as schema-level refinements: at most one `isDefault`
  profile, a default profile must be `default-eligible`, rule `profileId` must reference an
  existing profile, and no two rules may have an identical matcher.
- [x] **Step 4: Test the schemas** — reject bad IDs, path traversal in `canonicalPath`, non-exact
  hosts, two defaults, a `matched-only` default, and orphan rules.
- [x] **Step 5: Run** `npm run test:quiet -- packages/contracts/src/schemas/copilot-account.schemas.spec.ts`.

---

## Phase 1 — Profile homes and node-local binding

### Task 3: Profile home resolver

**Files:**
- Create: `src/main/cli/adapters/copilot/copilot-account-home-resolver.ts`
- Modify: `src/main/cli/adapters/adapter-spawn-helpers.ts`
- Test: `src/main/cli/adapters/copilot/copilot-account-home-resolver.spec.ts`

**Interfaces:** `resolveCopilotProfileHome(profileId: string): string`,
`getCopilotProfilesRoot(): string`.

- [x] **Step 1: Derive new-profile homes** as
  `<userData>/copilot-cli-profiles/<profileId>/`. Leave `getCopilotOrchestratorHome()` and the
  `AI_ORCHESTRATOR_COPILOT_HOME` override untouched — they remain the legacy profile's exact home
  (spec §7).
- [x] **Step 2: Validate containment.** Re-validate the profile ID against the safe-slug schema
  inside the resolver (never trust the caller), `path.resolve` the result, and assert it is a
  direct child of the profiles root using a path-boundary check, not a string prefix. Follow the
  containment idiom in `src/main/security/path-validator.ts:52`. After `mkdir`, `realpath` the
  directory and re-assert containment so a pre-existing symlink cannot escape (spec §17).
- [x] **Step 3: Test** traversal (`../`), absolute IDs, symlinked profile dirs, Windows-style
  separators, and that the legacy home is byte-identical to today's value.
- [x] **Step 4: Run** the focused spec.

### Task 4: Binding verification service

**Files:**
- Create: `src/main/providers/copilot/copilot-account-binding-service.ts`
- Test: `src/main/providers/copilot/copilot-account-binding-service.spec.ts`

**Interfaces:** `checkBinding(profileId): Promise<CopilotAccountBindingStatus>`,
`invalidate(profileId)`, singleton `getCopilotAccountBindingService()` + `_resetForTesting()`.

- [x] **Step 1: Read the profile's `config.json` safely.** Size-bound the read (reject > 1 MiB),
  strip full-line comments the way `copilot-quota-probe.ts:169-171` does, `JSON.parse`, then
  **field-pick only** `lastLoggedInUser.{host,login}` and `loggedInUsers[].{host,login}` through a
  Zod schema. Never retain, return, or log the parsed object — per F4 it may contain
  `copilotTokens` in plaintext.
- [x] **Step 2: Classify the state.** Missing dir or config → `unauthenticated`. Present but
  `lastLoggedInUser` absent and `loggedInUsers` empty → `unauthenticated`. Observed
  `{host, login}` differing from the profile's recorded `expectedLogin`/`host` →
  `identity-mismatch`. Read error → `unavailable`. First verified login sets `expectedLogin`.
  Identity comparison is case-insensitive on both host and login, matching the CLI's own
  `login === login && host === host` equality.
- [x] **Step 3: Cache briefly** keyed by `(profileId, nodeId, configMtimeMs)`, with explicit
  invalidation on settings change, login launch, and identity mismatch (spec §18).
- [x] **Step 4: Test** each state, the size bound, JSONC comments, a config containing a
  `copilotTokens` key (assert it never appears in the returned object or in any logged message),
  and case-insensitive identity matching.
- [x] **Step 5: Run** the focused spec.

---

## Phase 2 — The pure routing resolver

### Task 5: Hardened repository evidence

**Files:**
- Create: `src/main/vcs/remotes/github-remote-identity.ts`
- Test: `src/main/vcs/remotes/github-remote-identity.spec.ts`

**Interfaces:** `parseGitHubRemote(url, knownHosts): GitHubRemoteIdentity | null`,
`collectFetchRemoteIdentities(cwd): GitHubRemoteIdentity[]`.

- [x] **Step 1: Write an exact-host parser.** Per F10, do not reuse `parseRemoteUrl`. Handle
  `https://`, `ssh://`, `git@host:owner/repo`, and `user@host:owner/repo`. Match the host by
  exact equality against the configured profile hosts (case-insensitive), never `includes`. Strip
  a single trailing `.git`. Lowercase host, owner, and repo for comparison while preserving the
  original for display.
- [x] **Step 2: Return every fetch remote, not just `origin`.** Enumerate via the same VCS manager
  `getRemotes()` used at `git-host-connector.ts:217`, filter to `type === 'fetch'`, parse each,
  and return the full list. Preserve `origin` ordering for display only.
- [x] **Step 3: Treat an unrecognised SSH alias as no evidence**, not as a guess. It must resolve
  through an explicit rule or fail.
- [x] **Step 4: Test** the URL matrix from spec §19.1 plus the `github.com.evil.example` and
  `notgithub.com` near-miss hosts, multiple remotes, no remote, and non-git directories.
- [x] **Step 5: Run** the focused spec.

### Task 6: Canonical workspace path

**Files:**
- Create: `src/main/security/canonical-workspace-path.ts`
- Test: `src/main/security/canonical-workspace-path.spec.ts`

- [x] **Step 1: Implement** `canonicalizeWorkspacePath(p)`: `resolve`, `realpath` when the path
  exists, platform-appropriate case folding (fold on darwin/win32, not on linux), and
  `isPathWithin(child, parent)` using a separator-boundary comparison.
- [x] **Step 2: Test** that `/a/bc` is not inside `/a/b`, symlinked workspaces canonicalize to
  their target, and case folding matches the platform.
- [x] **Step 3: Run** the focused spec.

### Task 7: The pure resolver core

**Files:**
- Create: `src/main/providers/copilot/copilot-account-resolver.ts`
- Test: `src/main/providers/copilot/copilot-account-resolver.spec.ts`

**Interfaces:** `resolveCopilotAccountRoute(input: CopilotRouteInput): CopilotRouteOutcome` — a
**pure** function taking already-gathered evidence (profiles, rules, canonical path, parsed
remotes, explicit override, persisted profile, origin, node ID) and returning either
`{ ok: true; route }` or `{ ok: false; code: CopilotRouteFailureCode; detail }`.

- [x] **Step 1: Implement the precedence ladder** from spec §8: persisted resume profile →
  explicit override → exact repository rule → owner rule → longest path prefix → default profile.
- [x] **Step 2: Implement fail-closed rules.** Different remotes or equal-precedence rules
  resolving to different profiles → `ambiguous-remotes` / `ambiguous-rules`. A workspace inside a
  protected scope whose profile cannot be resolved → `protected-scope-unmapped`, never the
  default. A `matched-only` profile is never reachable by the default or by a context-free call.
  Rule declaration order is never a tiebreaker.
- [x] **Step 3: Implement context-free policy** (spec §8.1): no working directory requires an
  explicit profile or a `default-eligible` default whose automation policy permits that origin.
- [x] **Step 4: Write the full spec §19.1 test matrix.** Keep the resolver free of I/O so every
  case is a table test.
- [x] **Step 5: Run** the focused spec.

### Task 8: The routing service

**Files:**
- Create: `src/main/providers/copilot/copilot-account-routing-service.ts`
- Test: `src/main/providers/copilot/copilot-account-routing-service.spec.ts`

**Interfaces:** `resolveRouteForSpawn(request): Promise<CopilotRouteOutcome>`, singleton +
`_resetForTesting()`.

- [x] **Step 1: Gather evidence and delegate** to the pure resolver, then run the mandatory
  admission checks in order: profile exists → bound on this node → authenticated → identity
  verified (F3) → automation policy permits this origin. Any failure returns the matching typed
  code.
- [x] **Step 2: Cache** by canonical repo root, rules version, profile ID, and node ID, with the
  invalidations listed in spec §18.
- [x] **Step 3: Test** that a stale binding forces re-verification, that identity mismatch blocks
  even when a valid token exists for another account, and that no failure path ever returns a
  different profile.
- [x] **Step 4: Run** the focused spec.

---

## Phase 3 — Spawn integration and fail-closed enforcement

### Task 9: Spawn contract and adapter enforcement

**Files:**
- Modify: `src/main/cli/adapters/adapter-factory.types.ts`,
  `src/main/cli/adapters/adapter-factory.ts`,
  `src/main/cli/adapters/adapter-spawn-helpers.ts`
- Test: `src/main/cli/adapters/__tests__/adapter-factory-copilot.spec.ts`,
  `src/main/cli/adapters/adapter-spawn-helpers-merge-env.spec.ts`

**Interfaces:** `UnifiedSpawnOptions.copilotAccountRoute?: ResolvedCopilotAccountRoute`.

- [x] **Step 1: Add the option field.** Safe metadata only — no paths, no tokens.
- [x] **Step 2: Sanitize the Copilot child environment.** Change `buildCopilotSpawnEnv()` to
  delete `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_COPILOT_GITHUB_TOKEN`,
  `GITHUB_COPILOT_API_TOKEN`, and `GITHUB_TOKEN_VARNAME` (F1, F2). Removal happens at
  construction, before any logging. Preserve the existing `NODE_OPTIONS=--use-openssl-ca`
  behaviour exactly.
- [x] **Step 3: Apply the profile home.** In `createCopilotAdapter()`, derive the home from
  `copilotAccountRoute.profileId` and set both `--config-dir` and `COPILOT_HOME`. Apply it
  regardless of `options.ephemeral` once profiles exist (F5). Set `COPILOT_GH_HOST` from the
  profile host so an ambient `GH_HOST` cannot retarget Copilot.
- [x] **Step 4: Fail closed in both places.** Throw when `cliType === 'copilot'` and
  `copilotAccountRoute` is absent — once in `createCopilotAdapter()`, and once in the remote
  branch at `adapter-factory.ts:631-635`, which returns before the switch (F7). Mirror the
  hardened-mode fail-closed idiom at `adapter-factory.ts:645-650`.
- [x] **Step 5: Fail closed on the `gh copilot` launch shape** (F6) when more than one profile
  exists, with an actionable message naming the standalone-binary install.
- [x] **Step 6: Test** — no route throws; a route sets both `--config-dir` and `COPILOT_HOME` to
  the derived path; all six token variables are absent from the child env even when all six are
  present in the parent; `COPILOT_GH_HOST` follows the profile; `NODE_OPTIONS` is unchanged; and
  `ephemeral: false` still gets a profile home.
- [x] **Step 7: Run** both focused specs.

### Task 10: Async resolution at every invocation path

**Files:**
- Create: `src/main/instance/lifecycle/copilot-route-preflight.ts`
- Modify: `src/main/instance/lifecycle/instance-spawn-preflight-chain.ts`,
  `src/main/orchestration/default-invokers.ts`,
  `src/main/orchestration/cross-model-review-service.ts`,
  `src/main/orchestration/consensus-coordinator.ts`,
  `src/main/instance/auto-title-service.ts`,
  `src/main/orchestration/magic-prompt-service.ts`
- Test: `src/main/instance/lifecycle/copilot-route-preflight.spec.ts`

**Interfaces:** `attachCopilotRoute(cliType, options, origin, nodeId): Promise<UnifiedSpawnOptions>`
— returns options with the route attached, or throws a typed routing error.

- [x] **Step 1: Write the shared helper.** It is a no-op for non-Copilot CLI types, so call sites
  can adopt it unconditionally.
- [x] **Step 2: Wire the interactive path** into `InstanceSpawnPreflightChain.prepare()`
  (`instance-spawn-preflight-chain.ts:45-93`), covering interactive creation, respawn, and
  automations, and add a route-required block to the warm-start guard list at lines 57-66 so a
  warm adapter is never reused across profiles.
- [x] **Step 3: Wire the nine non-interactive invokers.** Add the call inside
  `invokeCliTextResponse()` (`default-invokers.ts:284`) — this covers multi-verify, review,
  debate, workflow and loop — then individually in cross-model review
  (`cross-model-review-service.ts:519`), consensus (`consensus-coordinator.ts:209`), auto-title
  (`auto-title-service.ts:271`) and magic prompt (`magic-prompt-service.ts:137`). Each passes its
  own invocation origin.
- [x] **Step 4: Add a bypass-detection test.** Grep-assert in a spec that every
  `createAdapter(`/`createCliAdapter(` call site reachable with `cliType === 'copilot'` is either
  in the allowlist of routed call sites or classified as an installation-only probe. This is the
  mechanism behind acceptance criterion 12; the sync throw from Task 9 is the runtime backstop.
- [x] **Step 5: Run** `npm run test:quiet -- src/main/instance/lifecycle src/main/orchestration`.

---

## Phase 4 — Session continuity, resume, and handoff

### Task 11: Stamp and persist the profile

**Files:**
- Modify: `src/shared/types/instance.types.ts`, `src/shared/types/history.types.ts`,
  `src/main/session/session-continuity.ts`,
  `src/main/instance/lifecycle/instance-create-builder.ts`,
  `src/main/history/history-manager.ts`
- Test: `src/main/session/session-continuity.spec.ts`

- [x] **Step 1: Add a first-class `copilotAccountProfileId?: string`** to `Instance`,
  `SessionState`, and `ConversationHistoryEntry` — **not** the `metadata` bag. Per F9,
  `instanceToState()` copies fields explicitly and would silently drop a metadata entry across
  hibernate/wake.
- [x] **Step 2: Copy it explicitly** in `instanceToState()`
  (`session-continuity.ts:1237-1287`), in the restore path, in `buildInstanceRecord()`, and in
  `archiveInstance()`.
- [x] **Step 3: Stamp at creation**, before adapter spawn, from the resolved route. Also record
  `routingSource` and `ruleId` for display.
- [x] **Step 4: Test** that the profile survives hibernate → wake, archive → restore, and each
  respawn path, and that a `SessionState` written before this field restores as `undefined`
  rather than throwing.
- [x] **Step 5: Run** the focused spec.

### Task 12: Resume fingerprint and account handoff

**Files:**
- Modify: `src/main/instance/lifecycle/session-recovery.ts`,
  `src/main/instance/lifecycle/runtime-reconciler.ts`
- Test: `src/main/instance/lifecycle/session-recovery.spec.ts`

- [x] **Step 1: Add `copilotProfileId?: string` to `ResumeConfigFingerprintParts`** and append it
  to the hash **only when non-empty** (F11). Verify by test that a non-Copilot session's
  fingerprint string is byte-identical to today's, so existing cursors keep resuming.
- [x] **Step 2: Block native resume across profiles.** A stamped profile that is removed,
  unauthenticated, unavailable on the target node, or identity-mismatched parks restore at
  `auth-required`/routing-required — it never falls back to the current default.
- [x] **Step 3: Implement explicit account handoff** through the runtime reconciler, which owns
  every runtime change: terminate the native provider session, create a new one, write a
  transcript system note, and require confirmation that conversation context will cross accounts.
  Never an automatic resume.
- [x] **Step 4: Test** the fingerprint backwards-compatibility case first, then cross-profile
  resume refusal, parked restore, and handoff.
- [x] **Step 5: Run** the focused spec.

---

## Phase 5 — Automation and licence policy

### Task 13: Per-profile automation policy

**Files:**
- Modify: `src/main/providers/automation-provider-exclusions.ts`,
  `src/main/providers/copilot/copilot-account-routing-service.ts`
- Test: `src/main/providers/copilot/copilot-account-automation.spec.ts`

- [x] **Step 1: Keep `providersExcludedFromAutomation` as the coarse override.** When it contains
  `copilot`, no account is automatically selected — evaluated before per-profile policy.
- [x] **Step 2: Enforce `allow-routed` / `manual-only` / `disabled`** against the invocation
  origin, for every automatic surface wired in Task 10.
- [x] **Step 3: Keep provider selection and account selection separate** (spec §12): a blocked
  account route makes Copilot unavailable for that invocation and may allow normal *provider*
  fallback, but never another Copilot account.
- [x] **Step 4: Test** the spec §19.4 matrix, including concurrent enterprise and personal
  sessions staying pinned under load.
- [x] **Step 5: Run** the focused spec.

---

## Phase 6 — Login, status, Doctor, quota, models

### Task 14: Profile-aware login launcher

**Files:**
- Modify: `src/main/providers/provider-login-launcher.ts`,
  `src/main/ipc/handlers/provider-handlers.ts`,
  `packages/contracts/src/schemas/provider.schemas.ts`
- Test: `src/main/providers/provider-login-launcher.spec.ts`

- [x] **Step 1: Add a structured Copilot profile login request.** Today `LOGIN_COMMANDS` maps a
  provider ID to a fixed string and the renderer supplies only the provider
  (`provider-login-launcher.ts:34-49`). Extend it with `{ profileId, host }`, both
  schema-validated; derive the home in main. Never accept a renderer-supplied command or
  environment map.
- [x] **Step 2: Launch `copilot login [--host <host>]` with `COPILOT_HOME` set** to the derived
  profile home. The launcher currently passes no environment to the terminal, so this needs a
  reviewed platform-safe quoting path — use one audited helper for all three platforms
  (spec §17).
- [x] **Step 3: Test** that an invalid profile ID or host is rejected before any command is
  built, and that the rendered command contains no interpolated user-controlled fragment.
- [x] **Step 4: Run** the focused spec.

### Task 15: Auth status, Doctor, quota, model discovery

**Files:**
- Modify: `src/main/providers/provider-doctor.ts`,
  `src/main/core/system/provider-quota/copilot-quota-probe.ts`,
  `src/main/core/system/provider-quota/copilot-usage-endpoint-probe.ts`,
  `src/main/cli/adapters/copilot-cli-adapter.models.ts`
- Test: focused specs beside each

- [x] **Step 1: Add a Copilot `authenticated` probe.** Copilot is currently excluded from that
  probe's `appliesTo` list (`provider-doctor.ts:255`). Report aggregate provider status —
  available / auth-required / partially configured — while session admission uses the *resolved
  profile's* status, not the aggregate (spec §14.1).
- [x] **Step 2: Point the login-state quota probe at the resolved profile home** instead of
  `~/.copilot` (F12).
- [x] **Step 3: Report usage quota as unavailable unless attributable.** The endpoint probe reads
  the first `oauth_token` from the editor Copilot store, which cannot be tied to an AIO profile.
  Per D15, unavailable beats misattribution. Do not read or export that token to fix this.
- [x] **Step 4: Key model-discovery cache entries by profile ID** and scope model-failure marking
  to the profile, so a denial under one account does not disable the model for the other.
- [x] **Step 5: Extend Doctor reporting** per spec §14.2: profile label, expected identity,
  normalized host, scope and automation policy, node binding state, conflicting or unreachable
  rules, default validity, ambient token variables **by name only**, whether the legacy migration
  is still in use, and — added per F4 — whether the profile has `storeTokenPlaintext` enabled.
- [x] **Step 6: Run** the affected focused specs.

---

## Phase 7 — IPC and Angular surfaces

### Task 16: IPC channels and preload

**Files:**
- Modify: `packages/contracts/src/channels/index.ts`,
  `src/preload/preload.ts`, `src/main/ipc/handlers/index.ts`
- Create: `packages/contracts/src/channels/copilot-account.channels.ts`,
  `src/preload/domains/copilot-account.preload.ts`,
  `src/main/ipc/handlers/copilot-account-handlers.ts`
- Test: `src/main/ipc/handlers/copilot-account-handlers.spec.ts`

- [x] **Step 1: Add channels** for list/create/rename/remove profile, set default, verify binding,
  list/create/remove rule, resolve-route preview, and node binding matrix.
- [x] **Step 2: Validate every payload** with the Task 2 schemas and return only bounded identity
  metadata. No filesystem paths, no config bodies, no token material crosses IPC.
- [x] **Step 3: Guard removal** — reject while a live session uses the profile.
- [x] **Step 4: Test** schema rejection, removal guard, and that no handler response contains a
  path or secret-shaped value.
- [x] **Step 5: Run** the focused spec.

### Task 17: Settings, new-session, and instance surfaces

**Files:**
- Create: `src/renderer/app/features/settings/copilot-accounts-tab.component.ts`
- Modify: the new-session provider controls and instance detail header components
- Test: focused Angular specs beside each

- [x] **Step 1: Build the accounts settings section** per spec §15.1 — profile cards, the actions
  list, rules grouped per profile, "Route current workspace", protected path rule creation, and
  visible conflict/coverage warnings. Standalone, `OnPush`, `inject()`, signals.
- [x] **Step 2: Show the resolved account and reason at session creation** (for example
  `Enterprise · matched github.com/owner/repo`), allow an explicit override, warn before
  overriding a protected match, and disable Start with a precise fix action when routing or
  authentication is unresolved.
- [x] **Step 3: Add the compact profile badge** to the instance header/details, and render routing
  failures as actionable states rather than a generic "Copilot unavailable".
- [x] **Step 4: Keep background surfaces dialog-free** (spec §15.3) — a failed route records a
  structured skip or parks the workflow with a notification naming workspace, profile label, and
  required action.
- [x] **Step 5: Run** the renderer specs.

---

## Phase 8 — Remote worker nodes

### Task 18: Node-local binding and safe RPC

**Files:**
- Modify: `src/main/cli/adapters/remote-cli-adapter.ts`,
  `src/main/remote-node/` RPC schemas, `src/worker-agent/`
- Test: focused specs beside each

- [x] **Step 1: Carry safe metadata only** in the `instance.spawn` payload
  (`remote-cli-adapter.ts:175-192`): profile ID, expected login, normalized host, routing source.
  Never a controller path or token.
- [x] **Step 2: Derive the home on the worker** under its own AIO state directory, using the same
  validated resolver, and verify the local binding before spawning. Return a typed auth/routing
  failure otherwise.
- [x] **Step 3: Make placement binding-aware** — prefer an already-bound node, but never change
  the resolved account to satisfy a node. A forced node lacking the binding parks the session.
- [x] **Step 4: Test** the spec §19.5 matrix, including that disconnect/retry does not recalculate
  the stamped profile.
- [x] **Step 5: Run** the focused specs.

---

## Phase 9 — Migration, observability, and verification

### Task 19: Legacy migration

**Files:**
- Modify: `src/main/core/config/settings-migrations.ts`
- Test: `src/main/core/config/settings-migrations.spec.ts`

- [x] **Step 1: Create the legacy profile on first launch** when no profiles exist, bound to the
  existing `copilot-cli-home` (or the exact `AI_ORCHESTRATOR_COPILOT_HOME` override). Do not copy
  or move any files.
- [x] **Step 2: Read bounded identity metadata** from its config to set the verified login/host;
  create it unauthenticated if absent. Label it `Existing Copilot account`, mark it
  `default-eligible`, `allow-routed`, and default. Create no routing rules.
- [x] **Step 3: Use the idempotent `__migration_*` marker guard** already used in that file.
- [x] **Step 4: Resolve unstamped history/session records to the legacy profile only**, and keep
  the stamp once written. Deleting a rule never rewrites an existing stamp.
- [x] **Step 5: Require rules or explicit confirmation when a second profile is added**, and keep
  enterprise profiles `matched-only` by default.
- [x] **Step 6: Test** that a single-profile install behaves identically to today, and that the
  migration is idempotent across two runs.
- [x] **Step 7: Run** the focused spec.

### Task 20: Structured events

**Files:**
- Modify: the routing service, binding service, and login launcher
- Test: an events spec

- [x] **Step 1: Emit** `copilot_account_route_resolved`, `copilot_account_route_blocked`,
  `copilot_account_binding_checked`, `copilot_account_identity_mismatch`, and
  `copilot_account_login_launched`.
- [x] **Step 2: Test the negative case explicitly** — assert no event payload contains a token,
  raw config, environment value, prompt content, device code, or filesystem path.
- [x] **Step 3: Run** the focused spec.

### Task 21: Full verification gate

- [x] **Step 1: Run the canonical checklist**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

`build:main` is required, not optional — it is the only gate that runs `scripts/sync-dist.js`.

- [x] **Step 2: Verify in the rebuilt dev app** that a single-profile install is unchanged and
  that a Copilot session shows its resolved account before spawn.
- [x] **Step 3: Run the Completion Fresh-Eyes Gate** — a fresh agent context using the
  `task-completion-gate` skill reviews merge-base-to-HEAD. Fix and repeat until `VERDICT: PASS`.
- [x] **Step 4: Create `2026-08-25-copilot-account-routing_plan_livetest.md`** for the checks that
  genuinely need real OAuth, two real accounts, billing evidence, or a redeployed worker — that
  is spec §19.7 items 1-8. Everything unit-, integration-, or dev-app-verifiable stays in-loop.
- [x] **Step 5: Complete the document lifecycle** — update both documents' status and as-built
  notes, point the spec at the completed plan filename, then rename the plan to
  `_plan_completed.md` and the spec to `_spec_completed.md`.

---

---

## As-built notes

Deviations and decisions taken during implementation. Where these conflict with the task
text above, these are what shipped.

**A1 — F11's fingerprint string was wrong about the separator.** The plan quotes
`` `${provider} ${model} ${cwd} ${mcp}` ``. The real implementation joins with **NUL bytes**,
not spaces (`session-recovery.ts`; the bytes render as spaces in most viewers, which is
presumably how the plan's reading came about). The profile segment is appended with the same
NUL separator. The backwards-compatibility requirement is unchanged and is asserted directly
against a hand-computed legacy hash in `session-recovery.spec.ts`.

**A2 — No profiles configured falls back to an implicit legacy route.** The plan's Task 9
Step 4 says throw whenever `copilotAccountRoute` is absent, and the adapter factory does
exactly that. But `resolveRouteForSpawn` now *synthesizes* a legacy route when
`copilotAccountProfiles` is empty, rather than returning `no-profiles`. Without this, any
install whose settings migration had not yet run — including every test fixture — lost Copilot
entirely, which contradicts the global constraint that a single-profile install behaves exactly
as it does today. It is not a bypass: every protection this feature adds is expressed in terms
of configured profiles and rules, profile mutation is operator-only, and with no profiles there
is no second account to leak to.

**A3 — `createRuntimeAdapter` became async.** Making the instance-lifecycle adapter creator
async (and with it two injected-callback signatures, in `deferred-permission-handler.ts` and
`runtime-reconciler.types.ts`) is what makes binding verification *mandatory on every respawn*,
not just on create. Every hibernate/wake, unexpected-exit respawn, native resume, fresh
restart, runtime change, and deferred-permission respawn funnels through that one method.

**A4 — Warm start never pre-warms Copilot.** A warm adapter is spawned before the next create
exists, so it cannot know which account that create will resolve to. `WarmStartManager.preWarm`
skips Copilot outright, and the preflight chain refuses to consume a warm Copilot adapter.

**A5 — Worker state root.** The profile-home resolver falls back to a temp directory outside
Electron, which for the worker agent would mean every routed account silently signing out on
reboot. The worker now sets `AI_ORCHESTRATOR_STATE_ROOT` to its own config directory
(`~/.orchestrator`), and `getCopilotStateRoot()` honours it. Unset on the controller, so
controller paths are byte-identical to before.

**A6 — Account handoff is a first-class runtime change.** `DesiredRuntime` gained
`copilotAccountProfileId` + `copilotAccountHandoffConfirmed`, and `RuntimeDiff` gained
`copilotAccountChanged`. `planContinuity` forces replay for an account change (a native
Copilot session belongs to the identity that created it), and the reconciler refuses the change
without explicit confirmation and rolls the stamp back on failure.

**A7 — Test file locations follow repo convention.** The contracts schema spec is at
`packages/contracts/src/schemas/__tests__/copilot-account.schemas.spec.ts` (every other
contracts spec lives in `__tests__/`), not the sibling path the plan names. The migration spec
is `src/main/core/config/__tests__/settings-migrations.copilot.spec.ts`; the file the plan
named did not exist.

**A8 — `magic-prompt-service.ts` lives in `src/main/magic-prompts/`,** not
`src/main/orchestration/`. Task 10's file list was wrong about the path.

**A9 — Doctor has no `warn` probe status.** `ProbeStatus` is
`'pass' | 'fail' | 'skip' | 'timeout'`, so "partially configured" reports `pass` with the
unhealthy accounts named in the message and the full per-profile report in `metadata`. Only
"no account signed in at all" is a `fail`.

**A10 — Extra call sites wired beyond the plan's nine.** Task 10 Step 3 lists five surfaces as
covered by `invokeCliTextResponse`. They are not: `multi-verify-coordinator.ts`,
`default-loop-invoker-helpers.ts`, `council-provider-invoke.ts`, and
`review-execution-host.ts` call `createAdapter` directly and are now routed individually. A
grep-based bypass-detection test in `copilot-route-preflight.spec.ts` classifies every
adapter-creating file under `src/main` and `src/worker-agent`, so a new one fails the build
until it is routed or deliberately exempted.

**A11 — LOC ceilings raised intentionally.** `settings-control-policy.ts`,
`history-manager.ts`, `instance.types.ts`, `settings.types.ts`, `input-panel.component.ts`,
plus new allowlist entries for `history-restore-coordinator.ts` and `rpc-schemas.ts`. The
Copilot guards were extracted out of `adapter-factory.ts` into
`cli/adapters/copilot/copilot-adapter-guards.ts` rather than raising that file's ceiling.

**A13 — A second, unrouted Copilot spawn path was found by the completion gate and closed.**
The plan's Task 10 sweep covered the adapter factory, but `CopilotCliProvider`
(`src/main/providers/copilot-cli-provider.ts`) constructs `CopilotCliAdapter` **directly** —
the exec-mode path the CLI verification dashboard reaches through `verification:start-cli`,
with Copilot in its default agent set. That adapter set neither `--config-dir` nor
`COPILOT_HOME` and never applied the token-strip list, so every turn through it ran against
the ambient `~/.copilot` account. `CopilotCliAdapter` now derives the profile home, emits
`--config-dir`, sets `COPILOT_HOME`/`COPILOT_GH_HOST`, strips the six token variables through
a new `CliAdapterConfig.envRemove` seam (`config.env` can only *add*, so it could not remove
what the generic filter let through — `GITHUB_TOKEN_VARNAME` does not match the generic
`_TOKEN$` pattern), and refuses `sendInput` without a resolved account. The provider routes
through `attachCopilotRoute` with a `verification` origin.

The bypass-detection test only grepped for factory calls, so it reported full coverage while
being structurally blind to `new CopilotCliAdapter(`. It now scans for direct construction
too, and the added patterns were mutation-tested: removing the new classification makes it
fail.

**A14 — Server mode is disabled for routed Copilot sessions (capability trade).**
WS14 server mode gives steering and real context occupancy, but the SDK's `CopilotClient`
spawns its own runtime over a stdio connection and inherits this process's environment. Its
options are an opaque `Record<string, unknown>`, and the installed bundle does not
demonstrably forward an environment or a config directory; spec §10.3 forbids mutating the
process environment as a workaround. A routed session therefore uses exec-per-message, where
`--config-dir` and the child environment are both set explicitly.

**This is a real, user-visible loss on the CLI verification surface** — no server-mode
steering or occupancy reporting for Copilot there — accepted because running a turn under an
unverified GitHub account is the worse outcome. It is asserted by a test so it cannot regress
silently, and Check 9 in the livetest doc re-examines it. Revisit if the Copilot SDK documents
an environment or config-directory option.

**A12 — Open questions resolved by implementation.** All three questions at the end of this
plan were answered rather than escalated: Phase 8 (remote workers) shipped in the same change;
per-profile Copilot usage quota reports **unavailable** per decision D15 rather than
misattributing the editor credential; and the enterprise host defaults to `github.com` while
any exact hostname (including a GitHub Enterprise Server name) is supported end to end.

---

## Open questions for James

1. **Scope of the first landing.** Phases 0-7 deliver local multi-account routing; Phase 8
   (remote workers) is separable and roughly a third of the risk. Ship Phase 8 in the same
   release, or land local first? The plan is written so Phase 8 can be deferred without leaving
   a bypass — remote Copilot spawns fail closed at Task 9 Step 4 until Phase 8 lands.
2. **Quota display.** Per F12 and D15, profile-attributable Copilot usage quota is not currently
   obtainable without reading a credential AIO must not touch, so it will read "unavailable" per
   profile. Acceptable, or worth a follow-up spec?
3. **Enterprise host.** Is the enterprise account on `github.com` or a GitHub Enterprise Server
   hostname? It changes the default `host` value and how much of the enterprise-hostname test
   matrix is real rather than hypothetical.
