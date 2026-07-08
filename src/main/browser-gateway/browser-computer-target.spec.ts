import { describe, expect, it } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  matchesBrowserComputerTarget,
  resolveBrowserComputerTarget,
} from './browser-computer-target';

describe('browser computer target resolution', () => {
  it('resolves a connected worker by normalized computer name', () => {
    const result = resolveBrowserComputerTarget(
      { computer: 'windows-pc' },
      { connectedNodes: [makeNode({ id: 'node-1', name: 'Windows PC', platform: 'win32' })] },
    );

    expect(result).toEqual({
      ok: true,
      target: {
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        localOnly: false,
      },
    });
  });

  it('uses cached browser descriptors when the worker node is not connected', () => {
    const result = resolveBrowserComputerTarget(
      { computer: 'Windows PC' },
      {
        connectedNodes: [],
        descriptors: [{ nodeId: 'node-1', nodeName: 'Windows PC' }],
      },
    );

    expect(result).toEqual({
      ok: true,
      target: {
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        localOnly: false,
      },
    });
  });

  it('treats local aliases as local-only targets', () => {
    const result = resolveBrowserComputerTarget(
      { computer: 'this computer' },
      { connectedNodes: [makeNode({ id: 'node-1', name: 'Windows PC', platform: 'win32' })] },
    );

    expect(result).toEqual({ ok: true, target: { localOnly: true } });
    if (result.ok) {
      expect(matchesBrowserComputerTarget({}, result.target)).toBe(true);
      expect(matchesBrowserComputerTarget({ nodeId: 'node-1' }, result.target)).toBe(false);
    }
  });

  it('rejects mismatched computer and nodeId selectors', () => {
    const result = resolveBrowserComputerTarget(
      { computer: 'Windows PC', nodeId: 'mac-node' },
      { connectedNodes: [makeNode({ id: 'node-1', name: 'Windows PC', platform: 'win32' })] },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'browser_computer_mismatch: "Windows PC" resolved to nodeId "node-1", not "mac-node"',
    });
  });

  it('returns an actionable not-found reason with available computers', () => {
    const result = resolveBrowserComputerTarget(
      { computer: 'studio pc' },
      {
        connectedNodes: [makeNode({ id: 'node-1', name: 'Windows PC', platform: 'win32' })],
        descriptors: [{ nodeId: 'node-2', nodeName: 'Linux Render Box' }],
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'browser_computer_not_found: no Browser Gateway computer matching "studio pc". Available computers: local, Windows PC, Linux Render Box',
    });
  });
});

function makeNode(params: {
  id: string;
  name: string;
  platform: WorkerNodeInfo['capabilities']['platform'];
}): WorkerNodeInfo {
  return {
    id: params.id,
    name: params.name,
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: params.platform,
      arch: 'arm64',
      cpuCores: 8,
      totalMemoryMB: 32_768,
      availableMemoryMB: 16_384,
      supportedClis: ['codex'],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}
