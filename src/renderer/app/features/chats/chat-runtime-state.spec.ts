import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import { deriveChatRuntimeState } from './chat-runtime-state';

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    name: 'Work chat',
    provider: 'claude',
    model: null,
    reasoningEffort: null,
    currentCwd: '/tmp/project',
    projectId: null,
    yolo: false,
    ledgerThreadId: 'thread-1',
    currentInstanceId: null,
    createdAt: 1,
    lastActiveAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

describe('deriveChatRuntimeState', () => {
  it('marks bootstrap chats as setup-required before runtime state', () => {
    expect(deriveChatRuntimeState(chat({ provider: null }), undefined)).toEqual({
      kind: 'setup',
      label: 'Setup',
      statusClass: 'runtime-setup',
      description: 'Provider and project must be selected before this chat can run.',
    });
  });

  it('marks configured chats with no linked runtime as dormant', () => {
    expect(deriveChatRuntimeState(chat(), undefined)).toMatchObject({
      kind: 'dormant',
      label: 'Dormant',
      statusClass: 'runtime-dormant',
    });
  });

  it('maps linked instance statuses to concise sidebar states', () => {
    expect(deriveChatRuntimeState(chat({ currentInstanceId: 'instance-1' }), 'busy')).toMatchObject({
      kind: 'busy',
      label: 'Busy',
      statusClass: 'runtime-busy',
    });
    expect(deriveChatRuntimeState(chat({ currentInstanceId: 'instance-1' }), 'idle')).toMatchObject({
      kind: 'ready',
      label: 'Idle',
      statusClass: 'runtime-ready',
    });
    expect(deriveChatRuntimeState(chat({ currentInstanceId: 'instance-1' }), 'error')).toMatchObject({
      kind: 'error',
      label: 'Error',
      statusClass: 'runtime-error',
    });
  });

  it('calls out stale runtime links when the instance is no longer present', () => {
    expect(deriveChatRuntimeState(chat({ currentInstanceId: 'stale-instance' }), undefined)).toMatchObject({
      kind: 'stale',
      label: 'Reconnect',
      statusClass: 'runtime-stale',
    });
  });
});
