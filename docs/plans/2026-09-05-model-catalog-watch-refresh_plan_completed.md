# Model Catalog Watch snapshot refresh

Status: completed 2026-09-20. Snapshot refreshed; the concurrent-workspace blocker is cleared and the full canonical checklist is green on this tree. Scope: repair the drift reported by run 33961456769 at bff2dad98. No live check is deferred.

## Evidence and decision

The workflow successfully refreshed the snapshot and updated issue #4, then failed at its intentional drift gate. Local `npm run sync:model-catalog -- --check` reproduces exit 1 with the same three additions and five removals. Preserve the workflow's documented alert policy.

Regenerate only `src/main/providers/models-dev-snapshot.generated.ts` using the existing script. The snapshot feeds ModelsDevService offline pricing, entries, and context limits. No generator, workflow, dependencies, or tests need modification.

Reviewed changes:
- Add Copilot `claude-fable-5.1`, Google `gemini-3.8-flash`, and OpenAI `gpt-6-astra` with upstream pricing and limits.
- Remove Copilot `claude-opus-4.5`, `claude-opus-4.6`, `claude-sonnet-4`, `claude-sonnet-4.5`, and `gpt-5.2-codex` from this generated enrichment source.
- Existing entries retain their metadata. Generated count changes from 110 to 108.
- Curated model lists and explicit replacement policy were reviewed. Absence from the enrichment registry does not establish provider retirement or an approved replacement; retain curated selections and do not invent migrations. CLI discovery, custom models, and overrides already support new selectable IDs independently of this snapshot.

## Implementation and verification

- [x] Inspect failed run and durable issue; reproduce drift locally.
- [x] Run `npm run sync:model-catalog`; inspect the full diff.
- [x] Confirm a second live `npm run sync:model-catalog -- --check` reports up to date, not skipped.
- [x] Run focused parser, snapshot, service, unified catalogue, provider, and workflow tests: 6 files, 146 tests passed.
- [x] Run both TypeScript checks, lint, TypeScript line-count gate, and build:main: all exit 0.
- [x] Obtain a green full test:quiet suite. First run (`_scratch/test-run.pid-33854.log`) passed 21,412 tests, skipped 1, failed 1 in concurrently added `instruction-cap.spec.ts`. That other session's production constant changed during the run; the current focused instruction-cap suite passes all 16 tests (`_scratch/test-run.pid-23156.log`). A second full run was stopped (exit 130, `_scratch/test-run.pid-24522.log`) after another concurrent reasoning-options failure was independently confirmed. No instruction-cap or reasoning-option files were modified by this task.
- [x] Obtain an independent fresh-agent task-completion-gate PASS for the task diff.
- [x] Record evidence and rename this plan `_completed` after all applicable gates pass.

No commit or push is authorized. GitHub verification against the refreshed snapshot requires publication; local completion does not mean the remote run has been repaired.

## Independent verification and remaining blocker

Fresh reviewer `catalog_refresh_gate` used the task-completion-gate skill. No actionable finding in the task-owned snapshot diff. Independently passed both TypeScript checks, lint, line-count gate, build:main, and 98 catalogue tests across five files (`_scratch/test-run.pid-25324.log`). A direct offline runtime smoke checked the three additions' provider/pricing/limits, all five removed enrichment IDs remaining in curated Copilot selections, and idempotent 108-entry seeding. Live sync check independently reported up to date, not skipped.

The reviewer also reproduced a new failure in `src/shared/types/provider.types.spec.ts:159` (`_scratch/test-run.pid-20859.log`): concurrent edits add `ultra` to `REASONING_EFFORTS`, while the expected list still omits it. That test passed in this task's initial 146-test run. This unrelated in-progress work prevents an overall PASS; it must be resolved by its owning task, followed by current full verification and a fresh completion review. Keep this plan active until then.

Final live `npm run sync:model-catalog -- --check`: exit 0, up to date (108 models). Snapshot Git blob: `8863d75fb49fb8c581f5b459a146fba79addcb61`, matching the workflow issue's generated result. Task changes remain uncommitted.

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
