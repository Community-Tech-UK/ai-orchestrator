import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { bindRawAdapterProviderEvents } from './instance-communication-provider-events';
import {
  buildParsedToolResultEvidenceIngress,
  buildRawToolResultEvidenceIngress,
} from './instance-provider-event-ingress';

describe('raw adapter provider-event evidence ingress', () => {
  it('offers the exact raw tool result to evidence capture before publishing the forensic event', () => {
    const adapter = new EventEmitter() as CliAdapter;
    const order: string[] = [];
    const captureToolResult = vi.fn((toolCall) => {
      order.push(`capture:${toolCall.result}`);
    });
    const emit = vi.fn(() => order.push('emit'));
    bindRawAdapterProviderEvents({
      adapter,
      isStale: () => false,
      captureToolResult,
      emit,
    });

    adapter.emit('tool_result', {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'first\r\nsecond\n',
    });

    expect(order).toEqual(['capture:first\r\nsecond\n', 'emit']);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tool_result', output: 'first\r\nsecond\n' }),
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:tool_result' }) }),
    );
  });

  it('builds one stable logical key for parsed and raw views of the same result', () => {
    const instance = evidenceInstance();
    const parsed: OutputMessage = {
      id: 'message-1',
      timestamp: 1,
      type: 'tool_result',
      content: 'exact\r\nbytes\n',
      metadata: { tool_use_id: 'tool-1', name: 'Read', turnId: 'turn-1' },
    };

    const parsedIngress = buildParsedToolResultEvidenceIngress(instance, parsed);
    const rawIngress = buildRawToolResultEvidenceIngress(instance, {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'exact\r\nbytes\n',
    });

    expect(parsedIngress).toMatchObject({
      queueId: 'instance-1',
      conversationId: 'conversation-1',
      captureKey: 'tool-result:turn-1:tool-1',
      turnRef: 'turn-1',
      toolCallRef: 'tool-1',
      toolName: 'Read',
      sourceKind: 'file',
      mimeType: 'text/plain;charset=utf-8',
    });
    expect(rawIngress).toMatchObject({
      captureKey: parsedIngress?.captureKey,
      turnRef: 'turn-1',
      toolCallRef: 'tool-1',
    });
    expect(new TextDecoder().decode(parsedIngress?.content)).toBe('exact\r\nbytes\n');
    expect(new TextDecoder().decode(rawIngress?.content)).toBe('exact\r\nbytes\n');
  });

  it('does not claim capture when evidence mode or app-owned conversation identity is absent', () => {
    const instance = evidenceInstance();
    instance.contextEvidence = { mode: 'off', captureFailureCount: 0 };

    expect(buildRawToolResultEvidenceIngress(instance, {
      id: 'tool-1', name: 'Read', arguments: {}, result: 'hidden',
    })).toBeNull();

    instance.contextEvidence = { mode: 'shadow', captureFailureCount: 0 };
    expect(buildRawToolResultEvidenceIngress(instance, {
      id: 'tool-1', name: 'Read', arguments: {}, result: 'hidden',
    })).toBeNull();
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
    outputBuffer: [], outputBufferMaxSize: 10, communicationTokens: new Map(), subscribedTo: [],
    totalTokensUsed: 0, requestCount: 0, errorCount: 0, restartCount: 0, restartEpoch: 0,
    contextEvidence: { mode: 'shadow', conversationId: 'conversation-1', captureFailureCount: 0 },
  };
}
