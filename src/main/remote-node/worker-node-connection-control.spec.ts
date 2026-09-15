import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  resetWorkerNodeConnection,
  resolveConnectedWorkerNode,
  type WorkerNodeConnectionControlDeps,
} from './worker-node-connection-control';

const mocks = {
  nodes: [] as WorkerNodeInfo[],
  resetNodeConnection: vi.fn(() => true),
};
const deps: WorkerNodeConnectionControlDeps = {
  server: {
    resetNodeConnection: mocks.resetNodeConnection,
    getConnectedNodeIds: () => mocks.nodes.map((node) => node.id),
    isNodeConnected: () => true,
  },
  registry: { getAllNodes: () => mocks.nodes },
};

describe('worker-node-connection-control', () => {
  beforeEach(() => {
    mocks.resetNodeConnection.mockClear();
    mocks.nodes = [
      { id: 'bb62e3ee', name: 'windows-pc', status: 'connected', capabilities: { platform: 'win32' } },
    ] as unknown as WorkerNodeInfo[];
  });

  it('resets by exact name, case-insensitively, without revoking', () => {
    expect(resetWorkerNodeConnection(deps, 'Windows-PC', 'Agent reset')).toEqual({
      nodeId: 'bb62e3ee',
      nodeName: 'windows-pc',
      reset: true,
    });
    expect(mocks.resetNodeConnection).toHaveBeenCalledWith('bb62e3ee', 'Agent reset');
  });

  it('refuses a capability-style target for the disruptive reset', () => {
    expect(() => resetWorkerNodeConnection(deps, 'windows', 'Agent reset')).toThrow('list_remote_nodes');
    expect(mocks.resetNodeConnection).not.toHaveBeenCalled();
    // The read-style resolver still accepts capability targets.
    expect(resolveConnectedWorkerNode(deps, 'windows').id).toBe('bb62e3ee');
  });
});
