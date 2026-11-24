## Snapshot of capability-9a4de061-39a1-49f9-a276-9f60c33e10d6_history.md

# Capability repair 9a4de061 history

## Round 1 (worker)

- Reproduced from code, not a running app: `reconcileOne` -> `retryOrigin` -> `retryCapabilityOrigin` (plan-queue-capability-control.ts) resumed a parked `needs-setup` original without looking at its checkout. `defaultRunConfigFor` gives any non-Harness folder an empty gate list, so `assertRunReady` cannot catch a parent-only run either. Repair dedupe (`attach` identity key), parent-only authorisation, account-rule matching and the held-for-owner path already existed and were reused unchanged.
- Added `src/main/plan-queue/plan-queue-source-presence.ts` (`findProjectFiles`: project file at the top or one folder down) and a guard `missingSourceProblem` in `retryCapabilityOrigin`: parked original + a waiting `setup`-class check + no project files in the run workspace -> throw a plain reason (names `repairRepository` when reported). Existing `reconcile` catch then holds the landed repair for its owner and notifies once; an owner's explicit resume is not blocked.
- Tests: plan-queue-source-presence.spec.ts (3), plan-queue-capability-service.spec.ts new describe (5: held and notified once, names application repository, resumes when source present, capability gap unaffected, owner resume after hold).
- Checks: `npm run test:quiet` on the two files above: 52 passed. Capability store/launch/evidence/control-authority specs: 24 passed. `npm run checks` typecheck, typecheck:spec, lint, check:ts-max-loc, build:main: all passed. build:renderer not run (no renderer change); no generator output changes (no IPC/alias change).
- Not done here: the independent runtime probe (checker's job on the Windows PC or test Mac) and the originating check rerun (coordinator).

## Round 2 (worker, after verifier round 1)

- Finding: `plan_queue_report_capability_probe` rejected with "This item does not own a capability repair" (plan-queue-capability-service.ts:128-129).
- Root cause (read-only query of loop-mode.db): repair row 9a4de061 has repository `/Users/suas/work/communitytech`, state `waiting`, and empty `repair_run_id` / `repair_item_id`. `launchCapabilityRun` refuses cross-project repairs ("requires its owner's handoff"), so the owner started this plan as an ordinary item. `forRepairItem(item.id)` therefore finds nothing, by design. The empty `capabilityRepairs` in status is expected: `summaries()` lists by origin item, not repair item.
- Consequence: `assertCanPass` does not require a probe for this item, so nothing blocks PASS; the probe just cannot be retained, and landing does not trigger the origin rerun through the repair record.
- Decision: no code change. Linking an owner-started plan to another repository's repair record (for example by parsing the id from the filename) would widen a cross-project authority boundary the plan says not to cross. Recorded the probe and original rerun in the `_plan_livetest.md` and reported the linking gap as a follow-up.
- Re-ran targeted tests: source-presence + capability-service specs, 52 passed.

## Round 3 (worker, after verifier round 2)

- Same finding: repair not durably linked, so probe and original-check evidence cannot be retained. The plan's own proposal asks for "durable prerequisite/evidence linkage", and its Owner authority paragraph records James's go-ahead to build here, so round 2's "no change" was wrong; the link is within the recorded authority.
- Change (`plan-queue-capability-service.ts`, `plan-queue-capability-store.ts`): `adoptOwnerRun` links the owner's queued item to the repair when the run's folder is inside `gap.repairRepository` and the plan file name is `capability-<repair id>_plan.md`. New `ownerRun` flag on the repair record keeps `reconcileOne` from pausing/resuming/cancelling the owner's run. `reportGap` also treats an item that is a repair's item as a repair run (no nested repair). Run config is untouched (account rules, routing keep the owner's).
- Not done on purpose: the origin run's own authority settings (`capabilityRepairRepository`) are not changed; the original rerun still goes through `retryCapabilityOrigin`, including the source-presence guard from round 1.
- Tests: 4 new cases in plan-queue-capability-service.spec.ts (links and leaves run alone; wrong name/repository; cancelled run; no nested repair). Targeted: 88 passed across capability, source-presence and discovery specs. `npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer): all passed.
- Limit: the live coordinator runs the old build, so a checker's probe call there still refuses until the app is rebuilt; recorded as livetest section 3.

## Round 4 (worker, after verifier round 3)

- Finding: `adoptOwnerRun` skipped only cancelled runs and skipped/discarded items, so a completed run's landed matching item could be linked; `reconcileOne` then saw `landed` and called `retryOrigin` although that item's PASS never required a probe (`assertCanPass` only asks for one once the item is a repair's item).
- Fix (`plan-queue-capability-service.ts` `adoptOwnerRun`): link only items in `running`/`paused` runs, not in `landing`/`landed`, and with no PASS verdict. Why the verdict check: `parked -> landing` is allowed without re-review (plan-queue-state.ts:30, plan-queue-item-flow.ts:878/902), so a merge-conflict park after PASS could otherwise land without the probe. Resume to `queued` (item-flow.ts:782) and `awaiting-slot -> verifying` (item-flow.ts:563) clear the verdict, so a re-reviewed item is still linkable. An item linked while `verifying` is fine: checker rules always carry the probe instructions and `assertCanPass` runs at PASS time.
- Tests: 2 new cases (already-passed items in completed/running runs and landing/parked-after-PASS are not linked and no original rerun; an item under review is linked and `assertCanPass` then demands the probe). Confirmed the first fails against the round 3 code (1 of 55 failed) and passes with the fix.
- Checks: capability evidence/launch/service/store + source-presence specs, 75 passed (exit 0). `npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer) exit 0. `generate:architecture` produced no change.

## Round 5 (worker, resumed after park for a rebuilt coordinator)

- Park reason: verifier's probe refused ("This item does not own a capability repair"); needs a coordinator containing this branch, with the repair linked to this item.
- Checked (22 Nov 2026, ~22:45): Harness restarted ~11 minutes earlier from `/Applications/Harness.app`, `app.asar` dated 22 Nov 22:34. Extracted `dist/main/plan-queue/plan-queue-capability-service.js` and `plan-queue-capability-control.js` from it: no `ownerRun`/`adoptOwnerRun`, no `missingSourceProblem`, and no `plan-queue-source-presence.js`. The rebuild was from main, which does not contain this unlanded branch.
- `plan_queue_status` run 3b0741d0 (communitytech): repair 9a4de061 `waiting`, `repairRunId: null`; original item 6d040113 working round 0. Run 04acb509: this item working, `capabilityRepairs: []`.
- Bootstrap: the link only happens in a coordinator built with this branch, and round 4 makes it link only items with no PASS and not landing/landed. So the order must be: build Harness with this branch, restart, let one queue pass link this unpassed item, then the checker's probe is retained, PASS, landing, original rerun. Landing first (for example Land anyway) would leave the repair unlinkable and the original waiting on it.
- Not done on purpose: no direct database edit to link the repair (would bypass the coordinator's own control), no gap report (a `setup` gap from this unlinked item would open a new repair in the old build), no restart of James's Harness (live sessions).
- No code change this round. Checks: capability service/source-presence/store/evidence/launch specs, 75 passed (exit 0, Windows PC); `npm run checks -- "npm run typecheck" "npm run lint"` exit 0.
- Updated livetest sections 2 and 3 with the order and the exact item and run ids.

## Round 6 (22 Nov 2026): merge from main

- Coordinator merged `main`; one conflict in `plan-queue-capability-service.spec.ts`: both sides appended a describe block at the end. Kept both (this branch's source-presence and owner-run blocks, main's "runtime probe only where Harness can produce one" block).
- Main's direct change (`aabbaa527`): `assertCanPass` requires the repair probe only when the run's workspace has `scripts/remote-checks/dev-app.js`. Effect here: the owner-run test "PASS then needs the runtime probe" used a bare temp repository and failed after the merge (did not throw). Fixed the test by writing the launcher file into that repository; main's tests cover the no-launcher case. Repair 9a4de061 is implemented in the Harness repository, which has the launcher, so the probe and livetest section 3 are unchanged.
- Checks: `npm run test:quiet -- plan-queue-capability-service.spec.ts plan-queue-source-presence.spec.ts` 63 passed exit 0; capability evidence/launch/store specs 17 passed exit 0; `npm run checks -- "npm run typecheck" "npm run typecheck:spec" "npm run lint"` exit 0 (Windows PC).

## Round 7 (24 Nov 2026, worker, resumed after park for a rebuilt coordinator)

- Main now holds this work: `7cabf1e16` "Plan Queue: link capability repairs to owner-started items..." (landed by hand from this branch at James's request, 23 Nov). `git diff HEAD 7cabf1e16 -- src/main/plan-queue` is empty.
- `plan_queue_status` run 3b0741d0 (communitytech): repair 9a4de061 `state: running`, `repairRunId: 04acb509-bb1a-4b2f-a3b5-547f744b2673`, `repairItemState: working`, detail "The repository owner is implementing this repair in their own queue run." Before (round 5) it was `waiting` with `repairRunId: null`. So the running coordinator contains `adoptOwnerRun` and has linked this unpassed item; the probe tool should now accept this item's checker. Run 04acb509 itself lists `capabilityRepairs: []`, which is expected: the repair record belongs to the origin run.
- No code change. Checks: `npm run test:quiet -- plan-queue-capability-service.spec.ts plan-queue-source-presence.spec.ts` 63 passed exit 0 (Windows PC); `npm run checks -- "npm run typecheck" "npm run typecheck:spec" "npm run lint"` exit 0 (Windows PC).
