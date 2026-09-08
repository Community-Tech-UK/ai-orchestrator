import { describe, expect, it } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
  BROWSER_WORKER_AGENT_TOO_OLD,
  assessRemoteExtensionCommandCapability,
  classifyBrowserExtensionIncompatibility,
  describeInferredWorkerAgentSkew,
  isInferredWorkerAgentSkew,
  workerAgentTooOldReason,
} from './browser-worker-agent-skew';

function makeNode(overrides: {
  name?: string;
  hasExtensionRelay?: boolean;
  extensionRelay?: WorkerNodeInfo['capabilities']['extensionRelay'];
} = {}): WorkerNodeInfo {
  return {
    id: 'node-1',
    name: overrides.name ?? 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16_384,
      availableMemoryMB: 8_192,
      supportedClis: ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp: false,
      hasExtensionRelay: overrides.hasExtensionRelay ?? true,
      ...(overrides.extensionRelay ? { extensionRelay: overrides.extensionRelay } : {}),
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}

describe('browser-worker-agent-skew', () => {
  it('names an old worker that reports a live extension version without the contract marker', () => {
    const node = makeNode({
      extensionRelay: {
        enabled: true,
        running: true,
        extensionVersion: '0.2.19',
      },
    });

    expect(isInferredWorkerAgentSkew(node.capabilities.extensionRelay, true)).toBe(true);
    expect(describeInferredWorkerAgentSkew(node)).toBe(workerAgentTooOldReason('windows-pc'));
    expect(classifyBrowserExtensionIncompatibility({
      runtime: {},
      nodeName: 'windows-pc',
      hasExtensionRelay: true,
      relay: node.capabilities.extensionRelay,
    })).toEqual({
      kind: 'skew',
      reason: workerAgentTooOldReason('windows-pc'),
    });
  });

  it('keeps a new-worker payload with a too-old extension as runtime incompatible', () => {
    expect(classifyBrowserExtensionIncompatibility({
      runtime: {
        extensionVersion: '0.2.2',
        extensionStartedAt: 2_000,
      },
      nodeName: 'windows-pc',
      hasExtensionRelay: true,
      relay: {
        enabled: true,
        running: true,
        extensionVersion: '0.2.2',
        forwardsRuntimeEvidence: true,
      },
    })).toEqual({
      kind: 'runtime',
      reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
    });
    expect(isInferredWorkerAgentSkew({
      enabled: true,
      running: true,
      extensionVersion: '0.2.2',
      forwardsRuntimeEvidence: true,
    }, true)).toBe(false);
  });

  it('does not invent skew for a node with no relay', () => {
    const node = makeNode({
      hasExtensionRelay: false,
    });

    expect(isInferredWorkerAgentSkew(undefined, false)).toBe(false);
    expect(describeInferredWorkerAgentSkew(node)).toBe('');
    expect(classifyBrowserExtensionIncompatibility({
      runtime: {},
      nodeName: 'windows-pc',
      hasExtensionRelay: false,
    })).toEqual({
      kind: 'runtime',
      reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
    });
    expect(assessRemoteExtensionCommandCapability({
      nodeName: 'windows-pc',
      hasExtensionRelay: false,
    })).toEqual({ commandsDeliverable: true });
  });

  it('treats last-N pre-delivery rejections as an incapable channel', () => {
    const capability = assessRemoteExtensionCommandCapability({
      nodeName: 'windows-pc',
      hasExtensionRelay: true,
      relay: {
        enabled: true,
        running: true,
        forwardsRuntimeEvidence: true,
        extensionVersion: '0.2.19',
      },
      preDelivery: {
        commandsDeliverable: false,
        reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
      },
    });

    expect(capability).toEqual({
      commandsDeliverable: false,
      reason: BROWSER_EXTENSION_RUNTIME_INCOMPATIBLE,
    });
    expect(capability.reason).not.toContain(BROWSER_WORKER_AGENT_TOO_OLD);
  });
});
