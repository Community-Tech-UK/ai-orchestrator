import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  _resetContextWorkerEventRelayForTesting,
  dispatchWorkerBroadcast,
  publishRlmWorkerEvent,
} from '../instance/context-worker-event-relay';
import type { RlmWorkerEventMsg } from '../instance/context-worker-protocol';
import type { WindowManager } from '../window-manager';
import {
  setupRlmEventForwarding,
  teardownRlmEventForwarding,
} from './ipc-main-runtime-wiring';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: vi.fn(() => ({ on: vi.fn() })),
  },
}));

const section = {
  id: 'section-1',
  type: 'file' as const,
  name: 'relay.ts',
  content: '',
  tokens: 3,
  startOffset: 0,
  endOffset: 10,
  checksum: 'checksum-1',
  depth: 0,
};

const store = {
  id: 'store-1',
  instanceId: 'instance-1',
  sections: [section],
  totalTokens: 3,
  totalSize: 10,
  createdAt: 1,
  lastAccessed: 2,
  accessCount: 3,
  config: {
    ipcSectionCount: 1,
    ipcSectionsTruncated: false,
  },
};

function makeWindowManager(): WindowManager {
  return {
    sendToRenderer: vi.fn(),
  } as unknown as WindowManager;
}

function sendToRenderer(windowManager: WindowManager) {
  return vi.mocked(windowManager.sendToRenderer);
}

describe('RLM renderer event forwarding', () => {
  afterEach(() => {
    teardownRlmEventForwarding();
    _resetContextWorkerEventRelayForTesting();
  });

  it('maps bounded relay DTOs to the existing renderer channels and payloads', () => {
    const windowManager = makeWindowManager();
    setupRlmEventForwarding(windowManager);

    const events: RlmWorkerEventMsg[] = [
      {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'store:created',
        payload: store,
      },
      {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'section:added',
        payload: { storeId: store.id, section, highVolume: false, store },
      },
      {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'section:removed',
        payload: {
          storeId: store.id,
          sectionId: section.id,
          highVolume: false,
          store,
        },
      },
      {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'query:executed',
        payload: {
          sessionId: 'session-1',
          queryResult: {
            query: { type: 'grep', params: { pattern: 'relay' } },
            result: 'match',
            tokensUsed: 2,
            sectionsAccessed: [section.id],
            duration: 4,
            depth: 0,
          },
        },
      },
    ];

    for (const event of events) dispatchWorkerBroadcast(event);

    expect(sendToRenderer(windowManager).mock.calls).toEqual([
      [IPC_CHANNELS.RLM_STORE_UPDATED, { storeId: store.id, store }],
      [IPC_CHANNELS.RLM_SECTION_ADDED, { storeId: store.id, section }],
      [IPC_CHANNELS.RLM_STORE_UPDATED, { storeId: store.id, store }],
      [IPC_CHANNELS.RLM_SECTION_REMOVED, { storeId: store.id, sectionId: section.id }],
      [IPC_CHANNELS.RLM_STORE_UPDATED, { storeId: store.id, store }],
      [IPC_CHANNELS.RLM_QUERY_COMPLETE, {
        sessionId: 'session-1',
        queryResult: {
          query: { type: 'grep', params: { pattern: 'relay' } },
          result: 'match',
          tokensUsed: 2,
          sectionsAccessed: [section.id],
          duration: 4,
          depth: 0,
        },
      }],
    ]);
  });

  it('suppresses high-volume section pushes exactly as before', () => {
    const windowManager = makeWindowManager();
    setupRlmEventForwarding(windowManager);

    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'section:added',
      payload: { storeId: store.id, section, highVolume: true, store },
    });
    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'section:removed',
      payload: {
        storeId: store.id,
        sectionId: section.id,
        highVolume: true,
        store,
      },
    });

    expect(sendToRenderer(windowManager)).not.toHaveBeenCalled();
  });

  it('registers once for repeated setup against the same relay and window manager', () => {
    const windowManager = makeWindowManager();
    setupRlmEventForwarding(windowManager);
    setupRlmEventForwarding(windowManager);

    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    });

    expect(sendToRenderer(windowManager)).toHaveBeenCalledOnce();
  });

  it('moves the subscription when runtime wiring is reinitialized with a new window manager', () => {
    const firstWindowManager = makeWindowManager();
    const secondWindowManager = makeWindowManager();
    setupRlmEventForwarding(firstWindowManager);
    setupRlmEventForwarding(secondWindowManager);

    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    });

    expect(sendToRenderer(firstWindowManager)).not.toHaveBeenCalled();
    expect(sendToRenderer(secondWindowManager)).toHaveBeenCalledOnce();
  });

  it('re-registers once after the relay singleton is reset', () => {
    const windowManager = makeWindowManager();
    setupRlmEventForwarding(windowManager);
    _resetContextWorkerEventRelayForTesting();
    setupRlmEventForwarding(windowManager);

    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    });

    expect(sendToRenderer(windowManager)).toHaveBeenCalledOnce();
  });

  it('tears down every relay subscription explicitly', () => {
    const windowManager = makeWindowManager();
    setupRlmEventForwarding(windowManager);
    teardownRlmEventForwarding();

    publishRlmWorkerEvent({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    });

    expect(sendToRenderer(windowManager)).not.toHaveBeenCalled();
  });
});

describe('RLM renderer wiring import isolation', () => {
  afterEach(() => {
    vi.doUnmock('../rlm/context-manager');
    vi.resetModules();
  });

  it('does not resolve the RLM context manager when runtime wiring loads', async () => {
    vi.resetModules();
    const resolveManager = vi.fn();
    vi.doMock('../rlm/context-manager', () => {
      resolveManager();
      throw new Error('runtime wiring must not resolve the RLM manager');
    });

    await expect(import('./ipc-main-runtime-wiring')).resolves.toMatchObject({
      setupRlmEventForwarding: expect.any(Function),
    });
    expect(resolveManager).not.toHaveBeenCalled();
  });
});
