# Loop/automation verification authority — use the verifier we already detected

Status: completed (code + agent-runnable gates); live checks deferred to
[`2026-07-25-loop-verification-authority-autodetect_livetest.md`](./2026-07-25-loop-verification-authority-autodetect_livetest.md)
Date: 2026-07-25

## The defect

Starting a loop on this repo is blocked by:

> Implementation goals need a verification authority: add a verify command
> (tests/build/typecheck), or enable operator-reviewed completion.

…while the same panel, two fields above, says **"Verify command (auto-detected: npm run verify)"**.

The app has already answered its own question and then refuses to start because the
answer wasn't typed into the box.

### Traced call path

| Step | File | What happens |
| --- | --- | --- |
| Detect | `src/main/orchestration/loop-verify-command.ts:32` | `inferLoopVerifyCommand()` walks up/down from the workspace and returns `npm run verify` |
| Show | `src/main/ipc/handlers/loop-handlers.ts:551` → `loop-config-panel.component.ts:329` | result rendered as the `verifyHint()` label — **and nothing else** |
| Gate (renderer) | `loop-config-panel.component.ts:387-394` | reads `verifyCommand()` (the typed field) only; `inferredVerify()` is ignored |
| Build | `loop-config-panel.component.ts:547` | sends `verifyCommand: ''` |
| Gate (main) | `loop-start-config.ts:106-117` | reads `config.completion.verifyCommand` only → same refusal for IPC/programmatic callers |

So `inferLoopVerifyCommand` is **decorative**: its result is never resolved into a config
and never runs. `loop-control.component.ts:659` compounds the lie by displaying
`'auto-detected'` for an empty verify command in the run summary.

### Same root cause on the automations surface

- `packages/contracts/src/schemas/automation.schemas.ts:88` — `verifyCommand: z.string().min(1)`
- `automations-page.component.html:352` — `required`, label "Verify Command (required)"
- `automations-page.component.ts:583` — `canSave()` returns false without it
- `automation-form-model.ts:94` — **silent data loss**: a blank verify command makes
  `formToLoopAction()` return `undefined`, so "Run as autonomous loop" is quietly
  discarded and the automation saves as a one-shot turn with no warning.

## Design

One resolver, used at every start seam. Detection stops being a label and becomes the
actual authority.

### 1. `resolveLoopVerification()` — `src/main/orchestration/loop-verify-command.ts`

Lives beside the inference it wraps. Pure precedence, injectable `infer` for tests:

1. explicit trimmed command → `explicit`
2. `allowOperatorReviewedCompletion` → `operator-reviewed` (a deliberate choice; do
   not silently bolt a detected command onto it)
3. `requireAuthority === false` (investigation loops) → `none`, **no inference** —
   investigation deliverables are cited reports, not builds; running a test suite
   there is cost with no gate value
4. otherwise infer → `inferred` (command + source) or `none`

`requireAuthority` rather than `goalIntent` keeps intent semantics in the caller.

#### Scope guard on adoption

`inferLoopVerifyCommand` searches ancestors *and* descendants, so it can return a
verifier belonging to an enclosing project the loop was never aimed at. Adopting that
silently would gate the run on a suite covering code outside its scope, addressed by an
absolute machine path. The inference result now carries
`scope: 'workspace' | 'descendant' | 'ancestor'`:

- `workspace` / `descendant` → auto-adopted; descendant commands switch from an absolute
  `npm --prefix "/abs/path"` to a workspace-relative `npm --prefix "pkg"`, since verify is
  spawned with `cwd` = the loop's working directory
- `ancestor` → surfaced in the hint as a paste-in suggestion, never adopted

The renderer receives `scope` over the existing infer IPC and applies the same rule, so
the panel never claims "will be used" about a command the main process won't adopt.

### 2. `prepareLoopStartConfig()` — the single main-process authority

Every start seam already funnels through it: loop IPC, automations
(`automation-loop-run.ts:263`), campaigns, `goal-loop-command`, thin-client executor.

- resolve, then throw only when `kind === 'none'` on an implementation goal, with a
  message that says *no verifier was detected in this workspace* (the current text
  implies the user forgot something)
- write the resolved command into `completion.verifyCommand` on every return branch, so
  the loop actually runs it, the persisted run config records it, and
  `manualReviewOnly` (`loop-coordinator.ts:789`) is computed from the real value
- log the adoption with its source

### 3. Renderer stops duplicating a stricter rule

`validationError()` accepts a detected verifier as authority. `buildConfig()` keeps
sending the typed field only — main stays the single source of truth for resolution.

### 4. Automations: blank means auto-detect

Schema allows `''`; `formToLoopAction` keys off `loopEnabled` alone (kills the silent
drop); `canSave()` and `required` drop the verify constraint. Resolution happens at
dispatch, where the working directory is known and the existing terminal-error path
already reports a workspace with no verifier.

### 5. Campaign import

`buildCampaignFromPlan` is deliberately pure/sync, so resolve in the async IPC handler
(`campaign-handlers.ts:95`) and pass the resolved command in.

## Observed, not changed (out of scope)

`loop-handlers.ts:660` — the resume-with-answers path synthesises
`allowOperatorReviewedCompletion: true` whenever the source config carried no
verify command. That branch now outranks inference in the resolver, so a resumed
run still falls back to human sign-off even in a workspace whose verifier we can
now detect. That is the pre-existing, documented intent (the human is already in
the loop, having just answered its questions), and the precedence order is
deliberate — but it does mean resume is the one seam that will not auto-adopt.
Changing it would alter gating for resumed runs, which is its own decision.

### Start seams confirmed to route through the single authority

`loop-handlers.ts:271` (start), `loop-handlers.ts:675` (resume),
`campaign-coordinator.ts:422`, `goal-loop-command.ts:54`, and
`automation-loop-run.ts:263` (automation dispatch, via a dynamic import) all call
`prepareLoopStartConfig`. There is no second copy of the authority rule in the
main process; the renderer's `validationError()` is a UX pre-check only.

`LoopCompletionDetector.runVerify` spawns with `cwd: config.workspaceCwd`
(`loop-completion-detector.ts:657`), **not** `executionCwd`. So an isolated loop's verify
runs against the original checkout, not the worktree it edited. That looks deliberate —
`createWorktree` is called with `skipInstall: true` (`loop-coordinator.ts:840`), so a
worktree has no `node_modules` and an `npm run` verify there would fail outright — but it
does mean the completion gate for an isolated run tests code the loop did not change.
Worth a decision of its own; not touched here.

## Deliberately not changed

- Investigation loops still need no verifier and gain no inferred one.
- Operator-reviewed still requires a finite cost cap.
- Cross-model review is still corroboration, never the completion authority.
- The upward/downward package.json search is unchanged — adopting it only makes true
  what the hint already displayed.

## Verification

- new: `loop-verify-command.spec.ts` — precedence table for the resolver
- new: `loop-start-config.spec.ts` — implementation goal + `package.json` verify script
  starts and carries the inferred command (the reported bug)
- new: `loop-config-panel.component.spec.ts` — detected verifier unblocks submit
- updated: `automation-form-model.spec.ts` — blank verify keeps the loop action

### As-built gate results (2026-07-25)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 |
| `npm run lint` | exit 0 — all files pass |
| `npm run check:ts-max-loc` | exit 0 — ratchet passed |
| targeted specs (4 files, the ones above) | 84 passed |
| campaign/automations seam specs (3 files) | 32 passed |
| `npm run test:quiet` (full suite) | 1571 files · 15572 tests passed |

### As-built deviations

- **`loop-control.component.ts:659` needed no edit.** The run summary's
  `'auto-detected'` fallback is now unreachable: `manualReviewOnly` is
  `!config.completion.verifyCommand.trim()` (`loop-coordinator.ts:789`), and the
  resolved command is written into `completion.verifyCommand` before the run
  persists — so an empty command always renders as `manual review (no command)`,
  and a resolved one renders as itself. The stale string is dead rather than
  wrong; left alone to avoid churn in a file this change does not otherwise touch.
- **The infer IPC needed no handler edit.** `loop-handlers.ts:554` returns the
  `inferLoopVerifyCommand` result verbatim, so adding `scope` to
  `InferredLoopVerifyCommand` carried it to the renderer through the existing
  channel.

Live checks that need a rebuilt/restarted app are recorded in
`2026-07-25-loop-verification-authority-autodetect_livetest.md`.
