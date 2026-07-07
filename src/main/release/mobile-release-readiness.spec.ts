import { describe, expect, it } from 'vitest';
import {
  buildReleaseOperationalReadinessReport,
} from './mobile-release-readiness';
import * as readiness from './mobile-release-readiness';

describe('mobile release operational readiness', () => {
  it('blocks completion when physical rollout and live release evidence is missing', () => {
    const report = buildReleaseOperationalReadinessReport({
      expectedWorkerVersion: '2026.07.07',
      expectedExtensionVersion: '0.2.1',
      remoteNodes: [],
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      'worker-redeploy-missing',
      'extension-reload-missing',
      'harness-restart-missing',
      'browser-health-missing',
      'native-host-recovery-drill-missing',
      'testflight-internal-release-missing',
      'play-internal-release-missing',
    ]));
    expect(report.requiredNextActions).toEqual(expect.arrayContaining([
      'Redeploy the rebuilt worker agent to every browser-capable worker node.',
      'Reload the Browser Gateway extension on every browser-capable machine.',
      'Run a real TestFlight internal release and capture build/group/smoke evidence.',
      'Run a real Play internal release and capture edit/track/smoke evidence.',
    ]));
  });

  it('passes only when rollout, drill, browser health, and both store releases are proven', () => {
    const report = buildReleaseOperationalReadinessReport({
      expectedWorkerVersion: '2026.07.07',
      expectedExtensionVersion: '0.2.1',
      harnessRestartedAt: 1_700_000_000_000,
      remoteNodes: [
        {
          name: 'windows-pc',
          connected: true,
          hasBrowserMcp: true,
          workerVersion: '2026.07.07',
          workerDeployedAt: 1_700_000_000_000,
          extensionVersion: '0.2.1',
          extensionReloadedAt: 1_700_000_000_000,
          extensionRelay: {
            enabled: true,
            running: true,
            lastExtensionContactAt: 1_700_000_010_000,
          },
        },
      ],
      browserHealth: {
        checkedAt: 1_700_000_020_000,
        ok: true,
      },
      nativeHostRecoveryDrill: {
        ranAt: 1_700_000_030_000,
        passed: true,
        nodeName: 'windows-pc',
      },
      testflightInternalRelease: {
        releasedAt: 1_700_000_040_000,
        bundleId: 'com.example.app',
        buildNumber: '42',
        betaGroupAttached: true,
        smokePassed: true,
      },
      playInternalRelease: {
        releasedAt: 1_700_000_050_000,
        packageName: 'com.example.app',
        versionCode: 42,
        track: 'internal',
        committed: true,
        smokePassed: true,
      },
    });

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
  });

  it('keeps captured browser health details when the browser gate blocks release', () => {
    const report = buildReleaseOperationalReadinessReport({
      remoteNodes: [],
      browserHealth: {
        checkedAt: 1_700_000_020_000,
        ok: false,
        summary: 'browser.health=missing; list_targets=0 target(s), 0 stale',
      },
    });

    expect(report.checks.find((check) => check.id === 'browser-health')).toMatchObject({
      status: 'blocked',
      blocker: 'browser-health-missing',
      evidence: {
        checkedAt: 1_700_000_020_000,
        ok: false,
        summary: 'browser.health=missing; list_targets=0 target(s), 0 stale',
      },
    });
  });

  it('maps list_remote_nodes output into rollout evidence for the readiness report', () => {
    const mapper = (readiness as typeof readiness & {
      remoteNodesToReleaseReadinessEvidence?: (nodes: unknown[]) => unknown[];
    }).remoteNodesToReleaseReadinessEvidence;

    expect(typeof mapper).toBe('function');
    expect(mapper!([
      {
        name: 'windows-pc',
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
    ])).toEqual([
      {
        name: 'windows-pc',
        connected: true,
        hasBrowserMcp: true,
        workerVersion: '0.1.0',
        workerDeployedAt: 1_700_000_000_000,
        extensionVersion: '0.2.1',
        extensionReloadedAt: 1_700_000_010_000,
        extensionRelay: {
          enabled: true,
          running: true,
          lastExtensionContactAt: 1_700_000_020_000,
        },
      },
    ]);
  });
});
