/**
 * check-ts-max-loc.ts
 *
 * Ratchet script that enforces TypeScript file size limits.
 *
 * - For files NOT in the allowlist: fails if any file exceeds MAX_LINES (700).
 * - For files IN the allowlist: fails if the file GROWS beyond its recorded ceiling
 *   (the ceiling must be reduced as the file is refactored down).
 *
 * Usage: tsx scripts/check-ts-max-loc.ts
 *
 * To add a new large file: run the script, note the count, add an entry below.
 * To tighten a ceiling after refactoring: lower the number.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MAX_LINES = 700;

/**
 * Known large files and their current line-count ceilings.
 * The ceiling is the maximum the file is allowed to be. It must never grow.
 * Reduce the ceiling as the file is refactored.
 */
const ALLOWLIST: Record<string, number> = {
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
  'src/main/browser-gateway/browser-gateway-service.spec.ts': 1363,
  'src/main/browser-gateway/browser-gateway-service.ts': 2455,
  // Main process — channels
  'src/main/channels/__tests__/channel-message-router.spec.ts': 1141,
  'src/main/channels/adapters/discord-adapter.ts': 898,
  'src/main/channels/channel-message-router.ts': 2502,
  // Main process — CLI adapters
  'src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts': 721,
  'src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts': 1143,
  'src/main/cli/adapters/acp-cli-adapter.spec.ts': 1275,
  'src/main/cli/adapters/acp-cli-adapter.ts': 2142,
  'src/main/cli/adapters/base-cli-adapter.ts': 741,
  'src/main/cli/adapters/claude-cli-adapter.ts': 2170,
  'src/main/cli/adapters/codex-cli-adapter.spec.ts': 1227,
  'src/main/cli/adapters/codex-cli-adapter.ts': 3004,
  'src/main/cli/adapters/copilot-cli-adapter.ts': 1146,
  'src/main/cli/adapters/cursor-cli-adapter.ts': 1024,
  'src/main/cli/adapters/gemini-cli-adapter.ts': 873,
  // Main process — codemem
  'src/main/codemem/code-index-manager.ts': 782,
  // Main process — context
  'src/main/context/context-compactor.ts': 853,
  'src/main/context/jit-loader.ts': 772,
  // Main process — core
  'src/main/core/config/claude-md-loader.ts': 804,
  'src/main/core/error-recovery.ts': 950,
  // Main process — history
  'src/main/history/history-manager.ts': 1227,
  // Main process — indexing
  'src/main/indexing/benchmarks/benchmark-utils.ts': 820,
  'src/main/indexing/tree-sitter-chunker.ts': 716,
  // Main process — instance
  'src/main/instance/__tests__/instance-manager.spec.ts': 1602,
  'src/main/instance/instance-communication.spec.ts': 896,
  'src/main/instance/instance-communication.ts': 2236,
  'src/main/instance/instance-context.ts': 1204,
  'src/main/instance/instance-lifecycle.ts': 3304,
  'src/main/instance/instance-manager.ts': 2500,
  'src/main/instance/instance-orchestration.ts': 1516,
  'src/main/instance/lifecycle/interrupt-respawn-handler.ts': 941,
  // Main process — IPC handlers
  'src/main/ipc/handlers/__tests__/instance-handlers.spec.ts': 846,
  'src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts': 720,
  'src/main/ipc/handlers/__tests__/session-handlers.spec.ts': 761,
  'src/main/ipc/handlers/app-handlers.ts': 746,
  'src/main/ipc/handlers/instance-handlers.ts': 1125,
  'src/main/ipc/handlers/mcp-handlers.ts': 941,
  'src/main/ipc/handlers/session-handlers.ts': 1003,
  'src/main/ipc/handlers/vcs-handlers.ts': 978,
  'src/main/ipc/ipc-main-handler.ts': 726,
  'src/main/ipc/orchestration-ipc-handler.ts': 1316,
  // Main process — learning
  'src/main/learning/ab-testing.ts': 832,
  'src/main/learning/habit-tracker.ts': 733,
  'src/main/learning/metrics-collector.ts': 731,
  'src/main/learning/outcome-tracker.ts': 743,
  'src/main/learning/preference-store.ts': 719,
  // Main process — MCP
  'src/main/mcp/mcp-manager.ts': 1025,
  'src/main/mcp/mcp-tool-search.ts': 842,
  // Main process — memory
  'src/main/memory/codebase-miner.ts': 725,
  'src/main/memory/critique-agent.ts': 817,
  'src/main/memory/proactive-surfacer.ts': 701,
  'src/main/memory/procedural-store.ts': 802,
  'src/main/memory/project-memory-brief.ts': 997,
  'src/main/memory/r1-memory-manager.ts': 792,
  'src/main/memory/unified-controller.ts': 1320,
  // Main process — orchestration
  'src/main/orchestration/__tests__/debate-coordinator.spec.ts': 1055,
  'src/main/orchestration/__tests__/multi-verify-coordinator.spec.ts': 908,
  'src/main/orchestration/child-result-storage.ts': 836,
  'src/main/orchestration/cli-verification-extension.ts': 973,
  'src/main/orchestration/consensus-coordinator.ts': 860,
  'src/main/orchestration/consensus.ts': 759,
  'src/main/orchestration/cross-model-review-service.ts': 798,
  'src/main/orchestration/debate-coordinator.ts': 1196,
  'src/main/orchestration/default-invokers.ts': 1072,
  'src/main/orchestration/embedding-service.ts': 845,
  'src/main/orchestration/event-store/__tests__/event-store.spec.ts': 783,
  'src/main/orchestration/loop-coordinator.ts': 1733,
  'src/main/orchestration/multi-verify-coordinator.ts': 1163,
  'src/main/orchestration/orchestration-handler.ts': 1507,
  'src/main/orchestration/supervisor.ts': 735,
  'src/main/orchestration/voting.ts': 777,
  // Main process — persistence
  'src/main/persistence/rlm/rlm-schema.ts': 2126,
  // Main process — plugins
  'src/main/plugins/plugin-manager.ts': 1235,
  // Main process — providers
  'src/main/providers/model-discovery.ts': 707,
  // Main process — remote
  'src/main/remote/observer-server.ts': 864,
  // Main process — repo jobs
  'src/main/repo-jobs/repo-job-service.ts': 989,
  // Main process — RLM
  'src/main/rlm/ast-chunker.ts': 766,
  'src/main/rlm/context-manager.ts': 701,
  'src/main/rlm/episodic-rlm-store.ts': 765,
  'src/main/rlm/hyde-service.ts': 788,
  'src/main/rlm/llm-service.ts': 994,
  'src/main/rlm/smart-compaction.ts': 879,
  // Main process — security
  'src/main/security/permission-manager.ts': 1560,
  'src/main/security/sandbox-manager.ts': 877,
  // Main process — session
  'src/main/session/checkpoint-manager.ts': 752,
  'src/main/session/session-continuity.ts': 1579,
  // Main process — workspace
  'src/main/workspace/git/vcs-manager.ts': 1174,
  'src/main/workspace/git/worktree-manager.ts': 742,
  'src/main/workspace/lsp-manager.ts': 899,
  // Preload
  'src/preload/domains/infrastructure.preload.ts': 830,
  'src/preload/domains/orchestration.preload.ts': 940,
  'src/preload/domains/workspace.preload.ts': 907,
  'src/preload/generated/channels.ts': 1138,
  // Renderer — services
  'src/renderer/app/core/services/ipc/memory-ipc.service.ts': 724,
  'src/renderer/app/core/services/ipc/orchestration-ipc.service.ts': 745,
  // Renderer — stores
  'src/renderer/app/core/state/instance/instance-list.store.ts': 972,
  'src/renderer/app/core/state/instance/instance-messaging.store.ts': 774,
  'src/renderer/app/core/state/instance/instance.store.ts': 753,
  'src/renderer/app/core/state/source-control.store.spec.ts': 1164,
  'src/renderer/app/core/state/source-control.store.ts': 973,
  // Renderer — feature components
  'src/renderer/app/features/archive/archive-page.component.ts': 1059,
  'src/renderer/app/features/browser/browser-page.component.ts': 1195,
  'src/renderer/app/features/chats/session-artifacts-strip.component.ts': 729,
  'src/renderer/app/features/communication/communication-page.component.ts': 729,
  'src/renderer/app/features/debate/debate-visualization.component.ts': 993,
  'src/renderer/app/features/debate/enhanced-debate-visualization.component.ts': 821,
  'src/renderer/app/features/editor/editor-page.component.ts': 951,
  'src/renderer/app/features/file-explorer/file-explorer.component.ts': 1069,
  'src/renderer/app/features/hooks/hooks-config.component.ts': 1027,
  'src/renderer/app/features/hooks/hooks-page.component.ts': 767,
  'src/renderer/app/features/instance-detail/input-panel.component.ts': 1676,
  'src/renderer/app/features/instance-detail/instance-detail.component.ts': 1489,
  'src/renderer/app/features/instance-detail/output-stream.component.ts': 1113,
  'src/renderer/app/features/instance-detail/user-action-request.component.ts': 1015,
  'src/renderer/app/features/instance-list/instance-list.component.ts': 1767,
  'src/renderer/app/features/instance-list/instance-row.component.ts': 842,
  'src/renderer/app/features/knowledge/knowledge-page.component.ts': 1322,
  'src/renderer/app/features/logs/logs-page.component.ts': 1020,
  'src/renderer/app/features/loop/loop-control.component.ts': 916,
  'src/renderer/app/features/mcp/mcp-page.component.ts': 1113,
  'src/renderer/app/features/memory/memory-browser.component.ts': 957,
  'src/renderer/app/features/models/model-selection-panel.component.ts': 905,
  'src/renderer/app/features/models/models-page.component.ts': 768,
  'src/renderer/app/features/observations/observations-page.component.ts': 806,
  'src/renderer/app/features/plan/plan-page.component.ts': 1036,
  'src/renderer/app/features/plugins/plugins-page.component.ts': 1100,
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
  'src/renderer/app/features/source-control/source-control.component.ts': 1034,
  'src/renderer/app/features/stats/stats-page.component.ts': 868,
  'src/renderer/app/features/tasks/tasks-page.component.ts': 977,
  'src/renderer/app/features/training/training-page.component.ts': 818,
  'src/renderer/app/features/verification/config/api-key-manager.component.ts': 890,
  'src/renderer/app/features/verification/config/verification-preferences.component.ts': 850,
  'src/renderer/app/features/verification/dashboard/verification-dashboard.component.spec.ts': 873,
  'src/renderer/app/features/verification/execution/agent-selector.component.spec.ts': 747,
  'src/renderer/app/features/verification/execution/agent-selector.component.ts': 745,
  'src/renderer/app/features/verification/results/export-panel.component.ts': 774,
  'src/renderer/app/features/verification/results/verification-results.component.spec.ts': 798,
  'src/renderer/app/features/workflow/workflow-page.component.ts': 799,
  'src/renderer/app/features/workflow/workflow-progress.component.ts': 733,
  'src/renderer/app/features/worktree/worktree-page.component.ts': 717,
  'src/renderer/app/features/worktree/worktree-panel.component.ts': 714,
  // Shared
  'src/shared/types/settings.types.ts': 796,
  // Worker agent
  'src/worker-agent/worker-agent.ts': 801,
};

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function main(): void {
  const repoRoot = process.cwd();

  const trackedFiles = execFileSync('git', ['ls-files', '*.ts'], { cwd: repoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const violations: string[] = [];

  for (const relPath of trackedFiles) {
    const absPath = resolve(repoRoot, relPath);
    const lines = countLines(absPath);

    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, relPath)) {
      const ceiling = ALLOWLIST[relPath];
      if (lines > ceiling) {
        violations.push(
          `RATCHET EXCEEDED: ${relPath} has ${lines} lines (ceiling: ${ceiling}). ` +
            `File grew — refactor it down or raise the ceiling intentionally.`,
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

  if (violations.length > 0) {
    console.error('\nTypeScript file size ratchet FAILED:\n');
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    console.error(`\n${violations.length} violation(s) found.`);
    process.exit(1);
  }

  console.log(
    `TypeScript file size ratchet passed. ` +
      `Checked ${trackedFiles.length} files (limit: ${MAX_LINES} lines, ` +
      `${Object.keys(ALLOWLIST).length} allowlisted legacy files).`,
  );
  process.exit(0);
}

main();
