/**
 * Google has switched off the Gemini CLI's personal Google sign-in ("Gemini Code Assist for individuals").
 * The CLI still starts, then exits with code 1 and this on stderr (gemini 0.70, seen 21 November 2026):
 *
 *   An unexpected critical error occurred: This client is no longer supported for Gemini Code Assist for
 *   individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google
 *
 * Nothing the person retries changes it, so it is told apart from an ordinary failed turn.
 *
 * This module is shared with the worker computer's build, so it holds no storage of its own. The main process
 * listens through `setGeminiSignInObserver` and keeps the record; a worker computer never listens, so its own
 * Gemini set-up never changes this computer's record.
 */

import type { SurfacedToUserError } from './surfaced-error';

const RETIRED_CLIENT = /no longer supported for Gemini Code Assist/i;

export function isGeminiClientRetiredText(text: string): boolean {
  return RETIRED_CLIENT.test(text);
}

/**
 * The turn failed because Google retired this sign-in. The adapter reports it as an error event,
 * which the transcript shows in plain words, so callers add no "could not be delivered" notice of their own.
 */
export class GeminiClientRetiredError extends Error implements SurfacedToUserError {
  readonly code = 'gemini-retired';
  readonly surfacedToUser = true;

  constructor(detail: string) {
    super(detail);
    this.name = 'GeminiClientRetiredError';
  }
}

/** What a Gemini run on this computer showed: Google's retirement message, or a reply. */
export type GeminiSignInOutcome = 'retired' | 'replied';

let observer: ((outcome: GeminiSignInOutcome) => void) | undefined;

/** Set once by the main process at startup. */
export function setGeminiSignInObserver(next: ((outcome: GeminiSignInOutcome) => void) | undefined): void {
  observer = next;
}

export function reportGeminiSignInOutcome(outcome: GeminiSignInOutcome): void {
  observer?.(outcome);
}
