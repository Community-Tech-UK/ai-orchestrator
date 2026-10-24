# Restart onto a limited account: closing the known residuals

Status: completed 2026-10-19. Implemented and verified. A fresh completion gate passed, plus a focused review of the fail-open follow-up. Checks that need the installed app are in the live-test doc.

Follows [restart onto a limited account](2026-10-19-restart-limit-account-switch_plan_completed.md), whose "Known residuals" list is the input here. The live checks for both plans are in [the live-test doc](2026-10-19-restart-limit-account-switch_livetest.md).

## Decisions per residual

1. **Queued writes behind the first refused response were still sent.** Fixed.
   - Before each queued orchestration response is sent, the write queue now re-checks the provider-limit hold (`assertQueuedResponseDeliverable` in `orchestration-delivery-failure.ts`, dep `holdQueuedResponse`). This is in addition to the existing adapter-replaced check.
   - A response that is held there was never sent. It is requeued as `provider-limited`.
2. **A restart-time account move added no notice.** Fixed.
   - The routing service now records `account_failover_performed` and sends the same "Account switched" notification a failover gives (`reportRestartMove`).
   - The notification service is loaded on use, so the routing module still does not import Electron.
3. **Wake, interrupt and unexpected-exit respawns keep the stamped account.** Not changed.
   - The next send's preflight starts the switch, and the switch now waits for the session to settle. Moving on these respawns would add routing changes to every recovery path for no gain.
4. **A promptless park resumes with the standard continuation turn.** Not changed. This is existing, intended behaviour.
5. **A remote restart move relies on the worker's sign-in check.** Not changed, as with every remote spawn.
6. **A replay-continuation pool kept a restart on the limited account.** Fixed for fresh provider sessions.
   - `attachAccountRoute` now passes `resume`.
   - A replay fallback or "restart fresh" (`resume: false`) moves in any pool.
   - A native resume still moves only in a `shared-store` pool, because only there can the thread continue under another account.
7. **A limit-held child completion is not tracked for fresh-fallback reconciliation.** Not changed, by design.
   - That reconciliation is for restart-window loss. A held completion is still delivered later, like an `awaiting-human` suppression, which `orchestration-handler.spec.ts` pins as not restart loss.
   - A `respawning` requeue stays tracked.
8. **Held responses are lost on an app restart.** Not changed. Investigation found:
   - A restored session gets a new instance id (`continuity-revival.ts` refuses the old id).
   - Its orchestration context starts empty.
   - Children are terminated on quit and are not recoverable.
   - A clean quit marks the parent's pending rows `expired`.
   - Each child's result is already written to the parent's transcript as a "Child completed" message (`instance-child-completion-handler.ts` `addParentNotification`), and the transcript is persisted.
   - Rehydrating rows would therefore need id remapping and would mostly repeat what the restored transcript already holds.
9. **A refused response whose failover ends `not-switched` with no reset time had nothing to resume it.** Fixed.
   - In a pool, `maybePark` now parks until the hour the ledger benches the account for (`ASSUMED_ACCOUNT_LIMIT_MS`, re-probed every few minutes while parked). Previously it did not park at all.
   - The switch itself is still told there is no reset time, so no notice claims a reset that is only assumed.

## Notes from review

- The queued-response pre-send check fails open (`holdQueuedOrchestrationResponse`), like the admission check, so an unreadable limit state never fails a deliverable response.
- With automatic resume on, a pooled limit with no reset time from any source now retries, unattended, once the assumed hour is up. Each retry costs at most one refused request and never spends credits. The setting is opt-in.
- The park banner and an offer's title show the assumed hour as the resume time. A park taken from an assumed ledger row already did the same.

## Verification

- Targeted specs:
  - `instance-provider-limit-handler.account-failover.spec.ts` (no-reset park, offered park)
  - `instance-orchestration.response-delivery.spec.ts` (queued response held before sending)
  - `provider-account-routing-service.spec.ts` (restart notice and event; a fresh session moves in a replay pool)
  - `account-route-preflight.spec.ts` (`resume` forwarded)
  - `orchestration-response-delivery.spec.ts` (respawn-only reconciliation reporting)
- Final gates, 2026-10-19:
  - Passed: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run lint:fast`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`.
  - `npm run test:quiet`: 34,268 of 34,269 tests passed. The one failure, `codex-exec-native-outcome.spec.ts`, is in an unrelated Codex adapter area that drives real processes. It passed on its own straight afterwards and in every earlier full run, so it was a load timing failure.
