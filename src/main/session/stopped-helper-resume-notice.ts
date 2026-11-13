/**
 * The notice that tells a resumed conversation which helper agents stopped
 * with the runtime it just left, and how to carry them on instead of starting
 * them again (plan 2026-11-12-usage-burn-followups item 3.2).
 *
 * Pure wording and state helpers, so every delivery route (runtime change,
 * recovery respawn, hibernation wake, restart, continuity revival) shares one
 * phrasing and the wording is unit-testable without lifecycle code. The stored
 * list is one-shot: whichever route delivers first takes it and clears it, so
 * no later resume repeats the notice.
 */

import type { SessionState, StoppedHelper } from './session-continuity.types';

/** What stopped the helpers. Reads into the notice as the cause phrase. */
export type StoppedHelperCause =
  | 'the account switch'
  | 'the provider change'
  | 'the restart'
  | 'hibernation';

function helperCountLine(count: number, cause: StoppedHelperCause): string {
  return `${count} helper agent${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} stopped by ${cause} and did not finish.`;
}

function helperLine(helper: StoppedHelper): string {
  const identity = helper.agentId
    ? `Agent call ${helper.toolUseId}, agent ${helper.agentId}`
    : `Agent call ${helper.toolUseId}`;
  const details: string[] = [`last active ${new Date(helper.lastActivityAt).toISOString()}`];
  if (helper.toolUseCount !== undefined) details.push(`${helper.toolUseCount} tool uses reported`);
  if (helper.transcriptPath) details.push(`transcript ${helper.transcriptPath}`);
  return `- ${identity}: ${details.join(', ')}.`;
}

/**
 * Model-facing notice. Naming the Agent call (tool-use id) lets the resumed
 * model match each line to its own earlier Agent call; the 3.0 experiment
 * proved SendMessage to the agent id continues the helper with its context,
 * so the wording leads with that and falls back to one transcript-reading
 * replacement only when resume refuses.
 */
export function stoppedHelperNoticeText(helpers: StoppedHelper[], cause: StoppedHelperCause): string {
  return [
    `[System: ${helperCountLine(helpers.length, cause)} Continue each stopped helper where it left off instead of starting a fresh copy.`,
    ...helpers.map(helperLine),
    "Continue a helper by sending SendMessage to its agent id; the helper's context is saved in the transcript above. If SendMessage cannot resume a helper, start exactly one replacement that first reads that transcript and checks the files the helper changed. Helpers that already finished need nothing; do not start those again.]",
  ].join('\n');
}

/** The short line James reads in the conversation. */
export function stoppedHelperUserText(count: number, cause: StoppedHelperCause): string {
  return `${count} helper agent${count === 1 ? ' was' : 's were'} stopped by ${cause}; the session was told to carry them on.`;
}

/**
 * One-shot read of the stored list: clears `state.stoppedHelpers` as it takes
 * it, so the same helpers are never announced twice. Mutates the given state
 * in place — for tracked state that is exactly the persistence mechanism.
 */
export function takeStoppedHelpersFromState(state: SessionState): StoppedHelper[] {
  const helpers = state.stoppedHelpers ?? [];
  if (helpers.length === 0) return [];
  state.stoppedHelpers = [];
  return helpers;
}

/** Structurally compatible with `RuntimeChangeNotice` without a cross-layer import. */
export interface StoppedHelperResumeNotice {
  text: string;
  userText: string;
  kind: 'stopped-helpers';
}

/** Announce-and-render pair for delivery routes that carry both texts. */
export function stoppedHelperResumeNotices(
  helpers: StoppedHelper[],
  cause: StoppedHelperCause,
): StoppedHelperResumeNotice[] {
  if (helpers.length === 0) return [];
  return [{
    text: stoppedHelperNoticeText(helpers, cause),
    userText: stoppedHelperUserText(helpers.length, cause),
    kind: 'stopped-helpers',
  }];
}
