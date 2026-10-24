# A18 execution-proof and telemetry remediation

Checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`.

Status: all actionable findings in `review-notes-final-trial-integrity.md` are addressed in source and focused tests. This is an implementation handoff, **not an independent PASS**. Coordinator owns final canonical gates, root documentation/seal cleanup and independent verification. No commit, stash, branch/worktree operation, full suite, build, GUI/browser, new agent, provider call, quota change, credential switch, configuration bypass or global setting change was performed.

## Concurrency and scope

Read AGENTS, RTK instructions, architecture, findings, reports, full implementation files and relevant callers/types/tests first. Kept the checkout untouched until `_scratch/oct2-phaseD-round2/guidance-finished.flag` existed, polling in 15-second intervals. Re-read the final guidance report and current implementation after the flag. Root plan/history were not edited or copied. Existing source hunks were preserved.

The final guidance helper had already fixed missing-directory enrollment and atomic state replacement. Its final remote change deferred persistence until RPC acknowledgement, but still manufactured a `reviewerRuleProven:true` snapshot from `cliVersion:null`. An old CLI could acknowledge startup without the guard, leaving false controller proof. This continuation replaces that anticipated proof with execution-node evidence.

## Acceptance checklist

- [x] **Durable storage finding rechecked, retained.** `prepareClaudeTrialPolicy` chooses parent/OFF when no durable directory exists or writing fails. Existing atomic replacement and 0600 writes remain. Added explicit no-directory and failed-write checks; workers can still apply a validated controller snapshot without their own durable store.
- [x] **Fresh snapshots contain no invented reviewer proof.** `resolveRemoteClaudeSpawnPolicy` no longer evaluates an unknown worker version to set proof. Existing genuinely proven session records remain usable; roots and new children remain unproven.
- [x] **Execution acknowledgement.** The real env decision is captured during adapter construction; argv stages the actual guard and RTK decision only after materialization succeeds. Native Claude `system/init` publishes it once, with the authoritative native session hash. A constructed adapter, built argv, successful spawn RPC without init, rejected launch or rejected acknowledgement cannot grant controller proof.
- [x] **Controller acknowledgement barrier.** One bounded pending init record is held until the spawn RPC succeeds; teardown discards it. Later init records are handled immediately on the acknowledged session. No new RPC method was introduced.
- [x] **Safe worker version handling.** Trial-bearing Claude requires exact numeric `claudeTrialExecution:1` alongside existing `claudeSpawnPolicy:1`. Missing, boolean, string or unknown capability versions fail before transport and are checked again at spawn after re-registration. Registration/heartbeat schemas preserve only the supported literal. No local/silent policy fallback was added. Non-trial base Claude policy compatibility and Codex capability semantics remain intact.
- [x] **Remote arm logging.** Versioned, strict, bounded `claude_trial_execution` metadata crosses existing `instance.telemetry`, worker observer/notifier, authenticated coordinator router and matched remote adapter. Main writes the existing `claude-helper-arm` / `claude-rtk-arm` row families. Unsupported CLI and caller-env skips are recorded. No prompts, env values, paths or credentials travel in this event.
- [x] **Identity and hashing.** Worker hashes native and root identities once. Main checks the root digest against its own snapshot, writes hashes unchanged, adds its own controller `instanceId`, and stores native proof at `session-<native digest>.json`. Raw native recovery hashes to that same filename; no digest-of-digest alias is created.
- [x] **Lifetime and pairing.** Actual guarded execution is persisted only to session identities/native aliases, never the cohort/root. Worker retains actual init proof in the existing hibernate/wake snapshot. Controller/app recovery and worker restart restore proven arms and paired reviewer rules; old-CLI fresh → supported-CLI resume with no guard stays un-enrolled. Legacy resumes cannot bootstrap proof from a malformed resume record.
- [x] **RTK scope preserved.** Remote one-shots still receive no RTK config and remain excluded. When an eligible config is supplied to the execution adapter, the real argv/metadata path records its arm; absent config produces `rtkArm:null` and no RTK row. RTK remains OFF globally. The account monthly spend-limit probe was not retried.
- [x] **Validation/teardown/fail-soft.** Closed reason/arm enums, exact wire version, fixed SHA-256 shapes, bounded model/version metadata and decision consistency checks reject malformed payloads. Invalid node, instance and root routing does not reach the writer. Durable replay does not duplicate records. Termination, failed launch/rejected ack and resident exit remove telemetry observation. Publisher/storage failure does not break otherwise valid native startup or grant in-memory controller proof.
- [x] **Preserved boundaries.** Codex snapshots, policy/share/credit telemetry and report readers pass unchanged regression checks. No context-window pricing observation argument or RLM `PromptSurface` import was changed. Worker closure is exactly 155 with zero Electron value importers. No LOC ceiling was raised.
- [ ] **Coordinator final verification and independent review.** Intentionally outside this continuation; no independent PASS is claimed.

## Exact source changes

New production leaves:

- `src/main/remote-node/claude-trial-execution-schema.ts`: strict version-1 execution metadata and semantic decision checks.
- `src/main/cli/adapters/claude-trial-execution.ts`: capture env decision, stage successful argv, publish once on native init.
- `src/main/cli/adapters/remote-claude-trial-telemetry.ts`: bounded acknowledgement buffer, main arm writer and proof handoff.

Narrow integration hunks:

- `claude-env-pack.ts`, `claude-cli-argv-builder.ts`, `claude-cli-adapter.types.ts`, `claude-system-message.ts`: internal execution draft and native-init publisher. No edits to the 2118-line entry adapter.
- `remote-claude-spawn-policy.ts`, `remote-spawn-policy.ts`, `remote-cli-adapter.ts`: remove predicted success, require execution capability, consume/commit/reset actual telemetry.
- `claude-trial-state.ts`: reuse atomic writer for already-hashed native aliases; controller proof updates memory only after successful durable writes; private writer rejects an absent directory instead of silently returning.
- `claude-helper-arm-log.ts`: optional controller-owned instance identity on existing row types.
- `remote-spawn-policy-schemas.ts`, `instance-telemetry-rpc.ts`, `shared/types/worker-node.types.ts`, `worker-agent/capability-reporter.ts`: capability and existing telemetry union plumbing.
- `worker-agent/worker-instance-telemetry.ts`, `local-instance-manager.ts`: paired listener and validated actual-proof retention in the worker snapshot used for hibernate/wake.

New tests:

- `src/worker-agent/__tests__/remote-claude-trial-execution.spec.ts` (12 tests): real controller factory, remote adapter, JSON/schema boundary, real worker manager/factory, Claude constructor/env/argv/spawn/native-init parser, observer/notifier, router and actual main file writer. Only native process I/O, login/discovery and unrelated account-pool activation are synthetic. Includes a separate Node process reading durable native proof.
- `src/main/cli/adapters/claude-trial-execution.spec.ts` (4 tests): eligible/absent RTK config through actual adapter/argv/native-init/observer/main writer, null/unwritable store, publisher failure and atomic temp cleanup.

Existing test assertions retained, with capability fixtures and predicted-proof expectation corrected: `__tests__/claude-trial-lifetime.integration.spec.ts`, `__tests__/adapter-factory-claude-remote-policy.spec.ts`, and `remote-node/worker-node-claude-spawn-policy.spec.ts`. The lifetime fixture now relays actual worker execution telemetry; an RPC-only acknowledgement correctly carries false proof.

## Verification and exact commands

All shell commands used RTK. Full stdout/stderr are on disk, with genuine process exit codes. `run-trial-integrity-check.py` records the complete argv array, cwd, start time, duration, exit code and log path in each matching `.exit.json`. Those arrays are the exact final commands, without abbreviated path lists.

| Receipt stem under `_scratch/oct2-phaseD-round2/` | Exact command / source of complete command | Actual result |
| --- | --- | --- |
| `trial-integrity-regression-final` | Complete 16-file `rtk npm run test:quiet -- ...` argv in `trial-integrity-regression-final.exit.json`; reproduced verbatim below | **0; 16 files / 156 tests**. Full runner log `_scratch/test-run.pid-2583.log`. |
| `trial-integrity-main-types-final` | `rtk proxy node node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json` | **0** |
| `trial-integrity-spec-types-final` | `rtk npm run typecheck:spec` | **0**, normal project 8 GiB wrapper |
| `trial-integrity-lint-final` | Complete scoped `rtk proxy node_modules/.bin/oxlint --config .oxlintrc.json` argv in `trial-integrity-lint-final.exit.json` (23 implementation/test paths) | **0**, three existing warnings only: two subagent regex escapes and the capability reporter's existing spread fallback |
| `trial-integrity-loc-final` | `rtk npm run check:ts-max-loc` | **0**, ceilings unchanged |
| `trial-integrity-diff-check-final` | `rtk git diff --check` | **0** |
| `trial-integrity-fast-types.log` | `rtk npm run typecheck:fast` | **1**: installed tsgo rejects existing `moduleResolution=node10` and `baseUrl`. No compiler/config override was used; standard main and spec compilers above pass. |

Final focused command:

```sh
rtk npm run test:quiet -- \
  src/worker-agent/__tests__/remote-claude-trial-execution.spec.ts \
  src/main/cli/adapters/claude-trial-execution.spec.ts \
  src/main/cli/adapters/__tests__/claude-trial-lifetime.integration.spec.ts \
  src/main/cli/adapters/__tests__/adapter-factory-claude-remote-policy.spec.ts \
  src/main/remote-node/worker-node-claude-spawn-policy.spec.ts \
  src/main/cli/adapters/claude-helper-agent-trial.spec.ts \
  src/main/cli/adapters/claude-rtk-harm-check.spec.ts \
  src/main/cli/adapters/claude-helper-arm-log.spec.ts \
  src/main/cli/adapters/claude-trial-native-compaction.spec.ts \
  src/worker-agent/__tests__/remote-instance-telemetry.spec.ts \
  src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts \
  src/main/cli/adapters/remote-cli-adapter.spec.ts \
  src/worker-agent/local-instance-manager.spawn-policy.spec.ts \
  src/main/instance/__tests__/context-worker-import-isolation.spec.ts \
  scripts/__tests__/rtk-trial-report.spec.ts \
  scripts/__tests__/codex-helper-trial-report.spec.ts
```

Reproduce-first and intermediate evidence, retained honestly:

- `trial-integrity-red.log`: exit 1, initial fixture setup error (the wrapper attempted native spies on the remote adapter); not product evidence.
- `trial-integrity-red-behavior.log`: exit 1, **3/5 failed**, actual defects: old CLI snapshot falsely proven, RPC acknowledgement without native init falsely persisted proof, caller-env execution produced no main arm row. Native launch/rejected-ack safety cases already passed at that revision. Full `_scratch/test-run.pid-8870.log`.
- `trial-integrity-wire-first.log`: exit 1, 1/5 failed because the synthetic RPC rejection had left the successfully created worker fixture alive. Fixture now explicitly tears down the rejected child; main proof assertions already passed. Full `_scratch/test-run.pid-13061.log`.
- `trial-integrity-focused-first.log`: exit 0, 4 files / 50 tests; `_scratch/test-run.pid-44095.log`.
- `trial-integrity-regression.log`: exit 0, 16 files / 155 tests before the final resident-exit/semantic validation assertion; `_scratch/test-run.pid-77955.log`.
- `trial-integrity-main-types.log`, `trial-integrity-spec-types.log`, `trial-integrity-lint.log`, `trial-integrity-loc.log`: earlier passing checks, superseded by final receipts above.

No full suite, full lint, main/renderer build or independent completion gate was run. Those belong to the coordinator.

## Limits and cleanup

Execution proof means the worker constructed the paired argv/env and Claude acknowledged native init, with the spawn RPC accepted. It does not assert that a model obeyed the reviewer instruction or that a paid run succeeded. The guidance report's provider/model measurement and genuine rebuilt-app checks remain outstanding. No real Windows worker was contacted/upgraded; trial sessions now clearly require a rebuilt worker advertising `claudeTrialExecution:1`.

`trial-integrity-cleanup.json` records current closure and cleanup evidence:

- Worker closure **155**, Electron value importers **0**.
- Entry adapter **2118**, remote adapter **694**, RPC schemas **758**, dispatcher **700**, shared settings **887**. Shared settings were not edited in this continuation; 887 was the helper's supplied final state. LOC gate passes without ceiling changes.
- **Zero** owned `trial-integrity-test-*` or `trial-integrity-unit-*` runtime directories remain. TMPDIR and temporary model/settings readers are scoped and restored by test teardown; fake process I/O creates no native CLI process. Managers/notifiers/router listeners and timers are torn down.
- Logs, exact exit receipts, cleanup receipt and the small receipt runner remain in this scratch folder for coordinator review. Prior helpers' artifacts were preserved. No production trial-state directory, user credentials/settings, branch, worktree or stash was removed or altered.

All source/tests remain uncommitted in the supplied checkout. Coordinator may now run canonical verification and fresh independent review against the combined work.
