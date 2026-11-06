import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { CodexTurnCeilingSettings } from '../../../../shared/types/codex-turn-ceiling-settings.types';

/**
 * Oct-2 Phase D Step 1 (Decision 16a): a ceiling on runaway Codex rounds.
 *
 * A round is everything Codex does for one message, including its helper
 * threads. Processed tokens (input including cached input, plus output) are
 * summed for the root thread and every helper thread.
 *   - At the wrap-up threshold Codex is asked once to wrap up.
 *   - At the stop threshold the round is interrupted, for Harness's own
 *     background work only. Chats get the wrap-up and are never stopped
 *     unless James turns the chat stop threshold on (Decision 16b).
 * A threshold of 0 switches that action off.
 */
export const CODEX_TURN_WRAP_UP_TOKENS = 150_000_000;
export const CODEX_TURN_STOP_TOKENS = 300_000_000;
/** Wrap-up delivery is retried only after a failed request, never after a delivered one. */
const MAX_WRAP_UP_ATTEMPTS = 3;

export type CodexCeilingGroup = 'chat' | 'harness';

export interface CodexTurnCeilingPolicy {
  group: CodexCeilingGroup;
  /** Processed tokens at which Codex is asked to wrap up; 0 = off. */
  wrapUpAt: number;
  /** Processed tokens at which the round is stopped; 0 = off. */
  stopAt: number;
}

export interface CodexTurnCeilingAction {
  /** The round just crossed the stop point. Returned once per round. */
  stop: boolean;
  /**
   * A claim on the one wrap-up request allowed in flight, or null. Settle it with
   * `settleWrapUp`; a claim from an earlier round is ignored.
   */
  wrapUp: number | null;
}

export interface CodexTurnTokenSnapshot {
  turnId: string | null;
  rootTokens: number;
  helperTokens: number;
  totalTokens: number;
  /** Helper tokens as a fraction of the round total (0 when nothing was counted). */
  helperShare: number;
  wrapUpDelivered: boolean;
  stopRequested: boolean;
}

/**
 * Harness's own background work, as named by the plan: plan queue, loops,
 * scheduled jobs and reviews. Ordinary helper children (`child`) belong to the
 * chat or job that started them and are treated like chats here.
 */
export function codexCeilingGroup(kind: SessionKind | undefined): CodexCeilingGroup {
  return kind === 'loop' || kind === 'plan-queue' || kind === 'automation' || kind === 'review' ? 'harness' : 'chat';
}

const threshold = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;

export function resolveCodexTurnCeilingPolicy(
  kind: SessionKind | undefined,
  settings: Partial<CodexTurnCeilingSettings> | undefined,
): CodexTurnCeilingPolicy {
  const group = codexCeilingGroup(kind);
  return group === 'harness'
    ? {
        group,
        wrapUpAt: threshold(settings?.codexTurnCeilingHarnessWorkWrapUpTokens, CODEX_TURN_WRAP_UP_TOKENS),
        stopAt: threshold(settings?.codexTurnCeilingHarnessWorkStopTokens, CODEX_TURN_STOP_TOKENS),
      }
    : {
        group,
        wrapUpAt: threshold(settings?.codexTurnCeilingChatsWrapUpTokens, CODEX_TURN_WRAP_UP_TOKENS),
        // Decision 16a: your own chats are never stopped unless you choose 16b.
        stopAt: threshold(settings?.codexTurnCeilingChatsStopTokens, 0),
      };
}

/** Per-root-turn processed-token counter with one-shot wrap-up and stop triggers. */
export class CodexTurnTokenCeiling {
  private turnId: string | null = null;
  private generation = 0;
  private rootTokens = 0;
  private helperTokens = 0;
  private wrapUpAttempts = 0;
  private wrapUpInFlight = false;
  private wrapUpDelivered = false;
  private stopRequested = false;

  constructor(private policy: CodexTurnCeilingPolicy) {}

  setPolicy(policy: CodexTurnCeilingPolicy): void {
    this.policy = policy;
  }

  getPolicy(): CodexTurnCeilingPolicy {
    return this.policy;
  }

  beginTurn(turnId: string | null): void {
    this.generation += 1;
    this.turnId = turnId;
    this.rootTokens = 0;
    this.helperTokens = 0;
    this.wrapUpAttempts = 0;
    this.wrapUpInFlight = false;
    this.wrapUpDelivered = false;
    this.stopRequested = false;
  }

  /** Adds processed tokens to the round. Counting never fires or consumes an action. */
  record(tokens: number, helper: boolean): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    if (helper) this.helperTokens += tokens;
    else this.rootTokens += tokens;
  }

  /**
   * Decides what the round's current total calls for. The stop is returned once.
   * A wrap-up claim is handed out only when no request is in flight, none was
   * delivered and the bounded attempts are not used up, so samples that arrive
   * while a request is running cannot burn the retries.
   */
  evaluate(): CodexTurnCeilingAction {
    const total = this.rootTokens + this.helperTokens;
    const { stopAt, wrapUpAt } = this.policy;
    if (stopAt > 0 && total >= stopAt && !this.stopRequested) {
      this.stopRequested = true;
      return { stop: true, wrapUp: null };
    }
    const wrapUpDue = wrapUpAt > 0 && total >= wrapUpAt && !this.stopRequested && !this.wrapUpDelivered
      && !this.wrapUpInFlight && this.wrapUpAttempts < MAX_WRAP_UP_ATTEMPTS;
    if (!wrapUpDue) return { stop: false, wrapUp: null };
    this.wrapUpInFlight = true;
    this.wrapUpAttempts += 1;
    return { stop: false, wrapUp: this.generation };
  }

  /**
   * Records how a wrap-up request ended. Returns false, and changes nothing,
   * when the claim belongs to a round that has since been replaced.
   */
  settleWrapUp(claim: number, delivered: boolean): boolean {
    if (claim !== this.generation) return false;
    this.wrapUpInFlight = false;
    if (delivered) this.wrapUpDelivered = true;
    return true;
  }

  snapshot(): CodexTurnTokenSnapshot {
    const totalTokens = this.rootTokens + this.helperTokens;
    return {
      turnId: this.turnId,
      rootTokens: this.rootTokens,
      helperTokens: this.helperTokens,
      totalTokens,
      helperShare: totalTokens > 0 ? this.helperTokens / totalTokens : 0,
      wrapUpDelivered: this.wrapUpDelivered,
      stopRequested: this.stopRequested,
    };
  }
}
