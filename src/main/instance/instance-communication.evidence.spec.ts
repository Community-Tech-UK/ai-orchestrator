import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 1, enableDiskStorage: false }) }),
}));
vi.mock('../memory', () => ({
  getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }),
}));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({ classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })) }),
}));
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => undefined,
}));

import { InstanceCommunicationManager } from './instance-communication';

class FakeAdapter extends EventEmitter {
  getName(): string { return 'claude-cli'; }
  getSessionId(): string | null { return 'provider-session-1'; }
  getCurrentTurnId(): string | null { return 'turn-1'; }
}

describe('InstanceCommunicationManager context-evidence ingress', () => {
  let instance: Instance;
  let adapter: FakeAdapter;
  let captureContextEvidenceToolResult: ReturnType<typeof vi.fn>;
  let drainContextEvidence: ReturnType<typeof vi.fn>;
  let onToolStateChange: ReturnType<typeof vi.fn>;
  let manager: InstanceCommunicationManager;

  beforeEach(() => {
    instance = evidenceInstance();
    adapter = new FakeAdapter();
    captureContextEvidenceToolResult = vi.fn().mockResolvedValue(undefined);
    drainContextEvidence = vi.fn().mockResolvedValue(undefined);
    onToolStateChange = vi.fn();
    manager = new InstanceCommunicationManager({
      getInstance: (id) => id === instance.id ? instance : undefined,
      getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(() => true),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onToolStateChange,
      captureContextEvidenceToolResult,
      drainContextEvidence,
    });
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
  });

  it('enqueues the original parsed tool result before hooks and output-buffer retention', async () => {
    const message: OutputMessage = {
      id: 'message-1', timestamp: 1, type: 'tool_result',
      content: 'first\r\nsecond\n',
      metadata: { tool_use_id: 'tool-1', name: 'Read', turnId: 'turn-1' },
    };

    adapter.emit('output', message);

    expect(captureContextEvidenceToolResult).toHaveBeenCalledOnce();
    const capture = captureContextEvidenceToolResult.mock.calls[0]![0];
    expect(capture).toMatchObject({
      queueId: instance.id,
      conversationId: 'conversation-1',
      captureKey: 'tool-result:turn-1:tool-1',
      provider: 'claude',
      providerThreadRef: 'provider-session-1',
      turnRef: 'turn-1',
      toolCallRef: 'tool-1',
      toolName: 'Read',
      sourceKind: 'file',
      mimeType: 'text/plain;charset=utf-8',
    });
    expect(new TextDecoder().decode(capture.content)).toBe('first\r\nsecond\n');

    await vi.waitFor(() => expect(instance.outputBuffer).toHaveLength(1));
    expect(instance.outputBuffer[0]?.content).toBe('first\r\nsecond\n');
  });

  it('drains serialized capture before completion side effects can finalize the turn', async () => {
    let releaseDrain!: () => void;
    drainContextEvidence.mockImplementation(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const response = {
      id: 'response-1', role: 'assistant', content: 'done', usage: { outputTokens: 1 },
    } satisfies CliResponse;

    adapter.emit('complete', response);

    expect(drainContextEvidence).toHaveBeenCalledWith(instance.id);
    expect(onToolStateChange).not.toHaveBeenCalledWith(instance.id, 'idle');
    releaseDrain();
    await vi.waitFor(() => expect(onToolStateChange).toHaveBeenCalledWith(instance.id, 'idle'));
  });

  it('offers both raw and parsed views under the same logical key for service-level dedupe', async () => {
    adapter.emit('tool_result', {
      id: 'tool-1', name: 'Read', arguments: { path: 'README.md' }, result: 'same bytes',
    });
    adapter.emit('output', {
      id: 'message-1', timestamp: 1, type: 'tool_result', content: 'same bytes',
      metadata: { tool_use_id: 'tool-1', name: 'Read', turnId: 'turn-1' },
    } satisfies OutputMessage);

    expect(captureContextEvidenceToolResult).toHaveBeenCalledTimes(2);
    expect(captureContextEvidenceToolResult.mock.calls.map((call) => call[0].captureKey))
      .toEqual(['tool-result:turn-1:tool-1', 'tool-result:turn-1:tool-1']);
    await vi.waitFor(() => expect(instance.outputBuffer).toHaveLength(1));
  });
});

function evidenceInstance(): Instance {
  return {
    id: 'instance-1', displayName: 'Evidence', createdAt: 1, historyThreadId: 'history-1',
    parentId: null, childrenIds: [], supervisorNodeId: '', depth: 0,
    terminationPolicy: 'terminate-children', launchMode: 'orchestrated', executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build', agentMode: 'build', planMode: { enabled: false, state: 'off' },
    status: 'processing', contextUsage: { used: 0, total: 1_000, percentage: 0 },
    lastActivity: 1, processId: 1, sessionId: 'session-1', providerSessionId: 'provider-session-1',
    activeTurnId: 'turn-1', workingDirectory: '/tmp', yoloMode: false, provider: 'claude',
    outputBuffer: [], outputBufferMaxSize: 1, communicationTokens: new Map(), subscribedTo: [],
    totalTokensUsed: 0, requestCount: 0, errorCount: 0, restartCount: 0, restartEpoch: 0,
    contextEvidence: { mode: 'shadow', conversationId: 'conversation-1', captureFailureCount: 0 },
  };
}
