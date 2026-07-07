export type ReleaseReadinessStatus = 'passed' | 'blocked';

export interface ReleaseReadinessNodeEvidence {
  name: string;
  connected: boolean;
  hasBrowserMcp: boolean;
  workerVersion?: string;
  workerDeployedAt?: number;
  extensionVersion?: string;
  extensionReloadedAt?: number;
  extensionRelay?: {
    enabled: boolean;
    running: boolean;
    lastExtensionContactAt?: number;
  };
}

export interface BrowserHealthEvidence {
  checkedAt?: number;
  ok: boolean;
  summary?: string;
}

export interface NativeHostRecoveryDrillEvidence {
  ranAt?: number;
  passed: boolean;
  nodeName?: string;
  summary?: string;
}

export interface TestflightInternalReleaseEvidence {
  releasedAt?: number;
  bundleId: string;
  buildNumber: string;
  betaGroupAttached: boolean;
  smokePassed: boolean;
}

export interface PlayInternalReleaseEvidence {
  releasedAt?: number;
  packageName: string;
  versionCode: number;
  track: string;
  committed: boolean;
  smokePassed: boolean;
}

export interface ReleaseOperationalReadinessInput {
  expectedWorkerVersion?: string;
  expectedExtensionVersion?: string;
  harnessRestartedAt?: number;
  remoteNodes: ReleaseReadinessNodeEvidence[];
  browserHealth?: BrowserHealthEvidence;
  nativeHostRecoveryDrill?: NativeHostRecoveryDrillEvidence;
  testflightInternalRelease?: TestflightInternalReleaseEvidence;
  playInternalRelease?: PlayInternalReleaseEvidence;
}

export interface ReleaseReadinessRemoteNodeLike {
  id?: string;
  name?: string;
  status?: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connected?: boolean;
  hasBrowserMcp?: boolean;
  workerVersion?: string;
  workerDeployedAt?: number;
  workerAgent?: {
    version?: string;
    startedAt?: number;
  };
  extensionVersion?: string;
  extensionReloadedAt?: number;
  extensionRelay?: {
    enabled?: boolean;
    running?: boolean;
    extensionVersion?: string;
    extensionReloadedAt?: number;
    lastExtensionContactAt?: number;
  };
}

export function remoteNodesToReleaseReadinessEvidence(
  nodes: ReleaseReadinessRemoteNodeLike[],
): ReleaseReadinessNodeEvidence[] {
  return nodes.map((node) => {
    const workerVersion = node.workerVersion ?? node.workerAgent?.version;
    const workerDeployedAt = node.workerDeployedAt ?? node.workerAgent?.startedAt;
    const extensionVersion = node.extensionVersion ?? node.extensionRelay?.extensionVersion;
    const extensionReloadedAt = node.extensionReloadedAt ?? node.extensionRelay?.extensionReloadedAt;
    const extensionRelay = node.extensionRelay
      ? {
          enabled: node.extensionRelay.enabled === true,
          running: node.extensionRelay.running === true,
          ...(node.extensionRelay.lastExtensionContactAt !== undefined
            ? { lastExtensionContactAt: node.extensionRelay.lastExtensionContactAt }
            : {}),
        }
      : undefined;
    return {
      name: node.name ?? node.id ?? 'unknown-node',
      connected: node.connected ?? node.status === 'connected',
      hasBrowserMcp: node.hasBrowserMcp === true,
      ...(workerVersion ? { workerVersion } : {}),
      ...(workerDeployedAt !== undefined ? { workerDeployedAt } : {}),
      ...(extensionVersion ? { extensionVersion } : {}),
      ...(extensionReloadedAt !== undefined
        ? { extensionReloadedAt }
        : {}),
      ...(extensionRelay ? { extensionRelay } : {}),
    };
  });
}

export interface ReleaseReadinessCheck {
  id: string;
  title: string;
  status: ReleaseReadinessStatus;
  blocker?: string;
  evidence?: Record<string, unknown>;
}

export interface ReleaseOperationalReadinessReport {
  ready: boolean;
  blockers: string[];
  checks: ReleaseReadinessCheck[];
  requiredNextActions: string[];
}

export function buildReleaseOperationalReadinessReport(
  input: ReleaseOperationalReadinessInput,
): ReleaseOperationalReadinessReport {
  const checks = [
    workerRedeployCheck(input),
    extensionReloadCheck(input),
    harnessRestartCheck(input),
    browserHealthCheck(input),
    nativeHostRecoveryDrillCheck(input),
    testflightInternalReleaseCheck(input),
    playInternalReleaseCheck(input),
  ];
  const blockers = checks
    .map((check) => check.blocker)
    .filter((blocker): blocker is string => Boolean(blocker));
  return {
    ready: blockers.length === 0,
    blockers,
    checks,
    requiredNextActions: nextActions(blockers),
  };
}

function workerRedeployCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  const browserNodes = input.remoteNodes.filter((node) => node.hasBrowserMcp);
  const deployed = browserNodes.filter((node) =>
    node.connected &&
      Boolean(node.workerDeployedAt) &&
      (!input.expectedWorkerVersion || node.workerVersion === input.expectedWorkerVersion));
  if (browserNodes.length > 0 && deployed.length === browserNodes.length) {
    return passed('worker-redeploy', 'Worker redeploy', {
      nodeCount: deployed.length,
      expectedWorkerVersion: input.expectedWorkerVersion,
    });
  }
  return blocked('worker-redeploy', 'Worker redeploy', 'worker-redeploy-missing', {
    browserNodeCount: browserNodes.length,
    deployedNodeCount: deployed.length,
    expectedWorkerVersion: input.expectedWorkerVersion,
  });
}

function extensionReloadCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  const browserNodes = input.remoteNodes.filter((node) => node.hasBrowserMcp);
  const reloaded = browserNodes.filter((node) =>
    node.connected &&
      Boolean(node.extensionReloadedAt) &&
      (!input.expectedExtensionVersion || node.extensionVersion === input.expectedExtensionVersion) &&
      node.extensionRelay?.enabled === true &&
      node.extensionRelay.running === true &&
      Boolean(node.extensionRelay.lastExtensionContactAt));
  if (browserNodes.length > 0 && reloaded.length === browserNodes.length) {
    return passed('extension-reload', 'Browser extension reload', {
      nodeCount: reloaded.length,
      expectedExtensionVersion: input.expectedExtensionVersion,
    });
  }
  return blocked('extension-reload', 'Browser extension reload', 'extension-reload-missing', {
    browserNodeCount: browserNodes.length,
    reloadedNodeCount: reloaded.length,
    expectedExtensionVersion: input.expectedExtensionVersion,
  });
}

function harnessRestartCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  if (input.harnessRestartedAt) {
    return passed('harness-restart', 'Harness restart', {
      harnessRestartedAt: input.harnessRestartedAt,
    });
  }
  return blocked('harness-restart', 'Harness restart', 'harness-restart-missing');
}

function browserHealthCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  if (input.browserHealth?.ok && input.browserHealth.checkedAt) {
    return passed('browser-health', 'Browser health check', {
      checkedAt: input.browserHealth.checkedAt,
      summary: input.browserHealth.summary,
    });
  }
  return blocked('browser-health', 'Browser health check', 'browser-health-missing', {
    checkedAt: input.browserHealth?.checkedAt,
    ok: input.browserHealth?.ok ?? false,
    summary: input.browserHealth?.summary,
  });
}

function nativeHostRecoveryDrillCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  const drill = input.nativeHostRecoveryDrill;
  if (drill?.passed && drill.ranAt) {
    return passed('native-host-recovery-drill', 'Native-host recovery drill', {
      ranAt: drill.ranAt,
      nodeName: drill.nodeName,
      summary: drill.summary,
    });
  }
  return blocked(
    'native-host-recovery-drill',
    'Native-host recovery drill',
    'native-host-recovery-drill-missing',
  );
}

function testflightInternalReleaseCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  const release = input.testflightInternalRelease;
  if (release?.releasedAt && release.betaGroupAttached && release.smokePassed) {
    return passed('testflight-internal-release', 'TestFlight internal release', {
      releasedAt: release.releasedAt,
      bundleId: release.bundleId,
      buildNumber: release.buildNumber,
    });
  }
  return blocked(
    'testflight-internal-release',
    'TestFlight internal release',
    'testflight-internal-release-missing',
  );
}

function playInternalReleaseCheck(input: ReleaseOperationalReadinessInput): ReleaseReadinessCheck {
  const release = input.playInternalRelease;
  if (
    release?.releasedAt &&
      release.track === 'internal' &&
      release.committed &&
      release.smokePassed
  ) {
    return passed('play-internal-release', 'Play internal release', {
      releasedAt: release.releasedAt,
      packageName: release.packageName,
      versionCode: release.versionCode,
      track: release.track,
    });
  }
  return blocked('play-internal-release', 'Play internal release', 'play-internal-release-missing');
}

function passed(
  id: string,
  title: string,
  evidence?: Record<string, unknown>,
): ReleaseReadinessCheck {
  return { id, title, status: 'passed', evidence };
}

function blocked(
  id: string,
  title: string,
  blocker: string,
  evidence?: Record<string, unknown>,
): ReleaseReadinessCheck {
  return { id, title, status: 'blocked', blocker, evidence };
}

function nextActions(blockers: string[]): string[] {
  const actions: Record<string, string> = {
    'worker-redeploy-missing': 'Redeploy the rebuilt worker agent to every browser-capable worker node.',
    'extension-reload-missing': 'Reload the Browser Gateway extension on every browser-capable machine.',
    'harness-restart-missing': 'Restart Harness so the main process and MCP SEA changes are live.',
    'browser-health-missing': 'Run browser_health/list_targets after restart and capture fresh channel evidence.',
    'native-host-recovery-drill-missing': 'Run the native-host kill/recovery drill and record the result.',
    'testflight-internal-release-missing': 'Run a real TestFlight internal release and capture build/group/smoke evidence.',
    'play-internal-release-missing': 'Run a real Play internal release and capture edit/track/smoke evidence.',
  };
  return blockers.map((blocker) => actions[blocker] ?? `Resolve ${blocker}.`);
}
