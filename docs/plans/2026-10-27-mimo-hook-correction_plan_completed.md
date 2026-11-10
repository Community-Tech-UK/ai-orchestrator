# MiMo queue hook correction

On main: code only (hand-merged 6 Nov 2026, commit `521e709e3`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Done: all four numbered requirements are implemented and on main (`521e709e3`, hand-merged). On the queue branch (2026-11-10) the staged-test suites pass (61 tests) and `npm run checks` passes (both typechecks, lint, source/UI checks, both builds). Earlier hook replays with disposable indexes and the log/receipt reductions are recorded in the history file.
Next: verifier runs the full default suite and the fresh independent completion gate; coordinator owns closure.
Open: nothing for the worker. Live checks were closed earlier by dated evidence in the owning report; no fresh UI claim.
Pointers: history in [history](2026-10-27-mimo-hook-correction_plan_history_8e17c2da04fdbf8a6cc314ac01dd7f5eee7f7b7463fe8b6799410b69951df8b1_completed.md).

- [ ] Verifier-owned: full default suite and fresh independent completion gate; coordinator-owned: closure/integration.


Owning report: [MiMo live test](2026-09-25-mimo-session-resilience_livetest.md).

The five live checks already have dated passing evidence. This correction addresses the coordinator handoff, without repeating completed checks or changing saved logins.

1. Move the real main-worker build prerequisite into staged-test execution after the existing source selection. Documentation and generated-only commits skip both compilation and Vitest. Every nonempty source selection rebuilds workers before related tests, conservatively covering indirect worker dependencies without duplicating dependency-graph logic. Propagate build/test failures and signals.
2. Reproduce both paths, retain focused regressions and replay the real hook with disposable Git indexes, preserving the real index.
3. Reduce duplicative raw verification output with portable summaries, exact hashes and local full-output retention. Keep all unique live observations and historical receipts/seals.
4. Use the pinned runtime and branch-declared dependencies for canonical gates. Preserve any pre-existing install for restoration. Obtain fresh independent completion review, then clean owned runtime and record status.

Risks: source commits still pay compilation cost; deliberately conservative because related tests can depend indirectly on compiled workers. Generated-only changes must stay excluded. No production application or test assertion is weakened. No new branch, commit, app restart or completed rename.
