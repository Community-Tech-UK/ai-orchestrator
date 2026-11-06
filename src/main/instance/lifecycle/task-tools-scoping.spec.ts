import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetTaskToolsScopingForTesting, configureInstanceTaskTools,
  isInstanceTaskTools, removeInstanceTaskTools, setInstanceTaskTools,
} from './task-tools-scoping';

const chat = { id: 'chat', provider: 'claude' as const, parentId: null, executionLocation: { type: 'local' as const } };

describe('task-tools-scoping', () => {
  beforeEach(() => _resetTaskToolsScopingForTesting());

  it('records and clears per-instance flags, treating unset ids and false writes as disabled', () => {
    expect(isInstanceTaskTools(undefined)).toBe(false);
    expect(isInstanceTaskTools('chat')).toBe(false);
    setInstanceTaskTools('chat', true);
    expect(isInstanceTaskTools('chat')).toBe(true);
    removeInstanceTaskTools('chat');
    expect(isInstanceTaskTools('chat')).toBe(false);
    setInstanceTaskTools('chat', true);
    setInstanceTaskTools('chat', false);
    expect(isInstanceTaskTools('chat')).toBe(false);
  });

  it('evicts the oldest flag at the bound and refreshes re-registered entries', () => {
    for (let index = 0; index < 1_000; index++) setInstanceTaskTools(`chat-${index}`, true);
    setInstanceTaskTools('chat-0', true);
    setInstanceTaskTools('chat-1000', true);
    expect(isInstanceTaskTools('chat-0')).toBe(true);
    expect(isInstanceTaskTools('chat-1')).toBe(false);
    expect(isInstanceTaskTools('chat-1000')).toBe(true);
  });

  it('enables only opted-in local Claude main chats', () => {
    configureInstanceTaskTools(chat, true);
    expect(isInstanceTaskTools(chat.id)).toBe(true);
    configureInstanceTaskTools(chat, false);
    expect(isInstanceTaskTools(chat.id)).toBe(false);
    configureInstanceTaskTools({ ...chat, provider: 'codex' }, true);
    expect(isInstanceTaskTools(chat.id)).toBe(false);
  });

  it.each([
    { parentId: 'parent' },
    { metadata: { planQueueRunId: 'queue', planQueueRole: 'worker' } },
    { metadata: { automationId: 'automation', automationRunId: 'run' } },
    { metadata: { repoJobId: 'job-1', spendPurpose: 'repo-job' } },
    { metadata: { pingPongReviewer: true } },
  ])('excludes main-looking machine sessions %j', (overrides) => {
    configureInstanceTaskTools({ ...chat, ...overrides }, true);
    expect(isInstanceTaskTools(chat.id)).toBe(false);
  });

  it('uses actual remote placement despite the builder initially recording local', () => {
    configureInstanceTaskTools(chat, true, { type: 'remote', nodeId: 'worker' });
    expect(isInstanceTaskTools(chat.id)).toBe(false);
    expect(chat.executionLocation.type).toBe('local');
  });

  it('refreshes the setting and actual provider at a later spawn', () => {
    configureInstanceTaskTools(chat, false);
    configureInstanceTaskTools(chat, true);
    expect(isInstanceTaskTools(chat.id)).toBe(true);
    configureInstanceTaskTools(chat, true, chat.executionLocation, 'codex');
    expect(isInstanceTaskTools(chat.id)).toBe(false);
  });
});
