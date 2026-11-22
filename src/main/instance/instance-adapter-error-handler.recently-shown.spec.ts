import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

import type { OutputMessage } from '../../shared/types/instance.types';
import { recentlyShownError } from './instance-adapter-error-handler';
import { RECENT_ADAPTER_ERROR_OUTPUT_DEDUP_MS } from './instance-communication.constants';

const NOW = 1_000_000;

function raw(content: string, timestamp = NOW): OutputMessage {
  return { id: content, timestamp, type: 'error', content };
}

function plain(reason: string, timestamp = NOW): OutputMessage {
  return {
    id: `plain-${reason}`, timestamp, type: 'error', content: 'Plain words.',
    metadata: { errorPresentation: { category: 'unknown', headline: 'Plain', whatToDo: 'What to do: x', rawDetail: reason } },
  };
}

describe('recentlyShownError', () => {
  it('finds the same reason shown a moment ago, whether the earlier line was raw or in plain words', () => {
    expect(recentlyShownError([raw('Tool read failed: missing')], 'Tool read failed: missing', { now: NOW })).toBe(true);
    expect(recentlyShownError([plain('Tool read failed: missing')], 'Tool read failed: missing', { now: NOW })).toBe(true);
  });

  it('ignores a different reason, and the same reason shown longer ago than the window', () => {
    expect(recentlyShownError([raw('other failure')], 'Tool read failed: missing', { now: NOW })).toBe(false);
    const old = NOW - RECENT_ADAPTER_ERROR_OUTPUT_DEDUP_MS - 1;
    expect(recentlyShownError([raw('Tool read failed: missing', old)], 'Tool read failed: missing', { now: NOW })).toBe(false);
  });

  it('with plainOnly, keeps a second raw line with the same text, which can be a separate failure', () => {
    const shownRaw = [raw('Tool read failed: missing')];
    expect(recentlyShownError(shownRaw, 'Tool read failed: missing', { now: NOW, plainOnly: true })).toBe(false);
    expect(recentlyShownError([plain('Tool read failed: missing')], 'Tool read failed: missing', { now: NOW, plainOnly: true })).toBe(true);
  });

  it('ignores lines that are not errors', () => {
    const assistant: OutputMessage = { id: 'a', timestamp: NOW, type: 'assistant', content: 'Tool read failed: missing' };
    expect(recentlyShownError([assistant], 'Tool read failed: missing', { now: NOW })).toBe(false);
  });
});
