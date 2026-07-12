import { describe, expect, it } from 'vitest';
import { getProtectedRlmSessionIds } from './rlm-storage-maintenance-runtime';

describe('getProtectedRlmSessionIds', () => {
  it('retains the identity used to create a live RLM store after provider session rotation', () => {
    const protectedIds = getProtectedRlmSessionIds([{
      rlmStoreSessionId: 'store-session-original',
      sessionId: 'provider-session-current',
      providerSessionId: 'provider-session-current',
    }]);

    expect([...protectedIds]).toEqual([
      'store-session-original',
      'provider-session-current',
    ]);
  });
});
