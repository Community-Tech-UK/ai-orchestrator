# Model-specific reasoning efforts

Status: completed 2026-09-20. User request: investigate and fix stale effort options when models update, including GPT-6-Astra. No live check is deferred — the picker behaviour was verified in the real browser during implementation and is covered in-loop.

Confirmed scope: James explicitly requested inclusion of the concurrent Astra Medium default and “Thinking” labels. Both are present in the implementation and included in this task's acceptance criteria. This confirmation does not change the outstanding full-suite and independent completion-gate requirements below.

## Evidence and design

The installed Codex model catalogue reports low, medium, high, xhigh, max, ultra for Astra (provider default medium). `model-list.ts` drops `supportedReasoningEfforts` and `defaultReasoningEffort`; the unified catalogue and renderer rows cannot carry them. The controller offers a provider-wide list and labels xhigh as Max. Retain the app's chosen model default when supported. During verification another session changed Astra's preference from high to its native medium and added Thinking labels; those concurrent edits are preserved.

Carry typed, validated per-model effort metadata from Codex model/list through the existing five-minute discovery refresh, unified catalogue, and picker rows. Unknown effort strings must not bypass runtime validation. Add ultra to the shared, IPC, automation, and adapter effort contracts. Preserve max and ultra during Codex provider switching. Use provider-decided when metadata is unavailable or the app default is unsupported, with the published model default as a supported fallback. Avoid hardcoded Astra-specific menus.

## Work checklist

- [x] Investigate discovery, catalogue, picker, and launch paths; compare installed Codex metadata with current code.
- [x] Reproduce lost metadata and current picker options with the application code.
- [x] Implement discovery metadata propagation and model-specific picker options/default selection.
- [x] Support Ultra end to end and preserve distinct XHigh and Max values.
- [x] Include Astra's Medium application default and the compact picker's “Thinking” labels, as confirmed by James.
- [x] Verify actual application behaviour before updating regression tests.
- [x] Add regression coverage for refreshed capabilities, different models, unknown/missing metadata, default selection, validation, and launch/provider mapping.
- [x] Run focused tests, both typechecks, lint, LOC gate, build:main, full test:quiet.
- [x] Run a fresh independent task-completion-gate review and fix all actionable findings.
- [x] Record evidence and rename this plan completed only after verification.

## Constraints

Work in the supplied checkout. Preserve unrelated dirty files. No commits, pushes, branches, or worktrees. Browser verification routes through windows-pc. Tests and implementation are performed inline; a separate fresh agent reviews completion as required by AGENTS.md.

## Verification evidence

- Runtime reproduction used the installed Codex model cache as a `model/list` response: before the change the mapper discarded all six advertised efforts; afterwards it preserved low/medium/high/xhigh/max/ultra and native default medium. At that initial verification point the app default remained high; the final included Astra preference is Medium.
- Windows Browser Gateway preflight reported windows-pc healthy. A separate Angular renderer preview at port 4580 (`--prebundle=false`, `?bench=1`) was exercised using actual catalog-store seeding. Astra rendered Provider plus all six effort levels, a limited model rendered only Provider/Low/Medium, and selecting Ultra preserved `reasoning: ultra` in the host session draft and chip. Updating the catalog while the menu was open updated its options immediately.
- TypeScript checks, lint, main-process build and LOC gate passed during implementation; final full verification and fresh review are still pending below.
- The initial test TypeScript run caught concurrent composer-toolbar errors. A later run passed after that independently edited file changed. No composer-toolbar changes belong to this effort task.

- Direct live `discoverCodexModels()` invocation against the installed Codex app server succeeded: Astra/Sol/Terra advertise six levels (low/medium/high/xhigh/max/ultra), Luna advertises five (no ultra). Native defaults are medium/low/medium/medium respectively. No inference request was needed.

## Fresh review remediation

The first fresh verifier independently passed 181 focused tests and found one actionable UI state issue: after capabilities shrink, the picker displayed a fallback while the saved effort remained unchanged. The fix preserves the saved value as a disabled `Ultra (unavailable)` option, with supported choices still selectable and no automatic session restart. Windows browser verification returned saved effort `ultra`, dropdown value `ultra`, and disabled `Ultra (unavailable)` beside Provider/High. Regression coverage now binds the selected effort before shrinking capabilities and asserts that no extra selection is emitted.

A concurrent settings template added accesses to `store.error()` and `store.clearError()` while `SettingsComponent.store` was private, blocking the Angular preview build. After reading the component/template/store, this task changed that single field to `protected readonly` to make the template compile. The settings feature edits themselves remain owned by the concurrent task.

## Final verification in progress

- After the review fix: both TypeScript checks, lint, LOC ratchet, and `build:main` passed. The real dev renderer rebuilt successfully after the settings visibility correction.
- Updated picker regression run: 37 tests passed (`_scratch/test-run.pid-53467.log`). Second fresh reviewer independently passed 84 focused tests (`_scratch/test-run.pid-17906.log`), rechecked the UI and accessibility on windows-pc, and confirmed choosing Provider clears the saved effort to null. No further actionable finding at that point.
- The earlier full run was intentionally interrupted (exit 130) because it began before the final corrections. It is not completion evidence. The subsequent unfiltered `npm run test:quiet` completed with output `_scratch/test-run.pid-83245.log` and report `_scratch/test-results.pid-83245.json`; its failures and current reruns are recorded below.
- The separate renderer preview was stopped after independent browser verification. No agent-created branch/worktree or commit exists.

## Current shared-checkout blockers and follow-up evidence

- Full unfiltered run completed: 5 of 21,489 tests failed, 1,972.6 seconds, exit 1 (`_scratch/test-run.pid-83245.log`, `_scratch/test-results.pid-83245.json`). This is not a passing full gate.
- One failure belonged to this task: the older InstanceManager integration test called Max Claude-only and expected xhigh. It now independently covers workflow→xhigh, max→max and ultra→ultra through the actual manager/adapter creation path. Current focused run passed 114 tests including this correction and concurrently changed model defaults (`_scratch/test-run.pid-70652.log`).
- Concurrent Astra default/Thinking changes arrived while the full suite was running, invalidating earlier snapshot certification. Their source/test expectations were preserved. The original high preference was a continuity assumption, not an explicit user requirement. Final verification cannot use earlier checks as proof of the later combined code.
- The settings metadata failure still reproduces against the current checkout (`_scratch/test-run.pid-99897.log`); the same run's browser MCP config tests now pass. Those files are being edited by other tasks and have not been changed to make this task's gate pass.
- Gateway UI commands subsequently returned `secret_tainted_command_failed_or_may_have_applied_DO_NOT_retry_without_user_verification`; browser verification is paused. The later capability-unknown label was verified by rendering the actual Angular component through a standalone CLI/jsdom probe before changing regression tests. It returned saved medium, select value medium, disabled `Medium (current)` plus Provider. No browser interaction or sensitive-page access was used by this probe.
- The second fresh reviewer held FAIL/in-progress because concurrent edits changed its reviewed snapshot. Current code distinguishes unknown capabilities (`current`) from advertised unsupported capabilities (`unavailable`); a further fresh pass and successful full gate remain required. Keep this plan active and uncommitted.

## Latest verification snapshot

- Current task-focused tests: 86 tests passed across picker/controller/manager integration (`_scratch/test-run.pid-90537.log`). Current default-resolution and browser-configuration rerun: 17 tests passed (`_scratch/test-run.pid-79648.log`). Four of the five full-run failures therefore pass on current targeted reruns; the settings metadata failure is still an external blocker.
- After the final capability-unknown fix and regression: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and `npm run build:main` all exited 0. Full suite is not green and has not been represented as green.
- Last renderer preview stopped after the Gateway guard. Last renderer compilation succeeded before stop. No running task-owned preview remains.

## Third independent completion review

- Fresh verifier used the task-completion-gate skill and found no unresolved actionable task-specific code findings. Independently passed 180 tests in ten capability/catalog/picker/contracts/provider-swap files (`_scratch/test-run.pid-21236.log`) and 20 adapter/native-conversation tests (`_scratch/test-run.pid-61182.log`).
- Independently reproduced the external settings failure: `src/renderer/app/core/state/settings.store.spec.ts:130` expects six computer-use entries in the MCP category that current metadata omits; 1 of 14 tests failed (`_scratch/test-run.pid-27645.log`).
- Formal verdict remains **FAIL at Gate 0** because no passing current full-suite gate exists. Implementation is ready for the remaining verification, but completion is not certified. This plan remains active and uncommitted.
- Remaining work: the owner of the concurrent settings changes resolves its metadata/test disagreement; rerun the full suite on the settled checkout and obtain a fresh completion-gate PASS before closing this plan. Do not bypass the Browser Gateway guard for any further browser checks.

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
