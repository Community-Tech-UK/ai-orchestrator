import { describe, expect, it } from 'vitest';
import { assertNodeSatisfiesPlacement, buildRunOnNodePlacement } from './run-on-node-support';
import type { WorkerNodeCapabilities, WorkerNodeInfo } from '../../shared/types/worker-node.types';

function node(iosAutomation?: Partial<NonNullable<WorkerNodeCapabilities['iosAutomation']>>): WorkerNodeInfo {
  return {
    id: 'mac-1', name: 'ct-test-mac', status: 'connected', activeInstances: 0,
    capabilities: {
      platform: 'darwin', arch: 'arm64', cpuCores: 8, totalMemoryMB: 1, availableMemoryMB: 1, supportedClis: [],
      hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false,
      maxConcurrentInstances: 2, workingDirectories: [], browsableRoots: [], discoveredProjects: [],
      ...(iosAutomation
        ? { iosAutomation: { xcodePath: '', licenceAccepted: true, runtimes: [], devices: [], signing: {}, problems: [], checkedAt: 1, ready: false, ...iosAutomation } }
        : {}),
    },
  };
}

describe('run_on_node requiresIos', () => {
  it('is only set when asked for, never guessed from the prompt', () => {
    expect(buildRunOnNodePlacement({ prompt: 'test the iPhone app in the simulator' })).toBeUndefined();
    expect(buildRunOnNodePlacement({ prompt: 'x', requiresIos: true })).toEqual({ requiresIos: true });
    expect(buildRunOnNodePlacement({ prompt: 'x', requiresIos: false })).toBeUndefined();
  });

  it('rejects a named node that is not iOS ready, in plain words', () => {
    expect(() => assertNodeSatisfiesPlacement(node(), { requiresIos: true }))
      .toThrow(/"ct-test-mac" is not ready for iPhone\/iPad testing/);
    expect(() => assertNodeSatisfiesPlacement(node({ ready: false }), { requiresIos: true }))
      .toThrow(/licence accepted/);
  });

  it('accepts an iOS-ready node and ignores the check when not requested', () => {
    expect(() => assertNodeSatisfiesPlacement(node({ ready: true }), { requiresIos: true })).not.toThrow();
    expect(() => assertNodeSatisfiesPlacement(node(), { requiresBrowser: false })).not.toThrow();
  });
});
