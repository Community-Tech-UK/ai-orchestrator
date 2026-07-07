#!/usr/bin/env node
/**
 * Warn-level dead-helper sweep.
 *
 * This is intentionally narrower than a full knip/ts-prune pass: it targets
 * patterns that repeatedly regrew during the dead-code audit and are cheap to
 * scan reliably enough in CI output:
 *   - exported module-level `_reset*ForTesting` helpers
 *   - exported classes with static `_resetForTesting()`
 *   - exported `getXxx()` convenience getters that only return `Xxx.getInstance()`
 *
 * It exits 0 by default. Set AIO_CHECK_DEAD_STRICT=1 to make candidates fail.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCAN_ROOTS = ['src/main', 'src/shared', 'packages/contracts/src', 'packages/sdk/src'];
const EXTENSIONS = new Set(['.ts', '.tsx']);
// Baseline captured at the end of the 2026-07 dead-code audit. These helpers
// are intentionally kept warn-level so the ratchet catches new exported reset
// helpers/getInstance aliases without destabilizing existing singleton tests.
const DEAD_HELPER_BASELINE = [
  { path: 'src/main/app/pause-feature-bootstrap.ts', kind: 'module-reset-helper', name: '_resetPauseFeatureRuntimeForTesting' },
  { path: 'src/main/bootstrap/capability-probe.ts', kind: 'static-reset-helper', name: 'CapabilityProbe._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-extension-command-store.ts', kind: 'static-reset-helper', name: 'BrowserExtensionCommandStore._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-extension-contact-state.ts', kind: 'static-reset-helper', name: 'BrowserExtensionContactState._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-extension-tab-store.ts', kind: 'static-reset-helper', name: 'BrowserExtensionTabStore._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-health-service.ts', kind: 'static-reset-helper', name: 'BrowserHealthService._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-profile-registry.ts', kind: 'static-reset-helper', name: 'BrowserProfileRegistry._resetForTesting' },
  { path: 'src/main/browser-gateway/browser-target-registry.ts', kind: 'static-reset-helper', name: 'BrowserTargetRegistry._resetForTesting' },
  { path: 'src/main/browser-gateway/remote-extension-bridge.ts', kind: 'static-reset-helper', name: 'RemoteBrowserExtensionBridge._resetForTesting' },
  { path: 'src/main/cli/adapters/codex/app-server-broker.ts', kind: 'static-reset-helper', name: 'CodexBrokerManager._resetForTesting' },
  { path: 'src/main/cli/adapters/codex/app-server-broker.ts', kind: 'convenience-getter', name: 'getCodexBrokerManager' },
  { path: 'src/main/cli/cli-latest-version.ts', kind: 'static-reset-helper', name: 'CliLatestVersionService._resetForTesting' },
  { path: 'src/main/cli/cli-update-poll-service.ts', kind: 'static-reset-helper', name: 'CliUpdatePollService._resetForTesting' },
  { path: 'src/main/communication/cross-instance-comm.ts', kind: 'static-reset-helper', name: 'CrossInstanceCommService._resetForTesting' },
  { path: 'src/main/compare/multi-provider-compare-service.ts', kind: 'module-reset-helper', name: '_resetMultiProviderCompareServiceForTesting' },
  { path: 'src/main/conversation-ledger/conversation-ledger-service.ts', kind: 'static-reset-helper', name: 'ConversationLedgerService._resetForTesting' },
  { path: 'src/main/conversation-ledger/native-conversation-registry.ts', kind: 'static-reset-helper', name: 'NativeConversationRegistry._resetForTesting' },
  { path: 'src/main/diagnostics/doctor-service.ts', kind: 'module-reset-helper', name: '_resetDoctorServiceForTesting' },
  { path: 'src/main/diagnostics/instruction-diagnostics-service.ts', kind: 'module-reset-helper', name: '_resetInstructionDiagnosticsServiceForTesting' },
  { path: 'src/main/diagnostics/operator-artifact-exporter.ts', kind: 'module-reset-helper', name: '_resetOperatorArtifactExporterForTesting' },
  { path: 'src/main/diagnostics/skill-diagnostics-service.ts', kind: 'module-reset-helper', name: '_resetSkillDiagnosticsServiceForTesting' },
  { path: 'src/main/event-bus/main-event-bus.ts', kind: 'module-reset-helper', name: '_resetMainEventBusForTesting' },
  { path: 'src/main/event-bus/thin-client-ws-server.ts', kind: 'static-reset-helper', name: 'ThinClientWsServer._resetForTesting' },
  { path: 'src/main/git/stale-branch-policy.ts', kind: 'module-reset-helper', name: '_resetStaleBranchPolicyForTesting' },
  { path: 'src/main/instance/file-edit-bus.ts', kind: 'module-reset-helper', name: '_resetFileEditBusForTesting' },
  { path: 'src/main/instance/instance-provider-limit-handler.ts', kind: 'module-reset-helper', name: '_resetInstanceProviderLimitHandlerForTesting' },
  { path: 'src/main/mcp/mcp-lifecycle-manager.ts', kind: 'module-reset-helper', name: '_resetMcpLifecycleManagerForTesting' },
  { path: 'src/main/mcp/mcp-multi-provider-singletons.ts', kind: 'module-reset-helper', name: '_resetMcpMultiProviderSingletonsForTesting' },
  { path: 'src/main/mcp/secret-storage.ts', kind: 'module-reset-helper', name: '_resetMcpSecretStorageForTesting' },
  { path: 'src/main/memory/codebase-miner.ts', kind: 'static-reset-helper', name: 'CodebaseMiner._resetForTesting' },
  { path: 'src/main/memory/knowledge-bridge.ts', kind: 'static-reset-helper', name: 'KnowledgeBridge._resetForTesting' },
  { path: 'src/main/memory/knowledge-graph-service.ts', kind: 'static-reset-helper', name: 'KnowledgeGraphService._resetForTesting' },
  { path: 'src/main/memory/memory-monitor.ts', kind: 'module-reset-helper', name: '_resetMemoryMonitorForTesting' },
  { path: 'src/main/memory/output-storage.ts', kind: 'module-reset-helper', name: '_resetOutputStorageManagerForTesting' },
  { path: 'src/main/memory/project-code-index-bridge.ts', kind: 'static-reset-helper', name: 'ProjectCodeIndexBridge._resetForTesting' },
  { path: 'src/main/memory/project-knowledge-coordinator.ts', kind: 'static-reset-helper', name: 'ProjectKnowledgeCoordinator._resetForTesting' },
  { path: 'src/main/memory/project-knowledge-read-model.ts', kind: 'static-reset-helper', name: 'ProjectKnowledgeReadModelService._resetForTesting' },
  { path: 'src/main/memory/project-memory-brief.ts', kind: 'module-reset-helper', name: '_resetProjectMemoryBriefServiceForTesting' },
  { path: 'src/main/memory/project-root-registry.ts', kind: 'static-reset-helper', name: 'ProjectRootRegistry._resetForTesting' },
  { path: 'src/main/memory/token-stats.ts', kind: 'static-reset-helper', name: 'TokenStatsService._resetForTesting' },
  { path: 'src/main/memory/wake-context-builder.ts', kind: 'static-reset-helper', name: 'WakeContextBuilder._resetForTesting' },
  { path: 'src/main/mobile-gateway/mobile-apns-sender.ts', kind: 'module-reset-helper', name: '_resetMobileApnsSenderForTesting' },
  { path: 'src/main/mobile-gateway/mobile-device-registry.ts', kind: 'module-reset-helper', name: '_resetMobileDeviceRegistryForTesting' },
  { path: 'src/main/mobile-gateway/mobile-gateway-server.ts', kind: 'static-reset-helper', name: 'MobileGatewayServer._resetForTesting' },
  { path: 'src/main/observability/otel-setup.ts', kind: 'module-reset-helper', name: '_resetOtelForTesting' },
  { path: 'src/main/operator/operator-database.ts', kind: 'static-reset-helper', name: 'OperatorDatabase._resetForTesting' },
  { path: 'src/main/operator/operator-run-runner.ts', kind: 'static-reset-helper', name: 'OperatorRunRunner._resetForTesting' },
  { path: 'src/main/operator/project-registry.ts', kind: 'static-reset-helper', name: 'ProjectRegistry._resetForTesting' },
  { path: 'src/main/orchestration/campaign-coordinator.ts', kind: 'module-reset-helper', name: '_resetCampaignCoordinatorForTesting' },
  { path: 'src/main/orchestration/doom-loop-detector.ts', kind: 'static-reset-helper', name: 'DoomLoopDetector._resetForTesting' },
  { path: 'src/main/orchestration/loop-store-service.ts', kind: 'static-reset-helper', name: 'LoopStoreService._resetForTesting' },
  { path: 'src/main/orchestration/orchestration-activity-bridge.ts', kind: 'static-reset-helper', name: 'OrchestrationActivityBridge._resetForTesting' },
  { path: 'src/main/process/resource-governor.ts', kind: 'static-reset-helper', name: 'ResourceGovernor._resetForTesting' },
  { path: 'src/main/providers/catalog-override-source.ts', kind: 'module-reset-helper', name: '_resetCatalogOverrideSourceForTesting' },
  { path: 'src/main/providers/codex-cli-discovery-service.ts', kind: 'module-reset-helper', name: '_resetCodexCliDiscoveryServiceForTesting' },
  { path: 'src/main/providers/models-dev-service.ts', kind: 'module-reset-helper', name: '_resetModelsDevServiceForTesting' },
  { path: 'src/main/providers/provider-runtime-service.ts', kind: 'module-reset-helper', name: '_resetProviderRuntimeServiceForTesting' },
  { path: 'src/main/remote-node/directory-sync-service.ts', kind: 'static-reset-helper', name: 'DirectorySyncService._resetForTesting' },
  { path: 'src/main/remote-node/discovery-service.ts', kind: 'static-reset-helper', name: 'DiscoveryService._resetForTesting' },
  { path: 'src/main/remote-node/file-transfer-service.ts', kind: 'static-reset-helper', name: 'FileTransferService._resetForTesting' },
  { path: 'src/main/remote-node/remote-cdp-tunnel.ts', kind: 'module-reset-helper', name: '_resetRemoteCdpTunnelClientForTesting' },
  { path: 'src/main/remote-node/remote-node-roster-service.ts', kind: 'module-reset-helper', name: '_resetRemoteNodeRosterServiceForTesting' },
  { path: 'src/main/remote-node/remote-worker-repair-service.ts', kind: 'module-reset-helper', name: '_resetRemoteWorkerRepairServiceForTesting' },
  { path: 'src/main/remote-node/remote-worker-repair-tracker.ts', kind: 'static-reset-helper', name: 'RemoteWorkerRepairTracker._resetForTesting' },
  { path: 'src/main/remote/observer-auth.ts', kind: 'static-reset-helper', name: 'RemoteObserverAuth._resetForTesting' },
  { path: 'src/main/remote/observer-server.ts', kind: 'static-reset-helper', name: 'RemoteObserverServer._resetForTesting' },
  { path: 'src/main/repo-jobs/repo-job-store.ts', kind: 'static-reset-helper', name: 'RepoJobStore._resetForTesting' },
  { path: 'src/main/security/permission-enforcer.ts', kind: 'module-reset-helper', name: '_resetPermissionEnforcerForTesting' },
  { path: 'src/main/security/self-permission-granter.ts', kind: 'module-reset-helper', name: '_resetSelfPermissionGranterForTesting' },
  { path: 'src/main/security/tool-execution-gate.ts', kind: 'module-reset-helper', name: '_resetToolExecutionGateForTesting' },
  { path: 'src/main/security/tool-validator.ts', kind: 'static-reset-helper', name: 'ToolValidator._resetForTesting' },
  { path: 'src/main/session/artifact-attribution-store.ts', kind: 'module-reset-helper', name: '_resetArtifactAttributionStoreForTesting' },
  { path: 'src/main/session/artifact-cleanup-service.ts', kind: 'module-reset-helper', name: '_resetArtifactCleanupServiceForTesting' },
  { path: 'src/main/session/git-checkpoint-store.ts', kind: 'module-reset-helper', name: '_resetGitCheckpointStoreForTesting' },
  { path: 'src/main/session/session-recall-service.ts', kind: 'module-reset-helper', name: '_resetSessionRecallServiceForTesting' },
  { path: 'src/main/session/session-share-service.ts', kind: 'static-reset-helper', name: 'SessionShareService._resetForTesting' },
  { path: 'src/main/state/index.ts', kind: 'module-reset-helper', name: '_resetStoreForTesting' },
  { path: 'src/main/usage/usage-tracker.ts', kind: 'static-reset-helper', name: 'UsageTracker._resetForTesting' },
  { path: 'src/main/webhooks/webhook-server.ts', kind: 'static-reset-helper', name: 'WebhookServer._resetForTesting' },
  { path: 'src/main/webhooks/webhook-store.ts', kind: 'module-reset-helper', name: '_resetWebhookStoreForTesting' },
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.worktrees' ||
        entry.name === 'generated'
      ) {
        continue;
      }
      walk(full, out);
      continue;
    }
    if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function isDeclarationOnlyFile(filePath) {
  return /\.d\.ts$/.test(filePath);
}

function collectFiles(scanRoots = DEFAULT_SCAN_ROOTS) {
  return scanRoots.flatMap((rel) => walk(path.join(ROOT, rel)))
    .filter((filePath) => !isDeclarationOnlyFile(filePath))
    .map((filePath) => ({
      path: path.relative(ROOT, filePath),
      content: fs.readFileSync(filePath, 'utf8'),
    }));
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function countWord(files, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  return files.reduce((count, file) => count + (file.content.match(re)?.length ?? 0), 0);
}

function countStaticResetUse(files, className) {
  const re = new RegExp(`\\b${escapeRegExp(className)}\\._resetForTesting\\s*\\(`, 'g');
  return files.reduce((count, file) => count + (file.content.match(re)?.length ?? 0), 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateKey(candidate) {
  return `${candidate.path}\0${candidate.kind}\0${candidate.name}`;
}

function filterBaselinedCandidates(candidates, baseline = DEAD_HELPER_BASELINE) {
  const baselineKeys = new Set(baseline.map(candidateKey));
  return candidates.filter((candidate) => !baselineKeys.has(candidateKey(candidate)));
}

function collectDeadHelperCandidates(files) {
  const candidates = [];

  for (const file of files) {
    for (const match of file.content.matchAll(/export\s+function\s+(_{1,2}reset\w*ForTesting)\s*\(/g)) {
      const name = match[1];
      if (countWord(files, name) <= 1) {
        candidates.push({
          kind: 'module-reset-helper',
          name,
          path: file.path,
          line: lineOf(file.content, match.index),
        });
      }
    }

    for (const match of file.content.matchAll(/export\s+function\s+(get[A-Z]\w*)\s*\([^)]*\)[\s\S]{0,180}?return\s+([A-Z]\w*)\.getInstance\s*\(/g)) {
      const name = match[1];
      if (countWord(files, name) <= 1) {
        candidates.push({
          kind: 'convenience-getter',
          name,
          path: file.path,
          line: lineOf(file.content, match.index),
        });
      }
    }

    for (const classReset of findExportedClassStaticResets(file.content)) {
      const className = classReset.name;
      if (countStaticResetUse(files, className) === 0) {
        candidates.push({
          kind: 'static-reset-helper',
          name: `${className}._resetForTesting`,
          path: file.path,
          line: lineOf(file.content, classReset.index),
        });
      }
    }
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function findExportedClassStaticResets(content) {
  const results = [];
  for (const match of content.matchAll(/export\s+class\s+([A-Z]\w*)[^{]*\{/g)) {
    const bodyStart = match.index + match[0].length - 1;
    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd === -1) continue;
    const body = content.slice(bodyStart + 1, bodyEnd);
    if (/static\s+_resetForTesting\s*\(/.test(body)) {
      results.push({ name: match[1], index: match.index });
    }
  }
  return results;
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function main() {
  const files = collectFiles();
  const allCandidates = collectDeadHelperCandidates(files);
  const candidates = filterBaselinedCandidates(allCandidates);
  const baselinedCount = allCandidates.length - candidates.length;
  if (candidates.length === 0) {
    const baselineNote = baselinedCount > 0
      ? `, ${baselinedCount} baselined helper candidate(s)`
      : '';
    console.log(`check:dead — OK (${files.length} files scanned, 0 new helper candidates${baselineNote})`);
    return;
  }

  const heading = `check:dead — WARN: ${candidates.length} new unbaselined helper candidate(s)`;
  const lines = candidates.map(
    (candidate) =>
      `  ${candidate.path}:${candidate.line}  ${candidate.kind}  ${candidate.name}`,
  );
  if (baselinedCount > 0) {
    lines.push(`  (${baselinedCount} baselined helper candidate(s) omitted)`);
  }
  console.warn([heading, ...lines].join('\n'));

  if (process.env.AIO_CHECK_DEAD_STRICT === '1') {
    process.exit(1);
  }
}

module.exports = {
  collectDeadHelperCandidates,
  filterBaselinedCandidates,
};

if (require.main === module) {
  main();
}
