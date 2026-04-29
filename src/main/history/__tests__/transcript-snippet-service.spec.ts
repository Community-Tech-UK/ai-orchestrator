import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetTranscriptSnippetServiceForTesting,
  getTranscriptSnippetService,
} from '../transcript-snippet-service';
import type { OutputMessage } from '../../../shared/types/instance.types';

const message = (
  id: string,
  type: OutputMessage['type'],
  content: string,
  timestamp = Date.now(),
): OutputMessage => ({
  id,
  type,
  content,
  timestamp,
} as OutputMessage);

describe('TranscriptSnippetService.extractAtArchiveTime', () => {
  beforeEach(() => {
    _resetTranscriptSnippetServiceForTesting();
  });

  it('returns empty snippets for an empty transcript', () => {
    expect(getTranscriptSnippetService().extractAtArchiveTime({ messages: [] })).toEqual([]);
  });

  it('skips tool and system messages', () => {
    const snippets = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [
        message('tool-1', 'tool_result', 'tool auth output'),
        message('system-1', 'system', 'system auth note'),
        message('user-1', 'user', 'how does the auth bug reproduce?'),
      ],
      query: 'auth',
    });

    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.excerpt).toContain('auth');
  });

  it('caps snippets at five by default', () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(`user-${index}`, 'user', `message about feature ${index}`),
    );

    const snippets = getTranscriptSnippetService().extractAtArchiveTime({ messages });

    expect(snippets.length).toBeLessThanOrEqual(5);
  });

  it('honors maxSnippets', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(`user-${index}`, 'user', `feature ${index}`),
    );

    const snippets = getTranscriptSnippetService().extractAtArchiveTime({
      messages,
      maxSnippets: 2,
    });

    expect(snippets).toHaveLength(2);
  });

  it('uses query token overlap for scoring when supplied', () => {
    const snippets = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [
        message('user-1', 'user', 'fix the layout regression in the header'),
        message('user-2', 'user', 'investigate the auth token refresh issue'),
        message('user-3', 'user', 'add a unit test for parseArgs'),
      ],
      query: 'auth token',
    });

    expect(snippets[0]?.excerpt).toMatch(/auth/i);
  });

  it('truncates excerpts to the configured character cap', () => {
    const snippets = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [message('user-1', 'user', 'a'.repeat(500))],
      maxExcerptChars: 240,
    });

    expect(snippets[0]?.excerpt.length).toBeLessThanOrEqual(240);
  });

  it('records the source message position in the original buffer', () => {
    const snippets = getTranscriptSnippetService().extractAtArchiveTime({
      messages: [
        message('tool-1', 'tool_result', 'noise'),
        message('user-1', 'user', 'meaningful content about auth'),
      ],
      query: 'auth',
    });

    expect(snippets[0]?.position).toBe(1);
  });
});
