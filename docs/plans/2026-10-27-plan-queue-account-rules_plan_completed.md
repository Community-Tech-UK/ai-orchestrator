# Plan Queue: "never use" and "use last" account rules

Status: implemented and verified 2026-10-27. Approved by James 2026-10-27 (review page: overall APPROVED;
decision 5 = option A, "last across the whole run"; decision 9 left unmarked under the overall approval). The live
checks that need a rebuilt app and real accounts are deferred to
[2026-10-27-plan-queue-account-rules_livetest.md](2026-10-27-plan-queue-account-rules_livetest.md).
Requested by James, 2026-10-27: "I'd like the ability when using plan-queue to try and keep certain
accounts from being used, as a preference and as a hard rule. I.e. never touch "SuasClaude" or
whatever the account is named, or "please use this last"."

Builds on [2026-10-13-plan-queue-provider-account-control_plan_completed.md](2026-10-13-plan-queue-provider-account-control_plan_completed.md)
(per-run provider/account choices, account fence, automatic-work origins).

## In short

Add one list on the Plan Queue page where every signed-in account (Claude, Codex, MiMo and Copilot)
can be set to **Use normally**, **Use last** or **Never use**. The queue reads it every time it starts
or moves a session, so a change applies straight away, including to runs already going:

- **Never use** is a hard rule. No queue session (worker, triage or checker) starts on that account,
  switches onto it when another account runs out, or wakes up on it. A queue session already running
  on it when you add the rule is stopped at a safe point and restarted on an allowed account. If no
  allowed account is left, the document waits with a plain reason instead of using it.
- **Use last** is a preference. The queue uses that account only when every other option it has for
  that job cannot run at all (out of usage, waiting for a limit to reset, or signed out). Being close
  to a limit does not count: the queue keeps using your other accounts right up to their limit first.

Neither rule affects sessions you open yourself, automations or loops.

## What already exists (and why it isn't enough)

Checked in the code on 2026-10-27:

1. **Settings → Accounts → "Manual only" / "Never"** (`automationPolicy`) already keeps an account away
   from *all* automatic work: Plan Queue, automations, loops and failover. If that is what you want for
   SuasClaude, it works today. It cannot say "keep it away from the Plan Queue only", and it has no
   "use last" option. (`src/main/providers/account-pool/provider-account-selector.ts` `accountVetoFor`.)
2. **Account priority order** in a pool already prefers lower-numbered accounts for every session. It is
   a weak "use last": the pool steers new sessions off any account at 90% usage
   (`preemptive.thresholdPct`), so the lowest-priority account gets picked as soon as the others reach
   90%, not when they run out. It also only orders accounts within one provider, and it affects every
   session in the app.
3. **Plan Queue worker/checker choices** (Plan Queue page, "Providers and accounts") can tick the
   accounts a run may use. That is an allow list per choice. It does not cover checkers chosen
   automatically, the worker inherited from the starting session, or Copilot accounts picked by folder
   rules, and you would have to re-tick every choice to keep one account out.

## Decisions (numbered so James can answer by number)

1. **Plan Queue only.** The rules apply to queue sessions (workers, triage, checkers). Everything else
   keeps the existing account settings. *Assumption from the request.*
2. **One saved list, applied live.** New operator-only setting `planQueueAccountRules`, edited on the
   Plan Queue page. Unlike worker/checker choices (fixed when a run starts), it is read every time the
   queue starts or moves a session, so a change reaches runs already going. Agents cannot change it
   (same protection as `planQueueRouting`), and a run with `relaxSettings` does not relax it.
3. **"Never use" beats every other choice.** A saved or per-run worker/checker choice that ticks a
   "never" account is refused with the account's name; the panel refuses to save that combination.
   The starting session's account is not inherited if it is on the "never" list (the pool picks
   another allowed account instead, and the run status says so). A pooled choice whose every usable
   account is "never" is refused at start.
4. **"Never use" on a Copilot account** blocks Copilot wherever that account is the one the folder
   would use. For a worker choice, the run start is refused. For a checker, that checker is skipped. In
   a protected work folder whose seat is "never", automatic checking cannot use the seat, so the item
   parks with "the work Copilot seat for this folder is on your never-use list; choose checkers on the
   Plan Queue page", unless saved checkers replace the seat (they already can). Copilot never switches
   accounts mid-session, so there is no failover case.
5. **"Use last" means last across the whole run, not just within one provider** (James chose this,
   2026-10-27). With workers "1. Claude, 2. Codex" and SuasClaude set to "use last", a new worker goes
   to another Claude account, then to Codex, and only then to SuasClaude. The rejected alternative was
   "last among the Claude accounts, but still before trying Codex".
6. **"Use last" ignores the 90% steer.** A "use last" account is chosen only when no other allowed
   account can run at all. Pre-emptive moves (moving a live session off an account at 90%) never move
   onto a "use last" account. A session that has had to fall back to a "use last" account stays there
   until its session ends; new sessions go back to your preferred accounts once they have usage again.
   No moving back and forth mid-document.
7. **Inherited accounts.** The starting session's account is not inherited when it is "use last"
   either: the run then uses the pool's normal pick, with that account in the last tier.
8. **A newly banned account mid-run.** When "never use" is added while a queue session is running on
   that account, that one document is held at a safe point (the same hold "Pause" uses: worktree and
   branch kept, worker stopped) and restarted on an allowed account. Other documents are untouched.
   Adding "use last" never stops anything; it applies to the next session.
9. **Accounts that disappear** from Settings stay in the list as "account no longer exists" until the
   next save on the Plan Queue page drops them. A rule naming a missing account never blocks a run.

Not in scope: a global (whole-app) version of these rules; sessions that a queue worker itself starts
(already a known gap of the account fence); a session restored by hand through crash recovery (rebuilt
without queue routing, same known gap). These are recorded so they are not mistaken for done.

## Technical design

### Setting and contracts

- `packages/contracts/src/schemas/plan-queue.schemas.ts`: `PlanQueueAccountRefSchema`
  (`{ provider: 'claude' | 'codex' | 'opencode' | 'copilot', accountId }`, strict) and
  `PlanQueueAccountRulesSchema` (`{ never: AccountRef[], last: AccountRef[] }`, strict, max 50 each,
  refined so one account cannot be in both lists). `DEFAULT_PLAN_QUEUE_ACCOUNT_RULES = { never: [], last: [] }`.
  Provider is part of the reference because pool and Copilot profile IDs are separate namespaces.
- Setting `planQueueAccountRules`: `settings.types.ts`, `settings-defaults.ts`, metadata (hidden,
  bespoke panel, like `planQueueRouting` in `settings-metadata-review-network.ts`),
  `settings-surfacing.ts`, `settings-control-policy.ts` (read-only tool tier + privileged-CLI
  operator-only anchor; bump the anchor count in the docs and its pinning test), `settings-export.ts`.
- Kept separate from `planQueueRouting` on purpose: routing is fixed per run at start; these rules are
  live. Mixing them would make one setting mean two different things.

### Generic account-pool support (not queue-specific)

The pool learns two optional per-session lists. Nothing outside the queue sets them, so other
sessions behave exactly as today.

- `src/shared/types/instance.types.ts`: `accountPreferences?: { avoid: string[]; last: string[] }` on
  `Instance` and `InstanceCreateConfig` (pool profile IDs for the session's own provider), next to
  `allowedAccountProfileIds`. Carry it through every place the fence goes today:
  `instance-create-builder.ts:124`, `session-continuity.types.ts:167`,
  `session-continuity-instance-state.ts:83`, `account-route-preflight.ts:70-74` (restore) and `:91/139`
  (attach), `instance-spawn-preflight-chain.ts:152`, `instance-lifecycle.ts:850`
  (`createRuntimeAdapter`).
- `provider-account-routing-service.ts` `AccountRouteRequest`: `avoid?` and `useLast?`.
  - `avoid` filters candidates after `restrictTo`. An explicit avoided profile fails
    `automation-disallowed` with a message naming the account and the Plan Queue list. A legacy-only
    pool whose legacy sign-in is avoided fails the same way.
  - **Persisted profile now avoided** (wake, restart, respawn after James added the rule): today a
    persisted profile always wins (line ~252), and the fence never shrinks, so this case could not
    happen before. It now routes like `moveOffParkedPersisted`: resolve within the allowed accounts with
    source `failover`, subject to the same continuation rules. When the thread cannot move (a replay
    pool resuming its own thread) it fails `automation-disallowed`; the queue then starts a fresh
    worker for that document (verify that path in the coordinator's respawn handling and test it).
  - `useLast` makes `resolveDefault` select in tiers: preferred accounts with the threshold, preferred
    without the threshold, then last-tier accounts. The "everything parked, wait for the soonest reset"
    fallback is unchanged and considers all allowed accounts.
- `provider-account-selector.ts`: no change to vetoes; tiering lives in the routing service and the
  failover coordinator so the pure selector stays a single-tier ordering.
- `account-failover-coordinator.ts` (~line 538): read `accountPreferences` from the instance (live, as
  the fence is read today); add `avoid` to `exclude`; select preferred tier first, then last tier; a
  `preemptive` handoff never targets the last tier (decision 6).

### Copilot

- `copilot-account-routing-service.ts` `CopilotRouteRequest`: `avoidProfileIds?`. When the resolved
  profile (explicit, rule-matched or default) is in it, fail `automation-disallowed` naming the
  account. Never fall back to another Copilot account (the router's existing rule).
- A side-effect-free `previewProfileFor(workingDirectory, explicitProfileId?)` (rule matching and
  precedence only, no admission or sign-in check), used by run-start validation, ranked worker choices
  and checker selection. Confirm during implementation whether an existing method already does this
  before adding one.
- `attachCopilotRoute` passes `avoidProfileIds` from the create config. No persistence needed: a
  Copilot session keeps its stamped account, and a banned one is replaced by a new session (decision 8).

### Plan Queue

- `plan-queue-routing.ts`
  - `PlanQueueRoutingDeps.readAccountRules()` (live setting).
  - `assertRouteChoice`: a ticked "never" account, a Copilot choice whose account resolves to a "never"
    profile, or a pooled choice with no ticked accounts where every enabled, automation-allowed account
    is "never" → `PlanQueueRoutingError` with the account label.
  - `inheritedWorker`: drop a "never" or "last" parent account (decisions 3 and 7) and say so in the
    run's status.
  - `routeQueueSpawn` (the single `createInstance` chokepoint for every worker, triage and checker
    spawn, including respawns): set `accountPreferences` for pooled providers and the Copilot avoid list
    from the live rules, filtered to the spawn's provider.
- `plan-queue-route-usage.ts`: `planQueueRouteUsage` takes `{ avoid, last }`; `pickRouteChoice` makes
  two passes: first with "last" accounts treated as unavailable, then with them allowed (decision 5).
  "Never" accounts are unavailable in both passes. Copilot choices use `previewProfileFor`.
- `plan-queue-verifier-select.ts`: `selectFromChoices` skips choices that can only run on "never"
  accounts (reason in the skip list) and ranks via the two-pass picker. Automatic selection moves a
  provider whose only usable route is a "last" account to the end of the order, and drops a Copilot
  candidate (including `licence-pinned`) whose profile is "never" (decision 4).
- Live changes: the coordinator subscribes to `planQueueAccountRules` changes. For each live queue
  instance it rewrites `accountPreferences` (and persists session state) so failover sees the new
  lists at once. Any live queue session whose current pool account or Copilot profile is now "never"
  has its item held with `holdItem` (`plan-queue-run-hold.ts`) and the pump requested, so it restarts
  under the new rules. Must take the same lock the hold path already requires; test it against a run
  that is pausing and against a landing in progress.
- `plan_queue_status` / `describeRouting`: add an "Account rules" line (account labels, not IDs).

### Renderer

- New `plan-queue-account-rules-panel.component.*` on the Plan Queue page, below "Providers and
  accounts": one row per account grouped by provider, a three-way choice (Use normally / Use last /
  Never use), Save, and the saved-state message pattern the routing panel already uses (real save
  error shown, edits kept on failure). Read `docs/screen-and-wording-guide.md` first.
- `plan-queue-routing-panel.component.ts`: grey out "never" accounts in the tick lists with "on your
  never-use list"; label "use last" accounts. Refuse to save a choice that ticks a "never" account.
- Standalone, OnPush, signals, `inject()`.

### Docs

- `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`: the new setting (read-only for agents),
  the status line, and the privileged-anchor count.

## Implementation checklist

- [x] Contracts and setting `planQueueAccountRules` (schema, defaults, metadata, surfacing, control policy,
      export). Schema tests: `packages/contracts/src/schemas/__tests__/plan-queue-account-rules.schemas.spec.ts`.
      The privileged-anchor pin is now 26 (`orchestrator-settings-tools.spec.ts`) and both docs say 26.
- [x] Instance `accountPreferences` through create config, record, session state, restore, spawn preflight and
      `createRuntimeAdapter`. Tests beside the fence tests (create builder, preflight chain, restore stamp,
      continuity state).
- [x] Routing service: `avoid`, `useLast`, persisted-but-avoided move or refusal, legacy-only refusal. Tests:
      `provider-account-routing-service.account-rules.spec.ts`.
- [x] Failover coordinator: avoid, tiers, no pre-emptive move onto the last tier. Tests in
      `account-failover-coordinator.spec.ts` ("account rules").
- [x] Copilot router `avoidProfileIds` and `previewProfileFor`. Tests in `copilot-account-routing-service.avoid.spec.ts`
      and `copilot-account-routing-service.spec.ts`.
- [x] Plan Queue routing, route usage two-pass picker, verifier selection, status line. Tests:
      `plan-queue-routing.account-rules.spec.ts`, `plan-queue-account-rules.spec.ts`,
      `plan-queue-verifier-select.spec.ts`, `plan-queue-route-usage.spec.ts`, `plan-queue-spawn.spec.ts`.
- [x] Live rule changes: preference rewrite and per-item hold for newly banned accounts. Tests:
      `plan-queue-account-rules-live.spec.ts`, `plan-queue-pause-control.spec.ts` (ban restarts only the held
      document; use-last stops nothing; a rule during a pause waits; a hold queued for a moved-on item does nothing),
      `plan-queue-pause-landing.spec.ts` (a rule change before the merge lets the landing finish).
- [x] Renderer panel and routing panel greying (component specs; `npm run build:renderer` and `npm run lint` pass).
- [x] Docs: `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`.
- [x] Mutation checks, each confirmed caught by a failing test and restored: avoid filter in the routing service,
      persisted-avoided move, failover avoid, pre-emptive last-tier block, two-pass order, Copilot avoid, live hold,
      verifier never-skip, queued-hold guard under the item lock, cancel-on-rule-hold landing abort.
- [x] Canonical gates on the final state: `npx tsc --noEmit -p tsconfig.json` and
      `-p tsconfig.electron.json`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
      `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`
      (2,819 files, 35,603 tests passed).
- [x] Fresh-eyes completion gate: six independent reviews. Rounds 1 to 5 returned defects, all fixed and
      covered by tests; round 6 returned `VERDICT: PASS` on the final state (two low-severity edges accepted, see
      below).
- [x] Live checks moved to `2026-10-27-plan-queue-account-rules_livetest.md` (pending: needs a rebuilt app and real
      accounts).

## As built

Decisions 1 to 9 hold as written. Deviations and additions, each made during implementation:

- `previewProfileFor` takes the origin as a second argument. The manual-only policy depends on origin, so a
  signature without it could not give the answer a queue spawn gets.
- The Copilot "never use" refusal runs in the routing service, after the decision and before the event is reported
  (`refuseAvoidedCopilotRoute`). `attachCopilotRoute` also refuses an already-attached route on the list.
- The live-change logic is in `plan-queue-account-rules-live.ts`, not in the coordinator, because the coordinator is
  at its file-length limit. The pure rules are in `plan-queue-account-rules.ts`.
- A targeted (rule-change) hold does not cancel a landing in flight. It queues behind the landing under the item
  lock, and `holdUnlocked` runs the landing first. Pause still cancels, as before. This was changed after review
  round 5, so a rule change never aborts a landing that was about to merge.
- A triage session on a newly banned account is paused. The pump respawns it with the new lists, as it does for any
  paused triage.
- Persisted sessions moved off a never-use account do not need the pool's failover mode to be `automatic`: the
  move was asked for by James, not chosen by the pool.
- The inherited starting account note appears in the `plan_queue_start` message, not the run status.
- File-length ratchet entries (`scripts/check-ts-max-loc.ts`) were raised with dated reasons for:
  `instance-lifecycle.ts` (3642), `instance.types.ts` (915), `settings.types.ts` (891), and new entries for
  `copilot-account-routing-service.ts` (739), `plan-queue-coordinator.ts` (727) and `plan-queue-item-flow.ts` (706).
  The coordinator and item-flow entries include other uncommitted Plan Queue work in the same tree; re-tighten
  after that work is committed and the files are split.

## Known residual edges (accepted)

- A restart can wait behind a slow landing, because the pump is requested after every hold settles. The periodic
  pump bounds the delay.
- A hold that lands on a landing which then falls back to fixing can stop a replacement worker that a since-ended
  session left behind, costing one extra restart. No data is lost and the banned account is not used.
- A hold on an item whose `detail` already has text does not record the never-use note, so the resume wording falls
  back to the default. Cosmetic.
- A queued hold re-checks the session but not the rule set. A ban removed in the same moment still restarts the
  session. Harmless.
- A hold that arrives between a PASS verdict and the verification handler releasing the item lock runs the landing
  itself, outside the cross-run landing chain. The same path existed before this change; git writes still go
  through the git write queue.

## Risks

- **Crash and concurrency paths** are where this subsystem's past defects were (park vs prepare, cancel
  vs start). The live-change hold is the new one: test the rule change racing a pause, a cancel and a
  landing.
- **Wake onto a banned account** is new behaviour for the routing service (a persisted account no
  longer always wins). It is limited to sessions that carry an avoid list, so non-queue sessions are
  unaffected; a test must pin that.
- **ts-max-loc**: `plan-queue-routing.ts` (408 lines) and the routing panel (536 lines) are already
  large; put the rules logic in a new `plan-queue-account-rules.ts` rather than growing them.
