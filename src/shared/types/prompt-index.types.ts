/**
 * Session user-prompt index types.
 *
 * The transcript jump rail shows one tick per user prompt in the SESSION, not
 * just the renderer's bounded message window. The main process keeps a running
 * tally of prompts alongside the output-storage index and serves it via the
 * `instance:get-prompt-index` IPC channel.
 */

/** Lightweight reference to a user prompt in a session. */
export interface UserPromptRef {
  /** OutputMessage id of the user message. */
  id: string;
  timestamp: number;
  /** Single-line excerpt of the prompt (bounded length). */
  excerpt: string;
}
