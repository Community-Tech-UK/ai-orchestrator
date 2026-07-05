import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteNodeIpcService } from '../services/ipc/remote-node-ipc.service';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import { RemoteNodeStore } from './remote-node.store';

function makeNode(
  id: string,
  status: RemoteNodeRosterEntry['status'],
  connected = status === 'connected',
): RemoteNodeRosterEntry {
  return { id, name: id, status, connected } as RemoteNodeRosterEntry;
}

describe('RemoteNodeStore', () => {
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
      onNodesChanged: vi.fn(() => () => undefined),
      onNodeEvent: vi.fn(() => () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        RemoteNodeStore,
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    });

    const store = TestBed.inject(RemoteNodeStore);
    await store.initialize();

    expect(store.connectedNodes().map((node) => node.id)).toEqual([
      'degraded-live',
      'connected-live',
    ]);
  });
});
