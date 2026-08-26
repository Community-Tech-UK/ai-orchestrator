/**
 * Prompt retention for the bounded output buffer.
 *
 * The live output buffer keeps only the newest `outputBufferSize` messages.
 * Everything older is pushed to disk storage and dropped from memory, which is
 * fine for tool traffic but not for the user's own prompts: they carry the
 * task. Once the opening prompt fell out of the buffer, every in-memory
 * consumer lost it — above all the continuity builders, which rebuild a
 * swapped/restarted session from `outputBuffer` alone and therefore resumed
 * with no idea what was asked.
 *
 * The retained prompts are held *beside* the buffer rather than spliced back
 * into it. `outputBuffer` is addressed by position — the renderer derives
 * `bufferIndex` from an offset plus the array index, and fork/rewind resolve
 * against it — so re-seating old messages into it would silently shift those
 * indices and fork at the wrong message.
 */

import type { Instance, OutputMessage } from '../../shared/types/instance.types';

/**
 * Maximum number of overflowed prompts retained per instance. The opening
 * prompt is always one of them; the rest are the most recent, since a long
 * session's middle prompts are the least likely to still describe the task.
 */
export const PINNED_PROMPT_LIMIT = 20;

/**
 * Identity of a retained prompt, independent of its id.
 *
 * Ids cannot be trusted here. A prompt makes round trips through persisted
 * session state, where `instanceToState` renumbers every entry positionally
 * (`msg-<index>`) on each checkpoint, and wake then derives a prompt id from
 * that renumbered entry. The same prompt therefore arrives under a different id
 * on nearly every hibernate/wake cycle; id-only dedup let it accumulate a fresh
 * copy each time until the duplicates filled the cap and evicted real prompts.
 */
function identity(message: OutputMessage): string {
  return `${message.timestamp}\u0000${message.content}`;
}

/**
 * Keep the opening prompt plus the newest ones, dropping the middle.
 * Sorted first, since a wake can surface prompts older than ones already held.
 */
function bound(prompts: OutputMessage[]): OutputMessage[] {
  const ordered = [...prompts].sort((a, b) => a.timestamp - b.timestamp);
  return ordered.length <= PINNED_PROMPT_LIMIT
    ? ordered
    : [ordered[0], ...ordered.slice(-(PINNED_PROMPT_LIMIT - 1))];
}

/**
 * Fold the prompts in a trim's overflow slice into the retained set.
 *
 * Returns the existing array unchanged when the overflow held no prompts, so a
 * trim that only shed tool traffic costs nothing.
 */
export function mergeRetainedPrompts(
  existing: readonly OutputMessage[] | undefined,
  overflow: readonly OutputMessage[],
): OutputMessage[] {
  const current = existing ?? [];
  const overflowPrompts = overflow.filter((message) => message.type === 'user');
  if (overflowPrompts.length === 0) {
    return current as OutputMessage[];
  }

  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const prompt of overflowPrompts) {
    if (!seen.has(identity(prompt))) {
      seen.add(identity(prompt));
      merged.push(prompt);
    }
  }

  return bound(merged);
}

/**
 * Retained prompts that the given live messages no longer cover, oldest first.
 *
 * Continuity builders prepend these so the original request is present even
 * though it fell out of the buffer.
 */
export function retainedPromptsMissingFrom(
  retained: readonly OutputMessage[] | undefined,
  active: readonly OutputMessage[],
): OutputMessage[] {
  if (!retained || retained.length === 0) {
    return [];
  }

  const present = new Set(active.map(identity));
  return retained.filter((prompt) => !present.has(identity(prompt)));
}

/**
 * The instance's opening request, if it is still known.
 *
 * Prefers the retained set, which holds prompts already evicted from the
 * buffer, and falls back to the oldest prompt still in the buffer.
 */
export function findOriginalRequest(
  retained: readonly OutputMessage[] | undefined,
  active: readonly OutputMessage[],
): OutputMessage | undefined {
  return retained?.find((message) => message.type === 'user')
    ?? active.find((message) => message.type === 'user');
}

/**
 * Retained prompts a fork should inherit from its source.
 *
 * `boundary` is the first message the fork EXCLUDED, or undefined when the fork
 * keeps everything. Anything older than it belongs to the fork's prehistory.
 *
 * The boundary has to come from the caller rather than being inferred from the
 * forked slice: forking at index 0 — "edit the oldest message I can still see",
 * routine once compaction has shrunk the buffer — leaves that slice empty, and
 * an empty slice cannot distinguish "nothing precedes this" from "everything
 * precedes this". Inferring it dropped the opening prompt in exactly the case
 * this feature exists to protect.
 *
 * Returned separately rather than spliced into the fork's message array —
 * `ForkConfig.atMessageIndex` addresses that array by position.
 */
export function retainedPromptsForFork(
  retained: readonly OutputMessage[] | undefined,
  forkedMessages: readonly OutputMessage[],
  boundary: OutputMessage | undefined,
): OutputMessage[] {
  const missing = retainedPromptsMissingFrom(retained, forkedMessages);
  if (!boundary) {
    return missing;
  }

  // Exclude the boundary itself by id: on edit-and-resend it is the message
  // being replaced, so the fork must not carry it forward.
  return missing.filter(
    (prompt) => identity(prompt) !== identity(boundary) && prompt.timestamp <= boundary.timestamp,
  );
}

/** Messages compaction leaves in the buffer. Shared by both context ports. */
export const COMPACTION_KEEP_RECENT = 50;

/**
 * Trim a live buffer to its newest `keep` messages, retaining evicted prompts.
 *
 * Returns how many messages were evicted, for the caller's logging. Compaction
 * writes nothing to output storage, so without this the evicted prompts are
 * gone from every source at once.
 */
export function trimBufferRetainingPrompts(
  instance: Pick<Instance, 'outputBuffer' | 'retainedPrompts'>,
  keep: number,
): number {
  const trimCount = (instance.outputBuffer?.length ?? 0) - keep;
  if (trimCount <= 0) {
    return 0;
  }

  instance.retainedPrompts = mergeRetainedPrompts(
    instance.retainedPrompts,
    instance.outputBuffer.slice(0, trimCount),
  );
  instance.outputBuffer = instance.outputBuffer.slice(-keep);
  return trimCount;
}

/** The subset of a persisted conversation entry this module needs. */
export interface RetainableHistoryEntry {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

/**
 * The prompts a "keep only the newest N" history truncation would discard.
 *
 * Wake and continuity-revival both rebuild a buffer from persisted history and
 * keep only its tail, which drops the opening prompt exactly as a live trim
 * does. Ids are derived from the source entry rather than generated per call,
 * so repeated wake cycles re-merge the same prompt instead of accumulating a
 * fresh copy each time.
 */
export function promptsDiscardedByTruncation(
  history: readonly RetainableHistoryEntry[],
  keep: number,
  idPrefix: string,
): OutputMessage[] {
  return history
    .slice(0, Math.max(0, history.length - keep))
    .filter((entry) => entry.role === 'user')
    .map((entry, idx) => ({
      id: `${idPrefix}${entry.id || idx}`,
      timestamp: entry.timestamp,
      type: 'user' as const,
      content: entry.content,
    }));
}
