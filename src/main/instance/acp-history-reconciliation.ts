import type { OutputMessage } from '../../shared/types/instance.types';

function normalized(value: string): string { return value.replace(/\r\n/g, '\n').trim(); }

// These are leading envelopes emitted by toPromptBlocks, wrapRtkAwareness,
// buildReplayContinuityMessage, indexed context and orchestration builders.
// They are detection boundaries, never instructions to strip user text.
function internalEnvelope(value: string): boolean {
  return ['[SYSTEM INSTRUCTIONS]', '[RTK AWARENESS]', '<conversation_history>', '[Indexed Codebase Context]', '## You Are an Orchestrator', '## Child Instance', '[SYSTEM: Context Usage Warning]'].some((prefix) => value.trimStart().startsWith(prefix));
}

function unsafeHistory(): never {
  throw new Error('Native transcript recovery cannot safely display ambiguous user history. Retained visible history was preserved.');
}

/** Reverse lexical order uses the same UTF-16 units as String.endsWith. */
function compareFromEnd(left: string, right: string, suffixOnly = false): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let offset = 1; offset <= sharedLength; offset++) {
    const difference = left.charCodeAt(left.length - offset) - right.charCodeAt(right.length - offset);
    if (difference !== 0) return difference;
  }
  return suffixOnly && left.length >= right.length ? 0 : left.length - right.length;
}

/** Build once; matching suffixes are adjacent in reverse lexical order. */
function indexWrappedUserSuffixes(messages: readonly OutputMessage[]): (content: string) => boolean {
  const wrapped: string[] = [];
  const ordinary = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'user') continue;
    if (internalEnvelope(message.content)) wrapped.push(message.content);
    else ordinary.add(message.content);
  }
  wrapped.sort(compareFromEnd);
  return (content) => {
    // The caller already found a wrapped match. An exact ordinary occurrence
    // therefore makes that mapping ambiguous, regardless of its position.
    if (ordinary.has(content)) return false;
    let low = 0;
    let high = wrapped.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (compareFromEnd(wrapped[middle], content, true) < 0) low = middle + 1;
      else high = middle;
    }
    return wrapped[low]?.endsWith(content) === true && wrapped[low + 1]?.endsWith(content) !== true;
  };
}

/** Native model steps form the one answer that Harness retains for each user turn. */
function conversation(replay: readonly OutputMessage[]): OutputMessage[] {
  const messages: OutputMessage[] = [];
  for (const message of replay) {
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    const previous = messages.at(-1);
    if (message.type === 'assistant' && previous?.type === 'assistant') {
      messages[messages.length - 1] = { ...previous, content: previous.content + message.content };
    } else messages.push(message);
  }
  return messages;
}

/** Native ordering repairs missing prefixes; matching retained display remains authoritative. */
export function reconcileAcpHistoryReplay(seed: readonly OutputMessage[], replay: readonly OutputMessage[]): OutputMessage[] {
  const nativeMessages = conversation(replay);
  const nativeCounts = new Map<string, number>();
  for (const message of nativeMessages) {
    const key = `${message.type}\0${normalized(message.content)}`;
    nativeCounts.set(key, (nativeCounts.get(key) ?? 0) + 1);
  }
  const byId = new Map<string, number>();
  const byContent = new Map<string, number[]>();
  seed.forEach((message, index) => {
    byId.set(message.id, index);
    const nativeId = message.metadata?.['acpMessageId'];
    if (typeof nativeId === 'string') byId.set(nativeId, index);
    const key = `${message.type}\0${normalized(message.content)}`;
    const indices = byContent.get(key) ?? [];
    indices.push(index); byContent.set(key, indices);
  });
  const offsets = new Map<string, number>();
  const merged: OutputMessage[] = [];
  let uniqueWrappedSuffix: ((content: string) => boolean) | undefined;
  let cursor = 0;
  for (const native of nativeMessages) {
    const identity = byId.get(native.id);
    const key = `${native.type}\0${normalized(native.content)}`;
    const indices = byContent.get(key) ?? [];
    let offset = offsets.get(key) ?? 0;
    while (offset < indices.length && indices[offset] < cursor) offset++;
    offsets.set(key, offset);
    let match = identity !== undefined && identity >= cursor ? identity : indices[offset];
    if (native.type === 'user' && identity === undefined && match !== undefined && (nativeCounts.get(key) ?? 0) > indices.length) unsafeHistory();
    let repair = false;
    const next = seed[cursor];
    if (match === undefined && next?.type === native.type && next.content.trim()) {
      if (native.type === 'user' && internalEnvelope(native.content) && native.content.endsWith(next.content)) {
        uniqueWrappedSuffix ??= indexWrappedUserSuffixes(nativeMessages);
        if (!uniqueWrappedSuffix(next.content)) unsafeHistory();
        match = cursor;
      }
      else if (native.type === 'assistant' && native.content.startsWith(next.content)) { match = cursor; repair = true; }
    }
    if (match === undefined) {
      if (native.type === 'user' && internalEnvelope(native.content)) unsafeHistory();
      merged.push(native); continue;
    }
    merged.push(...seed.slice(cursor, match));
    merged.push(repair ? { ...seed[match], content: native.content } : seed[match]);
    cursor = match + 1;
  }
  merged.push(...seed.slice(cursor));
  return merged;
}
