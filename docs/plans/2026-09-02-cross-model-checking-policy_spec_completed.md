# Cross-model checking policy — differentiate the checker by model, not by exclusion

Status: COMPLETED — implementation plan:
[2026-09-02-cross-model-checking-policy_plan_completed.md](./2026-09-02-cross-model-checking-policy_plan_completed.md)
Live checks deferred to
[2026-09-02-cross-model-checking-policy_livetest.md](./2026-09-02-cross-model-checking-policy_livetest.md)
Date: 2026-09-02
Origin: James's request —

> "When we use the enterprise github copilot account for a ticket, we should route the
> checking we do through other models. I.e. if we use codex, we should check with claude
> and vice versa."

Direction confirmed by James, 2026-09-02:

1. Keep enterprise ticket work **on the employer's licence**, and get the cross-check by
   using **different models on that same seat**.
2. The check has to produce **correct output** — a real second opinion, not a rubber stamp.
3. **Nothing gets barred.** Providers stay eligible; they work differently instead.
4. **Hardcode** the policy. No new settings.

## 1. Problem

Six surfaces pick who checks work. They differentiate on the *provider* axis and do it
inconsistently: three exclude the implementer, three do not, and one guesses the
implementer was Claude when nobody told it otherwise.

Provider is the wrong axis. Copilot fronts Anthropic, OpenAI, Google, xAI, Moonshot and
Microsoft models, so "Copilot checks Copilot" can be a genuine cross-model check, while
"Claude CLI checks Copilot-running-claude-opus-5" is self-review wearing a different
provider's name. The axis that matters is the **model family**.

## 2. Verified facts

Everything below was read or executed in this session.

### 2.1 The defect that prompted this

`src/main/orchestration/loop-coordinator-completion-gates.ts:426-441` calls the fresh-eyes
reviewer without `builderProvider`, though `loop-fresh-eyes-reviewer.ts:89,264` accepts it.
`src/main/orchestration/cross-model-review-service.ts:678,687` then fills the blank with
`request.primaryProvider ?? 'claude'`.

Consequences, verified end to end:

- Enterprise-Copilot ticket work → **Claude is barred from checking it**; the check falls
  to Cursor/Codex. Exactly backwards.
- Codex builder → Claude barred, and **Codex is eligible to review Codex**.
- Claude builder → accidentally correct.

`src/main/cli-entrypoints/review-command.ts:145-151` (`aio review`) passes no implementer
at all and inherits the same default.

Surfaces that are already right: in-session cross-model review
(`instance-event-forwarding.ts:418` passes the real `instance.provider`, filtered at
`reviewer-pool.ts:78`) and the ping-pong reviewer
(`agentic-pingpong-reviewer.ts:207-216`).

### 2.2 The EBRD seat can genuinely check itself across families

Run against the enterprise profile home
(`copilot-cli-profiles/lawrencj`, `ebrd.ghe.com`), the seat's own API returned an
authoritative roster in a `model_call_failure` event:

> `The requested model is not available for integrator "copilot-developer-cli". Available
> models: [gpt-4.1 claude-fable-5 claude-opus-4.7 claude-opus-4.8-fast claude-opus-4.8
> claude-opus-5 claude-sonnet-5 … gemini-3.5-flash gemini-3.6-flash gemini-3.7-flash
> gpt-5.3-codex gpt-5.4-mini gpt-5.4 gpt-5.5 gpt-5.6-luna gpt-5.6-sol gpt-5.6-terra
> grok-4.5 grok-4.6 kimi-k2.7-code kimi-k3 mai-code-1.1-flash …]`

That seat has actually run `claude-sonnet-5`, `gpt-5.4` and `gpt-5.4-nano`. So building on
`claude-opus-5` and checking on `gpt-5.6-terra` (or vice versa) is available **inside the
employer licence**, which is exactly what requirement 1 asks for.

### 2.3 The app cannot currently see a seat's real entitlements

`CopilotCliAdapter.listAvailableModels()`
(`src/main/cli/adapters/copilot-cli-adapter.ts:1081-1126`) discovers models by spawning
`copilot --no-auto-update --log-level none help config` and parsing the output. The cache
is correctly profile-scoped (`:85-114`), but the data is not: running that command against
the personal home and the enterprise home returns **the same 28-model list**. It is a
static build-time roster, not seat entitlements.

The two lists disagree in both directions — `help config` advertises `claude-sonnet-4.6`,
`claude-opus-4.6` and `gemini-3.1-pro-preview`, which the EBRD seat does not serve; the
seat serves `grok-4.6`, which `help config` does not list.

Consequence for this design: a checker model must be chosen from an ordered candidate list
and the "not available for integrator" 400 must be handled, not assumed away. Related live
misconfiguration: `crossModelReviewModelByProvider.copilot` is `claude-sonnet-4.6`, which
that seat would reject.

### 2.4 Where the implementer's model already lives

| Surface | Implementer model available? | Field |
| --- | --- | --- |
| Loop fresh-eyes gate | **Yes** | `LoopIteration.model` (`loop-state.types.ts:258-259`), already in scope at the gate |
| In-session cross-model review | Yes, via lookup | `Instance.currentModel` (`instance.types.ts:538`); `OutputBuffer` does not carry it |
| Ping-pong reviewer | Yes, via the same lookup | reviewer model comes from `resolveReviewerModelOverride()` |
| Consensus | **Yes, per participant** | `ConsensusProviderSpec.model` (`consensus.types.ts:9`) |
| Headless review / `aio review` | No | `HeadlessReviewRequest` (`review-execution-host.ts:76-89`) has no model field |
| CLI verification panel | No | `AgentConfig` (`cli-verification-extension.ts:50-56`) has no model field |

`LoopConfig` has no model field — only `provider` (`loop.types.ts:534`) — but the loop
resolves each iteration's model through `resolveAutomationDefaultModel()`
(`automation-model-defaults.ts:44`, reading `loopModelByProvider`) and records the result
on the iteration, so nothing new has to be plumbed for the loop path.

### 2.5 Model-family classification is currently too coarse

`modelProviderFamily()` (`automation-model-resolution.ts:99-117`) returns only `'claude'`
or `'codex'` and is deliberately conservative — gemini, grok, kimi and mai ids all return
`undefined`. It is a provider-routing guard, not a vendor classifier, and it cannot express
"gpt-5.6-terra and gpt-5.3-codex are the same family".

### 2.6 The licence guard currently blocks the whole approach

`providersExcludedFromAutomation = ["copilot"]` (live setting). Copilot routing rejects any
automatic origin outright at
`copilot-account-routing-service.ts:170-185` before per-profile policy is even considered,
and `'review'`/`'verification'` are automatic origins
(`copilot-account.types.ts:148-157`). So today no Copilot account can check anything.

Also relevant: `accountKind: 'enterprise'` exists on profiles
(`copilot-account.types.ts:23`) but is label-only, and the account resolver
(`copilot-account-resolver.ts:234`) is a pure function, so a workspace can be classified
without a spawn or an auth check.

## 3. Requirements

R1. **Family diversity.** A checker must run a model from a different family than the
implementer's model. Family, not provider, is the unit of difference.

R2. **Licence containment.** When the workspace routes to an enterprise Copilot profile,
every checker for that work runs on **that same profile**. Employer code does not go to
Claude, Codex, Cursor or a personal Copilot seat.

R3. **Nothing is barred.** A provider whose model would collide with the implementer's
family is **re-modelled**, not dropped. Losing a checker is a worse outcome than a
same-family checker, so re-model first and only fall back to running it as-is.

R4. **Honest unknowns.** An unknown implementer provider or model constrains nothing and
is logged as unknown. The `?? 'claude'` default is deleted.

R5. **Entitlement-safe.** A chosen model that the seat rejects must degrade to the next
candidate automatically, and the real roster must be learned and cached.

R6. Hardcoded policy, no new settings keys.

## 4. Design

### 4.1 Model family classifier

New `src/shared/models/model-family.ts`:

```ts
export type ModelFamily =
  | 'anthropic' | 'openai' | 'google' | 'xai'
  | 'moonshot' | 'microsoft' | 'github' | 'unknown';

export function modelFamily(modelId: string): ModelFamily;
export function sameFamily(a: string | undefined, b: string | undefined): boolean;
```

Prefix rules covering the Copilot roster and every first-party CLI id: `claude-*`, plus
the `sonnet`/`opus`/`haiku` aliases → `anthropic`; `gpt-*`, `o1*`, `o3*`, `*-codex` →
`openai`; `gemini-*` → `google`; `grok-*` → `xai`; `kimi-*` → `moonshot`; `mai-*` →
`microsoft`; `raptor-*` → `github`. Strips a `[1m]`-style context suffix first, as
`modelProviderFamily()` already does.

`sameFamily()` returns **false** when either side is `unknown` — an unknown model must not
be treated as colliding, per R4.

`modelProviderFamily()` stays as-is; it answers a different question (which provider owns
this id) and has its own callers.

### 4.2 Checker plan resolver

New `src/main/review/checker-plan.ts`:

```ts
export interface CheckerContext {
  implementerProvider?: string;
  implementerModel?: string;
  workingDirectory?: string;
  context: string;              // call-site name, for logs
}

export interface CheckerCandidate {
  provider: string;
  model?: string;               // undefined = let the CLI pick
  rationale: 'licence-pinned' | 'family-diverse' | 'unchanged';
}

export function resolveCheckerPlan(
  candidates: readonly string[],
  ctx: CheckerContext,
): CheckerCandidate[];
```

Two branches:

**Licence-pinned** — `classifyWorkspaceCopilotScope(cwd)` returns an enterprise profile.
The plan becomes N × `{ provider: 'copilot', model: <different family> }`, all on that
profile. Models are drawn from a hardcoded family-ordered preference list, skipping the
implementer's family:

```
anthropic: claude-opus-5, claude-sonnet-5, claude-opus-4.8
openai:    gpt-5.6-terra, gpt-5.5, gpt-5.3-codex
google:    gemini-3.7-flash, gemini-3.6-flash
xai:       grok-4.6, grok-4.5
```

Ordering across families rotates by review index so two checkers on the same work do not
both land on OpenAI.

**Normal** — every other workspace. Existing provider selection runs unchanged, then each
selected checker's resolved model is compared against the implementer's. On a family
collision the checker is re-modelled to a different-family model that provider supports
(R3); if none exists, it is kept and marked `'unchanged'`, never dropped.

`classifyWorkspaceCopilotScope(cwd)` is a new thin export beside the existing pure
resolver — profiles + rules + `resolveCopilotAccountRoute()`, no admission, no auth, no
spawn, so it stays cheap enough to call per dispatch and does not fail when the enterprise
seat happens to be signed out.

### 4.3 Narrow licence-guard carve-out

`providersExcludedFromAutomation` keeps its meaning — "never *pick* this provider out of a
pool" — everywhere it applies today. The carve-out is for the one case where the app is not
picking: a workspace **protected-routed** to a specific Copilot profile *mandates* that
account, it is not chosen from a pool.

Implementation: a dedicated `isWorkspaceMandatedCopilotProfile(cwd)` consulted only by the
checking call sites and by `CopilotAccountRoutingService.resolveRouteForSpawn()` when the
origin is `'review'` or `'verification'` **and** the request's workspace resolves to a
protected rule for an enterprise profile. Scaffolding, magic prompts, consensus fan-out
outside enterprise workspaces, failover and provider preference keep the coarse guard
untouched.

This is the one deliberate loosening in the spec and it is the price of requirement 1.

### 4.4 Entitlement learning

- `parseCopilotUnavailableModelError(message)` recognises
  `The requested model is not available for integrator "…". Available models: [ … ]` and
  returns the list.
- On that error the reviewer records the roster against the profile (reusing the existing
  profile-scoped cache in `copilot-cli-adapter.ts:85-114`), drops the rejected id, and
  retries with the next candidate from the plan. One retry per candidate, bounded by the
  plan length.
- `listAvailableModels()` prefers a learned roster over the `help config` roster when one
  exists for that profile, and its doc comment gains the finding from §2.3 so nobody else
  mistakes it for entitlements.
- Copilot account Doctor surfaces the learned roster when present.

### 4.5 Per-surface wiring

| WS | File | Change |
| --- | --- | --- |
| WS1 | `src/shared/models/model-family.ts` (new) | Classifier + `sameFamily()` + tests |
| WS2 | `src/main/review/checker-plan.ts` (new) | Resolver above + `classifyWorkspaceCopilotScope()` + tests |
| WS3 | `cross-model-review-service.ts:676-692` | Delete both `?? 'claude'`; take implementer provider **and** model; run the plan |
| WS4 | `loop-coordinator-completion-gates.ts:426` | Pass `builderProvider: state.config.provider` and `builderModel: iteration.model` |
| WS5 | `review-execution-host.ts` | `HeadlessReviewRequest` gains `implementerProvider` / `implementerModel`; `dispatchReviewerPrompt` takes the planned model instead of only `resolveReviewerModelOverride()` |
| WS6 | `review-command.ts` | `--implementer <provider>` and `--implementer-model <id>`; no Claude default |
| WS7 | `cli-verification-extension.ts` | `AgentConfig` gains `model`; panel agents get family-diverse models; instance-triggered callers pass `instance.provider` / `instance.currentModel` |
| WS8 | `consensus-coordinator.ts:435-438` | Assign family-diverse models across participants via existing `ConsensusProviderSpec.model`. **No participant is excluded** |
| WS9 | `agentic-pingpong-reviewer.ts` | Reviewer model comes from the plan; keep the existing `reviewer != builder` guard as a provider-level backstop |
| WS10 | `copilot-account-routing-service.ts`, `copilot-cli-adapter.ts` | Carve-out (§4.3) and entitlement learning (§4.4) |
| WS11 | logging / provenance | Record chosen family per checker in `ReviewParticipantStatus.reason` (`cross-model-review.types.ts:12-19`) |

### 4.6 Tests

- Classifier: every id in the EBRD roster maps to the right family; unknown ids stay
  `unknown`; `sameFamily` is false when either side is unknown.
- Plan resolver: enterprise workspace yields all-Copilot candidates on the enterprise
  profile with a family different from the implementer; non-enterprise workspace re-models
  rather than drops; unknown implementer constrains nothing.
- Regression per defect: a Codex builder is never checked by a Codex-family model; an
  enterprise-Copilot builder on `claude-opus-5` is checked on an OpenAI/Google/xAI model
  **on the same seat**; `aio review` with no implementer does not exclude Claude.
- Entitlement: a simulated "not available for integrator" 400 learns the roster, retries,
  and succeeds on the next candidate.
- The five existing `*.exclusions.spec.ts` files must stay green — the coarse guard is
  unchanged outside the §4.3 carve-out, and that carve-out gets its own test asserting it
  does **not** fire for scaffolding, magic prompts or failover.

## 5. Risks

1. **The carve-out is a real loosening.** Copilot becomes automatically usable for
   review/verification inside protected enterprise workspaces. Mitigated by scope: only
   those two origins and only protected-routed enterprise profiles.

   Per-profile `automationPolicy` is enforced by the CHECKING POLICY itself
   (`checker-plan.ts`), not left to the router. An earlier draft of this spec
   claimed `copilot-account-resolver.ts`'s check covered it; that was wrong for
   ping-pong, which spawns via `InstanceManager.createInstance` and therefore
   routes with an `'interactive'` origin, and the resolver's `manual-only` branch
   only fires for an automatic origin. A `manual-only` or `disabled` enterprise
   seat now blocks checking outright — the seat is off limits and the code may
   not leave it, so there is no checker.
2. **Entitlements drift.** The static roster is already wrong for this seat in both
   directions. §4.4 makes that self-correcting rather than a silent failed review.
3. **Family diversity is not automatically quality diversity** (requirement 2). A
   `gemini-3.7-flash` check on an opus-built change is cross-family but weaker. The
   preference list is ordered by capability within each family for that reason, and the
   flash/mini/nano tiers are excluded from checker candidates entirely.

## 6. Non-goals

- No ticket/work-item model — the app has none; scope is keyed off the workspace, matching
  how Copilot routing rules already work.
- No new settings keys (requirement 4).
- No change to how `providersExcludedFromAutomation` behaves outside §4.3.
