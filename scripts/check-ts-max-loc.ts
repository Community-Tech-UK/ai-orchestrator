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
  'src/main/app/initialization-steps.ts': 887,
  // Benchmarks
  'benchmarks/external-benchmarks/swe-bench/adapter.ts': 795,
  'benchmarks/external-benchmarks/swe-bench/runner.ts': 888,
  'benchmarks/orchestrator-benchmark/runner.ts': 768,
  // Contracts
  'packages/contracts/src/schemas/session.schemas.ts': 742,
  'packages/contracts/src/types/transport.types.ts': 1827,
  // Main process — automations
  'src/main/automations/automation-store.ts': 847,
  // Main process — browser gateway
  'src/main/browser-gateway/browser-gateway-service.ts': 2319,
  // Main process — channels
  'src/main/channels/adapters/discord-adapter.ts': 965,
  'src/main/channels/channel-message-router.ts': 2521,
  // Main process — CLI adapters
  'src/main/cli/adapters/acp-cli-adapter.ts': 2142,
  'src/main/cli/adapters/base-cli-adapter.ts': 830,
  'src/main/cli/adapters/claude-cli-adapter.ts': 2049,
  'src/main/cli/adapters/codex-cli-adapter.ts': 3029,
  'src/main/cli/adapters/copilot-cli-adapter.ts': 978,
  'src/main/cli/adapters/cursor-cli-adapter.ts': 1044,
  'src/main/cli/adapters/gemini-cli-adapter.ts': 887,
  // Main process — codemem
  'src/main/codemem/code-index-manager.ts': 782,
  // Main process — context
  'src/main/context/context-compactor.ts': 952,
  'src/main/context/jit-loader.ts': 772,
  // Main process — core
  'src/main/core/config/claude-md-loader.ts': 804,
  'src/main/core/error-recovery.ts': 950,
  // Main process — history
  'src/main/history/history-manager.ts': 1362,
  // Main process — indexing
  'src/main/indexing/benchmarks/benchmark-utils.ts': 820,
  'src/main/indexing/tree-sitter-chunker.ts': 716,
  // Main process — instance
  'src/main/instance/instance-communication.ts': 2140,
  'src/main/instance/instance-context.ts': 1210,
  'src/main/instance/instance-lifecycle.ts': 3172,
  'src/main/instance/instance-manager.ts': 2508,
  'src/main/instance/instance-orchestration.ts': 1516,
  'src/main/instance/lifecycle/interrupt-respawn-handler.ts': 1071,
  // Main process — IPC handlers
  'src/main/ipc/handlers/app-handlers.ts': 767,
  'src/main/ipc/handlers/instance-handlers.ts': 1125,
  'src/main/ipc/handlers/mcp-handlers.ts': 941,
  'src/main/ipc/handlers/session-handlers.ts': 1013,
  'src/main/ipc/handlers/vcs-handlers.ts': 978,
  'src/main/ipc/orchestration-ipc-handler.ts': 1316,
  // Main process — learning
  'src/main/learning/ab-testing.ts': 832,
  'src/main/learning/habit-tracker.ts': 733,
  'src/main/learning/metrics-collector.ts': 731,
  'src/main/learning/outcome-tracker.ts': 743,
  'src/main/learning/preference-store.ts': 676,
  // Main process — MCP
  'src/main/mcp/mcp-manager.ts': 1025,
  'src/main/mcp/mcp-tool-search.ts': 842,
  // Main process — mobile gateway
  'src/main/mobile-gateway/mobile-gateway-server.ts': 1362,
  // Main process — memory
  'src/main/memory/codebase-miner.ts': 725,
  'src/main/memory/critique-agent.ts': 817,
  'src/main/memory/proactive-surfacer.ts': 701,
  'src/main/memory/procedural-store.ts': 802,
  'src/main/memory/project-memory-brief.ts': 997,
  'src/main/memory/r1-memory-manager.ts': 792,
  'src/main/memory/unified-controller.ts': 1320,
  // Main process — orchestration
  'src/main/orchestration/child-result-storage.ts': 836,
  'src/main/orchestration/cli-verification-extension.ts': 973,
  'src/main/orchestration/consensus-coordinator.ts': 888,
  'src/main/orchestration/consensus.ts': 759,
  'src/main/orchestration/cross-model-review-service.ts': 755,
  'src/main/orchestration/debate-coordinator.ts': 1196,
  'src/main/orchestration/default-invokers.ts': 1776,
  'src/main/orchestration/embedding-service.ts': 845,
  'src/main/orchestration/loop-coordinator.ts': 2635,
  'src/main/orchestration/loop-progress-detector.ts': 725,
  'src/main/orchestration/multi-verify-coordinator.ts': 1172,
  'src/main/orchestration/orchestration-handler.ts': 1443,
  'src/main/orchestration/supervisor.ts': 735,
  'src/main/orchestration/voting.ts': 777,
  // Main process — persistence
  'src/main/persistence/rlm/rlm-schema.ts': 2136,
  // Main process — plugins
  'src/main/plugins/plugin-manager.ts': 1235,
  // Main process — providers
  'src/main/providers/model-discovery.ts': 552,
  // Main process — remote
  'src/main/remote/observer-server.ts': 864,
  // Main process — repo jobs
  'src/main/repo-jobs/repo-job-service.ts': 989,
  // Main process — RLM
  'src/main/rlm/ast-chunker.ts': 766,
  'src/main/rlm/episodic-rlm-store.ts': 765,
  'src/main/rlm/hyde-service.ts': 716,
  'src/main/rlm/llm-service.ts': 962,
  'src/main/rlm/smart-compaction.ts': 879,
  // Main process — security
  'src/main/security/permission-manager.ts': 1610,
  'src/main/security/sandbox-manager.ts': 877,
  // Main process — session
  'src/main/session/checkpoint-manager.ts': 752,
  'src/main/session/session-continuity.ts': 1700,
  // Main process — workspace
  'src/main/workspace/git/vcs-manager.ts': 1280,
  'src/main/workspace/git/worktree-manager.ts': 742,
  'src/main/workspace/lsp-manager.ts': 899,
  // Preload
  'src/preload/domains/orchestration.preload.ts': 940,
  // Renderer — services
  'src/renderer/app/core/services/ipc/memory-ipc.service.ts': 724,
  'src/renderer/app/core/services/ipc/orchestration-ipc.service.ts': 745,
  // Renderer — stores
  'src/renderer/app/core/state/instance/instance-list.store.ts': 972,
  'src/renderer/app/core/state/instance/instance-messaging.store.ts': 774,
  'src/renderer/app/core/state/instance/instance.store.ts': 766,
  'src/renderer/app/core/state/source-control.store.ts': 976,
  // Renderer — feature components
  'src/renderer/app/features/archive/archive-page.component.ts': 1059,
  'src/renderer/app/features/chats/session-artifacts-strip.component.ts': 729,
  'src/renderer/app/features/communication/communication-page.component.ts': 729,
  'src/renderer/app/features/debate/debate-visualization.component.ts': 993,
  'src/renderer/app/features/debate/enhanced-debate-visualization.component.ts': 821,
  'src/renderer/app/features/editor/editor-page.component.ts': 951,
  'src/renderer/app/features/file-explorer/file-explorer.component.ts': 1069,
  'src/renderer/app/features/hooks/hooks-config.component.ts': 1027,
  'src/renderer/app/features/hooks/hooks-page.component.ts': 767,
  'src/renderer/app/features/instance-detail/input-panel.component.ts': 1703,
  'src/renderer/app/features/instance-detail/instance-detail.component.ts': 1491,
  'src/renderer/app/features/instance-detail/output-stream.component.ts': 1159,
  'src/renderer/app/features/instance-detail/user-action-request.component.ts': 1015,
  'src/renderer/app/features/instance-list/instance-list.component.ts': 1360,
  'src/renderer/app/features/instance-list/instance-row.component.ts': 843,
  'src/renderer/app/features/knowledge/knowledge-page.component.ts': 1322,
  'src/renderer/app/features/logs/logs-page.component.ts': 1020,
  'src/renderer/app/features/loop/loop-control.component.ts': 1154,
  'src/renderer/app/features/mcp/mcp-page.component.ts': 1113,
  'src/renderer/app/features/memory/memory-browser.component.ts': 957,
  'src/renderer/app/features/models/model-selection-panel.component.ts': 944,
  'src/renderer/app/features/models/models-page.component.ts': 768,
  'src/renderer/app/features/observations/observations-page.component.ts': 806,
  'src/renderer/app/features/plan/plan-page.component.ts': 1036,
  'src/renderer/app/features/plugins/plugins-page.component.ts': 1208,
  'src/renderer/app/features/remote-config/remote-config-page.component.ts': 815,
  'src/renderer/app/features/replay/session-replay-page.component.ts': 893,
  'src/renderer/app/features/review/review-results.component.ts': 858,
  'src/renderer/app/features/review/reviews-page.component.ts': 724,
  'src/renderer/app/features/rlm/context-browser/context-query-panel.component.ts': 852,
  'src/renderer/app/features/rlm/rlm-analytics.component.ts': 702,
  'src/renderer/app/features/semantic-search/semantic-search-page.component.ts': 865,
  'src/renderer/app/features/settings/ecosystem-settings-tab.component.ts': 999,
  'src/renderer/app/features/settings/permissions-settings-tab.component.ts': 1092,
  'src/renderer/app/features/skills/skill-browser.component.ts': 766,
  'src/renderer/app/features/stats/stats-page.component.ts': 868,
  'src/renderer/app/features/tasks/tasks-page.component.ts': 977,
  'src/renderer/app/features/training/training-page.component.ts': 818,
  'src/renderer/app/features/verification/config/api-key-manager.component.ts': 890,
  'src/renderer/app/features/verification/config/verification-preferences.component.ts': 850,
  'src/renderer/app/features/verification/execution/agent-selector.component.ts': 745,
  'src/renderer/app/features/verification/results/export-panel.component.ts': 774,
  'src/renderer/app/features/workflow/workflow-page.component.ts': 799,
  'src/renderer/app/features/workflow/workflow-progress.component.ts': 733,
  'src/renderer/app/features/worktree/worktree-page.component.ts': 717,
  'src/renderer/app/features/worktree/worktree-panel.component.ts': 714,
  // Shared
  'src/shared/types/loop.types.ts': 820,
  'src/shared/types/settings.types.ts': 810,
  // Worker agent
  'src/worker-agent/worker-agent.ts': 879,
};

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.split('\n').length;
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
