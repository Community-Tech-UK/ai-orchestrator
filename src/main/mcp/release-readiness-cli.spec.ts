import { describe, expect, it, vi } from 'vitest';
import { formatReleaseReadinessReport, runReleaseReadinessCli } from './release-readiness-cli';

const completeEvidence = {
  expectedWorkerVersion: '0.1.0',
  expectedExtensionVersion: '0.2.1',
  harnessRestartedAt: 1_700_000_030_000,
  remoteNodes: [
    {
      id: 'node-1',
      name: 'windows-pc',
      status: 'connected',
      connected: true,
      hasBrowserMcp: true,
      workerAgent: {
        version: '0.1.0',
        startedAt: 1_700_000_000_000,
      },
      extensionRelay: {
        enabled: true,
        running: true,
        extensionVersion: '0.2.1',
        extensionReloadedAt: 1_700_000_010_000,
        lastExtensionContactAt: 1_700_000_020_000,
      },
    },
  ],
  browserHealth: {
    checkedAt: 1_700_000_040_000,
    ok: true,
    summary: 'list_targets confirmed live extension channel',
  },
  nativeHostRecoveryDrill: {
    ranAt: 1_700_000_050_000,
    passed: true,
    nodeName: 'windows-pc',
  },
  testflightInternalRelease: {
    releasedAt: 1_700_000_060_000,
    bundleId: 'com.example.app',
    buildNumber: '42',
    betaGroupAttached: true,
    smokePassed: true,
  },
  playInternalRelease: {
    releasedAt: 1_700_000_070_000,
    packageName: 'com.example.app',
    versionCode: 42,
    track: 'internal',
    committed: true,
    smokePassed: true,
  },
};

describe('release-readiness-cli', () => {
  it('can capture remote-node rollout evidence from the parent RPC', async () => {
    const stdout = vi.fn();
    const client = {
      call: vi.fn(async () => ({
        connectedCount: 1,
        totalCount: 1,
        nodes: completeEvidence.remoteNodes,
      })),
    };

    await runReleaseReadinessCli([
      '--capture-remote-nodes',
      '--expected-worker-version',
      '0.1.0',
      '--expected-extension-version',
      '0.2.1',
      '--json',
    ], {
      client,
      stdout,
    });

    expect(client.call).toHaveBeenCalledWith('orchestrator_tools.list_remote_nodes', {});
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output) as { blockers: string[]; checks: Array<{ id: string; status: string }> };
    expect(parsed.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worker-redeploy', status: 'passed' }),
      expect.objectContaining({ id: 'extension-reload', status: 'passed' }),
    ]));
    expect(parsed.blockers).not.toContain('worker-redeploy-missing');
    expect(parsed.blockers).not.toContain('extension-reload-missing');
  });

  it('can capture browser health and refreshed target evidence from the browser gateway RPC', async () => {
    const stdout = vi.fn();
    const { browserHealth: _browserHealth, ...fileEvidence } = completeEvidence;
    const browserClient = {
      call: vi.fn(async (method: string) => {
        if (method === 'browser.health') {
          return {
            decision: 'allowed',
            outcome: 'succeeded',
            data: {
              checkedAt: 1_700_000_040_000,
              status: 'ready',
            },
          };
        }
        return {
          decision: 'allowed',
          outcome: 'succeeded',
          data: [
            {
              profileId: 'shared',
              targetId: 'target-1',
              title: 'Play Console',
              stale: false,
            },
          ],
        };
      }),
    };

    await runReleaseReadinessCli([
      '--evidence',
      '/tmp/release-evidence.json',
      '--capture-browser-health',
      '--json',
    ], {
      browserClient,
      readTextFile: vi.fn(async () => JSON.stringify(fileEvidence)),
      stdout,
    });

    expect(browserClient.call).toHaveBeenCalledWith('browser.health', {});
    expect(browserClient.call).toHaveBeenCalledWith('browser.list_targets', { refresh: true });
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output) as { ready: boolean; blockers: string[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.blockers).not.toContain('browser-health-missing');
  });

  it('writes merged captured evidence for later release-readiness runs', async () => {
    const stdout = vi.fn();
    const writeTextFile = vi.fn(async () => undefined);
    const client = {
      call: vi.fn(async () => ({
        connectedCount: 1,
        totalCount: 1,
        nodes: completeEvidence.remoteNodes,
      })),
    };
    const browserClient = {
      call: vi.fn(async (method: string) => method === 'browser.health'
        ? {
            decision: 'allowed',
            outcome: 'succeeded',
            data: { checkedAt: 1_700_000_040_000, status: 'ready' },
          }
        : {
            decision: 'allowed',
            outcome: 'succeeded',
            data: [{ targetId: 'target-1', stale: false }],
          }),
    };

    await runReleaseReadinessCli([
      '--capture-remote-nodes',
      '--capture-browser-health',
      '--expected-worker-version',
      '0.1.0',
      '--expected-extension-version',
      '0.2.1',
      '--write-evidence',
      '/tmp/release-evidence.json',
      '--json',
    ], {
      browserClient,
      client,
      stdout,
      writeTextFile,
    });

    expect(writeTextFile).toHaveBeenCalledOnce();
    expect(writeTextFile.mock.calls[0]?.[0]).toBe('/tmp/release-evidence.json');
    const written = JSON.parse(String(writeTextFile.mock.calls[0]?.[1])) as typeof completeEvidence;
    expect(written).toMatchObject({
      expectedWorkerVersion: '0.1.0',
      expectedExtensionVersion: '0.2.1',
      remoteNodes: completeEvidence.remoteNodes,
      browserHealth: {
        checkedAt: 1_700_000_040_000,
        ok: true,
        summary: 'browser.health=ready; list_targets=1 target(s), 0 stale',
      },
    });
    expect(stdout).toHaveBeenCalled();
  });

  it('writes manually recorded release gate evidence for later readiness runs', async () => {
    const stdout = vi.fn();
    const writeTextFile = vi.fn(async () => undefined);
    const {
      harnessRestartedAt: _harnessRestartedAt,
      nativeHostRecoveryDrill: _nativeHostRecoveryDrill,
      testflightInternalRelease: _testflightInternalRelease,
      playInternalRelease: _playInternalRelease,
      ...fileEvidence
    } = completeEvidence;

    await runReleaseReadinessCli([
      '--evidence',
      '/tmp/release-evidence.json',
      '--harness-restarted-at',
      '1700000030000',
      '--native-host-drill-ran-at',
      '1700000050000',
      '--native-host-drill-passed',
      '--native-host-drill-node',
      'windows-pc',
      '--native-host-drill-summary',
      'native host restarted and reconnected',
      '--testflight-released-at',
      '1700000060000',
      '--testflight-bundle-id',
      'com.example.app',
      '--testflight-build-number',
      '42',
      '--testflight-beta-group-attached',
      '--testflight-smoke-passed',
      '--play-released-at',
      '1700000070000',
      '--play-package-name',
      'com.example.app',
      '--play-version-code',
      '42',
      '--play-track',
      'internal',
      '--play-committed',
      '--play-smoke-passed',
      '--write-evidence',
      '/tmp/release-evidence.json',
      '--json',
    ], {
      readTextFile: vi.fn(async () => JSON.stringify(fileEvidence)),
      stdout,
      writeTextFile,
    });

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output) as { ready: boolean; blockers: string[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.blockers).toEqual([]);
    const written = JSON.parse(String(writeTextFile.mock.calls[0]?.[1])) as typeof completeEvidence;
    expect(written).toMatchObject({
      harnessRestartedAt: 1_700_000_030_000,
      nativeHostRecoveryDrill: {
        ranAt: 1_700_000_050_000,
        passed: true,
        nodeName: 'windows-pc',
        summary: 'native host restarted and reconnected',
      },
      testflightInternalRelease: {
        releasedAt: 1_700_000_060_000,
        bundleId: 'com.example.app',
        buildNumber: '42',
        betaGroupAttached: true,
        smokePassed: true,
      },
      playInternalRelease: {
        releasedAt: 1_700_000_070_000,
        packageName: 'com.example.app',
        versionCode: 42,
        track: 'internal',
        committed: true,
        smokePassed: true,
      },
    });
  });

  it('prints JSON readiness from an evidence file', async () => {
    const stdout = vi.fn();
    const readTextFile = vi.fn(async () => JSON.stringify(completeEvidence));

    await runReleaseReadinessCli(['--evidence', '/tmp/release-evidence.json', '--json'], {
      readTextFile,
      stdout,
    });

    expect(readTextFile).toHaveBeenCalledWith('/tmp/release-evidence.json');
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output) as { ready: boolean; blockers: string[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.blockers).toEqual([]);
  });

  it('formats blocked readiness with concrete next actions', () => {
    const output = formatReleaseReadinessReport({
      ready: false,
      blockers: ['worker-redeploy-missing'],
      checks: [
        {
          id: 'worker-redeploy',
          title: 'Worker redeploy',
          status: 'blocked',
          blocker: 'worker-redeploy-missing',
        },
      ],
      requiredNextActions: ['Redeploy the rebuilt worker agent to every browser-capable worker node.'],
    });

    expect(output).toContain('Release readiness: BLOCKED');
    expect(output).toContain('Worker redeploy: blocked');
    expect(output).toContain('Redeploy the rebuilt worker agent');
  });
});
