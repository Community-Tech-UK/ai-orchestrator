# F2 / F5 scoped repair report

Status: both assigned findings implemented and focused verification passed. This is a scoped handover, not an independent gate PASS or whole-plan completion claim. No plan/spec was closed or renamed.

## Scope and ownership

Used only the supplied AIO checkout. No other agent was started. No staging, commits, branches, worktrees, copies, merges, dependency/config/ceiling/suppression changes, skipped/deleted/weakened tests, personal database/settings access, browser/UI, external send, or deployment was performed.

Own production changes are limited to:

- `src/main/automations/automation-tool-impl.ts`: execution-transition authority checks and preservation of harmless edit scheduling.
- `src/main/mcp/orchestrator-automation-tools.ts`: authenticated caller metadata for postponement, using the existing trusted context.
- `src/main/automations/automation-runner-helpers.ts`: transient collection of captured assistant output for comparison.
- `src/main/automations/automation-runner.ts`: call the helper when terminalizing. Runner is 796 lines, below the requested 799-line cap.

New tests:

- `src/main/automations/automation-authority-transitions.spec.ts`
- `src/main/automations/automation-monitor-runner.spec.ts`

Existing edits in these production files were retained. No lifecycle, instance, queue, receipt/spend/path-display, parent documentation, or unrelated source file was edited. The authority validation and saved-runtime enforcement modules themselves were not changed. No existing fixture expectations were changed.

Applied systematic-debugging, test-driven-development, and verification-before-completion skills. Read the entire review findings report, executing touched modules, relevant caller/wiring, store, completion-receipt, reconciliation, authority, types and adjacent tests before the relevant edits.

## F2: authority at execution-affecting transitions

Root cause: `updateAutomation` only rebuilt and checked action fields. An authenticated caller could enable or reschedule a saved higher-authority human job without changing an action field. Also, recomputing the next fire during a metadata-only edit undid an operator's postponement/backoff, and unconditional past-one-time settlement could dispatch work during a harmless edit.

Implemented at `automation-tool-impl.ts:348` onward:

- Enabling an active disabled job, a changed active schedule/timezone, changing missed-run policy to `runOnce`, or concurrency policy to `queue` validates the effective saved action against the authenticated real caller before any store write/scheduling.
- Successful agent execution transitions pin inherited model/effort/approval values and the trusted authority snapshot through the existing `enforceAutomationAuthority` and bounded-destination checks.
- Metadata, unchanged scheduling fields, policy reductions, disabling, and scheduling edits while disabled preserve saved human authority. Metadata/no-op edits retain the existing next-fire value and do not invoke past-one-time dispatch.
- An agent can lower the action to its own model/effort/approval limits and reactivate it in the same update.
- Human operations remain unrestricted by caller ceilings; the human IPC form is unchanged. Existing actual human IPC -> store -> loop -> native-factory coverage passed.

Adjacent real bypass: absolute `postpone_automation.untilIso` could bring a job forward, or rearm a consumed schedule with no next fire. Reproduced RED separately. The tool now passes trusted caller metadata (`orchestrator-automation-tools.ts:563`), and `automation-tool-impl.ts:455` checks the saved action when bringing work forward or rearming it. Genuine later postponement preserves human authority and remains allowed, including with no caller lookup. Human direct operations retain their existing authority.

Evidence: new real MCP-definition -> implementation -> in-memory SQLite store tests reject inherited higher model, effort, and auto-approval reactivation; cron/runAt/timezone rescheduling; work-enabling policy changes; unresolved callers; and earlier absolute postponement for both schedule types. They assert the durable job remains unchanged on refusal. Positive cases cover metadata, human intent/postponement preservation, disabling, disabled schedule edits, policy reduction, lowering/reactivation, safe inherited defaults, unchanged scheduling fields, real delays and unrestricted human updates.

## F5: compare relevant complete assistant output

Root cause: the runner captured output chunks but passed only `lastAssistantOutput` to the store's existing monitor fingerprint logic. Earlier changed warnings were invisible when the final signoff was unchanged.

`monitorAssistantOutput` (`automation-runner-helpers.ts:35`) reads all already-captured nonblank assistant chunks in order. It ignores tool/system/debug output, uses a transient joined string, and stores no second run-lifetime transcript or additional durable output. The last-assistant fallback preserves the existing no-captured-chunk behavior. `automation-runner.ts:657` passes this value through the existing real store terminalization path. The existing timestamp/date/duration/ID normalization, semantic-result quiet counters, bounded summary, output archive and saved runtime-authority logic are unchanged.

The new typed runner/store fixture builds complete `Instance` records, sets `requestCount: 1`, `adapterGeneration: 7`, and emits typed `ProviderRuntimeEventEnvelope` values with matching generation and `requestCountAtCompletion`. Each individual fire is asserted running before completion and succeeded with a terminal timestamp afterward, before any next fire or monitor assertion. It uses real migrations, runner, store, monitor and semantic-result MCP tool, with controlled provider/host/content infrastructure and an isolated scratch output directory. It does not reuse the reviewer's incomplete scratch fixture.

Evidence: stable final signoff plus an earlier changed warning resets backoff; transient dates/times/durations/IDs across multiple assistant messages still allow backoff; changing tool/debug noise does not reset it; semantic quiet counters remain independent of fingerprint changes; opt-in behavior remains required. Original PhaseC normalization/long-output tests and output/store/grouping tests also pass.

## Commands and receipts

Every shell command used `rtk` / raw `rtk proxy`. Test and compiler commands used `/Users/suas/.nvm/versions/node/v24.22.1/bin` first in PATH. All test commands used this exact prefix:

```sh
rtk proxy env PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:/opt/homebrew/bin:/usr/bin:/bin AIO_COST_ATTRIBUTION=0 AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=<suffix> npm run test:quiet -- <files>
```

Logs are `_scratch/test-run.<suffix>.log`; machine results are `_scratch/test-results.<suffix>.json`.

| Suffix | Files below | Exit | Observed result |
|---|---|---:|---|
| `phasec-authority-monitor-baseline-20261031a` | Baseline | 0 | 4 files, 99 passed before edits |
| `phasec-authority-monitor-red-20261031a` | New regressions | 1 | 14 intended behavioral assertion failures of 18 tests, including both findings; no fixture/runtime crash |
| `phasec-authority-monitor-green-20261031a` | New regressions | 0 | 2 files, 18 passed after initial runtime fixes |
| `phasec-authority-monitor-postpone-red-20261031a` | Authority transitions only | 1 | 2 intended earlier-postponement assertion failures of 19 tests; other cases passed |
| `phasec-authority-monitor-focused-20261031a` | Focused regression set | 0 | 10 files, 235 passed |
| `phasec-authority-monitor-output-groups-20261031a` | Existing output/group set | 0 | 6 files, 67 passed |

Baseline file arguments:

```text
src/main/automations/automation-authority-runtime.spec.ts
src/main/automations/automation-phasec.spec.ts
src/main/automations/automation-tool-impl.spec.ts
src/main/automations/automation-runner.spec.ts
```

New regression file arguments:

```text
src/main/automations/automation-authority-transitions.spec.ts
src/main/automations/automation-monitor-runner.spec.ts
```

Focused regression set file arguments (baseline plus new regressions plus these four):

```text
src/main/automations/automation-one-shot-resolution.spec.ts
src/main/automations/automation-loop-authority.spec.ts
src/main/automations/automation-store.spec.ts
src/main/mcp/orchestrator-automation-tools.spec.ts
```

Existing output/group set file arguments:

```text
src/main/automations/automation-runner-delivery.spec.ts
src/renderer/app/features/instance-list/project-group-computation.service.spec.ts
src/renderer/app/features/instance-detail/thought-group-coalescer.spec.ts
src/renderer/app/shared/components/tool-group/tool-group.component.spec.ts
src/renderer/app/features/instance-detail/output-stream.utils.spec.ts
src/renderer/app/core/state/instance/instance-output.store.spec.ts
```

Other verification (same RTK/PATH prefix, raw output redirected to the named scratch log, shell exit propagated):

| Command | Exit | Log / evidence |
|---|---:|---|
| `npm run typecheck:spec` | 0 | `_scratch/phasec-authority-monitor-typecheck-spec.log`; used the existing project script/heap limit unchanged |
| `npx eslint` with all six own source/test paths listed under Scope | 0 | `_scratch/phasec-authority-monitor-eslint.log` |
| Same file-level ESLint command after final import formatting | 0 | `_scratch/phasec-authority-monitor-eslint-final.log` |
| `git diff --check --` with the four own production paths listed under Scope | 0 | `_scratch/phasec-authority-monitor-diff-check.log` |
| Scoped source SHA-256 / line receipt | 0 | `_scratch/phasec-authority-monitor-source-receipt.json` |

## Cleanup and limitations

- All own test, ESLint and compiler command sessions exited. The new monitor fixture untracks remaining instances, removes event listeners, clears fake timers, closes its in-memory database and removes its isolated output directory in teardown. No provider/worker/browser process was started by the new fixtures.
- A read-only `ps` inventory attempt returned `operation not permitted`; no retry or broad process kill was made. Own child completion is established by the command-session exit results above.
- No full test suite, broad lint, main/renderer/worker build, installed app/restart, external provider or UI verification was run. These remain with the parent after all writers stop, as requested. Spec compilation passed; it is not a substitute for the parent's Electron/Angular build gates.
- No independent reviewer was spawned, per the explicit instruction. Parent/read-only reviewer must do the independent final acceptance; this report is not self-certification of the entire plan.

## Requested-item checklist

- [x] F2 reproduced RED through the real MCP tool and store, fixed in the runtime transition path, then GREEN with refusal and permitted-operation coverage.
- [x] F5 reproduced RED with a complete typed receipt-bearing runner/store fixture, fixed using captured assistant output, then GREEN with every run explicitly terminalized.
- [x] Existing authority, output/normalization, store, human IPC and grouping regressions pass; spec compiler and focused lint pass.
- [x] Preserved unrelated edits and the runner cap; left plans/specs, index, branch/worktree lifecycle, dependencies, configuration and suppression/test policy untouched.
- [ ] Parent integrated gates and independent acceptance remain outside this scoped repair.
