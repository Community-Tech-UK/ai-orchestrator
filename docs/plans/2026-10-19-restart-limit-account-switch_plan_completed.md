# Restart onto a limited account: switch accounts instead of parking

Status: completed 2026-10-19. Implemented and verified. The fresh completion gate passed after five review rounds, plus a focused review of the final follow-up. Checks that need the installed app are deferred to the live-test doc.

Live checks: [installed-app live check](2026-10-19-restart-limit-account-switch_livetest.md).

## Incident (2026-10-19, session `xks30qllv`)

A Codex parent session (Work Finder) on the `chatgptcomtech-e73d` account hit that account's weekly usage limit (resets 25 October). James restarted it at 09:25:52. The second Codex account (`legacy`) was signed in with usage left; another session failed over to it at 09:22:57. This session did not switch. It was parked for six days with the note "The session could not be moved to another account".

Evidence (app.log and lifecycle.ndjson, 2026-10-19):

1. The restart resolved `account_route_resolved … profileId: chatgptcomtech-e73d, routingSource: persisted`. A persisted route is admitted with only a sign-in check. The provider-limit ledger is never consulted.
2. On the restart's ready edge, session admission released six queued child-completion reports. Orchestration responses go straight to the adapter, so they never reach the send path's known-limit preflight. Each one was refused (`usageLimitExceeded`), logged "Failed to inject response to instance", and dropped with a transcript error.
3. James's own message was held by the preflight, which started a failover. The failover waits for the session to be switchable for only 5 seconds, polling every 50 ms. The report deliveries kept the session busy from 09:25:53 to 09:26:06, with idle windows of 17 to 45 ms between them. The wait gave up as `busy` and parked the session. The reason was not logged.
4. When James pressed "Resume now" at 09:26:45, the session was idle and the switch to `legacy` succeeded at 09:27:02.

## Changes (as built)

1. **Restart routing**, in `provider-account-routing-service.ts` (`moveOffParkedPersisted`).
   - The move is opt-in through `moveOffLimitedAccount`, which only the restart paths set in `instance-lifecycle.ts`: native resume and replay fallback after a restart, and "restart fresh".
   - An account handoff, whether explicit, failover or pre-emptive, also respawns through a persisted route, and it keeps the profile that was just chosen. The first completion gate found that this was redirected.
   - When a persisted profile has an active ledger limit (its own model's or account-wide), the restart routes to the failover target with source `failover`.
   - This only applies when newer usage evidence has not lifted the limit, and when the pool is `automatic`, ownership has been acknowledged and continuation is `shared-store`.
   - The target is picked by the default selection, excluding the limited profile and respecting the session's account fence.
   - The persisted profile is kept when the pool asks first or is off, when it uses replay continuation, or when no other account is usable.
2. **Hold orchestration responses and consensus results**, in `session-admission-service.ts` (`setProviderLimitHold`, suppress reason `provider-limited`).
   - Admission asks `InstanceProviderLimitHandler.holdAutomatedTurn()` before admitting an orchestration response or a consensus result. This is wired in `late-runtime-initialization-steps.ts`.
   - The hold applies while the session is parked or switching, or while its account has a known limit.
   - A known limit starts the preflight's own switch-or-park, with no prompt to re-send and no pre-emptive switch. The switch's respawn, or the park's resume, gives the ready edge that redelivers the held responses.
   - Other origins are unaffected, because they send through `sendInput()` and its own preflight.
   - The check fails open.
3. **Refused responses are requeued, not dropped**, in `instance-orchestration.ts`, `instance-provider-limit-runtime.ts` (`holdRejectedOrchestrationResponse`) and `orchestration-response-delivery.ts` (`OrchestrationResponseHeldError`).
   - A response the provider refuses on a usage limit goes to `maybePark` with `resumePrompt: null`. This records the ledger row and starts a switch or park.
   - The response is then requeued through `SessionAdmissionService.requeueUndelivered()`.
   - With automatic resume off, `maybePark` declines to park. The ledger row it recorded still makes `holdAutomatedTurn` park hold-only, so the response is held rather than dropped.
   - A response with no admission row of its own, such as a consensus result, gets a fresh `orchestration` row so it can be requeued rather than dropped.
   - Any other delivery failure is also requeued while the session is parked or its account has a known limit.
   - A queued response whose adapter was replaced before it was sent is requeued with reason `respawning`. Nothing reached the provider, so it cannot be delivered twice.
   - A requeued response waits for a ready status with no active provider turn (`requireReadyForInput`), so it is never redelivered into a replacement that is still `initializing`. It re-decides on a microtask, because the replaced adapter's ready edge may already have passed.
   - A requeued child completion with reason `respawning` is tracked like any other child completion suppressed while its parent was respawning. A fresh-fallback restart then accounts for it once instead of also delivering it.
   - A requeue for a session that is gone fails the row instead of keeping it pending.
   - The transcript shows a "waiting" note instead of an error.
4. **Failover settle wait**, in `account-failover-coordinator.ts`.
   - Before taking the provider lock, a failover now waits up to `SETTLE_WAIT_MS` (60 s) for the session to be switchable. It previously gave up after 5 s.
   - A pre-emptive switch keeps the 5 s wait, because it holds a turn the user just sent.
   - Because the wait happens before the lock, other sessions' switches are not held up.
   - The existing 5 s wait inside the lock remains, for a send that races the switch.
5. **Switch cap.** An automated turn's hold check does not call `observeInput`, so a child report cannot reset the per-turn switch cap.
6. **Failover outcome logging**, in `instance-provider-limit-handler.ts`. "Account failover finished" now logs the outcome, the reason, and each considered account's veto.

## Known residuals (not changed)

- When the limit was not yet known at the ready edge, writes already queued behind the first refused response are still sent. Each one is refused and then held, so it waits rather than being dropped, but each costs one refused request. `instance-orchestration.ts` is at its size ceiling.
- A restart-time account move logs and stamps `accountRoutingSource: 'failover'`, which the account chip shows. It adds no transcript note.
- Waking a hibernated session, and the interrupt and unexpected-exit respawns, still keep the stamped account. The next send's preflight or the refused turn starts the switch, and the switch now waits for the session to settle.
- A park started for a held response has no prompt of its own. When it resumes, it sends the standard continuation turn alongside the redelivered responses. This is existing behaviour for promptless parks.
- A restart that moves onto a remote node's account relies on the worker's own sign-in check, as every remote spawn does.
- In a replay-continuation pool (not the default), a restart, including "restart fresh", keeps the limited account. The first refused turn's failover then moves it.
- A child completion held for a usage limit, rather than requeued for a respawn, is not tracked for fresh-fallback reconciliation. This matches how `quota-parked` suppressions already behave.
- Held responses live in memory, like every admission redelivery. An app restart during a long park loses them.
- A refused response whose failover ends `not-switched` with no reset time from any source has no park to resume it. It waits for the session's next ready edge, for example the user's next turn.

## Verification

- Targeted specs:
  - `provider-account-routing-service.spec.ts` (respawn block)
  - `session-admission-service.spec.ts` (provider-limit hold)
  - `session-admission-provider-limit.spec.ts` (an end-to-end replay of the incident through the real admission service, limit handler and ledger)
  - `instance-provider-limit-handler.account-failover.spec.ts` (`holdAutomatedTurn`)
  - `instance-provider-limit-runtime.spec.ts`
  - `instance-orchestration.response-delivery.spec.ts`
  - `account-failover-coordinator.spec.ts` (settle wait, lock not held, cancel)
  - `orchestration-response-delivery.spec.ts` (held responses with and without their own admission row)
  - `account-route-preflight.spec.ts` (the restart flag reaches the router)
- With its fix disabled, the routing spec failed, and so did the incident replay.
- Fresh completion-gate reviews, with every actionable finding fixed:
  - Review 1: handoff redirect, dropped consensus result, overclaimed comment, switch-cap reset.
  - Review 2: consensus not held, auto-resume off, "restart fresh", replaced adapter.
  - Review 3: early redelivery into an `initializing` replacement, pre-emptive wait, gone sessions, respawn tracking, comment accuracy.
  - Review 4: no test pinned the restart call sites. `instance-lifecycle-spawn-rollback.spec.ts` now covers native resume, replay fallback and "restart fresh", and all three fail without the flag. Held-note ids are now unique.
- Follow-up after the review 5 pass: `holdRejectedOrchestrationResponse` now fails a response, rather than throwing past its delivery confirmation, when the limit check throws. A focused fresh review passed.
- Final gates, 2026-10-19:
  - Passed: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint` (ng lint), `npm run lint:fast` (oxlint), `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`.
  - `npm run test:quiet` passed in full: 2,692 files, 34,242 tests. The final one-function guard was then re-run across the affected folders: 541 files, 7,401 tests.
  - An earlier full run had 5 failures in unrelated files (`opencode-account-login-command.spec.ts`, `plan-queue-retirement-control.spec.ts`). They were timeouts under load, passed on their own, and passed in the next full run.
