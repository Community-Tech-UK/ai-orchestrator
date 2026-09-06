# GitHub Copilot Account Routing — Specification

**Status:** COMPLETED (2026-08-26) — implemented and independently gated; the multi-account
live checks are deferred to
[2026-08-25-copilot-account-routing_plan_livetest.md](../plans/2026-08-25-copilot-account-routing_plan_livetest.md)
and are not claimed as verified.
**Date:** 2026-08-25
**Owner:** James
**Implementation plan:** [2026-08-25-copilot-account-routing_plan_completed.md](../plans/2026-08-25-copilot-account-routing_plan_completed.md)

---

## 1. Problem

James now has two GitHub identities that can provide GitHub Copilot service: a
personal account and an enterprise account. AI Orchestrator (AIO) must send each
Copilot request through the account appropriate to the current repository without
requiring a global account switch and without risking enterprise code or licence use
under the wrong identity.

The current AIO Copilot path cannot do this:

- `createCopilotAdapter()` resolves one application-wide directory through
  `getCopilotOrchestratorHome()` and supplies it to every Copilot ACP spawn as both
  `--config-dir` and `COPILOT_HOME`.
- The directory is `<Electron userData>/copilot-cli-home` unless
  `AI_ORCHESTRATOR_COPILOT_HOME` overrides it. It is not keyed by repository,
  workspace, instance, execution node, or GitHub account.
- The production AIO profile records one `lastLoggedInUser`; the development profile
  may have a different state. There is no account selector in AIO settings or instance
  creation.
- Copilot CLI supports multiple accounts and interactive `/user switch`, but that
  changes shared last-used state. Two concurrent AIO sessions could therefore race
  and send a request through whichever account switched last.
- Copilot authentication environment variables have higher priority than stored
  OAuth credentials. `buildCopilotSpawnEnv()` currently copies the parent process
  environment, so an inherited `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`
  can silently defeat profile selection.
- Account-sensitive adjacent surfaces are global today: Copilot authentication
  status, quota, model discovery, automation eligibility, resume metadata, and remote
  worker dispatch do not carry an account identity.

The existing `providersExcludedFromAutomation` setting protects a whole provider. It
cannot express “enterprise Copilot is allowed for employer repositories, personal
Copilot is allowed elsewhere.”

## 2. Goal

Add first-class Copilot account profiles and deterministic, repository-aware routing
so that every AIO-originated Copilot invocation:

1. resolves exactly one account profile before any Copilot process starts;
2. uses only that profile's Copilot configuration and stored OAuth selection;
3. records the selected profile on the AIO session for continuity and auditability;
4. refuses ambiguous, unauthenticated, policy-disallowed, or identity-drifted routes;
5. never moves tokens into AIO settings, SQLite, logs, IPC, or model context; and
6. behaves consistently for interactive sessions, automated invokers, restores,
   respawns, provider failover, and remote workers.

The primary expected configuration is:

```text
enterprise GitHub owner(s) and protected work path(s) -> Enterprise profile
personal GitHub owner(s)                             -> Personal profile
unmatched, unprotected workspaces                    -> Personal default
```

## 3. Non-goals

- Managing Git credentials used by `git fetch`, `git push`, commits, or `gh` CLI.
  This feature routes the `copilot` provider only.
- Storing or displaying GitHub/Copilot tokens in AIO.
- Automatically transferring authentication credentials between machines.
- Automatically deciding that a repository is enterprise-owned from commit email,
  filesystem ownership, branch name, or prompt content.
- Sharing a provider-native Copilot session across two account profiles.
- Building a generic multi-account framework for every provider in this change. The
  resolver and types should be reusable, but only Copilot is in scope.
- Guaranteeing that a GitHub organisation's own Copilot policies permit a request.
  AIO prevents known routing mistakes; GitHub remains the final policy authority.
- Reworking Copilot pricing or inventing quota data unavailable from an authoritative
  account-specific source.

## 4. Design invariants

1. **One request, one resolved profile.** A Copilot process cannot start with an
   unresolved or multiply matched account.
2. **No global switching.** AIO never invokes `/user switch` as part of routing and
   never mutates a shared account selection immediately before a request.
3. **No token custody.** OAuth tokens remain in Copilot CLI's supported credential
   storage. AIO persists only non-secret identity metadata and routing rules.
4. **No ambient token override.** OAuth-backed profile spawns do not inherit
   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.
5. **Account continuity is explicit.** A native Copilot session is resumed only under
   the same account profile that created it.
6. **Enterprise is matched-only by default.** A newly created enterprise profile
   cannot service an unmatched or context-free request unless James deliberately
   changes its scope policy.
7. **Protected scopes fail closed.** A workspace under a protected work path, or a
   repository matching a protected enterprise host/owner, is never silently routed
   to the personal default.
8. **No credential fallback across accounts.** Authentication failure, quota failure,
   or policy denial on one profile never retries the same request with another
   Copilot account.
9. **Node-local authentication.** A remote worker receives a profile ID and expected
   identity, never a controller token or controller filesystem path.
10. **Visible provenance.** The selected account label and routing reason are visible
    before or at spawn and remain inspectable on the session.

## 5. Approaches considered

### 5.1 Recommended: one `COPILOT_HOME` per account profile

Each AIO Copilot account profile receives an isolated state directory. A central
resolver chooses a profile from the workspace's GitHub remotes, protected path rules,
an explicit session override, and the configured default. The adapter receives the
resolved profile ID and locally derived home path.

Benefits:

- concurrent sessions cannot change one another's last-used account;
- it extends AIO's existing Copilot state-isolation seam;
- credentials stay in Copilot's supported OAuth/keychain flow;
- sessions, settings, history, and logs are naturally separated; and
- the same profile identifier can be bound independently on remote workers.

Trade-off: each profile must be authenticated once on each node that will run it.

### 5.2 Rejected: shared home plus `/user switch`

This is easy for a human operating one terminal, but unsafe for AIO. Account selection
is mutable process-external state. Parallel interactive sessions, reviewers, loops, or
background verification could switch it between resolution and request dispatch.

### 5.3 Rejected: inject a token per request

`COPILOT_GITHUB_TOKEN` would make selection deterministic, but AIO would need to
retrieve, transport, and inject credentials. It would expand the secret-handling
surface into settings, remote-node RPC, child environments, diagnostics, and crash
handling. It also creates precedence hazards with `GH_TOKEN` and `GITHUB_TOKEN`.

### 5.4 Rejected: infer from the globally active `gh` account

GitHub CLI account state is host-wide, not repository-bound for two accounts on the
same `github.com` host. It is also lower precedence than Copilot's own OAuth and token
environment variables. It cannot provide deterministic AIO routing.

## 6. Domain model

### 6.1 Account profile

Add shared, schema-validated types:

```ts
type CopilotAccountScopePolicy = 'matched-only' | 'default-eligible';
type CopilotAutomationPolicy = 'allow-routed' | 'manual-only' | 'disabled';

interface CopilotAccountProfile {
  id: string;                         // immutable safe slug/UUID
  label: string;                      // user-facing, e.g. "Enterprise"
  expectedLogin: string | null;       // populated after verified login
  host: string;                       // normalized host, normally github.com
  accountKind: 'personal' | 'enterprise';
  scopePolicy: CopilotAccountScopePolicy;
  automationPolicy: CopilotAutomationPolicy;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}
```

`accountKind` supplies safe defaults and UI language; it is not itself a routing
signal. A personal profile defaults to `default-eligible`. An enterprise profile
defaults to `matched-only`. Exactly zero or one profile may be `isDefault`; a default
profile must be `default-eligible`.

The profile stores no token, keychain reference, arbitrary environment value, or
absolute home directory. The home path is derived from the trusted profile ID on the
execution node.

### 6.2 Routing rule

```ts
type CopilotRoutingMatcher =
  | { type: 'repository'; host: string; owner: string; repo: string }
  | { type: 'owner'; host: string; owner: string }
  | { type: 'path-prefix'; canonicalPath: string };

interface CopilotAccountRoutingRule {
  id: string;
  profileId: string;
  matcher: CopilotRoutingMatcher;
  protected: boolean;
  createdAt: number;
  updatedAt: number;
}
```

Comparisons of GitHub host, owner, and repository are case-insensitive. `.git` suffixes
are removed. Path prefixes use a canonical workspace path: `resolve`, existing-path
`realpath`, platform-appropriate case handling, and a path-boundary comparison rather
than a raw string prefix.

`protected` means that a failed or ambiguous match within that scope blocks Copilot
rather than falling back to another account. Rules created for enterprise profiles
default to protected.

### 6.3 Node-local binding health

Authentication is node-local and derived, not copied into the controller database:

```ts
interface CopilotAccountBindingStatus {
  profileId: string;
  nodeId: string; // local controller uses the canonical local-node identity
  state: 'authenticated' | 'unauthenticated' | 'identity-mismatch' | 'unavailable';
  observedLogin?: string;
  observedHost?: string;
  checkedAt: number;
  errorCode?: string;
}
```

Only bounded identity metadata crosses IPC/RPC. Errors and logs never contain token
material or raw configuration bodies.

### 6.4 Resolved route

```ts
interface ResolvedCopilotAccountRoute {
  profileId: string;
  source: 'explicit' | 'repository' | 'owner' | 'path-prefix' | 'default' | 'legacy';
  ruleId?: string;
  repository?: { host: string; owner: string; repo: string };
  executionNodeId: string;
}
```

The resolved route is safe metadata. Store `profileId`, `source`, and `ruleId` on the
instance/session record. Repository evidence may be logged in structured form but does
not need to be duplicated in conversation history.

## 7. Profile state layout

For new profiles, derive the node-local Copilot home as:

```text
<AIO userData>/copilot-cli-profiles/<profileId>/
```

The existing profile remains at:

```text
<AIO userData>/copilot-cli-home/
```

and is represented by a migration-created legacy profile whose binding uses the
existing directory without copying or moving files.

`AI_ORCHESTRATOR_COPILOT_HOME`, when present, continues to define the legacy profile's
exact home for backward compatibility. New profiles are derived beneath a sibling
`copilot-cli-profiles/` directory, never by treating an arbitrary account label as a
path.

A helper such as `CopilotAccountHomeResolver` owns this derivation and validates that
the final path remains inside the expected AIO provider-state root. No renderer or
remote caller supplies a filesystem path.

## 8. Routing algorithm

Add a main-process `CopilotAccountRoutingService` with a pure resolver core. Every
Copilot spawn path calls it before adapter construction.

Inputs:

- canonical working directory, if any;
- the workspace's fetch remotes;
- explicit profile override, if any;
- account profiles and routing rules;
- invocation origin (`interactive`, `automation`, `review`, `verification`, `loop`,
  `failover`, or other internal surface);
- execution node; and
- persisted profile ID when restoring/resuming.

Resolution order:

1. **Persisted resume profile.** A restore, respawn, or native resume retains its
   original profile. Changed routing rules do not silently move an existing thread.
2. **Explicit session override.** A user-selected profile wins for a new session, but
   still passes profile scope and automation policy checks. An override cannot bypass
   a protected-scope conflict without a separate explicit confirmation in the UI.
3. **Exact repository rule.** Match normalized `{host, owner, repo}`.
4. **Owner rule.** Match normalized `{host, owner}`.
5. **Path-prefix rule.** Use the longest matching canonical prefix.
6. **Default profile.** Allowed only when the workspace is outside every protected
   scope and the profile is `default-eligible`.

Repository evidence uses all fetch remotes, preferring `origin` for display but not
discarding conflicts. Reuse and harden the parsing currently in
`vcs/remotes/git-host-connector.ts` so HTTPS, ordinary SSH, enterprise hostnames, and
configured SSH aliases can be normalized. An SSH alias must resolve through an
explicit routing rule or known alias mapping; substring matching such as
`host.includes('github.com')` is insufficient for security-sensitive routing.

The resolver returns a typed failure instead of guessing:

```ts
type CopilotRouteFailureCode =
  | 'no-profiles'
  | 'no-match'
  | 'ambiguous-remotes'
  | 'ambiguous-rules'
  | 'protected-scope-unmapped'
  | 'profile-missing'
  | 'profile-not-bound-on-node'
  | 'profile-unauthenticated'
  | 'profile-identity-mismatch'
  | 'automation-disallowed';
```

If multiple remotes or equal-precedence rules resolve to different profiles, routing
fails. Rule ordering in the settings UI is not a hidden tiebreaker.

### 8.1 Context-free invocations

A Copilot invocation without a working directory must carry an explicit profile or use
a `default-eligible` default profile whose automation policy permits that origin.
Matched-only profiles never receive context-free calls.

### 8.2 Protected paths

Path rules cover repositories without a usable remote and protect work checked out
from mirrors or before an origin is added. If a workspace falls beneath a protected
enterprise path, failure to resolve its configured enterprise profile blocks the
request. It does not fall through to personal.

## 9. Authentication and identity verification

### 9.1 Adding a profile

The settings flow creates metadata and an empty node-local home, then launches the
fixed Copilot login command with that home:

```text
COPILOT_HOME=<derived profile home> copilot login [--host <normalized host>]
```

The user completes browser/device-code authentication. AIO never clicks the browser,
types a code, or receives the OAuth token.

The current `ProviderLoginLauncher` accepts only a provider ID and a fixed command.
Extend it with a structured Copilot profile login request whose profile ID and host are
schema-validated and whose home is derived in main. Do not accept a renderer-provided
command or environment map.

### 9.2 Binding verification

After login, and before each spawn when cached health is stale, read only the bounded
identity fields from that profile's Copilot `config.json`:

- `lastLoggedInUser.host`
- `lastLoggedInUser.login`
- `loggedInUsers`, where present in the installed CLI version

The observed host/login must match the profile's expected identity. The first verified
login sets `expectedLogin`; a later difference is `identity-mismatch` and blocks spawn
until James explicitly adopts the new identity or reauthenticates.

Configuration parsing is JSONC-aware, size-bounded, and schema-validated. It never
returns the raw file over IPC or includes experimental assignments in logs.

### 9.3 Environment hygiene

For OAuth-backed account profiles, construct the Copilot child environment from the
safe provider environment and explicitly remove:

- `COPILOT_GITHUB_TOKEN`
- `GH_TOKEN`
- `GITHUB_TOKEN`

Set `COPILOT_HOME` to the resolved node-local profile home. Set
`COPILOT_GH_HOST` from the profile host when needed so an ambient `GH_HOST` cannot
retarget Copilot. Preserve the existing `NODE_OPTIONS=--use-openssl-ca` workaround.

No v1 profile mode accepts an arbitrary environment token. Headless tokens can be
designed later as an explicit secret-backed profile type rather than silently reusing
ambient process state.

## 10. Spawn integration

### 10.1 Unified spawn contract

Extend `UnifiedSpawnOptions` with safe routing metadata, not paths or tokens:

```ts
copilotAccountRoute?: ResolvedCopilotAccountRoute;
```

For `cliType === 'copilot'`, adapter construction requires this field after the legacy
migration is initialized. `createCopilotAdapter()` derives the local home from the
profile ID and execution-node context, sets the sanitized environment, and records the
profile ID in adapter diagnostics.

The factory must fail closed if production code tries to create a Copilot adapter
without a route. Tests may use an explicit deterministic test profile.

### 10.2 Coverage of every invocation path

Resolution belongs in a reusable spawn preflight used by:

- interactive instance creation;
- hibernate/wake and unexpected-exit respawn;
- model, permission, or runtime-change respawn;
- loop/default invokers;
- cross-model and ping-pong review;
- consensus and multi-verification;
- automations and magic-prompt provider selection;
- failover into Copilot;
- provider-runtime/direct provider callers; and
- remote worker dispatch.

Direct `new CopilotCliAdapter()` call sites used for status or model discovery do not
issue model requests, but they must either become profile-aware or be explicitly
classified as installation-only probes. No request-producing bypass may remain.

### 10.3 Adapter modes

Both ACP mode and any exec/server fallback receive the same profile home and sanitized
environment. Loading Copilot's bundled SDK from the installed package does not change
the account route. If an SDK client spawns its own runtime, its constructor/options
must receive the resolved `COPILOT_HOME`; process-global mutation is forbidden.

## 11. Session continuity and account handoff

Add `copilotAccountProfileId?: string` and safe routing source metadata to `Instance`,
creation/restoration payloads, session continuity, and history records.

Rules:

- A new Copilot session resolves and stamps a profile before adapter spawn.
- All turns, child process respawns, and native resumes for that provider session use
  the stamped profile.
- Changing repository rules affects only new sessions.
- If the stamped profile is removed, unauthenticated, unavailable on the target node,
  or identity-mismatched, restore parks at `auth-required`/routing-required. It does
  not use the current default.
- Switching an existing conversation to another Copilot account is an explicit
  account handoff: terminate the native provider session, create a new provider
  session, show a transcript/system note, and require confirmation that conversation
  context will be sent through the new account. It is never an automatic resume.
- Provider failover away from Copilot follows existing failover-consent rules. A later
  failover back to Copilot resolves the workspace route but cannot revive a native
  session created by a different profile.

The account profile ID participates in the resume/config fingerprint so a mismatch is
detectable before native resume.

## 12. Automation and licence policy

Keep `providersExcludedFromAutomation` as the coarse global override. When it contains
`copilot`, no Copilot account is automatically selected.

Add per-profile `automationPolicy`:

- `allow-routed`: automatic invocation is allowed after an unambiguous workspace
  route; this is the default for personal and enterprise profiles.
- `manual-only`: the profile can be chosen for a user-created session but never by
  automatic provider selection, reviews, loops, verification, or failover.
- `disabled`: no new invocation may use the profile.

Provider selection and account selection remain distinct:

1. the existing provider router decides whether Copilot is eligible;
2. the account router resolves an eligible account for the workspace and origin;
3. failure to resolve makes Copilot unavailable for that invocation; and
4. the existing provider router may choose a different provider only if its normal
   policy and user consent allow it. It may not choose a different Copilot account.

This preserves the existing licence guard while allowing enterprise Copilot automation
inside explicitly mapped employer repositories.

## 13. Remote worker nodes

Profile metadata and routing rules are controller-owned. Authentication bindings are
node-local.

For a Copilot session placed on a worker:

1. the controller resolves the profile from the workspace and stamps its profile ID;
2. the spawn RPC carries the profile ID, expected login, normalized host, and routing
   source only;
3. the worker derives its own profile home under its AIO state directory;
4. the worker verifies that local binding; and
5. the worker either spawns with that home or returns a typed auth/routing failure.

Credentials and profile directories are never synchronized. The settings UI shows a
profile-by-node authentication matrix and provides “Sign in on this node.” The existing
remote terminal mechanism may launch the fixed login flow on a trusted connected node.

Node placement must consider binding availability. It may prefer a node already bound
to the resolved profile, but it must not change the resolved account to satisfy a node.
If a forced node lacks the binding, the session parks and explains the required login.

## 14. Status, Doctor, quota, and model discovery

### 14.1 Authentication status

Add a Copilot profile-aware auth probe. The existing provider-wide status becomes an
aggregate presentation:

- available when the binary exists and at least one enabled profile is healthy;
- auth-required when profiles exist but none is healthy on the selected node; and
- “partially configured” when some profiles are healthy and others are not.

Session admission uses the resolved profile's status, not the aggregate.

### 14.2 Doctor

Doctor reports, without secrets:

- profile label and expected identity;
- normalized host;
- scope and automation policy;
- node binding state;
- conflicting/unreachable rules;
- default-profile validity;
- ambient token variables detected as present, reported by variable name only; and
- whether legacy migration remains in use.

Repair actions are profile-specific and launch only the fixed login flow.

### 14.3 Quota

Never present one account's quota as another's. Existing global Copilot probes must not
remain authoritative in multi-profile mode:

- login-state probing reads the resolved profile home;
- usage probing is keyed by profile only when the token source can be proven to belong
  to that profile; and
- if AIO cannot obtain authoritative account-specific quota without reading or
  exporting credentials, show quota as unavailable for that profile rather than using
  `~/.copilot` or the first token file found.

Provider-level UI may show the selected/default profile's quota with its label; it must
not sum unrelated account allowances.

### 14.4 Model discovery

The installed CLI model vocabulary may remain provider-wide. Account policy can still
deny individual models at runtime. Model discovery/cache results that come from an
authenticated request must be keyed by profile ID. A model failure under one profile
must not mark that model unavailable for every Copilot account.

No silent model fallback is introduced by this feature. Existing explicit/`auto`
selection behavior remains, with errors attributed to the selected account profile.

## 15. User experience

### 15.1 Settings: Copilot accounts

Add a GitHub Copilot Accounts section under provider settings:

- profile cards with label, account kind, login, host, default badge, scope policy,
  automation policy, and local/node auth state;
- Add account, Sign in/Reauthenticate, Verify, Rename, Set default, and Remove actions;
- routing rules grouped under each profile;
- “Route current workspace” action that reads the current remote and proposes an exact
  repository or owner rule;
- protected path rule creation for work roots; and
- visible conflict/coverage warnings.

Account labels are user-editable. Login and host are verified metadata, not free-form
claims after first authentication.

Removing a profile is blocked while a live session uses it. If history references it,
the UI explains that those sessions will no longer natively resume. Removing AIO's
profile metadata/state does not revoke the GitHub OAuth authorization or delete a
shared OS-keychain credential; revocation remains an explicit GitHub/Copilot action.

### 15.2 New session and instance display

When Copilot is selected:

- show the automatically resolved account and reason, for example
  `Enterprise · matched github.com/communitytech/repository`;
- allow an explicit account override behind the provider controls;
- warn before overriding a protected match; and
- disable Start with a precise fix action when routing/authentication is unresolved.

The instance header/details display a compact profile badge. Routing failures appear as
actionable states rather than generic “Copilot unavailable” errors.

### 15.3 Automatic/background surfaces

No dialog blocks unattended work. A failed account route records a structured skip or
parks the owning workflow according to its existing semantics, with a notification that
names the workspace, profile label, and required action. It never falls back to another
Copilot identity silently.

## 16. Persistence and migration

Persist profile metadata and routing rules through the canonical AIO settings/config
system with Zod validation. Credentials and observed token material are excluded.

On first launch after the feature ships:

1. If no Copilot profiles exist, create one legacy profile bound to the existing
   `copilot-cli-home` directory (or exact `AI_ORCHESTRATOR_COPILOT_HOME` override).
2. Read bounded identity metadata from its config. If present, use a neutral label such
   as `Existing Copilot account` and record the verified login/host. If absent, create
   the same profile as unauthenticated.
3. Mark it `default-eligible`, `allow-routed`, and default to preserve current behavior.
4. Do not create routing rules automatically; one account preserves the old global
   behavior outside protected scopes.
5. Existing history/session records without `copilotAccountProfileId` resolve to the
   legacy profile only. Once stamped, they retain it.

Adding a second profile changes safety behavior: the setup flow requires routing rules
or an explicit confirmation that the default handles unmatched workspaces. Enterprise
profiles remain matched-only by default.

Deleting a routing rule never rewrites existing instance/history profile IDs.

## 17. Security and privacy

- Account profiles contain no secret values.
- IPC, remote RPC, logs, telemetry, crash reports, review artifacts, and diagnostics
  use profile IDs/labels and bounded identity metadata only.
- Token environment variables are removed before Copilot spawn, not merely redacted
  after logging.
- AIO does not call `gh auth token`, `copilot` token-export functionality, macOS
  `security ... -w`, or equivalent secret-returning commands.
- Profile IDs are generated/validated safe identifiers. Labels, logins, hosts, and
  repository metadata never become shell fragments or filesystem paths.
- Login launch uses structured arguments and a derived environment. Any unavoidable
  terminal command rendering uses a single audited platform-safe quoting helper.
- Config files are size-bounded and parsed as data. Unexpected fields are ignored.
- Symlinks cannot escape the AIO provider-state root during home resolution.
- Rule mutation is a privileged user setting. Agents may read the resolved profile
  label/reason but cannot create rules, change a default, weaken protected scope, or
  change automation policy through ordinary settings tools.
- A profile identity mismatch fails closed even when a valid token exists for another
  stored account.

## 18. Error handling and observability

Add structured route and binding events:

```text
copilot_account_route_resolved
copilot_account_route_blocked
copilot_account_binding_checked
copilot_account_identity_mismatch
copilot_account_login_launched
```

Each event may include instance/workspace IDs, invocation origin, profile ID, routing
source, rule ID, node ID, and failure code. It must not include tokens, raw config,
environment values, prompt content, or browser/device codes.

Expected user-facing failures include a direct remedy:

- no route -> map this workspace or choose an account;
- profile not authenticated -> sign in for this profile on this node;
- identity mismatch -> reauthenticate or explicitly adopt the observed account;
- protected scope conflict -> fix overlapping owner/path rules;
- automation disallowed -> change that profile's automation policy or select another
  provider explicitly; and
- unavailable remote binding -> sign in on that worker or change placement.

Routing resolution and binding checks are cached briefly by canonical repository root,
rules version, profile ID, and node ID. Settings changes, remote changes, login repair,
or identity mismatch invalidate the cache.

## 19. Test strategy

### 19.1 Pure resolver tests

- explicit, exact repository, owner, longest path, and default precedence;
- case and `.git` normalization;
- HTTPS, SSH, enterprise host, SSH alias, nested repo, worktree, no-remote, and non-git
  workspaces;
- multiple remotes resolving to one profile succeeds;
- different-profile remotes/rules fail as ambiguous;
- protected unmatched paths fail closed;
- enterprise matched-only profile is never a default fallback;
- context-free invocation policy; and
- rule/path boundary and symlink behavior.

### 19.2 Profile and environment tests

- home derivation cannot escape the provider-state root;
- legacy override remains exact and new profiles use safe siblings;
- `COPILOT_HOME` reaches ACP, exec, and SDK/server modes;
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` are absent from OAuth profile
  children even when present in the AIO parent;
- `COPILOT_GH_HOST` follows the profile;
- existing `NODE_OPTIONS` behavior remains; and
- profile config parsing is bounded, JSONC-aware, and redacts raw content.

### 19.3 Lifecycle tests

- creation stamps the resolved profile before spawn;
- every respawn and hibernate/wake retains it;
- native resume refuses a different profile;
- changed routing rules affect new sessions only;
- removal/identity drift parks restore rather than using default;
- explicit account handoff creates a fresh provider session and visible note;
- failover to Copilot resolves once and does not cross-account retry; and
- parent/child and automated invocations carry the correct route.

### 19.4 Automation tests

- coarse `providersExcludedFromAutomation` still wins;
- `allow-routed`, `manual-only`, and `disabled` policies are enforced for every
  automatic surface;
- an enterprise repository uses enterprise while a personal repository uses personal
  under concurrent load; and
- a blocked account route may allow normal provider fallback but never Copilot-account
  fallback.

### 19.5 Remote-node tests

- RPC carries safe profile metadata only;
- worker derives its own home and never receives controller paths/tokens;
- unavailable worker binding fails before Copilot spawn;
- placement prefers a matching bound node without changing account; and
- disconnect/retry does not lose or recalculate the stamped profile.

### 19.6 UI and IPC tests

- account/rule CRUD schemas reject invalid hosts, IDs, paths, and overlapping rules;
- settings policy prevents agent mutation;
- resolved profile and reason render on session creation/details;
- Start is blocked with actionable text when resolution fails;
- removal guards active/restorable sessions; and
- profile-by-node status never exposes credential material.

### 19.7 Real runtime verification

With two test accounts or approved real accounts:

1. authenticate each isolated profile;
2. verify identity metadata independently;
3. run simultaneous Copilot prompts in mapped personal and enterprise repositories;
4. confirm each request is attributed to the expected account using Copilot's safe
   `/user`/account reporting or approved billing evidence;
5. change the globally active `gh` and ordinary Copilot account and confirm AIO routes
   remain unchanged;
6. launch AIO with ambient token variable names present and confirm profile spawns
   strip them without printing values;
7. restart AIO and verify restored sessions retain their original account; and
8. repeat on a bound remote worker if remote support ships in the same release.

Checks requiring real OAuth/browser interaction, multiple account billing, or rebuilt
worker deployment belong in a `_livetest.md` document during implementation. Unit and
integration behavior must not be deferred.

## 20. Acceptance criteria

1. James can add personal and enterprise Copilot profiles without placing a token in
   AIO-managed settings, SQLite, logs, or repository files.
2. James can map GitHub repositories/owners and canonical path prefixes to a profile.
3. A new Copilot session shows its resolved account and routing reason before spawn.
4. Simultaneous personal and enterprise sessions remain pinned to their own profiles.
5. Exact repository rules beat owner rules; owner rules beat path rules; the longest
   path rule wins; protected ambiguity blocks.
6. Unmatched, unprotected workspaces use only a default-eligible default profile.
7. Enterprise profiles are matched-only by default and never receive context-free
   automatic calls by default.
8. Ambient `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` cannot override an
   OAuth-backed AIO account route.
9. Restore, resume, hibernate/wake, runtime respawn, and model changes preserve the
   session's profile ID.
10. A profile change never native-resumes a session from another profile.
11. Authentication failure, policy denial, quota failure, and identity drift never
    trigger a retry through another Copilot account.
12. All interactive and automatic Copilot request-producing paths pass through the
    central resolver; tests identify any bypass.
13. Remote execution uses a node-local binding for the resolved profile and never
    transmits a token or controller home path.
14. Provider status, Doctor, quota attribution, and account-sensitive model failures
    identify the relevant profile and never misattribute another account's state.
15. Existing one-account installations continue through a migration-created legacy
    profile without moving their current Copilot state.
16. Profile/rule mutation is user-controlled and not writable by ordinary agents.
17. Focused tests plus the canonical project verification checklist pass.
18. Required multi-account live checks are recorded and completed, or explicitly
    deferred under the repository's `_livetest.md` contract after all agent-runnable
    checks pass.

## 21. Expected implementation surfaces

The implementation plan should confirm exact files after a fresh read, but the design
is expected to touch:

- shared account/rule/route types and Zod IPC schemas;
- settings defaults, metadata, migrations, and agent-control policy;
- a new Copilot account profile/home/binding service;
- a new pure repository/path routing resolver;
- `UnifiedSpawnOptions`, spawn preflight, adapter factory, and remote worker spawn RPC;
- Copilot ACP and SDK/server-mode environment propagation;
- instance/session/history persistence and resume fingerprints;
- provider login launcher and provider auth status;
- provider quota/Doctor/model-discovery attribution;
- provider settings and new-session/instance-detail Angular surfaces; and
- focused unit, integration, renderer, remote-node, migration, and runtime tests.

An implementation plan now exists (linked above). Its "Verified findings that change the
spec" section records fourteen points where a fresh read of the code and of the installed
Copilot CLI contradicted or extended this draft; the plan takes precedence where they conflict.

## 22. Decisions recorded in this draft

| # | Decision | Choice |
|---|---|---|
| D1 | Isolation mechanism | Separate `COPILOT_HOME` per account profile |
| D2 | Primary routing signal | Normalized GitHub remote host/owner/repository |
| D3 | Fallback routing signal | Canonical protected/unprotected path-prefix rules |
| D4 | Default behavior | Personal/default-eligible profile only outside protected scopes |
| D5 | Enterprise default | `matched-only` |
| D6 | Concurrent switching | Never mutate shared `/user switch` state |
| D7 | Credential handling | Copilot OAuth/keychain only; no AIO token storage/injection in v1 |
| D8 | Ambient auth variables | Strip from OAuth profile spawns |
| D9 | Session rule changes | Affect new sessions only |
| D10 | Cross-account continuation | Explicit fresh-session handoff; never native resume |
| D11 | Account failure fallback | No automatic fallback to another Copilot account |
| D12 | Remote nodes | Same profile ID, independently authenticated node-local binding |
| D13 | Existing installation | Preserve existing home as a legacy profile |
| D14 | Automation controls | Existing provider-wide exclusion plus per-profile policy |
| D15 | Quota uncertainty | Unavailable is preferable to cross-account misattribution |

## Appendix A — Verified existing foundations

| Capability | Existing location | Reuse/change |
|---|---|---|
| AIO Copilot state isolation | `cli/adapters/adapter-factory.ts` | Generalize one home into profile homes |
| Copilot home derivation | `cli/adapters/adapter-spawn-helpers.ts` | Replace singleton resolver with profile-safe resolver |
| Unified spawn metadata | `cli/adapters/adapter-factory.types.ts` | Add resolved safe route |
| Spawn preflight | `instance/lifecycle/instance-spawn-preflight-chain.ts` | Add account resolution/admission |
| Repository remote parsing | `vcs/remotes/git-host-connector.ts` | Reuse and harden for aliases/conflicts |
| Login terminal launcher | `providers/provider-login-launcher.ts` | Add structured profile-aware Copilot login |
| Session identity/lifecycle | `shared/types/instance.types.ts`, `instance/instance-lifecycle.ts` | Persist profile and fingerprint it |
| Automation provider guard | `providersExcludedFromAutomation` | Retain as coarse override; add profile policy |
| Remote spawn transport | `cli/spawn-worker/`, `remote-node/` | Carry profile identity, derive home remotely |
| Copilot login-state probe | `provider-quota/copilot-quota-probe.ts` | Point at profile home and expose profile identity |
| Copilot usage probe | `provider-quota/copilot-usage-endpoint-probe.ts` | Require provable profile attribution or report unavailable |
| Live CLI capability | installed Copilot CLI 1.0.80 | Supports multiple users, OAuth login, and `COPILOT_HOME` |

## Appendix B — Upstream behavior relied upon

GitHub Copilot CLI currently:

- supports multiple stored accounts and remembers a last-used account;
- switches interactively with `/user switch`;
- stores OAuth credentials in the operating-system credential store when available;
- uses `COPILOT_HOME` for configuration/state location; and
- resolves credentials in this order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, stored OAuth, then GitHub CLI fallback.

These are runtime dependencies, not assumptions hidden inside the router. AIO's Doctor
and tests must detect incompatible upstream changes and fail with an actionable error
rather than silently reverting to another identity.
