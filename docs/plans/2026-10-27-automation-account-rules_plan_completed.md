# Automations follow the "never use" and "use last" account rules

Status: implementation present; queue worker checks passed on 2026-10-31. Ready for independent verification;
the full suite and fresh-eyes gate remain the queue verifier's responsibility.
Requested by James, 2026-10-27: "Automations should follow the same preferences for plan queue preferences for
provider accounts."

Follows [2026-10-27-plan-queue-account-rules_plan_completed.md](2026-10-27-plan-queue-account-rules_plan_completed.md),
which built the list for the Plan Queue only and said automations were not affected. This document changes that for
automations. The completed plan is not edited.

## In short

The one list on the Plan Queue page (every signed-in account set to **Use normally**, **Use last** or **Never use**)
now applies to automation runs too:

- **Never use:** a fresh automation session never starts on, switches onto or wakes on that account. If every
  account of the provider it runs on is on the list, the run fails with a plain reason instead of using one.
- **Use last:** a fresh automation session uses that account only when no other account of its provider can run.
  Pre-emptive moves at 90% usage never move onto it.

## Decisions

1. **One shared list, not a second one.** "The same preferences" means the same list. The setting key stays
   `planQueueAccountRules` (it is persisted and already wired through settings, the control policy and the docs);
   its label, description and the Plan Queue page text now say it covers automation runs.
2. **Read when each run starts**, retries included. A run already going finishes on the lists it started with; Plan
   Queue's mid-run restart onto another account is not copied, because an automation run is a one-off session with
   no worktree or hold to restart from.
3. **The lists follow the provider the session actually runs on.** Pool and Copilot profile ids are separate
   namespaces, so the runner resolves the provider the way instance creation does: "auto", or a named CLI that is
   not installed, falls back through `defaultCli`; a forced worker node keeps a named provider.
4. **Not covered:** automations that wake an existing session (they continue that conversation on its own account),
   and loop actions (they route through the loop engine, which has no per-loop account lists; the original plan
   recorded no loop actions in its then-current automation inventory, not rechecked by this worker). Sessions James
   opens himself are unchanged. The Plan Queue page, help and CLI
   docs state the wake-up exception.
5. **A move to another provider keeps following the rules.** When any rule is set, an automation session carries
   lists even if none name its provider's accounts (empty lists). If the session later moves to another provider
   (cross-provider failover, `sessionFailoverProviders`, or a manual switch), it takes the new provider's lists from
   the current rules, and gets the old ones back if the move fails. This also covers a Plan Queue session that
   carries lists and is switched by hand.
6. **Copilot does not switch accounts.** A Copilot automation whose folder's account is on the never-use list fails
   each run with the plain refusal, as a Copilot queue session would; Copilot never falls back to another account.
   For the same reason Use last has no effect on a Copilot automation: it always runs on its folder's account. (In
   the Plan Queue, Use last on a Copilot account still moves that choice down the ranked worker list.) The page and
   help say so.

## As built

- `src/main/automations/automation-account-rules.ts`: `automationAccountPreferences(target, forceNodeId)` reads the
  list and returns the `AccountPreferences` for the resolved provider. It returns nothing only when both global
  lists are empty; rules naming only other providers produce empty lists, preserving enforcement on a later
  provider change.
- `src/main/automations/automation-runner.ts`: the fresh-session dispatch awaits the preferences, re-checks the
  startup abort signal, and passes `accountPreferences` to `createInstance`. The existing generic plumbing (create
  builder, spawn preflight, respawn, failover, session continuity) applies them, as it does for queue sessions.
- `src/main/instance/lifecycle/runtime-reconciler-account-handoff.ts`: `accountPreferencesAfterProviderSwap`.
  `runtime-reconciler.ts` applies it on a provider swap using the rules read at that moment, saves the new lists with
  the rest of the session state (so a wake does not bring back the old ones), and when a provider swap fails rebuilds
  the old provider's lists from the current rules; a failed account-only switch leaves the lists alone. Either way a
  rule change made during the switch stands.
- Refusal wording no longer says "Plan Queue never-use list": the pool and Copilot refusals say "never-use list
  (Plan Queue page)". Plan Queue page text, save message, setting metadata, help and the two CLI docs updated.
- Tests: `automation-account-rules.spec.ts` (provider resolution, namespaces, forced node, empty lists); runner tests
  for the first run, a retry, no rules, a failed lookup (run fails, no session) and a pause during the lookup (no
  session); the saved-settings wiring with the settings store and CLI lookup mocked; four provider-swap tests in
  `runtime-reconciler.provider-account-swap.spec.ts`. Earlier implementation notes recorded mutations removing the
  `createInstance` field, the abort re-check, the swap recompute, the saved lists, and the provider-only rollback
  each failing a test; the queue worker did not repeat those mutations.
  Seven older automation specs stub the reader, because it reads the settings store those specs do not set up.

## Queue worker handover — 2026-10-31

- The supplied queue checkout already contained the implementation and its tests. No source change was needed.
  The worker traced automation dispatch through instance creation and shared pool/Copilot preflight, and checked
  provider-swap persistence/rollback and pre-emptive selection. The generators produced no tracked differences.
- This plan has no separate linked spec. Its decisions above and the completed predecessor plan supply the scope;
  the predecessor was not changed.
- Evidence is in the queue worktree at `_scratch/automation-account-rules-worker/`: `report.md`, `seal.json`,
  `command-receipts.jsonl`, individual command logs and raw targeted-test reports. The seal records the source
  revision and file hashes. These are worker receipts, not an independent PASS verdict.
- Ruling: the queue worker instruction reserves the full suite and independent gate for the verifier. Those
  items stay open below; neither is treated as a live-test deferral. Only the coordinator may rename this plan.
- The file-size check passed with existing tolerance notices. The renderer build passed with its existing initial
  bundle budget warning (1.64 MB against a 1.00 MB warning threshold). No budgets, limits or tests were weakened.

## Verification — current worker evidence

- [x] Baseline focused tests: automation rules/runner, account handoff, provider swaps and Plan Queue rules
      (5 files, 121 tests; cache disabled).
- [x] Broader targeted tests: automations, pool account rules/failover, Copilot refusal, lifecycle preflight/provider
      swaps and the account-rules renderer panel (35 files, 400 tests; cache disabled).
- [x] `npx tsc --noEmit` (main and electron), `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
      `npm run check:ui-hints`.
- [x] `npm run generate:aliases`, `npm run generate:ipc` (no tracked output drift).
- [x] `npm run build:main`, `npm run build:renderer`.
- [ ] `npm run test:quiet` (full suite): intentionally not run by the worker; required of the independent verifier.
- [ ] Fresh-eyes completion gate: queue verifier must independently review and return PASS before closure.
- [ ] Live checks deferred to `2026-10-27-automation-account-rules_livetest.md`: no live result claimed. These
      change real account routing and start provider sessions, so James must choose the app instance, timing and
      accounts. Builds and automated tests above are not deferred.
