import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { getArchiveSerializationKey } from './history-archive-serialization';

function identity(overrides: Partial<Instance> = {}) {
  return {
    id: 'instance-placeholder-alpha',
    provider: 'claude' as const,
    historyThreadId: 'thread-placeholder-shared',
    providerSessionId: 'provider-session-placeholder-alpha',
    sessionId: 'session-placeholder-alpha',
    ...overrides,
  };
}

describe('getArchiveSerializationKey', () => {
  it('serializes different runtime generations by their shared history thread', () => {
    expect(getArchiveSerializationKey(identity({ id: 'generation-alpha' }))).toBe(
      getArchiveSerializationKey(identity({
        id: 'generation-beta',
        providerSessionId: 'provider-session-placeholder-beta',
        sessionId: 'session-placeholder-beta',
      })),
    );
  });

  it('uses provider-scoped session fallback without collapsing unrelated sessions', () => {
    const first = getArchiveSerializationKey(identity({
      historyThreadId: '',
      providerSessionId: 'provider-session-placeholder-alpha',
    }));
    const sameSession = getArchiveSerializationKey(identity({
      id: 'generation-beta',
      historyThreadId: '',
      providerSessionId: 'provider-session-placeholder-alpha',
    }));
    const otherSession = getArchiveSerializationKey(identity({
      historyThreadId: '',
      providerSessionId: 'provider-session-placeholder-beta',
    }));
    const otherProvider = getArchiveSerializationKey(identity({
      provider: 'codex',
      historyThreadId: '',
      providerSessionId: 'provider-session-placeholder-alpha',
    }));

    expect(sameSession).toBe(first);
    expect(otherSession).not.toBe(first);
    expect(otherProvider).not.toBe(first);
  });

  it('falls back to provider-scoped runtime identity when no logical identity exists', () => {
    const first = getArchiveSerializationKey(identity({
      historyThreadId: '',
      providerSessionId: '',
      sessionId: '',
    }));
    const other = getArchiveSerializationKey(identity({
      id: 'instance-placeholder-beta',
      historyThreadId: '',
      providerSessionId: '',
      sessionId: '',
    }));

    expect(other).not.toBe(first);
  });
});
