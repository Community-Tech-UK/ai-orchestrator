import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { ProviderAccountQuotaSessionPayloadSchema } from '../../../packages/contracts/src/schemas/provider-account.schemas';
import { IPC_CHANNELS } from '../generated/channels';
import { createChatDomain } from '../domains/chat.preload';
import { createContextEvidenceDomain } from '../domains/context-evidence.preload';
import { createInstanceDomain } from '../domains/instance.preload';
import { createOperatorDomain } from '../domains/operator.preload';
import { createProviderAccountDomain } from '../domains/provider-account.preload';
import { createVoiceDomain } from '../domains/voice.preload';

// Each describe checks one preload domain's calls against its IPC contract channels.
describe('chat preload domain', () => {
  it('exposes every chat command on the expected contract channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createChatDomain(ipcRenderer, IPC_CHANNELS);

    await domain.chatList({ includeArchived: true });
    await domain.chatGet({ chatId: 'chat-1' });
    await domain.chatCreate({ provider: 'claude', currentCwd: '/work' });
    await domain.chatRename({ chatId: 'chat-1', name: 'Renamed' });
    await domain.chatArchive({ chatId: 'chat-1' });
    await domain.chatDelete({ chatId: 'chat-1', confirmation: 'delete' });
    await domain.chatSetCwd({ chatId: 'chat-1', cwd: '/next' });
    await domain.chatSetProvider({ chatId: 'chat-1', provider: 'codex' });
    await domain.chatSetModel({ chatId: 'chat-1', model: null });
    await domain.chatSetReasoning({ chatId: 'chat-1', reasoningEffort: 'high' });
    await domain.chatSetYolo({ chatId: 'chat-1', yolo: true });
    await domain.chatLoadOlderMessages({ chatId: 'chat-1', beforeSequence: 20, limit: 10 });
    await domain.chatSendMessage({ chatId: 'chat-1', text: 'Hello' });
    await domain.chatGetUiState();
    await domain.chatSetUiState({ selectedChatId: 'chat-2', openChatIds: ['chat-1', 'chat-2'] });

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.CHAT_LIST, { includeArchived: true });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.CHAT_GET, { chatId: 'chat-1' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.CHAT_CREATE, { provider: 'claude', currentCwd: '/work' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, IPC_CHANNELS.CHAT_RENAME, { chatId: 'chat-1', name: 'Renamed' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(5, IPC_CHANNELS.CHAT_ARCHIVE, { chatId: 'chat-1' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(6, IPC_CHANNELS.CHAT_DELETE, { chatId: 'chat-1', confirmation: 'delete' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(7, IPC_CHANNELS.CHAT_SET_CWD, { chatId: 'chat-1', cwd: '/next' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(8, IPC_CHANNELS.CHAT_SET_PROVIDER, { chatId: 'chat-1', provider: 'codex' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(9, IPC_CHANNELS.CHAT_SET_MODEL, { chatId: 'chat-1', model: null });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(10, IPC_CHANNELS.CHAT_SET_REASONING, { chatId: 'chat-1', reasoningEffort: 'high' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(11, IPC_CHANNELS.CHAT_SET_YOLO, { chatId: 'chat-1', yolo: true });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(12, IPC_CHANNELS.CHAT_LOAD_OLDER_MESSAGES, { chatId: 'chat-1', beforeSequence: 20, limit: 10 });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(13, IPC_CHANNELS.CHAT_SEND_MESSAGE, { chatId: 'chat-1', text: 'Hello' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(14, IPC_CHANNELS.CHAT_UI_STATE_GET, {});
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(15, IPC_CHANNELS.CHAT_UI_STATE_SET, {
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
    });
  });

  it('subscribes and unsubscribes chat events using the contract channel', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createChatDomain(ipcRenderer, IPC_CHANNELS);
    const unsubscribe = domain.onChatEvent(vi.fn());

    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_EVENT, expect.any(Function));
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_EVENT, expect.any(Function));
  });
});

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

describe('instance preload domain', () => {
  it('stamps the Computer Use override request through the preload auth wrapper', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const withAuth = vi.fn((payload: Record<string, unknown> = {}) => ({
      ...payload,
      ipcAuthToken: 'auth-token',
    }));
    const domain = createInstanceDomain(ipcRenderer, IPC_CHANNELS, withAuth);

    await domain.setComputerUseMode({
      instanceId: 'inst-1',
      mode: 'unrestricted',
    });

    expect(withAuth).toHaveBeenCalledOnce();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.INSTANCE_SET_COMPUTER_USE_MODE,
      {
        instanceId: 'inst-1',
        mode: 'unrestricted',
        ipcAuthToken: 'auth-token',
      },
    );
  });

  it('invokes compaction context recovery on the contract channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInstanceDomain(ipcRenderer, IPC_CHANNELS);

    await domain.recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.INSTANCE_RECOVER_COMPACTION_CONTEXT,
      { instanceId: 'inst-1', markerId: 'marker-1' },
    );
  });
});

describe('operator preload domain', () => {
  it('exposes run audit and operator project methods', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;

    const domain = createOperatorDomain(ipcRenderer, IPC_CHANNELS);

    expect(Object.keys(domain).sort()).toEqual([
      'cancelOperatorRun',
      'getOperatorRun',
      'listOperatorProjects',
      'listOperatorRuns',
      'onOperatorEvent',
      'planOperatorProjectVerification',
      'rescanOperatorProjects',
      'resolveOperatorProject',
    ]);
  });
});

describe('provider account usage-session bridge', () => {
  it.each(['connect', 'disconnect'] as const)('sends a valid authenticated %s request without session credentials', async (action) => {
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      expect(channel).toBe('provider-account:quota-session');
      const request = ProviderAccountQuotaSessionPayloadSchema.parse(payload);
      expect(request).toEqual({
        provider: 'opencode',
        profileId: 'mimo-spare',
        action,
        ipcAuthToken: 'test-placeholder',
      });
      return { success: true };
    });
    const domain = createProviderAccountDomain({ invoke } as unknown as IpcRenderer, IPC_CHANNELS, (payload = {}) => ({
      ...payload,
      ipcAuthToken: 'test-placeholder',
    }));

    await expect(domain.manageProviderAccountQuotaSession('mimo-spare', action)).resolves.toEqual({ success: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('voice preload domain', () => {
  it('invokes local STT chunks and subscribes to local STT events on contract channels', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createVoiceDomain(
      ipcRenderer,
      IPC_CHANNELS,
      (payload = {}) => ({ ...payload, ipcAuthToken: 'auth-token' }),
    );
    const eventCallback = vi.fn();

    await domain.pushVoiceLocalSttChunk({
      sessionId: 'local-session-1',
      seq: 1,
      wavBase64: 'UklGRg==',
      last: true,
    });
    const stop = domain.onVoiceLocalSttEvent(eventCallback);
    stop();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_CHUNK,
      {
        sessionId: 'local-session-1',
        seq: 1,
        wavBase64: 'UklGRg==',
        last: true,
        ipcAuthToken: 'auth-token',
      },
    );
    expect(ipcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      expect.any(Function),
    );
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as unknown as (
      event: unknown,
      payload: unknown,
    ) => void;
    listener({}, { sessionId: 'local-session-1', kind: 'final', text: 'hello' });
    expect(eventCallback).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello',
    });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      listener,
    );
  });
});
