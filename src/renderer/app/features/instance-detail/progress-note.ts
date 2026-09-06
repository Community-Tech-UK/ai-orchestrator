/**
 * Progress notes — assistant messages a provider wrote to its running
 * commentary channel rather than as the turn's answer.
 *
 * Codex's base prompt requires a commentary update at least every 60 seconds
 * during a turn and marks each one `phase: "commentary"`; its own UI collapses
 * them once the final answer lands. The Codex app-server adapter forwards that
 * as `metadata.messagePhase`, so a long turn produced a stack of full-size
 * assistant bubbles here with no way to tell them from the real answer.
 *
 * Anything without a `messagePhase` is a final answer, which keeps every other
 * provider — and older Codex builds that omit the field — rendering unchanged.
 */

import type { OutputMessage } from '../../core/state/instance/instance.types';

export function isProgressNoteMessage(message: OutputMessage | undefined): boolean {
  return message?.type === 'assistant' && message.metadata?.['messagePhase'] === 'commentary';
}
