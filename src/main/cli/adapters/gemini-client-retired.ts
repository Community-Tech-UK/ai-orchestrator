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

import { presentError } from '../../../shared/present-error';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { redactSecrets } from '../../security/secret-detector';
import type { EventEmitter } from 'events';
import type { SurfacedToUserError } from './surfaced-error';

const RETIRED_CLIENT = /no longer supported for Gemini Code Assist/i;

export function isGeminiClientRetiredText(text: string): boolean {
  return RETIRED_CLIENT.test(text);
}

/**
 * The turn failed because Google retired this sign-in. The adapter writes one plain transcript line for it
 * (`geminiRetiredOutput`) as well as raising the error event, so callers add no "could not be delivered" notice.
 */
export class GeminiClientRetiredError extends Error implements SurfacedToUserError {
  readonly code = 'gemini-retired';
  readonly surfacedToUser = true;

  constructor(detail: string) {
    super(detail);
    this.name = 'GeminiClientRetiredError';
  }
}

/**
 * The one transcript line for a retired sign-in: plain words, with Google's text kept under Details. A worker
 * computer passes on only transcript lines, and here the error event matches this line by that text and adds nothing.
 */
export function geminiRetiredOutput(error: GeminiClientRetiredError): OutputMessage {
  const errorPresentation = presentError(error, { provider: 'gemini' });
  // The stderr chunk can carry other lines besides Google's; Details never shows a secret from them.
  errorPresentation.rawDetail = redactSecrets(errorPresentation.rawDetail);
  return {
    id: generateId(), timestamp: Date.now(), type: 'error',
    content: `${errorPresentation.headline} ${errorPresentation.whatToDo}`,
    metadata: { errorPresentation },
  };
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

/** Ends a turn that failed on the retired sign-in, for a runner that has no promise of its own to reject. */
export function emitRetiredGeminiTurn(emitter: EventEmitter, error: GeminiClientRetiredError): void {
  reportGeminiSignInOutcome('retired');
  emitter.emit('output', geminiRetiredOutput(error));
  if (emitter.listenerCount('error') > 0) emitter.emit('error', error);
}

/** Whether a transcript line is the plain retirement line `geminiRetiredOutput` writes. */
export function isGeminiRetiredLine(message: OutputMessage): boolean {
  const presentation = message.metadata?.['errorPresentation'];
  return typeof presentation === 'object' && presentation !== null
    && (presentation as { category?: unknown }).category === 'gemini-retired';
}

/**
 * A worker computer's failed send, for a worker that sends the plain retirement line itself (`isGeminiRetiredLine`).
 * The failure is marked as shown, so no "could not be delivered" notice is added on top. The class does not survive
 * the wire, and without the "RPC error <code>: " lead the text is the same real reason that line keeps under Details.
 * Any other failure is returned unchanged. A worker on older code sends no such line, so its notice still shows.
 */
export function asShownWorkerGeminiRetirement(error: unknown): unknown {
  if (!(error instanceof Error) || !isGeminiClientRetiredText(error.message)) return error;
  return new GeminiClientRetiredError(error.message.replace(/^RPC error -?\d+: /, ''));
}
