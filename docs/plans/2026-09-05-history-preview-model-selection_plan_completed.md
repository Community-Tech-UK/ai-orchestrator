# Closed-session model selection implementation plan

Status: completed 2026-09-20. James approved implementation of the diagnosed bug and proposed UX. Live checks deferred to [2026-09-05-history-preview-model-selection_livetest.md](./2026-09-05-history-preview-model-selection_livetest.md) (6 open).

## Acceptance criteria

- [x] A model/provider/reasoning choice in a closed history preview updates entry-scoped pending state without sending a synthetic preview ID to live IPC.
- [x] The composer says “Will use <model> when resumed”; pending choices survive switching between previews within the renderer session.
- [x] Restore, including background restore triggered by typing, is reused per history entry. Apply the latest selection to the real instance before sending, starting a loop, or forking an edited resend.
- [x] Failed or merely queued model changes never release a message on the wrong model. Retain draft/attachments and show a useful error for retry.
- [x] Live composer feedback distinguishes applying, queued, confirmed, and rejected changes. The compact picker cannot independently flash success for an unconfirmed host operation.
- [x] Regression coverage includes restore/apply races, navigation, retries, provider/reasoning/runtime-target forwarding, and actual rendered feedback.

## Implementation

1. Reproduce the existing preview picker failure in the dev renderer through the Windows Browser Gateway, using synthetic history and an instrumented IPC boundary.
2. Add a focused history-preview session service for per-entry pending selections, shared restore promises, and ordered model application before continuation. Reuse the existing history restore and model-change IPC contracts.
3. Wire the detail component's continuation paths to the service and the composer toolbar to pending preview state. Keep historical transcript metadata unchanged.
4. Give the composer ownership of confirmed feedback; keep form-only picker wording accurate.
5. Verify dev-renderer behavior before adding regression tests, then run focused tests and canonical gates.
6. Run a fresh independent task-completion-gate review, resolve findings and repeat until PASS. Complete this document only after verification.

## Risks and checks

Background restore may finish before or after selection; rapid changes and navigation must not cross entry boundaries. Live IPC may accept a queued request without applying it, so continuation must not treat acceptance as confirmation. Failed sends must preserve composition. Existing history, composer, and compact-picker tests cover integration, with additional ordered async and rendered UI regressions.

Canonical gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run test:quiet`. Also compile/verify the dev renderer.

No new branch/worktree, commits, pushes, or changes to unrelated work.

## Implementation and verification notes

- Root cause reproduced with the actual rendered toolbar and picker in an isolated Angular TestBed probe: a synthetic preview ID reached live model IPC while the picker showed success. After implementation the rendered probe shows only the entry-scoped pending choice and no live model call.
- The new service owns entry-scoped selections, restoration and ordered application. Typing warms a restore; send, loop start and edited resend await confirmation. Queued replies are re-confirmed when ready, and model application has one 30-second deadline, including IPC waits and newer selections.
- Continuation provider defaults follow pending CLI selections without changing historical metadata. Explicit loop-panel overrides retain their existing behavior. If the choice changes during loop preparation, start is refused with a retry message and the composition stays intact; normal sends still apply the latest choice. The loop helper also captures the current panel configuration after asynchronous attachment reads, retaining explicit advanced overrides.
- Composer feedback is owned by the host. Live request tokens prevent backend state hydration, navigation or destruction from causing stale feedback. A rendered regression reproduced a stuck Applying status before this correction.
- Focused renderer/service/integration checks, production renderer build, both typechecks, lint, LOC ratchet and main/preload build have passed during implementation. Full-suite and final fresh completion review evidence is still pending; do not treat this document as completed.
- Windows Browser Gateway preflight succeeded. Its subsequent evaluation returned `secret_tainted_command_failed_or_may_have_applied_DO_NOT_retry_without_user_verification` (audit `3f2bbbc4-6842-448f-9fdf-d83a8affb7db`). Browser testing stopped and verification was requested from James. No browser retry or local fallback was attempted. Rendered component tests are passing but do not claim a real-provider smoke test.
- Pending real-provider checks: [history-preview-model-selection_livetest.md](./2026-09-05-history-preview-model-selection_livetest.md).

## Current completion evidence

- Third fresh review: no actionable task-scoped code findings; independently passed 5 files / 84 tests (`_scratch/test-run.pid-2259.log`) and `git diff --check`. Formal verdict is FAIL at Gate 0 because repository failures outside this task prevent canonical completion.
- Full suite completed with exit 1: **4 of 21,481 tests failed**, 1999.3 seconds. Log: `_scratch/test-run.pid-18677.log`. Failures are outside task-owned files: `instance-manager.change-model.spec.ts` expects Codex `max` to map to `xhigh`, while the concurrently edited provider mapping now supports `max`; `settings.store.spec.ts` expects the old MCP metadata category keys after concurrent settings changes; `reasoning-effort-resolution.spec.ts` expects Astra medium but receives high; `browser-mcp-config.spec.ts` expects a stable-protocol environment flag that is absent.
- Both failures reproduce against the current checkout in `_scratch/test-run.pid-67834.log` (2 of 34 tests failed). Their assertions have not been changed for this task. This prevents canonical completion; keep this plan active and uncommitted.
- The later browser-config and reasoning-resolution failures passed on a focused rerun against the concurrently updated checkout: 2 files / 17 tests, exit 0, `_scratch/test-run.pid-77712.log`. This does not turn the completed full-suite run green; the original provider-swap and settings failures remain the last verified blockers. No task source or tests were changed to repair those external failures.
- The owned dev renderer process was stopped. The plan and live-check document remain untracked (`??`); no branch/worktree, commit, push or running-app restart was performed.

### Rebuild follow-up — 2026-09-05 evening

James reports rebuilding/restarting. The compiled renderer contains the fix. The two previously
remaining test failures now pass (2 files / 36 tests, exit 0, `_scratch/test-run.pid-45738.log`).
This supersedes the earlier claim that those failures persist, but does not replace a full-suite
completion gate. Running-app confirmation is requested and remains pending; see the live-check
document for fresh Browser Gateway/build evidence. No source changes were needed for this recheck.
The five task-specific specs also passed again: 84 tests, exit 0, 5.5 seconds,
`_scratch/test-run.pid-47938.log`.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.

### Checkbox reconciliation (2026-09-20)

Boxes ticked to match reality at the `_completed` rename, so a reader does not find a closed plan
full of apparently-unfinished work. Each acceptance item was confirmed by an independent fresh-eyes
reviewer against the executing code (with file:line evidence), and the gate items were confirmed by
running them on this tree: both typechecks, lint, the LOC ratchet, `build:main`, `build:renderer`
and the full `test:quiet` suite (2167 files / 25734 tests) all exit 0. The concurrent-session
failures recorded against the gate items above are gone. Live checks, where any remain, are named in
the status line and tracked in the linked `_livetest.md` — they are not ticked here.
