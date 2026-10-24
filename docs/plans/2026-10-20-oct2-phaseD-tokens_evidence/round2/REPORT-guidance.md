# Phase D guidance: final source status

Updated 21 October 2026 in the exact supplied worktree:
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`.

This supersedes the earlier partial report. Requested source integration is implemented and locally verified. RTK remains **OFF**. The end-to-end Claude RTK probe is externally blocked by the actual account monthly spend limit; it was **not retried**. No account limit, credential, permission bypass, global hook, user settings, dependency version, branch, worktree, stash or commit was changed. No new agent, GUI, browser, full test suite or build was run. Root plan/history were neither edited nor copied. Existing foreign hunks, including the Codex remote-policy bridge, remain in place. This report supplies local evidence only; combined project gates and independent verification belong to the coordinator. It makes no independent gate PASS claim.

## 1. A18: durable lifetime policy and paired reviewer protection

- `src/main/cli/adapters/claude-trial-state.ts` owns versioned strict snapshots. Root records freeze the helper setting and RTK scope. Session records prove the reviewer rule was paired with argv and retain the root key. Records live in `<session-policy>/claude-trial-state/{root,session}-<sha256>.json`, use atomic replacement and mode 0600, and contain no prompt or credential. They have no trial-log retention expiry: a session can outlive 60 days. Unavailable storage prevents new local enrollment. Corrupt/missing session proof never authorizes a legacy resume.
- `src/main/instance/lifecycle/token-trial-identity.ts`, `instance-create-builder.ts` and `instance-spawn-policy.ts` bind related children/grandchildren to the root or owning queue item/loop/automation key. New native UUIDs do not assign a new cohort. New instances carry `metadata.tokenTrialKey`; recovery also reads the durable native-session alias, because continuity deliberately omits arbitrary instance metadata. Queue replacements/checkers retain the item key.
- `src/main/cli/adapters/claude-subagent-policy.ts` enrolls only a known Opus parent. Unknown/default/auto, Sonnet and Haiku do not qualify. Native CLI >= 2.1.251 supports the variable as a **default**, so only `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is added; AIO never sets FORCE. Explicit spawn/agent models still win. Caller environment values, including an explicitly empty value, win.
- `src/main/cli/adapters/claude-env-pack.ts`, `claude-cli-adapter.types.ts` and `claude-cli-argv-builder.ts` carry one adapter snapshot and the rule selected with its env. A previously enrolled resume retains Sonnet and carries the fixed instruction to give reviewers/checkers/fresh-eyes helpers the parent's model explicitly. A modern recorded-prompt resume appends just this rule, preserving a caller's replace-mode prompt. Old/unknown CLI versions still get no Sonnet variable. A resume with no paired proof stays un-enrolled. A probe changing between env construction and argv cannot discard a rule already paired with the env.
- `src/main/cli/adapters/claude-system-message.ts` persists adopted native init IDs as aliases. This covers forks/fallback IDs before a later process/app recovery, without changing the root arm. `claude-helper-arm-log.ts` and `claude-env-pack.ts` retain the native transcript hash for report joins and additionally log the hashed root/task key.

### Remote Claude and real call paths

`src/main/cli/adapters/adapter-factory.types.ts` and `adapter-factory.ts` pass Claude identity/snapshot fields without altering the Codex fields. `remote-claude-spawn-policy.ts` and `src/main/remote-node/claude-spawn-policy-schema.ts` extend the existing strict Claude spawn policy. Worker parsing rejects unknown snapshot fields; unsupported workers refuse the policy. A worker uses the controller snapshot, including a caller helper-model override, instead of choosing from worker settings. A rejected preflight or failed RPC creates no durable reviewer proof: the controller records the paired snapshot only after spawn acknowledgement.

`src/main/cli/adapters/remote-cli-adapter.ts` records acknowledged proof and native aliases on the controller. `src/worker-agent/worker-instance-interaction.ts` now publishes a changed native session identity on subsequent activity, rather than only during startup catalog publication, so an adopted ID reaches the controller before recovery. The existing `worker-spawn-policy.ts` -> `LocalInstanceManager` -> real factory path applies the strict snapshot; no Codex snapshot or RPC logic was rewritten.

Runtime integration evidence:

- `src/main/cli/adapters/__tests__/claude-trial-lifetime.integration.spec.ts`: actual instance builder, spawn policy, factories, strict wire parser, real worker manager/factory, hibernate/wake, empty-worker restart, adopted-ID relay, metadata-omitting continuity projection, a separate Node process, control/candidate retention, caller overrides, unknown models/versions, legacy resumes, refused preflights and failed RPCs.
- `src/main/cli/adapters/claude-trial-native-compaction.spec.ts`: the real `compactSessionNatively()` flow uses the same Sonnet env and reviewer rule for the original warm process, `/compact` subprocess and resumed warm process. Only process launch/termination, login and capability probes are substituted; no paid provider runs.

## 2. Three settings and preserved boundaries

All seven surfaces are wired and exercised by `src/main/core/config/settings-control-policy.token-trials.spec.ts`:

1. `src/shared/types/settings.types.ts` extends type-only `TokenTrialSettings` from `src/shared/types/token-trial-settings.types.ts`.
2. `src/shared/types/settings-defaults.ts`: literal defaults `claudeHelperAgentModel='trial'`, `codexCheckerSkillCatalog='trial'`, `rtkAutoApproveScope='off'`.
3. `src/shared/types/settings-metadata-runtime.ts`: labels, choices and lifetime/scope descriptions.
4. `src/shared/types/settings-surfacing.ts`: visible advanced-tab classification.
5. `src/main/core/config/settings-control-policy.ts`: enum validation for renderer and privileged writes.
6. `src/main/core/config/settings-validators.ts`: supported values accepted, invalid values rejected.
7. `src/renderer/app/features/settings/advanced-settings-sections.ts`: all three controls listed.

No further settings edit was needed. The ceiling helper's four threshold settings are intact; their existing settings tests pass. No LOC ceiling was raised. AppSettings remains 887 lines. The context worker closure is exactly **155**, still below the unchanged **156** ceiling; it includes neither the new Claude trial store nor the prompt-injection runtime leaf. Exact measurement: `guidance-worker-closure.json` beside this report. Main's worker-local RLM logging remains in `src/main/rlm/llm-service.ts`, with a type-only `PromptSurface` import; all existing context-window pricing arguments were left untouched.

## 3. RTK: fixed root cohorts, real binary checks, fail-closed denies

- Existing `src/main/cli/rtk/rtk-harm-check.ts` machinery remains scoped to eligible auto-approve Claude spawns with an enabled binary and rewrite-hook config. The arm and frozen scope now use the durable related root/task key in both env logging and argv. Child/replacement UUIDs cannot rerandomize it. Approval sessions retain the ordinary defer hook. A remote/one-shot path without RTK config is not enrolled. No new RTK UI surface or global installation was added.
- `src/main/cli/hooks/rtk-defer-hook.mjs` had a real deny bug: rewrite-only mode discarded RTK exit 2. It now returns explicit **deny**. The ordinary approval path also denies before a stale stored allow can override it. Successful rewrite-only output contains `updatedInput` with **no allow decision**, leaving permission decisions to the native CLI. Exits 1, unavailable binary, errors and unchanged commands preserve their normal fallback behavior. Metadata logs distinguish `denied` from errors/passthrough.
- `src/main/cli/hooks/__tests__/rtk-defer-hook.binary.spec.ts` runs the actual bundled **0.51.0** binary and real Node hook locally. It checks the version, explicit allow and unmatched rewrites without approval, failing command exits, pipefail, pipeline counts, exactly one metadata row per call, native original-command deny rules (including a pipeline), deny over a stored allow, and `rtk gain`. Global user settings/hooks are untouched; fixture policy/data lives in owned scratch directories. Existing hook stub tests cover the remaining exit/error/mode cases.
- An additional safe local binary check confirmed that project `.claude/settings.local.json` denies also return exit 2. This does not substitute for native Claude consuming the hook response.
- `scripts/rtk-trial-report.mjs`, `.d.mts` and `scripts/__tests__/rtk-trial-report.spec.ts` understand the new denied rows, deduplicate replayed tool IDs/results, and combine related native UUIDs by their logged durable trial key. Root/task units, rather than correlated child UUIDs, supply the bootstrap samples and minimum group counts. Mixed-arm roots are excluded; legacy rows without a root key fall back to their native key. The report still refuses a saving claim.

## 4. Existing Steps 2.1/3, 6 and 8: reviewed and regression-checked

No new integration boundary is left for another helper.

- Codex thread/catalog policy: `src/main/cli/adapters/codex/codex-thread-policy.ts`, `codex-thread-requests.ts`, `codex-required-skills.ts`, `src/main/cli/adapters/codex-app-server-turn-adapter.ts`, `codex-cli-adapter.ts`, and `src/main/core/system/session-policy-log.ts`. Required skills remain selectable by explicit `$name` when the checker catalog is omitted. Codex snapshot/remote bridge changes remain with their owner and were preserved.
- Standing-note delivery is already wired in `src/main/cli/adapters/codex-cli-adapter.ts`; the bounded store/debt logic is `src/main/cli/adapters/codex/codex-standing-notes.ts`. Runtime adapter tests in `src/main/cli/adapters/codex-cli-adapter.standing-notes.spec.ts` cover developer-item injection, transient-source exclusion, own-compaction deferral until next send, failed-injection retry and existing compaction counts.
- Provider-unit report source is `scripts/codex-helper-trial-report.mjs` with `.d.mts`, `scripts/__tests__/codex-helper-trial-report.spec.ts`, and npm command `audit:codex-helpers`. It reads the actual policy/turn-share/credits/queue shapes; no optional log-format change is required for it to work.
- Step 8 sources: `src/main/context/prompt-injection-log.ts`, `src/main/context/prompt-budgets.spec.ts`, `src/main/orchestration/orchestration-protocol.prompts.ts`, `src/main/orchestration/loop-iteration-prompt.ts`, `src/main/instance/instance-manager.ts`, `src/main/plan-queue/plan-queue-prompts.ts`, and their delivery callers. Existing short-guide/first-turn reminder delivery, budget assertions, per-surface metadata logging and duplicate-removal tests pass. Main's RLM worker-local logger was retained.
- Scouts: `src/main/orchestration/scout-defaults.ts`, `src/main/instance/instance-orchestration.ts`, `src/main/instance/instance-manager.ts`, `src/main/orchestration/orchestration-protocol.types.ts`, `src/renderer/app/features/instance-detail/fanout-cost.ts` and `src/renderer/app/features/instance-detail/fanout-cost.component.ts`, wired through the instance header. Tests cover balanced/high defaults, explicit-model precedence, scout metadata and aggregate helper-cost display. No source change was required here.

Read-only reports run on the real local data after this work:

- `guidance-codex-report-local.log`: 4 files, 292 policy rows, 267 threads; 0 turn-share rows and 0 credit rows. Every effectiveness comparison is **NOT ENOUGH DATA**.
- `guidance-rtk-report-local.log`: 0 enrolled sessions, **NOT ENOUGH DATA**, consistent with the trial remaining OFF.

## 5. Verification receipts

Every listed `.log` is beside this report. `run-guidance-check.py` writes full stdout/stderr directly to disk and records command, exact exit and duration in the matching `.exit.json`. No test/typecheck exit is inferred through a shell pipeline.

| Receipt/log stem | Command or scope | Actual result |
|---|---|---|
| `guidance-last-lifetime-check` | Final owned-TMPDIR factory/process/worker/compact regression | exit 0; 10 tests |
| `guidance-final-integration` | Explicit 11-file integration/hook/report/worker regression selection; exact arguments in receipt | exit 0; 104 tests |
| `guidance-step6-step8-review` | Explicit 33-file selection in `guidance-focused-specs.txt`, not the full suite | exit 0; 535 tests |
| `guidance-final-targeted` | Earlier expanded 18-file caller/settings/worker selection | exit 0; 184 tests |
| `guidance-final-regression` | Root-group report, hook, settings and lifetime regression selection | exit 0; 61 tests |
| `guidance-final-types` | `rtk proxy npx tsc --noEmit -p tsconfig.electron.json` | exit 0 |
| `guidance-final-spec-types` | `rtk npm run typecheck:spec` (project's 8 GiB wrapper) | exit 0 |
| `guidance-final-lint` | `rtk proxy npx oxlint --config .oxlintrc.json` on changed source/tests; exact paths in receipt | exit 0 |
| `guidance-final-loc` | `rtk npm run check:ts-max-loc` | exit 0; no ceiling changes |
| `guidance-diff-check` | `rtk git diff --check` | exit 0 |
| `guidance-codex-report-local` / `guidance-rtk-report-local` | Real-data reports, `--since 2026-10-17 --json` | both exit 0 |

Earlier failed attempts are retained, not rewritten as successes: `guidance-types-fast` exits 1 because installed tsgo rejects this repository's node10 resolution/baseUrl options; compiler configuration was not changed, and standard tsc subsequently passed. Intermediate main/spec type runs caught the new optional env-record and test wire types, which were corrected. `guidance-native-compact-trial` initially counted a mocked `--help` capability probe as a session launch; the fixture now isolates capability probing and the actual three-launch compaction assertion passes. Prior partial helper warnings/errors are superseded by the current receipts. Expected mock-environment/legacy listener warnings remain visible in full logs.

No full suite, renderer build, main build or independent gate was attempted in this continuation. Those combined gates remain with the coordinator as requested.

## 6. Genuine provider/rebuilt-app checks

1. **Claude RTK end-to-end, blocked by monthly spend limit.** After ordinary service resumes, from this exact worktree run once:
   `rtk proxy node _scratch/oct2-phaseD-round2/probe-scripts/guidance-rtk-after-limit.mjs`
   This prepared recipe was syntax-checked only. It uses existing legitimate authentication, ordinary `dontAsk` permission handling, explicit harmless Bash grants, and a project-local deny rule. It does not disable user settings sources, switch credentials or raise account limits. It runs OFF then ON with the pinned 0.51.0 hook/binary; caps each run at 8 turns/$0.50; attempts exactly status, failing show, a two-line pipeline count, and denied diff; captures raw stream/stderr, process exits, tool-call IDs/results and cost receipts. On any provider refusal/limit/transport failure it stops immediately without retries. Inspect `receipts.json`: four unique calls per arm, failing-show error retained, pipeline count 2, deny retained, ON hook decisions present, no unexpected tools or commands. Only after this native consumption check succeeds should RTK trial enablement be considered; the shipped scope here remains OFF.
2. **Rebuilt Claude app/provider:** one enrolled root of each arm, related helpers and a reviewer/fresh-eyes helper, native compaction and app restart (local and an updated worker). Native transcript model evidence must show candidate general-purpose helpers on Sonnet, explicit reviewers/forks retaining their requested parent model, and unchanged cohort identity. Legacy restored sessions without proof must remain un-enrolled. Requires an available Claude account; local mocked lifecycle evidence is already recorded above.
3. **Rebuilt Codex/provider:** a candidate queue checker actually loads the pinned required skill while its automatic catalog is omitted; a long running-turn and idle/native-compaction conversation receives the standing-notes developer item at the documented boundary. Collect enough real rounds/credits before evaluating effectiveness reports.
4. **Rebuilt renderer:** inspect the helper-count/cost header with actual helpers and the three advanced settings controls. Browser/GUI verification belongs on `windows-pc` through the gateway if requested later; none was attempted here.

## 7. Exact runtime cleanup

`guidance-cleanup-receipt.json` records the exact paths. This continuation removed its disposable `rtk-native-policy-probe` directory and the two empty test-only temp leaves:

- `_scratch/oct2-phaseD-round2/rtk-native-policy-probe/`
- `/var/folders/0n/fs5yys3d0vg0c838h75hyrm00000gn/T/aio-claude-tmp/native-placeholder-b/`
- `/var/folders/0n/fs5yys3d0vg0c838h75hyrm00000gn/T/aio-claude-tmp/remote-adopted-placeholder/`

New integration fixtures now keep TMPDIR inside their owned worktree scratch directory. Tests remove `_scratch/guidance-lifetime-*`, `_scratch/guidance-compact-trial-*` and `_scratch/guidance-rtk-binary-*` in finally/afterEach; no owned test runtime remains. Existing sibling scratch/probe directories from other work were preserved. Logs/receipts, `run-guidance-check.py` and the unexecuted future recipe remain under `_scratch/oct2-phaseD-round2/` for coordinator review, not as runtime source.

The future paid recipe has created no directory because it has not run. When legitimately run, it prints the exact owned `_scratch/oct2-phaseD-round2/guidance-rtk-live-<suffix>/` path and writes it to `receipts.json`; retain evidence first, then remove only that printed directory. Never delete user credential/config directories or live production trial-state records as test cleanup.

## 8. As-built correction from the final trial-integrity continuation

The earlier remote section's RPC-acknowledgement proof was insufficient on an old worker CLI: its snapshot still predicted a guard before the worker version/argv decision. After `guidance-finished.flag`, the narrow continuation removed that prediction. Main now requires actual paired argv plus worker native-init telemetry and successful spawn acknowledgement. Trial-bearing remote Claude also requires exact `claudeTrialExecution:1`; older workers fail closed with an update-worker message. Main logs the bounded actual A18/RTK decisions through existing `instance.telemetry`, stores only session/native-alias proof, and preserves root proof as false. Native/root hashes are carried once, with controller-owned instance identity added at the main writer. RTK paths without supplied config remain excluded and RTK stays OFF.

Full final changes, exact command/exit receipts, limits and cleanup: [REPORT-trial-integrity.md](REPORT-trial-integrity.md). Its final focused regression passes **156 tests / 16 files**, normal main/spec types, scoped lint, LOC and whitespace checks; worker closure remains **155**. The fast tsgo command still rejects the existing config options, with no bypass applied. Earlier guidance facts/receipts and genuinely external checks above are retained. Combined canonical gates, seal cleanup and independent review remain coordinator-owned; this correction makes no independent PASS claim.
