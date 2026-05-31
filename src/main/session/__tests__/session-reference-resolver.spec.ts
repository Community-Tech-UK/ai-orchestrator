import { describe, it, expect, vi } from 'vitest';

vi.mock('../session-recall-service', () => ({
  getSessionRecallService: () => ({ search: vi.fn(async () => []) }),
}));

import {
  parseSessionRefTokens,
  resolveSessionReferences,
  type SessionReferenceResolverDeps,
} from '../session-reference-resolver';
import type { SessionRecallResult } from '../../../shared/types/session-recall.types';

function result(id: string, title: string, summary = '', score = 1): SessionRecallResult {
  return { source: 'archived_session', id, title, summary, score, timestamp: 0 };
}

describe('parseSessionRefTokens', () => {
  it('extracts unique ids in first-seen order', () => {
    const ids = parseSessionRefTokens('see @T-abc123 and @T-def456, also @T-abc123 again');
    expect(ids).toEqual(['abc123', 'def456']);
  });

  it('returns empty when there are no references', () => {
    expect(parseSessionRefTokens('no references here')).toEqual([]);
  });

  it('ignores too-short tokens', () => {
    expect(parseSessionRefTokens('@T-a is too short')).toEqual([]);
  });
});

describe('resolveSessionReferences', () => {
  it('returns the text unchanged when no references exist', async () => {
    const deps: SessionReferenceResolverDeps = { search: vi.fn() };
    const r = await resolveSessionReferences('plain prompt', deps);
    expect(r.annotatedText).toBe('plain prompt');
    expect(r.contextBlock).toBe('');
    expect(r.refs).toEqual([]);
    expect(deps.search).not.toHaveBeenCalled();
  });

  it('resolves an exact id match and annotates the token', async () => {
    const deps: SessionReferenceResolverDeps = {
      search: vi.fn(async () => [result('s7j4x1q9w', 'Fix login bug', 'patched null token')]),
    };
    const r = await resolveSessionReferences('continue @T-s7j4x1q9w please', deps);
    expect(r.refs[0]).toMatchObject({ id: 's7j4x1q9w', found: true, title: 'Fix login bug' });
    expect(r.annotatedText).toBe('continue @T-s7j4x1q9w ("Fix login bug") please');
    expect(r.contextBlock).toContain('@T-s7j4x1q9w: Fix login bug — patched null token');
  });

  it('resolves a prefix id to the full session', async () => {
    const deps: SessionReferenceResolverDeps = {
      search: vi.fn(async () => [result('s7j4x1q9w', 'Prefix match')]),
    };
    const r = await resolveSessionReferences('@T-s7j4 here', deps);
    expect(r.refs[0]).toMatchObject({ id: 's7j4', found: true, sessionId: 's7j4x1q9w' });
  });

  it('prefers an exact match over higher-scoring prefix candidates', async () => {
    const deps: SessionReferenceResolverDeps = {
      search: vi.fn(async () => [
        result('s7j4x1q9wEXTRA', 'Prefix higher score', '', 10),
        result('s7j4x1q9w', 'Exact lower score', '', 1),
      ]),
    };
    const r = await resolveSessionReferences('@T-s7j4x1q9w', deps);
    expect(r.refs[0].sessionId).toBe('s7j4x1q9w');
    expect(r.refs[0].title).toBe('Exact lower score');
  });

  it('marks unresolved references as not found and leaves the token unchanged', async () => {
    const deps: SessionReferenceResolverDeps = { search: vi.fn(async () => []) };
    const r = await resolveSessionReferences('@T-missing99', deps);
    expect(r.refs[0]).toMatchObject({ id: 'missing99', found: false });
    expect(r.annotatedText).toBe('@T-missing99');
    expect(r.contextBlock).toBe('');
  });

  it('survives a search error by reporting not found', async () => {
    const deps: SessionReferenceResolverDeps = {
      search: vi.fn(async () => {
        throw new Error('store down');
      }),
    };
    const r = await resolveSessionReferences('@T-abc123', deps);
    expect(r.refs[0].found).toBe(false);
  });

  it('searches only archived sessions', async () => {
    const search = vi.fn(async () => [result('abc123', 't')]);
    await resolveSessionReferences('@T-abc123', { search });
    expect(search).toHaveBeenCalledWith('abc123', ['archived_session'], 5);
  });
});
