## Snapshot of capability-713b20a8-163a-4f9a-a877-1dfbf70cfc53_history.md

# History: capability 713b20a8 (Codex checker skill record)

Round 1 (worker, 18 Nov 2026)

- Reproduced from source: no Harness row recorded which skills a checker turn named; Codex's own per-session record is in a private home (see plan "Refined design").
- Built: `required-skills` session-policy row for plan-queue checker turns (names only), written from the app-server turn path and the exec path. Remote-worker checkers not covered (follow-up).
- Checks (run on the Windows PC via the remote runner): targeted `npm run test:quiet` on the 3 skill specs + new spec: 4 files, 32 tests passed; wider codex adapter and core/system specs: 150 files, 1964 tests passed; `npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer): all passed. `npm run generate:architecture`: no diff.
- Not done: runtime probe on a rebuilt app (deferred, see `_livetest.md`).

Round 2 (worker, 18 Nov 2026)

- Verifier finding fixed: on the exec path the row was written before the process started, so its threadId was the adapter's Harness-owned placeholder. The row is now written when exec reports its native thread id (resumed turns fall back to the stored native id if no event arrives). Test now asserts `threadId: 'fixture-thread'`.
- Checks: targeted skill specs (3 files, 21 tests) and `codex-exec*` specs (5 files, 31 tests) passed; `npm run typecheck` and `npm run lint` passed.
- Not fixable here: runtime probe needs a free signed-in test-Mac slot (environment); remains in the `_livetest.md`.

Round 3 (worker, 18 Nov 2026)

- Verifier finding fixed: on the app-server path the row was written before Codex had accepted any input. The acceptance callback now says which request was acknowledged (`developer` or `input`); the row is written only on `input` (`turn/start` or `turn/steer`, which carry the skill items/mentions). A rejected, cancelled or stale send, or a developer item injected before a rejected `turn/start`, leaves no row. Two new specs cover rejection.
- Checks (Windows PC): skill specs + thread-runtime spec (4 files, 46 tests) passed; codex-cli-adapter specs (17 files, 344 tests) passed; typecheck, typecheck:spec, lint passed.
- Not done: runtime probe (see `_livetest.md`).

Round 4 (worker, 18 Nov 2026)

- Verifier finding fixed: `npm run check:ts-max-loc` failed because `codex-app-server-turn-adapter.ts` (703) and `codex/app-server-thread-runtime.ts` (702) crossed the 700-line limit. Compacted without behaviour change: the adapter now keeps a `skillDeliveries` list drained with `splice(0)` when the `input` request is acknowledged (same single-write behaviour as before); the runtime's callback doc comment is one line. Now 699 and 699.
- Checks: `check:ts-max-loc` passed; `typecheck` passed; oxlint on both files clean; `src/main/cli/adapters/codex` specs (98 files, 1239 tests) passed on the Windows PC.
- Not done: runtime probe (see `_livetest.md`).

Round 5 (worker, 19 Nov 2026, resume after park)

- Park reason: the checker found no free signed-in test-Mac launch slot for the runtime probe. No code change was asked for.
- No code change this round. Re-ran on the Windows PC after the merge of main: the three skill-record specs (3 files, 23 tests) passed; `typecheck` and `lint` passed.
- `dev-app.js status` still shows three other copies building on the test Mac; the Windows PC has no Codex. The probe stays with the independent checker (steps in `_livetest.md`); the worker cannot start it.

Round 6 (worker, 19 Nov 2026, verifier round 1 findings)

- Finding 1 fixed: `executePreparedMessage` in `codex-exec-adapter.ts` called `recordSkills(resumedThreadId)` in its catch path whatever happened, so a resumed turn whose input was refused before Codex accepted it still wrote a `required-skills` row. `recordSkills` now returns unless `writePhase.accepted` is true (covers the success, thread-id and failure paths). New spec in `codex-exec-skills.spec.ts` ("records nothing for a resumed turn whose input Codex never accepted"): first turn completes, later children have no stdin; exactly one row. Confirmed the spec fails (3 rows) with the guard removed and passes with it.
- Finding 2 (environment: no free signed-in test-Mac slot for the runtime probe) is not a code problem; left for the checker. Steps stay in `_livetest.md`.
- Checks (Windows PC): 4 skill specs (35 tests) passed; typecheck, typecheck:spec, lint, check:ts-max-loc passed.

Round 7 (worker, 20 Nov 2026, resume after second park)

- Park reason: the checker's runtime probe found the test Mac above its load limit (25/19/22 on 10 processors). Not a code change.
- No code change. `dev-app.js status` now shows no Harness copy on the test Mac (so a slot should be free); the worker does not run the probe, it belongs to the checker.
- Checks (Windows PC): 4 skill specs (35 tests) passed; typecheck, lint, check:ts-max-loc passed.

Round 8 (worker, 20 Nov 2026, resume after third park)

- Park reason: the checker's runtime probe found no launch slot below the test Mac's 15.0 load limit with a signed-in Codex (Windows has no Codex). Not a code change.
- No code change. `dev-app.js status` shows no Harness copy on the test Mac; the Windows PC has another run's copy. The probe belongs to the checker (steps in `_livetest.md`).
- Checks: typecheck and check:ts-max-loc passed; 5 skill-record/session-policy-log specs (41 tests) passed (Windows PC).

Round 9 (worker, 20 Nov 2026, resume after fourth park)

- Park reason: the checker session had no Browser Gateway control for the test Mac, so it could not drive the owned remote app's checker session. Not a code change.
- Observed in this session: `browser.health` returned status ready; remote extensions windows-pc and ct-test-mac both enabled, running, channel fresh, commands deliverable. So the channel exists; the gap was in the checker's session, not in the code. The worker does not run the probe (it belongs to the independent checker; steps in `_livetest.md`).
- No code change. Checks: 4 skill-record/session-policy-log specs (30 tests) passed; typecheck exit 0, lint exit 0, check:ts-max-loc passed.
