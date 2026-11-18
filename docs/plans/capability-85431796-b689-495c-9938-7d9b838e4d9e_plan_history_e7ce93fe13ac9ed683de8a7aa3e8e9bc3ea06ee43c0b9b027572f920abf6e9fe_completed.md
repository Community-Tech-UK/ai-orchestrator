## Snapshot of capability-85431796-b689-495c-9938-7d9b838e4d9e_history.md

# History: capability repair 85431796 (disposable Plan Queue run)

## Round 1 (worker)

Read: plan, `livetest-capability-repair-runbook.md`, `plan-queue-handlers.ts`, `plan-queue-run-create.ts`, `plan-queue-routing.ts`, `plan-queue-discovery*.ts`, `plan-queue-discard.ts`, coordinator `startRun`/`cancelRun`/`control`, `live-test-context.ts`, `user-data-path.ts`.

Findings:
- `planQueueStart` over IPC cannot carry a per-run worker/checker choice (`PlanQueueStartPayloadSchema` has no `routing`; non-strict object drops it), takes any repository the caller names, and leaves nothing recording a test run.
- Runbook rows for `dev-app.js seed`/`worker-start` and `createLiveTestQuestionSession` describe controls that are not in this checkout or in the root checkout (no matches in either). Not used; not in scope.
- Discarding a job keeps it `parked` with `discardedAt` set, so cleanup treats `parked` + `discardedAt` as stopped.

Built: `plan-queue-livetest-fixture.ts` (+ spec, 16 tests), `harnessLiveTestDataPath()`, three channels, handlers, preload, regenerated channels and inventory, runbook row, `_livetest.md`.

Checks (worktree, exit 0 unless noted): `npm run test:quiet -- plan-queue-livetest-fixture.spec.ts live-test-context.spec.ts` 20 passed; `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) all passed, run twice (second after adding `keepOnThisMac`); `npm run generate:ipc`, `npm run generate:architecture`, `verify:ipc` passed.

Not done: runtime probe. `dev-app.js start --port 9871 --remote-only` waited about 25 minutes: the test Mac stayed at load 16 to 30 on 10 processors and the Windows PC could not be reached; the Mac was not used. Recorded in the `_livetest.md` beside the plan for the checker's probe.

## Round 2 (worker, resumed 18 Nov)

`dev-app.js start --port 9871 --data /tmp/aio-lt-queue-fixture --remote-only --mac` got the test Mac at the first attempt (tree fe50a56d2826f6e1f39fcb553214c0dec16d3776, receipt printed by the launcher). Driven over CDP with puppeteer-core (no window on this Mac).
- The three preload calls exist; `planQueueLiveTestFixtureList` answered an empty list.
- Refusals: remove of an unknown id, start with empty workers (schema), start with extra `workspaceCwd` (schema), start with a missing parent: all failed with the expected messages; no repo folder was left; `registry.json` held `{"version":1,"fixtures":[]}`.
- `createInstance({workingDirectory:'/tmp', provider:'claude'})` made a parent (no provider CLI on the test Mac, so it never ran). Start with routing claude workers / codex verifiers returned a `runId`; `planQueueGet` showed a running run on the fixture repo with one queued job; repo had one commit and `?? docs/` only.
- Stopped and restarted the copy with the same `--data` (the Mac was busy for about 30 minutes before the relaunch): the fixture was still listed, `repoExists: true`.
- Remove answered `cancelledRun: true, discardedJobs: 1`; `planQueueGet` showed the run `cancelled`; list empty; registry empty; repo folder gone.
- Not run: the non-live-test refusal (needs a normal start; unit-tested), a worker or checker session actually running (no signed-in provider on the test Mac), and the "no session left listed" check.
- Cleanup: copy stopped, `dev-app.js status` shows no copies. `/tmp/aio-lt-queue-fixture` (profile plus empty registry) remains on the test Mac: it cannot be reached without a running copy.
