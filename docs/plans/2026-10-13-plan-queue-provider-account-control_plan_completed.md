# Plan Queue: provider and account control

Status: completed 2026-10-13 (reopened the same day at James's request for further fresh-eyes rounds; closed after round 10 passed) — live checks deferred to [2026-10-13-plan-queue-provider-account-control_livetest.md](2026-10-13-plan-queue-provider-account-control_livetest.md).
Requested by James, 2026-10-13: "When I use plan-queue it seems to use random accounts and subs
that I dont want to use … maybe I want plan-queue to always use one or more of the following
providers and accounts … Please fix all these things together."

## Observed behaviour (verified 2026-10-13)

- Workers copy the parent session's provider and model (`plan-queue-coordinator.ts` `startRun`),
  but NOT its account. Each spawn resolves an account afresh.
- Every spawn goes through `InstanceLifecycle.createRuntimeAdapter`, which routes Copilot and
  Claude/Codex/OpenCode accounts with a hardcoded `'interactive'` origin. Queue sessions are
  therefore treated as sessions James opened himself: `manual-only` accounts are eligible and the
  pool may bill purchased credits (`allowCredits: !isAutomaticAccountOrigin(origin)`).
- Pool default = first eligible account by priority; at ≥ the pre-emptive threshold (90%) a new
  session lands on the next account; automatic failover can later move it to any pooled account.
- The verifier picks a different provider: Codex, Claude, Copilot, then other installed CLIs, minus
  `providersExcludedFromAutomation`. In a protected enterprise Copilot scope `resolveCheckerPlan`
  replaces the list with the enterprise seat (`licence-pinned`), which bypasses that exclusion.
  The live log for the 2026-10-13 runs shows exactly that: worker `codex`, verifier
  `copilot / claude-opus-5 / licence-pinned`. This repository's remote owner `Community-Tech-UK`
  matches the protected owner rule → profile `lawrencj` (the EBRD seat).
- There is no per-run or saved choice of providers/accounts.

## Decisions

1. **Saved default + per-run override.** New operator-only setting `planQueueRouting`
   (`{ worker: RouteChoice | null, verifiers: RouteChoice[] }`), edited on the Plan Queue page. A run
   snapshots the effective routing into `config.routing` at start, so a running run never changes
   under James. `plan_queue_start` may override either half for one run.
   `RouteChoice = { provider, model?, accountProfileIds?, copilotProfileId? }`.
2. **Worker.** `routing.worker` set → that provider/model/accounts. Null → the parent session's
   provider and model as today, and now also its account (Claude/Codex/OpenCode pool account or
   Copilot profile) when that account is allowed for automatic work; otherwise the pool's automatic
   choice under automation rules.
3. **Checkers.** `routing.verifiers` non-empty → only those entries, in order. An entry is usable
   when its CLI is installed, it is not on the "never auto-pick" list, and it differs from the
   worker by provider, or has a model from a different family — compared directly when the
   workers' model is named, otherwise allowed only on a catalog multi-maker CLI (copilot,
   antigravity, cursor) whose live model is normally known by verification time. The start check, the
   panel and verifier selection share this rule (`sameProviderCheckerCanDiffer`). No usable entry → the item
   parks `no-diverse-verifier` with the reason. In a protected work Copilot folder only James's
   saved list (operator-only setting) replaces the licence-pinned seat; a per-run list from
   `plan_queue_start` (an agent's call) does not, and with a per-run list an unresolvable scope
   still fails closed. (A saved Copilot entry in an ambiguous scope fails at spawn in the Copilot
   router instead.)
   Empty list → today's automatic behaviour, unchanged.
4. **Queue sessions are automatic work.** Workers and triage spawn with origin `automation`,
   verifiers with `verification`, so the "never auto-pick" list and `manual-only`/`disabled` account
   policies apply to them, and the first account pick prefers accounts that do not bill purchased
   credits. (A later usage-limit switch may move onto credits, as for any pooled session; it never
   leaves the fence.) A run with `relaxSettings` skips the list check at start, since the run
   empties that list while it runs. A provider on that list (including one
   inherited from the starting session, or the `defaultCli` an "auto" session resolves to) refuses
   the run at start. Legacy aliases (`gemini` → antigravity, `openai` → codex) are checked under
   the CLI that actually runs. Licence-mandated Copilot checking still works (`isLicenceMandated`).
   (An earlier draft exempted Copilot workers; the fresh-eyes review showed that let `manual-only`
   Copilot accounts be spent, so the exemption was removed.)
5. **Account fence.** A queue session carries `allowedAccountProfileIds`; the initial pool choice
   and every later failover / pre-emptive switch stay inside it. Persisted across hibernate/wake.
6. **Validation at start.** Explicit choices are refused up front with a plain reason: unknown
   provider, provider on the "never auto-pick" list, unknown/disabled account, account of another
   provider, account not allowed for automatic work, OpenCode accounts without a MiMo Token Plan
   model, a misspelt key (route-choice schemas are strict), checkers that all share the workers'
   provider without a model from a different maker, or a per-run checker list in a repository
   covered by a protected (or unresolvable) work Copilot rule.
7. **Inherited accounts are a hard fence** (one account → no failover; a limit parks the item until
   reset, as before pools). Predictable over clever; choose several accounts to allow failover.

## Implementation checklist

- [x] Contracts: `PlanQueueRouteChoiceSchema`, `PlanQueueRoutingSchema`, `config.routing`,
      `plan_queue_start` args `worker` / `verifiers`.
- [x] Setting `planQueueRouting`: types, defaults, metadata (hidden/bespoke), surfacing,
      control policy (read-only + privileged-CLI operator-only).
- [x] Instance: `accountRouteOrigin` + `allowedAccountProfileIds` on create config, record,
      session state (persist + restore); `createRuntimeAdapter` uses them.
- [x] Account routing service: `restrictTo` filter; failover/pre-emptive honour the fence.
- [x] Plan queue: routing module (resolve at start, validate, spawn decoration), coordinator
      wiring, verifier selection with explicit list, verifier account fence.
- [x] MCP tool schema/description + status summary.
- [x] Renderer: Plan Queue page "Providers and accounts" panel saving `planQueueRouting`;
      run list shows each run's routing.
- [x] Docs: `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`.
- [x] Tests for each layer; canonical gates.
- [x] Fresh-eyes completion gate: ten fresh reviews (FAIL → PASS+findings → FAIL → PASS → PASS → FAIL → PASS+findings → FAIL → FAIL → PASS); every actionable finding fixed and re-verified, round-10 low items resolved as noted.
- Live checks needing a rebuilt app: see the livetest document linked above.

## As-built notes

- Routing logic: `src/main/plan-queue/plan-queue-routing.ts` (`resolveRunRouting`,
  `assertRouteChoice`, `routeQueueSpawn`, `describeRouting`), applied at the coordinator's single
  `createInstance` chokepoint so first start, resume, fresh-worker respawn, triage and verifier
  spawns all get it.
- Instance fields `accountRouteOrigin` / `allowedAccountProfileIds` flow create config → record →
  spawn preflight chain (first spawn) and `createRuntimeAdapter` (respawn/wake/runtime change) →
  `attachAccountRoute({ restrictTo })` → `ProviderAccountRoutingService` filters profiles; failover
  `select()` excludes profiles outside the fence. Persisted in `SessionState`, restored by
  `restoreAccountStamp`.
- Verifier: `selectFromChoices` in `plan-queue-verifier-select.ts`; item flow passes
  `choices` and the chosen accounts.
- `planQueueRouting` is operator-only (read-only tool tier + privileged-CLI anchor; anchor count
  23 → 24 in the docs and its pinning test).
- UI: `plan-queue-routing-panel.component.*` on the Plan Queue page; run list shows each run's
  routing.
- Final verification 2026-10-13 (after round 10): `tsc --noEmit`, `typecheck:spec`, `lint`,
  `check:ts-max-loc`, `build:main`, `build:renderer` all exit 0; full `test:quiet` 2420 files /
  31273 tests passed.
- Guards mutation-checked (test fails with the guard removed): failover fence, routing-service
  fence, builder field copy, `createRuntimeAdapter` origin/fence, coordinator `relaxSettings` wiring.
- Round 6 (James asked for another fresh-eyes check): fixed a checker list that could never
  succeed (now refused at start and in the panel), a per-run checker list silently ignored in a
  protected Copilot repo while the status showed it (now refused), queue sessions opting out of
  cross-provider session failover (`failoverProviders: []`), workers re-checking the never-auto-pick
  list at spawn, the real save error reaching the panel (`SettingsStore.set`) with James's edits
  kept on a failed save, and refusal messages saying where an inherited provider came from.
- Round 7 (fresh review PASS with low findings, fixed): a same-provider checker on a single-maker
  CLI is refused when the workers' model is not named; a
  document parked because triage could not start now says why; the coordinator's injected
  exclusion check reaches `routeQueueSpawn`; tests for the empty failover list beating the global
  seed and for a worker parked by a mid-run exclusion.
- Round 8 (fresh review FAIL, fixed): round 7 had wrongly treated Antigravity as single-maker (it
  serves Gemini, Claude and GPT models). "Serves several makers" is now derived from the model
  catalog in one shared helper (`src/shared/models/multi-maker-providers.ts`: copilot,
  antigravity, cursor) used by both the start check and the panel; the triage park message is
  punctuated; the triage-start test is made deterministic.
- Round 9 (fresh review FAIL, fixed): an OpenCode worker with no named model plus an OpenCode
  checker was accepted at start but always skipped at verification (OpenCode's session model
  stays unknown). OpenCode is no longer counted as resolving a known model; the start check,
  panel and verifier selection now share `sameProviderCheckerCanDiffer`.
- Known residuals (out of scope): sessions that a queue worker itself spawns are not fenced; a
  session restored by hand through crash-recovery revival is rebuilt without the queue's origin
  and fence; with the workers' model unnamed on Copilot/Antigravity/Cursor, a same-maker checker
  model is only caught at verification (the item parks with the reason), not at start; and
  `modelFamily` does not read vendor-prefixed OpenCode ids (`anthropic/…`), so two such OpenCode
  models always count as different makers (a shared helper, left unchanged here).
- Not part of this change: the `WORKER_EVIDENCE_CLEANUP_RULE` edit in `plan-queue-prompts.ts`
  (+ spec) belongs to another session's evidence-cleanup work.
- Round 10 (fresh review PASS, low findings): wording ("normally known"), residuals above
  recorded, panel tests added for OpenCode and an unnamed Copilot worker model.
