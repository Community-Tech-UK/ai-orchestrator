import { describe, expect, it } from 'vitest';
import type { WorkerHostHealthSample, WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  NodeOutageTracker,
  classifyOutageCause,
  describeHostHealthWarnings,
  formatOutageDuration,
  formatRecoveryNotification,
} from './node-outage-tracker';

const MIN = 60_000;
// 2026-10-07T08:59:00Z, the first network drop investigated.
const T0 = Date.UTC(2026, 9, 7, 8, 59);
const BOOT = T0 - 5 * 24 * 60 * MIN;
const WORKER_START = T0 - 3 * 24 * 60 * MIN;

describe('NodeOutageTracker', () => {
  it('reports a network outage when the same worker process comes back', () => {
    let now = T0;
    const tracker = new NodeOutageTracker(() => now);
    tracker.noteDisconnected(node({ lastHeartbeat: T0, startedAt: WORKER_START, hostBootedAt: BOOT }));

    now = T0 + 34 * MIN;
    const recovery = tracker.noteConnected(node({ startedAt: WORKER_START, hostBootedAt: BOOT + 1_500 }));

    expect(recovery).toMatchObject({ name: 'windows-pc', cause: 'network', downForMs: 34 * MIN });
    expect(formatRecoveryNotification(recovery!)).toEqual({
      title: 'windows-pc is back online',
      body: 'It was offline for 34 min. The Harness worker program kept running but could not reach this Mac '
        + '(a network drop, or the computer was asleep or frozen).',
    });
  });

  it('reports a computer restart and the abnormal sample taken before the drop', () => {
    let now = T0;
    const tracker = new NodeOutageTracker(() => now);
    tracker.noteDisconnected(node({
      lastHeartbeat: T0,
      startedAt: WORKER_START,
      hostBootedAt: BOOT,
      hostHealth: sample({
        udpEndpoints: 16_200,
        topUdpOwners: [{ name: 'svchost', pid: 12184, count: 15_900 }],
        topHandleHolders: [{ name: 'mtkbtsvc', pid: 6712, count: 127_519 }],
      }),
    }));

    now = T0 + 15 * MIN;
    const recovery = tracker.noteConnected(node({ startedAt: T0 + 14 * MIN, hostBootedAt: T0 + 13 * MIN }));

    expect(recovery?.cause).toBe('host-restarted');
    expect(formatRecoveryNotification(recovery!).body).toBe(
      'It was offline for 15 min. The computer restarted. Just before it dropped: '
      + 'Windows was using 16,200 network ports, most of them by svchost (15,900). '
      + 'mtkbtsvc was holding 127,519 system handles, which suggests a leak.',
    );
  });

  it('leaves out a host-health sample that was stale when the node dropped', () => {
    let now = T0;
    const tracker = new NodeOutageTracker(() => now);
    tracker.noteDisconnected(node({
      lastHeartbeat: T0,
      startedAt: WORKER_START,
      hostHealth: sample({ sampledAt: T0 - 20 * MIN, udpEndpoints: 16_200 }),
    }));

    now = T0 + 5 * MIN;
    expect(tracker.noteConnected(node({ startedAt: WORKER_START }))?.healthWarnings).toEqual([]);
  });

  it('only reports recoveries for nodes that were announced disconnected', () => {
    const tracker = new NodeOutageTracker(() => T0);

    expect(tracker.noteConnected(node({ startedAt: WORKER_START }))).toBeNull();

    tracker.noteDisconnected(node({ lastHeartbeat: T0, startedAt: WORKER_START }));
    expect(tracker.noteConnected(node({ startedAt: WORKER_START }))).not.toBeNull();
    expect(tracker.noteConnected(node({ startedAt: WORKER_START }))).toBeNull();
  });
});

describe('classifyOutageCause', () => {
  const before = { lastHeardAt: T0, workerStartedAt: WORKER_START, hostBootedAt: BOOT };

  it('separates a worker restart from a computer restart when boot time is reported', () => {
    expect(classifyOutageCause(before, T0 + MIN, BOOT + 2_000)).toBe('worker-restarted');
    expect(classifyOutageCause(before, T0 + MIN, T0 + 30_000)).toBe('host-restarted');
  });

  it('uses the last-heard time when the earlier boot time is unknown', () => {
    const noBoot = { lastHeardAt: T0, workerStartedAt: WORKER_START };
    expect(classifyOutageCause(noBoot, T0 + MIN, T0 + 30_000)).toBe('host-restarted');
    expect(classifyOutageCause(noBoot, T0 + MIN, BOOT)).toBe('worker-restarted');
  });

  it('falls back to process identity for workers that do not report boot time', () => {
    const oldWorker = { lastHeardAt: T0, workerStartedAt: WORKER_START };
    expect(classifyOutageCause(oldWorker, WORKER_START, undefined)).toBe('network');
    expect(classifyOutageCause(oldWorker, T0 + MIN, undefined)).toBe('worker-restarted');
    expect(classifyOutageCause({ lastHeardAt: T0 }, T0 - MIN, undefined)).toBe('unknown');
    expect(classifyOutageCause({ lastHeardAt: T0 }, undefined, undefined)).toBe('unknown');
  });
});

describe('describeHostHealthWarnings', () => {
  it('stays quiet for a normal sample', () => {
    expect(describeHostHealthWarnings(sample({}))).toEqual([]);
    expect(describeHostHealthWarnings(undefined)).toEqual([]);
  });

  it('tolerates a malformed sample that reached the registry unvalidated', () => {
    const malformed = { ...sample({ udpEndpoints: 9_999 }), topUdpOwners: null, topHandleHolders: null };

    expect(describeHostHealthWarnings(malformed as unknown as WorkerHostHealthSample))
      .toEqual(['Windows was using 9,999 network ports.']);
  });
});

describe('formatRecoveryNotification', () => {
  it('says when an old worker cannot tell a computer restart from a program restart', () => {
    expect(formatRecoveryNotification({
      nodeId: 'n', name: 'windows-pc', downForMs: 30_000, cause: 'worker-restarted', hostBootKnown: false, healthWarnings: [],
    }).body).toBe(
      'It was offline for under a minute. '
      + 'The Harness worker program on it restarted (possibly because the computer restarted).',
    );
  });

  it('formats long outages in hours', () => {
    expect(formatOutageDuration(95 * MIN)).toBe('1 h 35 min');
    expect(formatOutageDuration(120 * MIN)).toBe('2 h');
  });
});

function node(options: {
  lastHeartbeat?: number;
  startedAt?: number;
  hostBootedAt?: number;
  hostHealth?: WorkerHostHealthSample;
}): WorkerNodeInfo {
  return {
    id: 'windows-node',
    name: 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    ...(options.lastHeartbeat !== undefined ? { lastHeartbeat: options.lastHeartbeat } : {}),
    capabilities: {
      ...(options.startedAt !== undefined
        ? {
          workerAgent: {
            version: '0.1.0',
            startedAt: options.startedAt,
            ...(options.hostBootedAt !== undefined ? { hostBootedAt: options.hostBootedAt } : {}),
          },
        }
        : {}),
      ...(options.hostHealth ? { hostHealth: options.hostHealth } : {}),
      platform: 'win32',
      arch: 'x64',
      cpuCores: 16,
      totalMemoryMB: 65_536,
      availableMemoryMB: 32_768,
      supportedClis: [],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 10,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}

function sample(overrides: Partial<WorkerHostHealthSample>): WorkerHostHealthSample {
  return {
    sampledAt: T0,
    udpEndpoints: 85,
    tcpConnections: 283,
    topUdpOwners: [{ name: 'svchost', pid: 12184, count: 20 }],
    topHandleHolders: [{ name: 'UA Connect', pid: 31656, count: 11_844 }],
    ...overrides,
  };
}
