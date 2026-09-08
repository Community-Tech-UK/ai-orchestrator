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
