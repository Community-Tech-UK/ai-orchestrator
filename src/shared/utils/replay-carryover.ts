/**
 * How much of a conversation survives a replay (Oct-2 T17).
 *
 * When a change restarts a session without native resume, the new session does not get the
 * conversation back: it gets a short digest built by `buildReplayContinuityMessage`. These are
 * that builder's own limits, kept here so the pre-click preview and the real digest cannot drift
 * apart. The maintained hand-off document (`handoff-state-service`) is capped lower still.
 */

export const REPLAY_MAX_TURNS = 24;
export const REPLAY_MAX_CHARS_PER_MESSAGE = 800;
/** The newest turn, and the original request, get a larger budget than the scrollback around them. */
export const REPLAY_MAX_CHARS_FOR_LAST_TURN = 4_000;
export const REPLAY_MAX_UNRESOLVED_ITEMS = 5;

const CHARS_PER_TOKEN = 4;
/** Fixed wording around the digest: headings and the closing instruction. */
const REPLAY_FRAME_CHARS = 1_200;
/** Per item: a role label or bullet, and the marker left where a long message is cut. */
const REPLAY_ITEM_OVERHEAD_CHARS = 60;

/** The most a replay digest can hold, in tokens: the digest never grows past this however long the conversation is. */
export const REPLAY_DIGEST_MAX_TOKENS = Math.ceil((
  (REPLAY_MAX_TURNS - 1) * REPLAY_MAX_CHARS_PER_MESSAGE // the scrollback
  + REPLAY_MAX_CHARS_FOR_LAST_TURN                       // the newest turn
  + REPLAY_MAX_CHARS_PER_MESSAGE                         // the current objective
  + REPLAY_MAX_CHARS_FOR_LAST_TURN                       // the original request
  + REPLAY_MAX_UNRESOLVED_ITEMS * REPLAY_MAX_CHARS_PER_MESSAGE
  + (REPLAY_MAX_TURNS + REPLAY_MAX_UNRESOLVED_ITEMS + 2) * REPLAY_ITEM_OVERHEAD_CHARS
  + REPLAY_FRAME_CHARS
) / CHARS_PER_TOKEN);

/** What a replay of a conversation holding `conversationTokens` carries over, and what it leaves behind. */
export function replayCarryover(conversationTokens: number): { carriedTokens: number; droppedTokens: number } {
  const total = Math.max(0, Math.round(conversationTokens));
  const carriedTokens = Math.min(total, REPLAY_DIGEST_MAX_TOKENS);
  return { carriedTokens, droppedTokens: total - carriedTokens };
}
