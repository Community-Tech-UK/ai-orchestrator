import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  BuildReleaseOperationalReadinessReportArgsSchema,
} from './orchestrator-release-tools';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import {
  BrowserGatewayRpcClient,
  type BrowserGatewayRpcClientLike,
} from '../browser-gateway/browser-gateway-rpc-client';
import {
  buildReleaseOperationalReadinessReport,
  remoteNodesToReleaseReadinessEvidence,
  type BrowserHealthEvidence,
  type NativeHostRecoveryDrillEvidence,
  type PlayInternalReleaseEvidence,
  type ReleaseOperationalReadinessReport,
  type TestflightInternalReleaseEvidence,
} from '../release/mobile-release-readiness';

export interface ReleaseReadinessCliDeps {
  browserClient?: BrowserGatewayRpcClientLike;
  client?: OrchestratorToolsRpcClientLike;
  now?: () => number;
  readTextFile?: (path: string) => Promise<string>;
  stdout?: (text: string) => void;
  writeTextFile?: (path: string, text: string) => Promise<void>;
}

interface ManualReleaseEvidence {
  harnessRestartedAt?: number;
  nativeHostRecoveryDrill?: Partial<NativeHostRecoveryDrillEvidence>;
  playInternalRelease?: Partial<PlayInternalReleaseEvidence>;
  testflightInternalRelease?: Partial<TestflightInternalReleaseEvidence>;
}

const knownReleaseReadinessFlags = new Set([
  '--capture-browser-health',
  '--capture-remote-nodes',
  '--evidence',
  '--expected-extension-version',
  '--expected-worker-version',
  '--harness-restarted-at',
  '--help',
  '--json',
  '--native-host-drill-node',
  '--native-host-drill-passed',
  '--native-host-drill-ran-at',
  '--native-host-drill-summary',
  '--play-committed',
  '--play-package-name',
  '--play-released-at',
  '--play-smoke-passed',
  '--play-track',
  '--play-version-code',
  '--testflight-beta-group-attached',
  '--testflight-build-number',
  '--testflight-bundle-id',
  '--testflight-released-at',
  '--testflight-smoke-passed',
  '--write-evidence',
]);

export async function runReleaseReadinessCli(
  argv: readonly string[],
  deps: ReleaseReadinessCliDeps = {},
): Promise<void> {
  const help = argv.includes('--help') || argv.includes('-h');
  const json = argv.includes('--json');
  const captureBrowserHealth = argv.includes('--capture-browser-health');
  const captureRemoteNodes = argv.includes('--capture-remote-nodes');
  const evidencePath = valueAfter(argv, '--evidence');
  const expectedWorkerVersion = valueAfter(argv, '--expected-worker-version');
  const expectedExtensionVersion = valueAfter(argv, '--expected-extension-version');
  const writeEvidencePath = valueAfter(argv, '--write-evidence');
  const unknown = argv.find((arg) => arg.startsWith('--') && !knownReleaseReadinessFlags.has(arg));
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  if (help) {
    stdout(formatReleaseReadinessHelp());
    return;
  }
  if (unknown) {
    throw new Error(`Unknown release-readiness option: ${unknown}`);
  }
  if (!evidencePath && !captureRemoteNodes) {
    throw new Error('release-readiness requires --evidence <path> or --capture-remote-nodes');
  }
  const readTextFile = deps.readTextFile ?? ((path) => fs.readFile(path, 'utf8'));
  const fileEvidence = evidencePath
    ? JSON.parse(await readTextFile(evidencePath)) as Record<string, unknown>
    : {};
  const remoteNodes = captureRemoteNodes
    ? await captureRemoteNodeEvidence(deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 10_000 }))
    : undefined;
  const browserHealth = captureBrowserHealth
    ? await captureBrowserHealthEvidence(deps.browserClient ?? new BrowserGatewayRpcClient())
    : undefined;
  const manualEvidence = buildManualReleaseEvidence(argv, deps.now ?? Date.now);
  const mergedEvidence = mergeManualReleaseEvidence({
    ...fileEvidence,
    ...(expectedWorkerVersion ? { expectedWorkerVersion } : {}),
    ...(expectedExtensionVersion ? { expectedExtensionVersion } : {}),
    ...(remoteNodes ? { remoteNodes } : {}),
    ...(browserHealth ? { browserHealth } : {}),
  }, manualEvidence);
  const parsed = BuildReleaseOperationalReadinessReportArgsSchema.parse(mergedEvidence);
  if (writeEvidencePath) {
    await writeEvidenceFile(writeEvidencePath, parsed, deps.writeTextFile);
  }
  const report = buildReleaseOperationalReadinessReport({
    ...parsed,
    remoteNodes: remoteNodesToReleaseReadinessEvidence(parsed.remoteNodes),
  });
  stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReleaseReadinessReport(report));
}

export function formatReleaseReadinessReport(report: ReleaseOperationalReadinessReport): string {
  return [
    `Release readiness: ${report.ready ? 'READY' : 'BLOCKED'}`,
    '',
    'Checks:',
    ...report.checks.map((check) =>
      `- ${check.title}: ${check.status}${check.blocker ? ` (${check.blocker})` : ''}`),
    ...(report.blockers.length > 0
      ? ['', 'Blockers:', ...report.blockers.map((blocker) => `- ${blocker}`)]
      : []),
    ...(report.requiredNextActions.length > 0
      ? ['', 'Next actions:', ...report.requiredNextActions.map((action) => `- ${action}`)]
      : []),
    '',
  ].join('\n');
}

function formatReleaseReadinessHelp(): string {
  return [
    'Usage: aio-mcp release-readiness --evidence <path> [--json]',
    '       aio-mcp release-readiness --capture-remote-nodes [--capture-browser-health] [--evidence <path>] [--write-evidence <path>] [--json]',
    '',
    'Build the operational release readiness report from a captured evidence JSON file.',
    '',
    'Evidence write-back flags:',
    '  --harness-restarted-at <ms|iso|now>',
    '  --native-host-drill-ran-at <ms|iso|now> --native-host-drill-passed [--native-host-drill-node <name>] [--native-host-drill-summary <text>]',
    '  --testflight-released-at <ms|iso|now> --testflight-bundle-id <id> --testflight-build-number <number> --testflight-beta-group-attached --testflight-smoke-passed',
    '  --play-released-at <ms|iso|now> --play-package-name <name> --play-version-code <code> --play-track internal --play-committed --play-smoke-passed',
    '',
  ].join('\n');
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function requiredValueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function buildManualReleaseEvidence(argv: readonly string[], now: () => number): ManualReleaseEvidence {
  const harnessRestartedAt = timestampValueAfter(argv, '--harness-restarted-at', now);
  const nativeHostRecoveryDrill: Partial<NativeHostRecoveryDrillEvidence> = {};
  const nativeHostRanAt = timestampValueAfter(argv, '--native-host-drill-ran-at', now);
  if (nativeHostRanAt !== undefined) {
    nativeHostRecoveryDrill.ranAt = nativeHostRanAt;
  }
  if (argv.includes('--native-host-drill-passed')) {
    nativeHostRecoveryDrill.passed = true;
  }
  const nativeHostNode = requiredValueAfter(argv, '--native-host-drill-node');
  if (nativeHostNode) {
    nativeHostRecoveryDrill.nodeName = nativeHostNode;
  }
  const nativeHostSummary = requiredValueAfter(argv, '--native-host-drill-summary');
  if (nativeHostSummary) {
    nativeHostRecoveryDrill.summary = nativeHostSummary;
  }

  const testflightInternalRelease: Partial<TestflightInternalReleaseEvidence> = {};
  const testflightReleasedAt = timestampValueAfter(argv, '--testflight-released-at', now);
  if (testflightReleasedAt !== undefined) {
    testflightInternalRelease.releasedAt = testflightReleasedAt;
  }
  const testflightBundleId = requiredValueAfter(argv, '--testflight-bundle-id');
  if (testflightBundleId) {
    testflightInternalRelease.bundleId = testflightBundleId;
  }
  const testflightBuildNumber = requiredValueAfter(argv, '--testflight-build-number');
  if (testflightBuildNumber) {
    testflightInternalRelease.buildNumber = testflightBuildNumber;
  }
  if (argv.includes('--testflight-beta-group-attached')) {
    testflightInternalRelease.betaGroupAttached = true;
  }
  if (argv.includes('--testflight-smoke-passed')) {
    testflightInternalRelease.smokePassed = true;
  }

  const playInternalRelease: Partial<PlayInternalReleaseEvidence> = {};
  const playReleasedAt = timestampValueAfter(argv, '--play-released-at', now);
  if (playReleasedAt !== undefined) {
    playInternalRelease.releasedAt = playReleasedAt;
  }
  const playPackageName = requiredValueAfter(argv, '--play-package-name');
  if (playPackageName) {
    playInternalRelease.packageName = playPackageName;
  }
  const playVersionCode = requiredValueAfter(argv, '--play-version-code');
  if (playVersionCode) {
    playInternalRelease.versionCode = parsePositiveInteger('--play-version-code', playVersionCode);
  }
  const playTrack = requiredValueAfter(argv, '--play-track');
  if (playTrack) {
    playInternalRelease.track = playTrack;
  }
  if (argv.includes('--play-committed')) {
    playInternalRelease.committed = true;
  }
  if (argv.includes('--play-smoke-passed')) {
    playInternalRelease.smokePassed = true;
  }

  return {
    ...(harnessRestartedAt !== undefined ? { harnessRestartedAt } : {}),
    ...(hasKeys(nativeHostRecoveryDrill) ? { nativeHostRecoveryDrill } : {}),
    ...(hasKeys(testflightInternalRelease) ? { testflightInternalRelease } : {}),
    ...(hasKeys(playInternalRelease) ? { playInternalRelease } : {}),
  };
}

function timestampValueAfter(argv: readonly string[], flag: string, now: () => number): number | undefined {
  const value = requiredValueAfter(argv, flag);
  return value ? parseTimestamp(flag, value, now) : undefined;
}

function parseTimestamp(flag: string, value: string, now: () => number): number {
  if (value === 'now') {
    return now();
  }
  if (/^\d+$/.test(value)) {
    return parseNonnegativeInteger(flag, value);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a nonnegative millisecond timestamp, ISO date, or "now"`);
  }
  return parsed;
}

function parseNonnegativeInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a nonnegative integer`);
  }
  return parsed;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function mergeManualReleaseEvidence(
  evidence: Record<string, unknown>,
  manualEvidence: ManualReleaseEvidence,
): Record<string, unknown> {
  const merged = {
    ...evidence,
    ...(manualEvidence.harnessRestartedAt !== undefined
      ? { harnessRestartedAt: manualEvidence.harnessRestartedAt }
      : {}),
  };
  mergeNestedEvidence(merged, 'nativeHostRecoveryDrill', manualEvidence.nativeHostRecoveryDrill);
  mergeNestedEvidence(merged, 'testflightInternalRelease', manualEvidence.testflightInternalRelease);
  mergeNestedEvidence(merged, 'playInternalRelease', manualEvidence.playInternalRelease);
  return merged;
}

function mergeNestedEvidence<T extends object>(
  evidence: Record<string, unknown>,
  key: string,
  updates: T | undefined,
): void {
  if (!updates || !hasKeys(updates)) {
    return;
  }
  evidence[key] = {
    ...recordOrEmpty(evidence[key]),
    ...updates,
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

async function writeEvidenceFile(
  filePath: string,
  evidence: unknown,
  writeTextFile?: (path: string, text: string) => Promise<void>,
): Promise<void> {
  const writer = writeTextFile ?? (async (target, text) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  });
  await writer(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function captureRemoteNodeEvidence(
  client: OrchestratorToolsRpcClientLike,
): Promise<unknown[]> {
  const result = await client.call('orchestrator_tools.list_remote_nodes', {});
  if (!result || typeof result !== 'object' || !Array.isArray((result as { nodes?: unknown }).nodes)) {
    throw new Error('list_remote_nodes returned an invalid nodes list');
  }
  return (result as { nodes: unknown[] }).nodes;
}

async function captureBrowserHealthEvidence(
  client: BrowserGatewayRpcClientLike,
): Promise<BrowserHealthEvidence> {
  const [healthResult, targetsResult] = await Promise.all([
    client.call('browser.health', {}),
    client.call('browser.list_targets', { refresh: true }),
  ]);
  const health = asBrowserGatewayResult(healthResult);
  const targets = asBrowserGatewayResult(targetsResult);
  const healthData = health.data && typeof health.data === 'object'
    ? health.data as Record<string, unknown>
    : {};
  const targetData = Array.isArray(targets.data) ? targets.data : [];
  const staleCount = targetData.filter((target) =>
    target && typeof target === 'object' && (target as { stale?: unknown }).stale === true).length;
  const healthStatus = typeof healthData['status'] === 'string' ? healthData['status'] : 'unknown';
  const healthAllowed = health.decision === 'allowed' && health.outcome === 'succeeded';
  const targetsAllowed = targets.decision === 'allowed' && targets.outcome === 'succeeded';
  return {
    checkedAt: typeof healthData['checkedAt'] === 'number' ? healthData['checkedAt'] : Date.now(),
    ok: healthAllowed && targetsAllowed && healthStatus !== 'missing' && staleCount === 0,
    summary:
      `browser.health=${healthStatus}; list_targets=${targetData.length} target(s), `
      + `${staleCount} stale`,
  };
}

function asBrowserGatewayResult(value: unknown): {
  data?: unknown;
  decision?: unknown;
  outcome?: unknown;
} {
  return value && typeof value === 'object'
    ? value as { data?: unknown; decision?: unknown; outcome?: unknown }
    : {};
}
