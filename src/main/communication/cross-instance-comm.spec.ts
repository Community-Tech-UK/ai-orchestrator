import { describe, expect, it } from 'vitest';
import {
  CrossInstanceCommService,
  MemoryCrossInstanceCommStore,
  getCrossInstanceComm,
  getCrossInstanceCommService,
} from './cross-instance-comm';

describe('MemoryCrossInstanceCommStore', () => {
  it('stores bridges and messages independently of EventEmitter pub/sub', () => {
    const store = new MemoryCrossInstanceCommStore();
    store.createBridge({
      id: 'bridge-1',
      name: 'probe',
      sourceInstanceId: 'a',
      targetInstanceId: 'b',
      createdAt: 1,
      messageCount: 0,
    });
    store.appendMessage('bridge-1', {
      id: 'msg-1',
      bridgeId: 'bridge-1',
      fromInstanceId: 'a',
      toInstanceId: 'b',
      content: 'hello',
      timestamp: 2,
    });
    store.subscribe('a', 'bridge-1');

    expect(store.getBridge('bridge-1')?.name).toBe('probe');
    expect(store.getMessages('bridge-1')).toHaveLength(1);
    expect(store.getSubscriptions('a')).toEqual(['bridge-1']);

    store.deleteBridge('bridge-1');
    expect(store.getBridge('bridge-1')).toBeUndefined();
    expect(store.getSubscriptions('a')).toEqual([]);
  });
});

describe('CrossInstanceCommService', () => {
  it('injects storage so the bridge is testable without the singleton', () => {
    const store = new MemoryCrossInstanceCommStore();
    const service = CrossInstanceCommService.createForTesting(store);
    const created: string[] = [];
    service.on('bridge:created', (bridge: { id: string }) => created.push(bridge.id));

    const bridge = service.createBridge('login-probe', 'src', 'dst');
    expect(store.getBridge(bridge.id)).toEqual(bridge);
    expect(created).toEqual([bridge.id]);

    const message = service.sendMessage(bridge.id, 'src', 'please continue');
    expect(service.getMessages(bridge.id)).toEqual([message]);
    expect(store.getMessages(bridge.id)).toHaveLength(1);
  });

  it('rejects messages from non-participants', () => {
    const service = CrossInstanceCommService.createForTesting();
    const bridge = service.createBridge('probe', 'src', 'dst');
    expect(() => service.sendMessage(bridge.id, 'other', 'nope')).toThrow(/not a participant/);
  });

  it('exposes getCrossInstanceCommService as the singleton getter', () => {
    CrossInstanceCommService._resetForTesting();
    const first = getCrossInstanceCommService();
    expect(first).toBe(CrossInstanceCommService.getInstance());
    expect(getCrossInstanceComm()).toBe(first);
    CrossInstanceCommService._resetForTesting();
  });
});
