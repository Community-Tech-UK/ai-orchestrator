import type { IpcRenderer } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createContextEvidenceDomain } from '../domains/context-evidence.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('context-evidence preload domain', () => {
  it('forwards every bounded request unchanged on its contract channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createContextEvidenceDomain(ipcRenderer, IPC_CHANNELS);
    const scope = {
      conversationId: 'conversation-1',
      owner: { kind: 'instance' as const, instanceId: 'instance-1' },
    };
    const requests = [
      [domain.contextEvidenceList, IPC_CHANNELS.CONTEXT_EVIDENCE_LIST, { ...scope, limit: 20 }],
      [domain.contextEvidenceGetCard, IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD, {
        ...scope, cardId: 'card-1', tokenLimit: 512,
      }],
      [domain.contextEvidenceSearch, IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH, {
        ...scope, query: 'needle', tokenLimit: 512,
      }],
      [domain.contextEvidenceRead, IPC_CHANNELS.CONTEXT_EVIDENCE_READ, {
        ...scope, evidenceId: 'evidence-1', startByte: 0, endByte: 7, tokenLimit: 512,
      }],
      [domain.contextEvidenceCompare, IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE, {
        ...scope,
        left: { evidenceId: 'evidence-1', startByte: 0, endByte: 2 },
        right: { evidenceId: 'evidence-2', startByte: 2, endByte: 4 },
      }],
      [domain.contextEvidenceVerify, IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY, {
        ...scope,
        evidenceId: 'evidence-1', startByte: 0, endByte: 7, contentDigest: 'd'.repeat(64),
      }],
      [domain.contextEvidenceGetMetrics, IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS, scope],
    ] as const;

    for (const [method, channel, request] of requests) {
      await method(request as never);
      expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, request);
    }
  });

  it('forwards state changes and removes the exact listener', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createContextEvidenceDomain(ipcRenderer, IPC_CHANNELS);
    const callback = vi.fn();
    const unsubscribe = domain.onContextEvidenceStateChanged(callback);
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1];
    const update = { conversationId: 'conversation-1', metrics: { updatedAt: 1 } };

    listener({} as never, update);
    expect(callback).toHaveBeenCalledWith(update);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.CONTEXT_EVIDENCE_STATE_CHANGED,
      listener,
    );
  });
});
