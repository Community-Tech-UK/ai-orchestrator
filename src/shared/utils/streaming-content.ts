import type { OutputMessage } from '../types/instance.types';

/** ACP notices replace prose only within their own source; an ID collision must not claim another message. */
export function getStreamingStatusMergePolicy(
  previous: Pick<OutputMessage, 'type' | 'metadata'>,
  incoming: Pick<OutputMessage, 'type' | 'metadata'>,
): 'replace' | 'ignore' | undefined {
  const source = incoming.metadata?.['source'];
  if (incoming.type !== 'system' || (source !== 'acp-compaction' && source !== 'acp-retry-state')) return undefined;
  return previous.type === 'system' && previous.metadata?.['source'] === source ? 'replace' : 'ignore';
}

/**
 * Monotonic merge for streaming assistant bubbles.
 *
 * Providers stream by appending. A later update that is empty or shorter than
 * already-committed text is a rewind (Cursor ACP snapshot reset, per-segment
 * accumulator restart), not progress. Keep the committed text.
 */
export function nextMonotonicStreamingContent(
  previousContent: string,
  incomingContent: string,
): string {
  if (previousContent.trim().length === 0) {
    return incomingContent;
  }
  if (incomingContent.trim().length === 0) {
    return previousContent;
  }
  if (incomingContent.length < previousContent.length) {
    return previousContent;
  }
  return incomingContent;
}
