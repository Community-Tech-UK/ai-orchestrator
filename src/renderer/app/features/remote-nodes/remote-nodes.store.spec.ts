import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteNodeIpcService, type RemoteNodeEvent } from '../../core/services/ipc/remote-node-ipc.service';
import type {
  RemoteNodeRosterEntry,
  WorkerNodeInfo,
} from '../../../../shared/types/worker-node.types';
import { RemoteNodesStore } from './remote-nodes.store';

function makeNode(
  id: string,
  status: RemoteNodeRosterEntry['status'],
  connected = status === 'connected',
): RemoteNodeRosterEntry {
  return { id, name: id, status, connected } as RemoteNodeRosterEntry;
}

describe('RemoteNodesStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('derives connectedNodes from the live socket flag when present', async () => {
    const ipc = {
      listNodes: vi.fn().mockResolvedValue([
        makeNode('degraded-live', 'degraded', true),
        makeNode('connected-stale', 'connected', false),
        makeNode('connected-live', 'connected', true),
      ]),
      onNodeEvent: vi.fn(() => () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodesStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodesStore);
    await store.refresh();

    expect(store.connectedNodes().map((node) => node.id)).toEqual([
      'degraded-live',
      'connected-live',
    ]);
  });

  it('clears the live socket flag when a node disconnect event has no node payload', () => {
    let nodeEventCallback: ((event: RemoteNodeEvent) => void) | null = null;
    const ipc = {
      listNodes: vi.fn().mockResolvedValue([]),
      onNodeEvent: vi.fn((callback: (event: RemoteNodeEvent) => void) => {
        nodeEventCallback = callback;
        return () => undefined;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodesStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodesStore);
    store.nodes.set([makeNode('node-1', 'connected', true)]);

    (nodeEventCallback as ((event: RemoteNodeEvent) => void) | null)?.({ type: 'disconnected', nodeId: 'node-1' });

    expect(store.nodes()[0]).toMatchObject({
      status: 'disconnected',
      connected: false,
    });
    expect(store.connectedNodes()).toEqual([]);
  });

  it('replaces an existing node when a connected event carries only a node payload', () => {
    let nodeEventCallback: ((event: RemoteNodeEvent) => void) | null = null;
    const ipc = {
      listNodes: vi.fn().mockResolvedValue([]),
      onNodeEvent: vi.fn((callback: (event: RemoteNodeEvent) => void) => {
        nodeEventCallback = callback;
        return () => undefined;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodesStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodesStore);
    store.nodes.set([makeNode('node-1', 'disconnected', false)]);

    (nodeEventCallback as ((event: RemoteNodeEvent) => void) | null)?.({
      type: 'connected',
      node: makeNode('node-1', 'connected', true),
    });

    expect(store.nodes().map((node) => node.id)).toEqual(['node-1']);
    expect(store.connectedNodes().map((node) => node.id)).toEqual(['node-1']);
  });

  it('applies updated events that carry only a node payload', () => {
    let nodeEventCallback: ((event: RemoteNodeEvent) => void) | null = null;
    const ipc = {
      listNodes: vi.fn().mockResolvedValue([]),
      onNodeEvent: vi.fn((callback: (event: RemoteNodeEvent) => void) => {
        nodeEventCallback = callback;
        return () => undefined;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodesStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodesStore);
    store.nodes.set([{
      ...makeNode('node-1', 'connected', true),
      activeInstances: 1,
    }]);

    (nodeEventCallback as ((event: RemoteNodeEvent) => void) | null)?.({
      type: 'updated',
      node: {
        ...makeNode('node-1', 'connected', true),
        activeInstances: 3,
      } as RemoteNodeRosterEntry,
    });

    expect(store.nodes()).toHaveLength(1);
    expect(store.nodes()[0].activeInstances).toBe(3);
  });

  it('keeps roster-only fields when updated events carry live WorkerNodeInfo payloads', () => {
    let nodeEventCallback: ((event: RemoteNodeEvent) => void) | null = null;
    const ipc = {
      listNodes: vi.fn().mockResolvedValue([]),
      onNodeEvent: vi.fn((callback: (event: RemoteNodeEvent) => void) => {
        nodeEventCallback = callback;
        return () => undefined;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodesStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodesStore);
    store.nodes.set([{
      ...makeNode('node-1', 'connected', true),
      address: '100.64.1.2',
      pairingLabel: 'Studio PC',
      activeInstances: 1,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16384,
        availableMemoryMB: 8192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: ['C:\\repo'],
        browsableRoots: [],
        discoveredProjects: [],
      },
    }]);

    const liveUpdate: WorkerNodeInfo = {
      id: 'node-1',
      name: 'node-1',
      address: '100.64.1.2',
      status: 'degraded',
      activeInstances: 3,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16384,
        availableMemoryMB: 4096,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: true,
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: ['C:\\repo'],
        browsableRoots: [],
        discoveredProjects: [],
      },
    };

    (nodeEventCallback as ((event: RemoteNodeEvent) => void) | null)?.({
      type: 'updated',
      node: liveUpdate,
    });

    expect(store.nodes()[0]).toMatchObject({
      id: 'node-1',
      status: 'degraded',
      connected: true,
      activeInstances: 3,
      pairingLabel: 'Studio PC',
      hasBrowserMcp: true,
    });
    expect(store.connectedNodes().map((node) => node.id)).toEqual(['node-1']);
  });
});
