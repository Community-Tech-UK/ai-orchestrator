import { describe, expect, it } from 'vitest';
import { readOpenCodeSessionInfoMarker } from './opencode-acp-markers';

describe('readOpenCodeSessionInfoMarker', () => {
  it('maps retry without exposing provider message bodies', () => {
    expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', _meta: {
      'opencode/retry': { attempt: 2, nextRetryAt: 1_700_000_000_000, error: { type: 'rate_limit', message: 'private response', status: 429 } },
    } })).toEqual({ kind: 'retry', update: { sessionUpdate: 'retry_state', type: 'retrying', attempt: 2, reason: 'Provider returned HTTP 429.' } });
  });

  it('maps retry clearing and compaction status', () => {
    expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } })).toEqual({ kind: 'retry-cleared' });
    for (const status of ['started', 'completed', 'failed'] as const) {
      expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status } } })).toEqual({ kind: 'compaction', status });
    }
  });

  it('ignores unrelated or invalid markers', () => {
    expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', title: 'A title' })).toBeNull();
    expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', _meta: { 'other/key': 1 } })).toBeNull();
    expect(readOpenCodeSessionInfoMarker({ sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'unknown' } } })).toBeNull();
  });
});
