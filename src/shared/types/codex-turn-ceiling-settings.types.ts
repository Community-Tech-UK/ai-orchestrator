/**
 * Codex per-round token ceiling (Oct-2 Phase D Step 1, Decision 16a).
 *
 * A round is everything Codex does for one message, helper threads included.
 * Thresholds count processed tokens (input including cached input, plus
 * output). 0 switches that action off. Harness work and chats are separate so
 * your own chats get the wrap-up request but are never stopped by default.
 */
export interface CodexTurnCeilingSettings {
  codexTurnCeilingHarnessWorkWrapUpTokens: number;
  codexTurnCeilingHarnessWorkStopTokens: number;
  codexTurnCeilingChatsWrapUpTokens: number;
  codexTurnCeilingChatsStopTokens: number;
}

/** Ten billion processed tokens is far beyond any real round; it only bounds typos. */
export const CODEX_TURN_CEILING_MAX_TOKENS = 10_000_000_000;
