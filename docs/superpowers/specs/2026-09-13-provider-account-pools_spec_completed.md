# Provider Account Pools (Claude Code and Codex CLI): Specification

**Status:** IMPLEMENTED (2026-09-15) with the recommended choice for every decision in §15. Live checks are deferred to [2026-09-13-provider-account-pools_livetest.md](../../plans/2026-09-13-provider-account-pools_livetest.md).
**Date:** 2026-09-13
**Owner:** James
**Implementation plan:** [2026-09-13-provider-account-pools_plan_completed.md](../../plans/2026-09-13-provider-account-pools_plan_completed.md)
**Mechanics reference:** [2026-09-13-multi-account-mechanics-research.md](../../research/2026-09-13-multi-account-mechanics-research.md)

> **As built (2026-09-15).** The plan's *As-built notes* are authoritative where they differ
> from this spec. The differences that change a statement here:
> - §2 item 3 and §14: the resume fingerprint is **not** extended with the account profile.
>   Cross-profile native resume through the shared store (D3) and byte-identical existing
>   cursor hashes both depend on it staying as it is.
> - §4 invariant 5: ambient auth variables are stripped on every **routed** spawn, legacy
>   included. Routes are only attached while a pool is active, so a provider with only its
>   legacy profile spawns exactly as before.
> - §10: the collapsed quota chip keeps its provider-level (legacy) figure; the popover lists
>   each pool account under its provider with its own windows and reset times.
> - §7 (2026-09-16 follow-up): `~/.claude.json`'s `mcpServers` key (`claude mcp add
>   --scope user`/local) was not in the original shared-entry list, so pooled Claude accounts
>   started with none of the legacy account's MCP servers configured. `seedClaudeProfileHome`
>   now merges just that key into the profile's own `.claude.json` on every seed — the rest of
>   the file (identity/session state Claude Code owns per-profile) is left untouched. Codex
>   needed no equivalent fix: its per-spawn temp `CODEX_HOME` already mirrors all of
>   `~/.codex/config.toml` (including `[mcp_servers.*]`) and only swaps `auth.json`.

---

## 1. Problem

James may soon pay for more than one Claude subscription and more than one ChatGPT
subscription. When one account hits its 5-hour or weekly limit, Harness should carry on
under another account he owns, seamlessly, and come back to the exhausted one when its
window resets.

Today Harness cannot do this:

- Claude spawns inherit `~/.claude` (`CLAUDE_CONFIG_DIR` is set nowhere in the repo; the
  only mention is a debug read-back in `src/main/core/system/debug-commands.ts:134`), so
  every Claude instance is one identity.
- Codex spawns already get a private temporary `CODEX_HOME` per instance
  (`src/main/cli/adapters/codex/codex-home-manager.ts`), but every one of them symlinks
  `~/.codex/auth.json`, so every Codex instance is also one identity.
- The provider-limit ledger (`src/main/core/system/provider-limit-ledger.ts`) is keyed by
  `(provider, model)`. One exhausted account parks the whole provider and vetoes it as a
  failover target for every instance and loop.
- The quota service (`src/main/core/system/provider-quota-service.ts`) and the quota chip
  are keyed by provider only.
- The `provider-notice.ts` patterns that decide "this turn stopped on a limit" do not
  match Codex's real wording (`You’ve hit your usage limit … try again at 3:45 PM`, with
  U+2019). Verified 2026-09-13: all three Codex variants miss, both Claude variants match.
  Codex limits reach the loop classifier through a looser regex, but the regular-session
  park path can miss them. This is a defect independent of pools and is fixed first.

We already solved the same class of problem for GitHub Copilot
(`docs/superpowers/specs/2026-08-25-copilot-account-routing_spec_completed.md`): per-profile
home directory, a routing service, a mandatory pre-spawn `admit()`, fail-closed factory
enforcement, session stamping, and a resume fingerprint segment. This feature reuses that
shape. It differs in one deliberate way: Copilot routing exists to keep two licences apart
and forbids cross-account fallback (decision D11 there); account pools exist to spend
quota across accounts that all belong to James, so cross-account failover is the point.

## 2. Goal

Add first-class account profiles for the `claude` and `codex` providers, grouped per
provider into a pool, so that every Harness-originated invocation:

1. resolves exactly one account profile before the CLI starts;
2. uses only that profile's CLI home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and stored OAuth;
3. records the profile on the instance, session state, history and resume fingerprint;
4. when the profile hits a usage limit, records that limit against that profile only,
   picks another eligible profile of the same provider, moves the conversation to it, and
   re-sends the throttled turn without user intervention;
5. falls back to the existing behaviour (park until reset, offer a cross-provider switch)
   only when every profile of the provider is exhausted;
6. never moves tokens into Harness settings, SQLite, logs, IPC or model context, and never
   modifies or intermediates the vendor CLIs.

With zero or one profile configured the app behaves exactly as it does today.

## 3. Non-goals

- Pooling GitHub Copilot accounts. Copilot keeps its own routing feature; the generic
  pieces introduced here should let it migrate later, but that migration is not in scope.
- A localhost proxy in front of the CLIs (swisscode / CLIProxyAPI style). It would give
  mid-turn failover but requires token custody and changes CLI behaviour behind a
  non-Anthropic base URL. Explicitly rejected on terms-of-service grounds (§5).
- Refreshing, exporting, copying or rotating OAuth tokens. Harness never writes a
  credential file. The pre-existing read-only usage probe is the only place Harness reads
  a token, and decision D6 governs whether it is extended per profile.
- Round-robin or per-request load spreading. Rejected on both cache-locality and
  anti-abuse grounds (research §3, ccflare's removal of every non-sticky strategy).
- Disguising who or where we are: proxies, fingerprint changes, header replay. Rejected.
- Multiple ChatGPT workspaces under one login. Supported only as separate profiles that
  each complete their own `codex login`.

## 4. Design invariants

1. **Unmodified binaries, environment-only switching.** A profile is a directory plus the
   env var that points the official CLI at it. Nothing else.
2. **One request, one resolved profile.** No `claude` or `codex` process starts with an
   unresolved profile once a pool has more than the legacy profile.
3. **No token custody.** Profiles store non-secret identity metadata only. Login runs in a
   terminal the user drives. Harness never writes `.credentials.json` or `auth.json`.
4. **Byte-stable home paths.** The `CLAUDE_CONFIG_DIR` string is hashed into the macOS
   Keychain service name; it is derived once, absolute, realpath'd, no trailing slash, and
   the identical string is exported by every spawner (local, worker thread, remote worker).
5. **Ambient auth cannot override a profile.** Profile-routed Claude spawns strip
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`,
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and
   `CLAUDE_SECURESTORAGE_CONFIG_DIR`; profile-routed Codex spawns strip `CODEX_API_KEY`,
   `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` and `CODEX_SQLITE_HOME`, and pass
   `-c cli_auth_credentials_store=file`.
6. **Limits are per profile.** The ledger, quota snapshots, cooldowns and notifications all
   carry the profile id. "Provider parked" means every eligible profile is parked.
7. **Stay put until rejected.** A live instance changes account only on a limit rejection
   (or, if enabled, at a turn boundary past a threshold). New sessions go to the default
   profile unless it is parked or over the threshold.
8. **One switch decision per exhaustion.** A per-provider lock serialises the failover
   decision so N concurrent failures produce one ledger row and one target.
9. **A conversation moves as a whole.** Account failover terminates the old provider
   session and continues under a fresh one. Native resume is used when the session store
   is shared across profiles and verified; otherwise the existing `replay` continuity.
10. **Visible provenance.** The profile label and routing source are visible at spawn, on
    the instance header, in the transcript on every switch, and in Doctor.
11. **Never log a new profile in over an existing one.** `codex login` revokes the tokens
    already in that home; the launcher only ever targets a fresh, empty profile home.

## 5. Terms of service position

Summarised from the research reference §4; not legal advice.

- Neither Anthropic's nor OpenAI's consumer terms contain a multiple-accounts clause.
  Anthropic's own docs describe `CLAUDE_CONFIG_DIR` as "useful for running multiple accounts
  side by side". OpenAI ships an account switcher.
- The Anthropic clause that matters is "Advertised usage limits … assume ordinary,
  individual usage", and the end-user carve-out for "the unmodified Claude Code binary
  with their own Claude subscription". The OpenAI clause that matters is "circumvent any
  rate limits or restrictions".
- Documented bans concern relays that pool credentials for other people and datacenter or
  VPN egress IPs. We found no documented ban for one person switching between personally
  paid subscriptions with the official binaries.
- The design therefore: uses unmodified binaries; switches by environment; keeps no
  tokens; fails over on rejection rather than spreading load; and asks James to
  acknowledge once, in settings, that every profile in a pool is an account he personally
  pays for and that Anthropic and OpenAI reserve discretionary enforcement.
- The honest alternative is one bigger plan plus paid overage (Claude Max 20x plus usage
  credits; ChatGPT Pro plus Codex credits). The design supports a pool of one, so starting
  there costs nothing.

## 6. Domain model

### 6.1 Account profile

```ts
type PooledProvider = 'claude' | 'codex';

type AccountAutomationPolicy = 'allow-routed' | 'manual-only' | 'disabled';

interface ProviderAccountProfile {
  id: string;                        // safe slug, /^[a-z0-9][a-z0-9-]{0,62}$/
  provider: PooledProvider;
  label: string;                     // user-facing, e.g. "Max A"
  expectedIdentity: string | null;   // verified email; null until first verification
  expectedAccountKey: string | null; // codex: chatgpt account id; claude: org uuid. Pool sanity only.
  planLabel: string | null;          // display only, e.g. "max", "pro"
  priority: number;                  // lower is preferred; unique within a provider
  enabled: boolean;
  automationPolicy: AccountAutomationPolicy;
  isLegacy: boolean;                 // bound to ~/.claude or ~/.codex, never to a derived home
  createdAt: number;
  updatedAt: number;
}
```

The profile stores no token, no home path and no environment value. The home is derived
from the id on the executing node, exactly as `copilot-account-home-resolver.ts` does.

### 6.2 Pool policy (one per provider)

```ts
interface ProviderAccountPoolPolicy {
  failoverMode: 'automatic' | 'ask' | 'off';
  continuation: 'shared-store' | 'replay';         // see D3
  preemptive: { newSessions: boolean; liveSessionsAtTurnBoundary: boolean; thresholdPct: number };
  switchCooldownMs: number;                        // default 300_000
  maxSwitchesPerTurn: number;                      // default: profile count - 1, capped at 3
  acknowledgedOwnershipAt: number | null;          // §5; required before a second profile is enabled
}
```

### 6.3 Resolved route (wire-safe)

```ts
type AccountRouteSource = 'explicit' | 'default' | 'failover' | 'persisted' | 'legacy' | 'preemptive';

interface ResolvedAccountRoute {
  provider: PooledProvider;
  profileId: string;
  source: AccountRouteSource;
  executionNodeId: string;
  profileLabel?: string;
  expectedIdentity?: string;
}
```

### 6.4 Binding status (node-local, derived, never persisted centrally)

```ts
interface AccountBindingStatus {
  provider: PooledProvider;
  profileId: string;
  nodeId: string;
  state: 'authenticated' | 'unauthenticated' | 'identity-mismatch' | 'unavailable';
  observedIdentity?: string;
  observedAccountKey?: string;
  checkedAt: number;
  errorCode?: string;
}
```

Claude binding: `CLAUDE_CONFIG_DIR=<home> claude auth status --json` (exit 0/1, `email`,
`subscriptionType` when `authMethod === "claude.ai"`). No network.
Codex binding: `auth.json` present with `auth_mode: "chatgpt"` for health; identity via a
short-lived `codex app-server` and `account/read` at profile creation and on demand.

### 6.5 Ledger row

`provider_limit_events` gains `account_profile_id TEXT NOT NULL DEFAULT ''` (empty means
the legacy profile). `getActive` takes the profile id. A new
`getParkedProfileIds(provider, model, now)` backs the "every eligible profile is parked"
veto.

### 6.6 Quota snapshot

`ProviderQuotaSnapshot` gains `accountProfileId?: string`. The service keys snapshots by
`provider` (legacy) or `${provider}:${profileId}`.

## 7. Profile home layout

```
<stateRoot>/claude-cli-profiles/<profileId>/
  .claude.json             seeded {"hasCompletedOnboarding": true} (livetest whether -p needs it)
  settings.json  -> ~/.claude/settings.json      (symlink: shared user settings)
  CLAUDE.md      -> ~/.claude/CLAUDE.md          (symlink, if present)
  commands/ skills/ agents/ plugins/ -> ~/.claude/<same>   (symlinks, if present)
  projects/      -> ~/.claude/projects           (symlink: SHARED session store, D3)
  .credentials.json / Keychain item              written by `claude auth login` only

<stateRoot>/codex-cli-profiles/<profileId>/
  config.toml              written by Harness: cli_auth_credentials_store = "file"
  auth.json                written by `codex login --device-auth` only
```

`stateRoot` is the existing `getCopilotStateRoot()` resolution generalised (worker env
`AI_ORCHESTRATOR_STATE_ROOT` → Electron userData → tmpdir), renamed
`getProviderStateRoot()`. The legacy profile of each provider is bound to `~/.claude`
(no `CLAUDE_CONFIG_DIR` at all, preserving the existing Keychain item) and `~/.codex`.

At spawn time Codex keeps its temporary per-instance home; the only change is that
`auth.json` is linked from the profile home instead of `~/.codex`, and config still comes
from `~/.codex/config.toml`. Session history stays in the shared
`~/.ai-orchestrator/codex` store, which is what makes Codex native resume already
profile-independent.

## 8. Routing and failover algorithm

### 8.1 Resolve for a new spawn

Inputs: provider, explicit profile id (optional), persisted profile id (resume/respawn),
invocation origin, execution node.

1. Persisted profile wins (restore, respawn, native resume). Changed pool settings never
   move a live thread.
2. Explicit profile wins for a new session, subject to `enabled`, `automationPolicy` and
   binding.
3. Otherwise the default candidate is the enabled profile with the lowest priority number.
   Skip it when the ledger has an active row for `(provider, model or '', profileId)`, or
   when `preemptive.newSessions` is on and its freshest 5-hour utilisation is at or above
   `thresholdPct`. Take the next eligible in priority order.
4. With no profiles at all, synthesise the legacy route (identical to today).
5. `admit()` runs the node-local binding check and refuses `unauthenticated`,
   `identity-mismatch` and `unavailable` with a typed failure. It never substitutes a
   different profile; that is the pool's job in step 3, before admission.

### 8.2 On a limit during a turn

`InstanceProviderLimitHandler.maybePark()` (and the loop twin) after the ledger row is
recorded for the exhausted profile and before `park()`:

1. If `failoverMode === 'off'`, or the instance has already switched
   `maxSwitchesPerTurn` times this turn, or the instance is inside `switchCooldownMs` of
   its last switch: fall through to park.
2. Acquire the provider lock. Re-read the ledger. Select the next profile in priority
   order that is enabled, allowed for this origin, bound `authenticated` (30 s cache),
   has no active ledger row for this model, and (when quota is known) has 5-hour
   utilisation under 100 %. Prefer, among equals, the one whose weekly window resets
   soonest (consume-first), then the least recently used.
3. None found: release the lock, fall through to park (existing behaviour, now with the
   veto meaning "every profile is parked").
4. Found and `failoverMode === 'ask'`: park as today and attach an "offer account switch"
   notification with a one-click accept (mirrors the WS7 provider-switch offer).
5. Found and `failoverMode === 'automatic'`: apply a `DesiredRuntime` with the same
   provider and the new `accountProfileId`, `accountHandoffKind: 'failover'`. The runtime
   reconciler terminates the provider session and creates a new one under the new
   profile: continuity `native-resume` when `continuation === 'shared-store'` and the
   adapter reports resume support, else `replay`. A transcript system note records
   `Account switched: <from label> → <to label> (usage limit; resets <time>)`. Release the
   lock. Re-send the throttled turn. Return `'switched-account'`.
6. Emit `account_failover_performed` with instance id, provider, from, to, reason and
   reset time. Notify once per switch.

A second rejection on the new profile within 60 s counts as a switch and is subject to the
per-turn cap; when the cap is hit the instance parks on the soonest reset across profiles.

### 8.3 Coming back

Nothing moves a live conversation back to its original profile. When the ledger row
expires, the exhausted profile simply becomes eligible for new sessions and for the next
failover. Parked instances (all profiles exhausted) resume exactly as today.

### 8.4 Pre-emptive switching (optional)

When `preemptive.liveSessionsAtTurnBoundary` is on, a live instance whose profile reports
`allowed_warning` (Claude `rate_limit_event`) or a 5-hour `usedPercent` at or above
`thresholdPct` (Codex `account/rateLimits/updated`) is switched before its next turn is
sent, using the same handoff. Default off; new-session steering is on by default.

## 9. Limit detection per provider

Claude (`claude-cli-adapter.ts`):

- `rate_limit_event` with `status: 'rejected'` and `resetsAt` (already parsed into
  `lastRateLimitInfo`). Also surface `allowed_warning`, `utilization` and
  `surpassedThreshold` into the per-profile quota snapshot.
- `result` with `is_error: true` and `api_error_status: 429`: new structured signal. Attach
  `quota: { exhausted: true, resetAt }` diagnostics to the thrown error so
  `detectErrorProviderLimit` no longer depends on text.

Codex (`codex-app-server-notification-adapter.ts`, `app-server-client.ts`):

- `error` notification with `codexErrorInfo === 'usageLimitExceeded'`, and `turn/completed`
  with `turn.error.codexErrorInfo === 'usageLimitExceeded'`: structured signal. On receipt,
  issue `account/rateLimits/read`; reset time is the soonest `resetsAt` among windows with
  `usedPercent >= 100`, else the primary window's `resetsAt`; treat
  `ordinaryUsageAllowed === false` as authoritative.
- Subscribe to `account/rateLimits/updated` and merge into the profile's quota snapshot.
- Exec-mode fallback and the shared `provider-notice.ts`: accept U+2019 and the
  "try again at" phrasing.

## 10. Quota and identity probes (decision D6, D7)

- Passive: every live instance feeds its profile's snapshot for free (Claude
  `rate_limit_event`, Codex `account/rateLimits/updated`).
- Active Claude: the existing `/api/oauth/usage` probe runs per profile, reading the token
  from the profile's Keychain item (`Claude Code-credentials-<hash>`) or
  `<home>/.credentials.json`. Polling cadence is divided by profile count so the total
  endpoint budget stays what it is today.
- Active Codex: a short-lived `CODEX_HOME=<profile> codex app-server` answering
  `account/rateLimits/read` (and `account/read` for identity). No token handling by
  Harness. Cadence: on demand, on park, and at most every 15 minutes per idle profile.
- The chip shows one row per profile under each provider header; the provider-level
  figure is the default profile's, labelled.

## 11. Settings, IPC, UI

- Settings keys `providerAccountProfiles` and `providerAccountPools`, Zod-validated, in
  `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`, agents read-only.
- IPC domain `provider-account:*` mirroring `copilot-account:*` (list, create, verify,
  rename, set priority, enable, remove, launch login, pool policy read/update, binding
  matrix, acknowledge ownership).
- Settings tab "Accounts" with a Claude section and a Codex section: profile cards
  (label, identity, plan, priority, enabled, policy, node binding), Add account (launches
  the terminal login into a fresh home), Verify, reorder, Remove (blocked while a live
  instance uses it), pool policy controls, ownership acknowledgement.
- New-session panel: account picker behind the provider controls, showing the resolved
  default and reason.
- Instance header: profile badge with routing source. Transcript note on every switch.
- Notifications: `Account switched`, `All <provider> accounts exhausted; resuming at <t>`,
  `Profile <label> needs sign-in`.
- Doctor: per-profile binding, expected identity, default validity, ambient auth
  variables present (by name), workspace-shared limits detected (Codex same accountId).

## 12. Remote worker nodes

Spawn RPC carries `accountRoute: { provider, profileId, expectedIdentity, source }`
(optional for wire compatibility). The worker derives its own home under
`AI_ORCHESTRATOR_STATE_ROOT`, verifies its local binding, and refuses with a typed
`profile-not-bound-on-node` error. Credentials are never synchronised. Placement prefers a
node bound to the resolved profile but never changes the profile to satisfy a node.

## 13. Security and privacy

- Profiles contain no secrets; IPC, RPC, logs, telemetry and review artifacts carry ids,
  labels and bounded identity only. The `assertNoPathOrSecret` response gate is reused
  with Claude/Codex home markers added.
- Profile ids are validated slugs; home resolution re-validates and double-checks
  containment (pre- and post-mkdir realpath) exactly like the Copilot resolver.
- Ambient auth variables are removed from the child env, not merely redacted after the
  fact (`envRemove` on the adapter config, which Claude does not use today).
- Harness never runs `security ... -w` for anything new. The existing read-only usage
  probe is the one exception and is governed by D6.
- Login commands are structured, derived in main, and rendered through the audited
  `quotePathForTerminal` helper.

## 14. Test strategy

- Pure selector tests over the eligibility and ordering matrix (priority, parked rows,
  automation policy, binding, threshold, cooldown, per-turn cap, consume-first tie-break).
- Detection tests with the exact Claude and Codex strings and structured payloads,
  including U+2019, `api_error_status: 429`, `codexErrorInfo: 'usageLimitExceeded'`,
  `account/rateLimits/read` window classification by `windowDurationMins`.
- Home resolver containment; Keychain service-name derivation (`sha256(NFC(path))[0:8]`)
  is asserted against known vectors so a path drift shows up in CI.
- Spawn env tests: `CLAUDE_CONFIG_DIR` present and byte-identical; stripped variables
  absent even when set in the parent; Codex `-c cli_auth_credentials_store=file` present;
  legacy profile sets nothing.
- Ledger migration and per-profile queries; the veto returns parked only when all
  eligible profiles are parked.
- Failover coordinator with the scripted adapter: a Claude turn that hits a limit, then a
  second profile succeeds; N concurrent failures produce one switch; `ask` mode parks with
  an offer; `off` mode parks; cap and cooldown respected; loop path parity.
- Reconciler handoff: fingerprint segment appended only when non-empty; native-resume vs
  replay chosen by policy and adapter capability; transcript note emitted.
- IPC schema strictness, `ipcAuthToken`, response gate; settings policy blocks agents.
- Renderer: tab, badge, picker, chip rows.
- Live checks (deferred to `_livetest.md`): two real Claude and two real Codex accounts;
  symlinked `projects/` honoured by native resume; `-p` on a fresh config dir; Keychain
  item names as predicted; a forced limit fails over and resumes; remote worker binding.

## 15. Decisions for James

| # | Decision | Recommended choice | Alternatives |
|---|---|---|---|
| D1 | Isolation mechanism | Per-profile `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, unmodified binaries, no token custody | Localhost proxy (mid-turn failover, token custody, rejected on ToS) |
| D2 | Providers in scope | Claude and Codex; Copilot untouched | Generalise Copilot in the same change |
| D3 | Conversation continuation on switch | Shared session store (`projects/` symlink, Codex already shared) with native resume, `replay` fallback, no confirmation prompt for acknowledged pools | Replay only; or require confirmation like Copilot |
| D4 | Selection order | Priority list, stay put until rejected, consume-first then LRU tie-break | Least-utilised first; round-robin (rejected) |
| D5 | Pre-emptive switching | New sessions steered away from profiles at or above 90 % of the 5-hour window; live sessions never moved pre-emptively | Also move live sessions at turn boundaries; off entirely |
| D6 | Claude per-profile usage probe | Extend the existing Keychain-token probe per profile, total cadence unchanged | Passive telemetry only (no token reads at all) |
| D7 | Codex identity and usage probe | Short-lived `codex app-server` (`account/read`, `account/rateLimits/read`), no token handling | Read `auth.json` token and call `wham/usage` directly (existing probe pattern) |
| D8 | Failover mode default | `automatic` once ownership is acknowledged; `ask` before | `ask` always |
| D9 | Loops | Same account failover in loops in the same release | Regular sessions first, loops later |
| D10 | Remote workers | Wire the RPC field and worker derivation now; live checks deferred | Local-only in v1 |
| D11 | Ownership acknowledgement | One-time settings acknowledgement before a second profile can be enabled | None |
| D12 | Profile home root | `<stateRoot>/claude-cli-profiles/<id>` and `<stateRoot>/codex-cli-profiles/<id>`, matching Copilot | `~/.ai-orchestrator/<provider>/profiles/<id>` |

## Appendix A: Verified existing foundations

| Capability | Existing location | Reuse or change |
|---|---|---|
| Per-profile home + containment | `cli/adapters/copilot/copilot-account-home-resolver.ts` | Generalise into `provider-account-home-resolver.ts` |
| Route attachment and factory backstop | `instance/lifecycle/copilot-route-preflight.ts`, `cli/adapters/copilot/copilot-adapter-guards.ts`, `adapter-factory.ts:332-447` | Same shape for `accountRoute` |
| Env strip list mechanism | `base-cli-adapter.ts:593-595` (`envRemove`), unused by Claude | Add Claude and Codex strip lists |
| Codex temp home | `cli/adapters/codex/codex-home-manager.ts:152-193` | Add `authSourceDir` |
| Limit funnel | `instance/instance-provider-limit-handler.ts:134-177` | Insert account failover between ledger record and `park()` |
| Ledger | `core/system/provider-limit-ledger.ts` | Add profile column |
| Runtime handoff | `instance/lifecycle/runtime-reconciler.ts:215-228` | Add account handoff branch |
| Resume fingerprint | `instance/lifecycle/session-recovery.ts:43-63` | Reuse the conditional segment |
| Quota service | `core/system/provider-quota-service.ts` | Composite key |
| Login launcher | `providers/provider-login-launcher.ts:124-150` | Add Claude and Codex profile login builders |
| Settings policy | `core/config/settings-control-policy.ts:445-446` | Two new keys |
| IPC/preload/renderer | `ipc/handlers/copilot-account-handlers.ts`, `preload/domains/copilot-account.preload.ts`, `features/settings/copilot-accounts-tab.component.ts` | Mirror |
| Remote spawn | `cli/adapters/remote-cli-adapter.ts:195-206`, `remote-node/rpc-schemas.ts:234-252`, `worker-agent/local-instance-manager.ts:234-269` | Mirror |
