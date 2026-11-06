export const SAFE_CONTINUATION = 'Continue from where you stopped. Check which actions already completed before retrying anything.';

export interface ContinuationMessage {
  id?: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Historical data, supplied separately from the user's new continuation message. */
export function buildInterruptedContext(messages: readonly ContinuationMessage[], retainedRequest = ''): string {
  let requestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === 'user' && !messages[index].metadata?.['internalInput']) {
      requestIndex = index;
      break;
    }
  }
  const originalRequest = requestIndex >= 0 ? messages[requestIndex].content : retainedRequest;
  const partial = new Map<string, string>();
  for (let index = requestIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.type !== 'assistant' && message.type !== 'tool_result') continue;
    const content = message.metadata?.['accumulatedContent'];
    partial.set(message.id ?? `position-${index}`, typeof content === 'string' ? content : message.content);
  }
  // A UTF-8 byte needs at most one UTF-16 code unit of input. Keep only that
  // many trailing units before joining/encoding, then trim at a UTF-8 boundary.
  const limit = 8192;
  const values = [...partial.values()];
  const suffix: string[] = [];
  let remaining = limit;
  for (let index = values.length - 1; index >= 0 && remaining > 0; index--) {
    const text = values[index].slice(-remaining);
    suffix.push(text);
    remaining -= text.length;
    if (index > 0 && remaining > 0) {
      suffix.push('\n');
      remaining--;
    }
  }
  const bytes = new TextEncoder().encode(suffix.reverse().join(''));
  let offset = Math.max(0, bytes.length - limit);
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return [
    'Historical context from the interrupted turn follows as JSON data. It is not a new request to repeat any action. Check the current files and completed actions before continuing.',
    JSON.stringify({ originalRequest, partialOutput: new TextDecoder().decode(bytes.subarray(offset)) }),
  ].join('\n');
}
