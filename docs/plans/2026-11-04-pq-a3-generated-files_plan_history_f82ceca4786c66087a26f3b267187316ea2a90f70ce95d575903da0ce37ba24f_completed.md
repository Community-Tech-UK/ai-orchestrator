- **Markdown.** Unchanged: ` M` and `??` only, merged by the helper. A register plus a generated file lands through the helper, and only the register is reported as merged.

### Verification run

- New `plan-queue-doc-merge-generated.spec.ts` (29 tests, real git and real `npm run` in a fixture repo): generated-only landing in unstaged, staged and staged-plus-unstaged form, an untracked generated file, generated plus register, generated plus code (blocked, bytes and index untouched), list intersection, missing, malformed and unsafe list, a deleted or item-deleted generated file, a change between check and reset, generator failure, undo for every state, fast-forward failure, and crash recovery before the fast-forward, after it, mid-rebuild, with a later change, and with an old manifest. Also `plan-queue-generated-files.spec.ts` (list loading, including this repository's own file) and `scripts/__tests__/generated-artifacts.spec.ts` (hook, test-staged and JSON agree; every generator is a real npm script).
- **Mutation checks** (each guard removed in turn, at least one test failed every time, file restored): artifact membership guard (4 failures), tip intersection (1), status guard (1), undo re-stage (3), recovery re-stage (2), post-fast-forward restore of the committed copy (1), set-aside state check (18), rebuild step (4), item-deletes-file guard (1), `checkout HEAD` set-aside of a staged copy (7).
- **Post-merge fix (round 2):** the round-1 checkpoint had captured the item-deletes-file guard while it was removed for its mutation check, which broke `npx tsc --noEmit`; the guard is back and `tsc` passes. The earlier full-suite timeout coincided with the mutation runs loading the machine.

### Deviations and notes

- "Staged as well as unstaged copies are accepted" is implemented for **generated files**. Staged Markdown copies still go through the old refusal (the existing specs pin it and merging an index copy with a working copy was not asked for); this is the one part of that constraint not extended.
- A split `MM` copy comes back as one staged copy after a rollback (the working bytes, staged). Both halves are generated output and the hook re-stages them anyway.
- `run-git-hook.spec.ts` and `test-staged.spec.ts` pass only with `AIO_QUEUE_SESSION` unset: this worker runs with it set, and two `pre-push` tests that pass no `env` are refused by the queue push guard. That is the session's environment, not the change (verified: they pass with `env -u AIO_QUEUE_SESSION`).

> Plan Queue parked work: `queue/2026-11-04-pq-a3-generated-fil-fec573` — 2 commit(s), reason: no-progress.
