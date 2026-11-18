## Snapshot of capability-9b9514ca-72a1-4f4e-8254-f47363876913_history.md

# History: capability repair 9b9514ca (hardened Codex session outside the fence)

## Round 1 (16 Nov 2026)

**Reproduction.** Source trace: hardened is set only from `InstanceCreateConfig.hardened` (`instance-create-builder.ts:112`), passed by the IPC create handler (`instance-handlers.ts:119`). The child path ignored it: `SpawnChildPayloadSchema` has no field and `createChildInstance` never passed one, so `hardened:true` on `spawn_child` was dropped. `dev-app.js status` showed no copies on either test computer. The 11 Nov observation (nested sandbox refused, fail closed) stands.

**Routes rejected.** Automations (`create_automation`): strict arg schema, caller-authority rules (`automation-agent-authority.ts`), no readable link from a run to its session, and `read_session` only reads related sessions. Dev app on the test Mac: already possible, but no Codex login there, and the originating check needs the installed build. Windows PC: no Seatbelt.

**Chosen.** `spawn_child` gets `hardened:true`. A child is created by the app's main process, so it is outside the asking session's sandbox; the parent already owns, reads and terminates its children (ownership checked in the handler).

**Built.** Contract field; `SpawnChildCommand.hardened`; `hardened-child-gate.ts` (refuses remote, non-Mac, unresolved `auto`, untested provider; applied in the `spawn-child` handler before limits so nothing is created); `createChildInstance` passes `hardened`; search shortcut skipped for hardened; command signature keeps hardened apart; `ChildInfo.hardened` on `get_children`; runbook row (root, untracked file).

**Why the gate is in the handler.** `instance-manager.ts` was exactly at its size limit (2530), so the manager change is one line with no growth.

**Checks.** `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all exit 0 (test Mac). Focused specs pass: gate (9), orchestration hardened-child (10), manager change-model, command signature, protocol (137 across three files in the last run). Wider run of `src/main/instance src/main/orchestration src/main/mcp packages/contracts`: 4 failures in `instance-turn-summary.integration.spec.ts` ("unavailable" baseline), 2 of 6 on rerun alone. That spec does not import anything changed here and the count varied between runs, so it is a timing flake, not caused by this change (not proven on HEAD; the verifier's full run will show).

**Not done in this round.** No runtime probe (the independent checker does it on the test Mac or PC). The live check needing the installed app and a Codex login is in the `_livetest.md` beside the plan.

## Round 1 resume (17 Nov 2026)

Reran the gates on the committed branch. `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all passed (test Mac, 2m 15s). Focused specs (gate, hardened-child orchestration, change-model, command signature, protocol) passed: 136 tests in 3 files. Working tree clean; no generated files changed. No code changes this round.

## Round 1 second resume (17 Nov 2026)

Parked earlier because the checker's runtime probe waited through four observations (test Mac load 19 to 30 on 10 processors) and never got a slot; the Windows PC cannot run hardened. That is a scheduling limit, not a code defect. No code changes. Reran the focused specs on the committed branch (gate, hardened-child orchestration, change-model, command signature, protocol): 3 files, 136 tests passed (test Mac). `dev-app status` now: no Harness copies on the test Mac; Windows PC unreachable from here. Working tree clean. The probe is still for the independent checker.

## Round 1 third resume (18 Nov 2026)

Parked again only because the checker's probe never got a test-Mac slot (load 21 to 29 on 10 processors). No code change. Reran on the committed branch (clean tree): focused specs (gate, hardened-child orchestration, change-model, command signature, protocol) 3 files, 136 tests passed (Windows PC, 51s). `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all passed (Windows PC, 1m 44s). `dev-app status`: no Harness copies on either computer, so the test Mac is free to launch the reviewed checkpoint now. The probe remains for the independent checker.

## Round 1 fourth resume (18 Nov 2026)

Parked again only because the checker's probe never got a test-Mac slot (load 23, 24, 23 on 10 processors at 12:21 to 12:27). No code change; tree clean. Reran on the committed branch: focused specs (gate, hardened-child orchestration, change-model, command signature, protocol) 3 files, 136 tests passed (Windows PC, 55s). `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all passed (Windows PC, 2m 4s). `dev-app status`: no Harness copies on either computer. The probe remains for the independent checker.

## Round 1 fifth resume (18 Nov 2026)

Parked because the previous worker ended its turn without reporting ready after two reminders. No code change; tree clean. Reran on the committed branch: focused specs (gate, command signature, protocol) 3 files, 136 tests passed (Windows PC, 44s). `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all passed (Windows PC, 1m 32s). The probe remains for the independent checker.
