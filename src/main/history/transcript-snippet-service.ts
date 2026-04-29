import { getLogger } from '../logging/logger';
import type { HistorySnippet } from '../../shared/types/history.types';
import type { OutputMessage } from '../../shared/types/instance.types';

const logger = getLogger('TranscriptSnippetService');

const DEFAULT_MAX_SNIPPETS = 5;
const DEFAULT_EXCERPT_CHARS = 240;
const MIN_TOKEN_LENGTH = 3;

export interface SnippetExtractionInput {
  messages: readonly OutputMessage[];
  query?: string;
  maxSnippets?: number;
  maxExcerptChars?: number;
}

export interface TranscriptSnippetService {
  extractAtArchiveTime(input: SnippetExtractionInput): HistorySnippet[];
  expandSnippetsOnDemand(
    entryId: string,
    query: string,
    opts?: { maxSnippets?: number; maxExcerptChars?: number },
  ): Promise<HistorySnippet[]>;
}

interface SnippetCandidate {
  position: number;
  score: number;
  content: string;
  timestamp: number;
}

class DefaultTranscriptSnippetService implements TranscriptSnippetService {
  extractAtArchiveTime(input: SnippetExtractionInput): HistorySnippet[] {
    const maxSnippets = input.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
    if (maxSnippets <= 0) {
      return [];
    }

    const maxExcerptChars = input.maxExcerptChars ?? DEFAULT_EXCERPT_CHARS;
    const queryTokens = tokenize(input.query ?? '');
    const now = Date.now();
    const candidates: SnippetCandidate[] = [];

    input.messages.forEach((message, position) => {
      if (message.type !== 'user' && message.type !== 'assistant') {
        return;
      }

      const content = String(message.content ?? '').trim();
      if (!content) {
        return;
      }

      const messageTokens = tokenize(content);
      const intersection = queryTokens.size === 0
        ? 1
        : countIntersection(messageTokens, queryTokens);
      if (queryTokens.size > 0 && intersection === 0) {
        return;
      }

      const timestamp = message.timestamp ?? now;
      const recency = recencyDecay(timestamp, now);
      const score = queryTokens.size === 0 ? recency : intersection * recency;
      candidates.push({ position, score, content, timestamp });
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.timestamp - a.timestamp;
    });

    return candidates.slice(0, maxSnippets).map(candidate => ({
      position: candidate.position,
      excerpt: buildExcerpt(candidate.content, queryTokens, maxExcerptChars),
      score: roundScore(candidate.score),
    }));
  }

  async expandSnippetsOnDemand(
    entryId: string,
    query: string,
    opts: { maxSnippets?: number; maxExcerptChars?: number } = {},
  ): Promise<HistorySnippet[]> {
    const { getHistoryManager } = await import('./history-manager');
    const conversation = await getHistoryManager().loadConversation(entryId);
    if (!conversation) {
      logger.warn('History entry not found for snippet expansion', { entryId });
      return [];
    }

    return this.extractAtArchiveTime({
      messages: conversation.messages,
      query,
      maxSnippets: opts.maxSnippets,
      maxExcerptChars: opts.maxExcerptChars,
    });
  }
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/\W+/u)
      .filter(token => token.length >= MIN_TOKEN_LENGTH),
  );
}

function countIntersection(source: Set<string>, query: Set<string>): number {
  let count = 0;
  for (const token of query) {
    if (source.has(token)) {
      count += 1;
    }
  }
  return count;
}

function recencyDecay(messageTimestamp: number, now: number): number {
  const ageMs = Math.max(0, now - messageTimestamp);
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (ageMs <= oneDayMs) return 1;
  if (ageMs <= 7 * oneDayMs) return 0.6;
  if (ageMs <= 30 * oneDayMs) return 0.3;
  return 0.1;
}

function buildExcerpt(content: string, queryTokens: Set<string>, maxChars: number): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  const lower = cleaned.toLowerCase();
  let center = 0;
  for (const token of queryTokens) {
    const index = lower.indexOf(token);
    if (index >= 0 && (center === 0 || index < center)) {
      center = index;
    }
  }

  const halfWindow = Math.floor(maxChars / 2);
  let start = Math.max(0, center - halfWindow);
  let end = Math.min(cleaned.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  let excerpt = cleaned.slice(start, end);
  if (start > 0) {
    excerpt = `...${excerpt}`;
  }
  if (end < cleaned.length) {
    excerpt = `${excerpt}...`;
  }
  if (excerpt.length > maxChars) {
    excerpt = `${excerpt.slice(0, maxChars - 3)}...`;
  }
  return excerpt;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

let instance: TranscriptSnippetService | null = null;

export function getTranscriptSnippetService(): TranscriptSnippetService {
  instance ??= new DefaultTranscriptSnippetService();
  return instance;
}

export function _resetTranscriptSnippetServiceForTesting(): void {
  instance = null;
}
