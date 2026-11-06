/**
 * What a change that restarts a session will cost, in plain words (Oct-2 T17).
 *
 * Seven kinds of change tear a session down. What the person pays depends on how the session
 * comes back: by native resume (the provider reads the whole conversation again, and a
 * different model or account starts with an empty cache) or by replay (a new session gets a
 * short digest, so the cost is small and the loss is the point). This turns the diff and the
 * continuity the main process will really use into one sentence, shown before the change is made.
 */

import { formatApproxTokens } from './claude-cache-economics';
import { REPLAY_MAX_TURNS, replayCarryover } from './replay-carryover';

/** The change flags of `computeRuntimeDiff`. */
export interface RuntimeChangeFlags {
  providerChanged: boolean;
  modelChanged: boolean;
  reasoningChanged: boolean;
  runtimeTargetChanged: boolean;
  yoloModeChanged: boolean;
  copilotAccountChanged: boolean;
  accountProfileChanged: boolean;
}

/** How the conversation survives the restart; the values of the main process's `ContinuityPlan`. */
export type RuntimeContinuity = 'replay' | 'native-resume' | 'native-resume-fork';

export type RuntimeChangeKind =
  | 'provider' | 'local-model' | 'copilot-account' | 'model' | 'account' | 'reasoning' | 'auto-approve';

/** Ask before a change whose next message re-reads at least this much at full price. */
export const LARGE_RESEND_TOKENS = 100_000;
/** Ask before a replay that leaves at least this much of the conversation behind: that is lost context, not a bill. */
export const LARGE_REPLAY_DROPPED_TOKENS = 100_000;

export interface RuntimeChangeCostOptions {
  continuity: RuntimeContinuity;
  /** The target model's context window, when known. */
  targetWindowTokens?: number | null;
  /** The provider or model the session moves to, for the sentence ("Codex"). */
  targetLabel?: string;
  /** False when the prompt cache has already expired, so a full re-read happens either way. */
  cacheWarm?: boolean;
}

export interface RuntimeChangeCostNote {
  kind: RuntimeChangeKind;
  /** One plain sentence, ready to show. */
  text: string;
  /** What the next message re-reads at full price; null when the change does not cause that. */
  resendTokens: number | null;
  /** On a replay: the most the new session can start with, and so the least it leaves behind. */
  carriedTokens: number | null;
  droppedTokens: number | null;
  /** Big enough to ask first: a large re-read at full price, or a large part of the conversation left behind by a replay. */
  large: boolean;
}

const SUBJECT: Record<RuntimeChangeKind, string> = {
  provider: 'Switching provider',
  'local-model': 'Switching to a local model',
  'copilot-account': 'Switching Copilot account',
  model: 'Switching model',
  account: 'Switching account',
  reasoning: 'Changing thinking effort',
  'auto-approve': 'Changing auto-approve',
};

/** The kind that decides the wording when several flags change at once (a provider switch also changes the model). */
export function runtimeChangeKind(diff: RuntimeChangeFlags): RuntimeChangeKind | null {
  if (diff.providerChanged) return 'provider';
  if (diff.runtimeTargetChanged) return 'local-model';
  if (diff.copilotAccountChanged) return 'copilot-account';
  if (diff.modelChanged) return 'model';
  if (diff.accountProfileChanged) return 'account';
  if (diff.reasoningChanged) return 'reasoning';
  if (diff.yoloModeChanged) return 'auto-approve';
  return null;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function windowClause(carriedTokens: number, windowTokens: number | null | undefined, label: string | undefined): string {
  if (!windowTokens || windowTokens <= 0) return '';
  const target = label ? `${label}'s` : 'its';
  const share = carriedTokens / windowTokens;
  if (share > 0.5) return `, which may not fit ${target} ${formatApproxTokens(windowTokens)} window`;
  const percent = share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`;
  return `, ${percent} of ${target} ${formatApproxTokens(windowTokens)} window`;
}

/**
 * Zero or one sentence for the change. `contextTokens` is what the session holds now (null when
 * the provider has not said); `idle` is false while a reply is running, in which case the change
 * waits for the reply to finish.
 */
export function describeRuntimeChangeCost(
  diff: RuntimeChangeFlags,
  contextTokens: number | null | undefined,
  idle: boolean,
  options: RuntimeChangeCostOptions,
): RuntimeChangeCostNote | null {
  const kind = runtimeChangeKind(diff);
  if (!kind) return null;
  const known = typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0
    ? Math.round(contextTokens) : null;
  const lead = idle ? SUBJECT[kind] : `Once the current reply finishes, ${lowerFirst(SUBJECT[kind])}`;

  if (options.continuity === 'replay') {
    const { carriedTokens, droppedTokens } = known === null
      ? { carriedTokens: null, droppedTokens: null } : replayCarryover(known);
    // The digest's total budget is an upper bound, not a lossless guarantee:
    // individual messages, older turns and tool results can still be omitted.
    const kept = `your first request, the last ${REPLAY_MAX_TURNS} messages and open to-dos`;
    const size = carriedTokens === null || known === null ? ''
      : `: up to ${formatApproxTokens(carriedTokens)} of the ${formatApproxTokens(known)} tokens here${windowClause(carriedTokens, options.targetWindowTokens, options.targetLabel)}`;
    return {
      kind,
      text: `${lead} starts a new session with a short summary of this one (${kept}${size}); the rest does not carry over.`,
      resendTokens: null,
      carriedTokens,
      droppedTokens,
      // `droppedTokens` is the least that is left behind, so this never asks without cause. It can stay quiet for
      // a session up to one digest (about 9K tokens) below the line, where the real loss may already pass it.
      large: droppedTokens !== null && droppedTokens >= LARGE_REPLAY_DROPPED_TOKENS,
    };
  }

  // Native resume keeps the conversation. Only a different model or account makes the next message
  // read it all again from an empty cache; the other kinds resume with their cache intact.
  if (known === null || options.cacheWarm === false || (kind !== 'model' && kind !== 'account')) return null;
  return {
    kind,
    text: `${lead} restarts this session, and the next message will re-read about ${formatApproxTokens(known)} tokens at full price.`,
    resendTokens: known,
    carriedTokens: null,
    droppedTokens: null,
    large: known >= LARGE_RESEND_TOKENS,
  };
}
