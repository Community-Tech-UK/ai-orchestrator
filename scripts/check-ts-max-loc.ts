/**
 * check-ts-max-loc.ts
 *
 * Ratchet script that enforces TypeScript file size limits.
 *
 * - Test sources are skipped; broad behavior coverage should not be shaped by LOC ratchets.
 * - For production files NOT in the allowlist: a violation if the file exceeds MAX_LINES (700).
 *   New large files must be added to the allowlist intentionally — SLACK does NOT apply here.
 * - For production files IN the allowlist: a violation only once the file grows beyond its
 *   recorded ceiling PLUS a small SLACK tolerance. The recorded ceiling still documents the
 *   intended size and should be re-tightened opportunistically (e.g. after a refactor); the
 *   slack just stops a one- or two-line edit from breaking the build during active work.
 *   Files that have crept past their ceiling but are still within slack are reported as an
 *   informational notice, not a violation.
 *
 * Strictness:
 * - By default violations FAIL the process (exit 1). This is what CI uses.
 * - With `--warn` (or CHECK_TS_MAX_LOC_WARN=1) violations are printed but the process exits 0.
 *   The local git hooks (pre-commit/pre-push) run in this warn-only mode so a commit or push is
 *   never blocked purely by file size — CI remains the enforcing gate.
 *
 * Usage:
 *   tsx scripts/check-ts-max-loc.ts            # strict (CI): violations fail
 *   tsx scripts/check-ts-max-loc.ts --warn     # warn-only: violations reported, exit 0
 *   CHECK_TS_MAX_LOC_SLACK=100 tsx scripts/check-ts-max-loc.ts   # widen the allowlist tolerance
 *
 * To add a new large file: run the script, note the count, add an entry below.
 * To tighten a ceiling after refactoring: lower the number.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MAX_LINES = 700;

/**
 * Tolerance (in lines) added on top of each allowlisted file's recorded ceiling
 * before growth is treated as a violation. Gives breathing room during active
 * development so small edits to a large file don't break the build. Override with
 * the CHECK_TS_MAX_LOC_SLACK env var (e.g. set to 0 for the old exact-ratchet
 * behavior). Does NOT apply to the hard MAX_LINES limit for brand-new files.
 */
const SLACK = ((): number => {
  const raw = Number(process.env['CHECK_TS_MAX_LOC_SLACK']);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 50;
})();

/**
 * When true, violations are reported but do NOT fail the process (exit 0).
 * Enabled via the `--warn` flag or CHECK_TS_MAX_LOC_WARN=1. Local git hooks use
 * this so commits/pushes are never blocked by size; CI runs strict (no flag).
 */
const WARN_ONLY =
  process.argv.includes('--warn') || /^(1|true|yes)$/i.test(process.env['CHECK_TS_MAX_LOC_WARN'] ?? '');

/**
 * Known large files and their current line-count ceilings.
 * The ceiling is the maximum the file is allowed to be. It must never grow.
 * Reduce the ceiling as the file is refactored.
 */
const ALLOWLIST: Record<string, number> = {
  // Main process — app
  'src/main/app/initialization-steps.ts': 916,
  // Benchmarks
  'benchmarks/external-benchmarks/swe-bench/adapter.ts': 795,
  'benchmarks/external-benchmarks/swe-bench/runner.ts': 888,
  'benchmarks/orchestrator-benchmark/runner.ts': 768,
  // Contracts
  'packages/contracts/src/schemas/session.schemas.ts': 743,
  // Allowlisted for the loop-engine/Pi-Task-18 fields (ledger-stall bounds,
  // CompletionSignalEvidence.openCount, LoopState ledger +
  // justCompacted, follow-up pending-input kind) — type/schema round-trip.
  // Raised 807 -> 864 (Fable WS6 loopRecipe/maxTurnsPerIteration/singleLoopOverride
  // + WS7 scope-assessment + WS8 ledger-convergence schemas).
  'packages/contracts/src/schemas/loop.schemas.ts': 864,
  // Raised 1788 -> 1803 for the provider swap fields on the change-model and
  // state-update payloads (provider + pendingModelChange round-trip).
  'packages/contracts/src/types/transport.types.ts': 1803,
  // Main process — automations
  'src/main/automations/automation-store.ts': 861,
  // Added 2026-07-16 at 753 (Fable WS5 spawn-loop dispatch branch + recovery
  // seams + breaker auto-disable notification; the loop logic itself lives in
  // automation-loop-run.ts). Re-tighten after the next runner split.
  'src/main/automations/automation-runner.ts': 753,
  // Main process — browser gateway
  // Raised 2284 -> 2400 for the execute_fill_plan + fill_credential service
  // methods (delegators to browser-form-fill-operations) + the credential
  // vault/authorization wiring for unattended overnight form-filling.
  // Raised 2400 -> 2410 for the email_code mailbox-reader pass-through.
  // Raised 2410 -> 2445 for resolveUploadApproval: the shared denied-upload
  // approval path (stored request + auto-approve) that both the managed and
  // existing-tab upload branches must go through.
  'src/main/browser-gateway/browser-gateway-service.ts': 2445,
  // Main process — desktop gateway
  // Crossed 700 during the in-flight desktop computer-use gateway work
  // (2026-07-12). Allowlisted at its then-current size so the gate stays
  // green; that work stream should refactor or re-tighten when it lands.
  'src/main/desktop-gateway/desktop-gateway-service.ts': 727,
  // Main process — channels
  'src/main/channels/adapters/discord-adapter.ts': 965,
  'src/main/channels/channel-message-router.ts': 2543,
  // Main process — CLI adapters
  'src/main/cli/adapters/acp-cli-adapter.ts': 2142,
  'src/main/cli/adapters/base-cli-adapter.ts': 940,
  // Raised 2218 -> 2286 for resident interrupt control_request handling.
  // Raised 2286 -> 2345 for per-text-block assistant emission + rate-limit dedup.
  'src/main/cli/adapters/claude-cli-adapter.ts': 2345,
  // Re-tightened after extracting the exec helpers to codex/exec-helpers.ts.
  'src/main/cli/adapters/codex-cli-adapter.ts': 3344,
  'src/main/cli/adapters/copilot-cli-adapter.ts': 1060,
  'src/main/cli/adapters/cursor-cli-adapter.ts': 1083,
  'src/main/cli/adapters/gemini-cli-adapter.ts': 892,
  // Main process — chats
  'src/main/chats/chat-service.ts': 788,
  // Main process — codemem
  'src/main/codemem/cas-store.ts': 765,
  'src/main/codemem/code-index-manager.ts': 792,
  // Main process — context
  'src/main/context/context-compactor.ts': 911,
  'src/main/context/jit-loader.ts': 773,
  // Main process — core
  'src/main/core/config/claude-md-loader.ts': 804,
  'src/main/core/error-recovery.ts': 990,
  // Main process — history
  'src/main/history/history-manager.ts': 1429,
  // Main process — indexing
  'src/main/indexing/benchmarks/benchmark-utils.ts': 820,
  'src/main/indexing/tree-sitter-chunker.ts': 716,
  // Main process — instance
  // Raised 2343 -> 2394 for the non-destructive streaming-replace guard.
  'src/main/instance/instance-communication.ts': 2577,
  'src/main/instance/instance-context.ts': 1265,
  // Raised 3450 -> 3528 for the queue-aware YOLO toggle (park-while-busy +
  // auto-apply-on-idle); the bulk lives in lifecycle/yolo-mode-queue.ts.
  // Tightened 3528 -> 3405 after extracting changeModel's execution body into
  // lifecycle/runtime-reconciler.ts (provider/model swap is its first client;
  // desired-runtime queueing lives in lifecycle/desired-runtime-queue.ts).
  'src/main/instance/instance-lifecycle.ts': 3405,
  // Raised 2632 -> 2655 for the sendInput post-wait liveness re-check (fail
  // fast instead of delivering input into a terminated instance).
  'src/main/instance/instance-manager.ts': 2722,
  'src/main/instance/instance-orchestration.ts': 1068,
  'src/main/instance/lifecycle/interrupt-respawn-handler.ts': 1421,
  // Main process — IPC handlers
  'src/main/ipc/handlers/app-handlers.ts': 660,
  'src/main/ipc/handlers/instance-handlers.ts': 1158,
  // Added 2026-07-16 at 794 (Fable WS6 LOOP_LIST_RECIPES + WS7 LOOP_ASSESS_SCOPE
  // read-only endpoints and the LOOP_START scope guard). Re-tighten after the
  // loop-handler split.
  'src/main/ipc/handlers/loop-handlers.ts': 794,
  'src/main/ipc/handlers/mcp-handlers.ts': 925,
  'src/main/ipc/handlers/session-handlers.ts': 1045,
  'src/main/ipc/handlers/vcs-handlers.ts': 992,
  'src/main/ipc/orchestration-ipc-handler.ts': 1316,
  // Main process — learning
  'src/main/learning/ab-testing.ts': 832,
  'src/main/learning/habit-tracker.ts': 728,
  'src/main/learning/metrics-collector.ts': 737,
  'src/main/learning/outcome-tracker.ts': 722,
  'src/main/learning/preference-store.ts': 676,
  // Main process — MCP
  'src/main/mcp/mcp-manager.ts': 1025,
  'src/main/mcp/mcp-tool-search.ts': 735,
  // Added 2026-07-16 at 771 (Fable WS11.5 read_node_output afterSeq cursor:
  // buildReadNodeOutputResult pure serialization + schema/doc additions live
  // beside the tool types). Re-tighten after a tool-defs split.
  'src/main/mcp/orchestrator-tools.ts': 771,
  // Crossed 700 by two lines of sync_to_node/sync_from_node context wiring.
  'src/main/mcp/orchestrator-tools-rpc-server.ts': 710,
  // Main process — remote node file transfer
  // Crossed 700 adding the sync_to_node/sync_from_node MCP handlers, which
  // must share this service's node/root/workspace validation helpers.
  'src/main/remote-node/remote-node-file-transfer-mcp-service.ts': 830,
  // Crossed 700 adding readFileChunk/writeFileChunk for streamed transfers,
  // which must share this handler's path/root/symlink write validations.
  'src/main/remote-node/node-filesystem-handler.ts': 760,
  // Main process — mobile gateway
  'src/main/mobile-gateway/mobile-gateway-server.ts': 1528,
  // Main process — memory
  'src/main/memory/codebase-miner.ts': 725,
  'src/main/memory/critique-agent.ts': 817,
  'src/main/memory/proactive-surfacer.ts': 701,
  'src/main/memory/procedural-store.ts': 802,
  'src/main/memory/project-memory-brief.ts': 997,
  'src/main/memory/r1-memory-manager.ts': 793,
  'src/main/memory/unified-controller.ts': 1312,
  // Main process — orchestration
  'src/main/orchestration/child-result-storage.ts': 836,
  'src/main/orchestration/cli-verification-extension.ts': 936,
  'src/main/orchestration/consensus-coordinator.ts': 859,
  'src/main/orchestration/consensus.ts': 759,
  // Raised 844 -> 907 for the reviewer format-repair retry + shared operation deadline.
  'src/main/orchestration/cross-model-review-service.ts': 907,
  'src/main/orchestration/debate-coordinator.ts': 1179,
  // Re-tightened after extracting loop-branch-selector-helpers.ts, then again
  // after extracting invocation-model-resolver.ts (model resolution + cheap-model
  // eligibility classifier).
  // Raised 2026-07-16 (loop-convergence WS4+WS5 seams; observer/discipline glue
  // already extracted to loop-attempt-observation.ts / loop-context-discipline-runtime.ts —
  // re-tighten after the next invoker refactor).
  'src/main/orchestration/default-invokers.ts': 1597,
  'src/main/orchestration/embedding-service.ts': 845,
  // Raised 3170 -> 3277 for typed intervention queueing and audit-gate
  // integration points. Audit mechanics live in loop-audit-runtime.ts.
  // Raised 3369 -> 3480 for B5 post-compaction canary + Pi Task 18
  // follow-up/steering drain (pure helpers extracted to loop-coordinator-block-utils.ts).
  // Raised 3480 -> 3496 for D5 self-declared more-work-remaining completion veto.
  // Raised 3496 -> 3567 for fail-closed ratchet hook termination,
  // tool-rw-lock-conflict terminal failures, and explicit loop failure signaling.
  // Raised 2026-07-16 (loop-convergence WS3+WS5 decision seams; pure logic lives in
  // loop-ledger-progress.ts / loop-invocation-attempt.ts — re-tighten at WS10).
  // Raised 3719 -> 3780 (Fable WS6 Task 3 PLAN prior-context assembly + Task 4
  // review-lesson gate wiring). Capture wiring itself lives in
  // loop-review-lesson-capture-wiring.ts / loop-prior-context.ts — re-tighten
  // after the next coordinator extraction.
  'src/main/orchestration/loop-coordinator.ts': 3780,
  // Re-tightened after extracting loop-completed-plan-helpers.ts.
  'src/main/orchestration/loop-completion-detector.ts': 794,
  'src/main/orchestration/loop-store.ts': 767,
  'src/main/orchestration/loop-progress-detector.ts': 755,
  // Added 2026-07-16 at 714 (Fable WS6 Task 3: planStageContext threaded through
  // buildPrompt/buildReviewDrivenPrompt; recipe stage-work now resolves via
  // loop-recipes.ts). Re-tighten after the prompt-builder extraction.
  'src/main/orchestration/loop-stage-machine.ts': 714,
  'src/main/orchestration/multi-verify-coordinator.ts': 1177,
  'src/main/orchestration/orchestration-handler.ts': 1458,
  'src/main/orchestration/supervisor.ts': 735,
  // Main process — plugins
  'src/main/plugins/plugin-manager.ts': 1303,
  // Main process — providers
  'src/main/providers/model-discovery.ts': 552,
  // Main process — remote
  'src/main/remote/observer-server.ts': 864,
  // Main process — review
  // Added at its origin/main size after it crossed the hard limit before the
  // startup-regression repair. Keep this as a ratchet pending a dedicated split.
  'src/main/review/local-review-tool-runner.ts': 715,
  // Main process — repo jobs
  'src/main/repo-jobs/repo-job-service.ts': 989,
  // Main process — RLM
  'src/main/rlm/episodic-rlm-store.ts': 766,
  'src/main/rlm/hyde-service.ts': 734,
  'src/main/rlm/llm-service.ts': 1024,
  'src/main/rlm/smart-compaction.ts': 880,
  // Main process — security
  'src/main/security/permission-manager.ts': 1151,
  // Main process — session
  'src/main/session/checkpoint-manager.ts': 752,
  // Re-tightened after moving the public session state interfaces to
  // session-continuity.types.ts. This remains a decomposition candidate.
  'src/main/session/session-continuity.ts': 1799,
  // Main process — workspace
  'src/main/workspace/git/vcs-manager.ts': 1296,
  // Raised for the worktree-isolation P4-P7 wiring (opt-in + shared
  // auto-integration, clonefile deps, per-session port). Heavy logic lives in
  // sibling modules: worktree-deps.ts, worktree-port.ts, worktree-integration.ts,
  // git-write-queue.ts. Re-tighten if the merge subsystem is later extracted.
  'src/main/workspace/git/worktree-manager.ts': 1040,
  'src/main/workspace/lsp-manager.ts': 899,
  // Preload
  'src/preload/domains/orchestration.preload.ts': 940,
  // Renderer — services
  'src/renderer/app/core/services/ipc/memory-ipc.service.ts': 724,
  'src/renderer/app/core/services/ipc/orchestration-ipc.service.ts': 745,
  'src/renderer/app/core/services/new-session-draft.service.ts': 869,
  // Renderer — stores
  'src/renderer/app/core/state/instance/instance-list.store.ts': 796,
  // Raised 774 -> 811 for permanent-send-failure draft restore + zombie-busy
  // reconciler wiring (status-reconciler service owns the polling logic).
  'src/renderer/app/core/state/instance/instance-messaging.store.ts': 825,
  'src/renderer/app/core/state/instance/instance.store.ts': 749,
  // Added 2026-07-16 at 710 (Fable WS6 recipe picker options + WS6 maxTurns/
  // allowUnbounded loop-config plumbing). Re-tighten after a store split.
  'src/renderer/app/core/state/loop.store.ts': 710,
  'src/renderer/app/core/state/source-control.store.ts': 976,
  // Renderer — feature components
  'src/renderer/app/features/archive/archive-page.component.ts': 1059,
  'src/renderer/app/features/chats/session-artifacts-strip.component.ts': 729,
  'src/renderer/app/features/communication/communication-page.component.ts': 729,
  'src/renderer/app/features/debate/debate-visualization.component.ts': 993,
  'src/renderer/app/features/debate/enhanced-debate-visualization.component.ts': 821,
  'src/renderer/app/features/editor/editor-page.component.ts': 951,
  'src/renderer/app/features/file-explorer/file-explorer.component.ts': 1096,
  'src/renderer/app/features/hooks/hooks-config.component.ts': 1035,
  'src/renderer/app/features/hooks/hooks-page.component.ts': 767,
  'src/renderer/app/features/instance-detail/input-panel.component.ts': 1714,
  'src/renderer/app/features/instance-detail/instance-detail.component.ts': 1554,
  'src/renderer/app/features/instance-detail/output-stream.component.ts': 1266,
  // Allowlisted at 747 when the Outputs rows gained a right-click context menu
  // (Open with preferred program / Open in editor / Open in Finder / Copy path),
  // mirroring session-artifacts-strip. Inline template + styles push it past 700.
  'src/renderer/app/features/instance-detail/session-progress-panel.component.ts': 747,
  'src/renderer/app/features/instance-detail/user-action-request.component.ts': 991,
  'src/renderer/app/features/instance-list/instance-list.component.ts': 1334,
  'src/renderer/app/features/knowledge/knowledge-page.component.ts': 1322,
  'src/renderer/app/features/logs/logs-page.component.ts': 1020,
  // Raised 992 -> 1051 for the Task 18 renderer follow-up affordance (queue a
  // `follow-up` from the loop control bar) — completes end-to-end exposure.
  // Added 2026-07-16 at 736 (Fable WS5 trigger picker, webhook filter rows,
  // and loop-action controls on the automation editor; pure mapping lives in
  // automation-form-model.ts). Re-tighten after a form-component split.
  'src/renderer/app/features/automations/automations-page.component.ts': 736,
  'src/renderer/app/features/loop/loop-control.component.ts': 1073,
  'src/renderer/app/features/mcp/mcp-page.component.ts': 1123,
  'src/renderer/app/features/memory/memory-browser.component.ts': 957,
  // Raised 946 -> 957 for hybrid usage-based row ordering in Favorites/provider tabs.
  // Raised 957 -> 964: default favorites now mirror each provider tab's usage-ordered top row.
  // Raised 964 -> 1029: curated DEFAULT_FAVORITE_MODEL_KEYS default with per-provider fallback.
  // Raised 1029 -> 1038: outlined (unfilled) star for non-favourited rows, gold fill when favourited.
  'src/renderer/app/features/models/model-selection-panel.component.ts': 1038,
  'src/renderer/app/features/models/models-page.component.ts': 768,
  'src/renderer/app/features/observations/observations-page.component.ts': 808,
  'src/renderer/app/features/plan/plan-page.component.ts': 1036,
  'src/renderer/app/features/plugins/plugins-page.component.ts': 1208,
  'src/renderer/app/features/remote-config/remote-config-page.component.ts': 815,
  'src/renderer/app/features/replay/session-replay-page.component.ts': 910,
  'src/renderer/app/features/review/review-results.component.ts': 858,
  'src/renderer/app/features/review/reviews-page.component.ts': 724,
  'src/renderer/app/features/rlm/context-browser/context-query-panel.component.ts': 852,
  'src/renderer/app/features/rlm/rlm-analytics.component.ts': 702,
  'src/renderer/app/features/semantic-search/semantic-search-page.component.ts': 865,
  'src/renderer/app/features/settings/ecosystem-settings-tab.component.ts': 733,
  'src/renderer/app/features/settings/permissions-settings-tab.component.ts': 413,
  'src/renderer/app/features/skills/skill-browser.component.ts': 766,
  'src/renderer/app/features/stats/stats-page.component.ts': 868,
  'src/renderer/app/features/tasks/tasks-page.component.ts': 994,
  'src/renderer/app/features/training/training-page.component.ts': 818,
  'src/renderer/app/features/verification/config/api-key-manager.component.ts': 890,
  'src/renderer/app/features/verification/config/verification-preferences.component.ts': 857,
  'src/renderer/app/features/verification/execution/agent-selector.component.ts': 745,
  'src/renderer/app/features/verification/results/export-panel.component.ts': 774,
  'src/renderer/app/features/workflow/workflow-page.component.ts': 799,
  'src/renderer/app/features/workflow/workflow-progress.component.ts': 733,
  'src/renderer/app/features/worktree/worktree-page.component.ts': 717,
  'src/renderer/app/features/worktree/worktree-panel.component.ts': 714,
  // Main process — services (voice/STT)
  // Pre-existing large file committed in the "Loop engine overhaul" work,
  // unrelated to the loop-engine/pi-capabilities specs. Allowlisted at its
  // current size pending a dedicated STT-follow-up split (see OUTSTANDING.md).
  'src/main/services/voice/providers/local-whisper-transcription-provider.ts': 849,
  // Shared
  'src/shared/types/loop.types.ts': 780,
  // Worker agent
  'src/worker-agent/worker-agent.ts': 981,
};

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf8');
    const withoutFinalNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
    return withoutFinalNewline === '' ? 0 : withoutFinalNewline.split('\n').length;
  } catch {
    return 0;
  }
}

function isTestSourceFile(relPath: string): boolean {
  const normalizedPath = relPath.replace(/\\/g, '/');
  return (
    normalizedPath.endsWith('.spec.ts') ||
    normalizedPath.endsWith('.test.ts') ||
    normalizedPath.includes('/__tests__/') ||
    normalizedPath.startsWith('__tests__/')
  );
}

function main(): void {
  const repoRoot = process.cwd();

  const trackedFiles = execFileSync('git', ['ls-files', '*.ts'], { cwd: repoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const checkedFiles = trackedFiles.filter((relPath) => !isTestSourceFile(relPath));
  const skippedTestFiles = trackedFiles.length - checkedFiles.length;

  const violations: string[] = [];
  const nearLimit: string[] = [];

  for (const relPath of checkedFiles) {
    const absPath = resolve(repoRoot, relPath);
    const lines = countLines(absPath);

    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, relPath)) {
      const ceiling = ALLOWLIST[relPath];
      const hardLimit = ceiling + SLACK;
      if (lines > hardLimit) {
        violations.push(
          `RATCHET EXCEEDED: ${relPath} has ${lines} lines (ceiling: ${ceiling}, tolerance: +${SLACK}). ` +
            `File grew well past its ceiling — refactor it down or raise the ceiling intentionally.`,
        );
      } else if (lines > ceiling) {
        nearLimit.push(
          `${relPath} is ${lines} lines — ${lines - ceiling} over its ${ceiling} ceiling but within the +${SLACK} tolerance.`,
        );
      }
    } else {
      if (lines > MAX_LINES) {
        violations.push(
          `TOO LARGE: ${relPath} has ${lines} lines (limit: ${MAX_LINES}). ` +
            `Either refactor the file or add it to the allowlist in scripts/check-ts-max-loc.ts.`,
        );
      }
    }
  }

  if (nearLimit.length > 0) {
    console.warn(
      `\nNote: ${nearLimit.length} allowlisted file(s) crept past their ceiling but stay within ` +
        `the +${SLACK}-line tolerance — please re-tighten the ceiling when convenient:`,
    );
    for (const n of nearLimit) {
      console.warn(`  - ${n}`);
    }
  }

  if (violations.length > 0) {
    const logViolation = WARN_ONLY ? console.warn : console.error;
    logViolation(`\nTypeScript file size ratchet ${WARN_ONLY ? 'WARNING' : 'FAILED'}:\n`);
    for (const v of violations) {
      logViolation(`  - ${v}`);
    }
    logViolation(`\n${violations.length} violation(s) found.`);
    if (WARN_ONLY) {
      console.warn(`\n(warn-only mode: not failing. Set CHECK_TS_MAX_LOC_SLACK to adjust tolerance.)`);
      process.exit(0);
    }
    console.error(
      `\nThis check is warn-only in local git hooks but enforced here/in CI. ` +
        `Refactor, raise the ceiling intentionally, or widen CHECK_TS_MAX_LOC_SLACK.`,
    );
    process.exit(1);
  }

  console.log(
    `TypeScript file size ratchet passed. ` +
      `Checked ${checkedFiles.length} production files (limit: ${MAX_LINES} lines, ` +
      `${Object.keys(ALLOWLIST).length} allowlisted legacy files (+${SLACK} tolerance), ` +
      `${skippedTestFiles} test files skipped).`,
  );
  process.exit(0);
}

main();
