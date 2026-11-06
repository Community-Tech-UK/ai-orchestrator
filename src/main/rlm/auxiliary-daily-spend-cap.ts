import { computeTokenCost, hasModelRate } from '../../shared/data/model-pricing';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import { reserveAuxiliarySpend } from '../core/system/cost-attribution';
import { getLocalAiAuxiliaryHooks } from '../local-ai-guard/local-ai-auxiliary-bridge';
import { getLogger } from '../logging/logger';
import { getTokenCounter } from './token-counter';

const logger = getLogger('AuxiliaryDailySpendCap');

export interface AuxiliarySpendCapRequest {
  slot: AuxiliaryLlmSlot;
  provider: string;
  endpointId: string;
  model: string;
  maxOutputTokens: number;
  systemPrompt: string;
  userPrompt: string;
  source: 'local' | 'cheap-cloud';
  /**
   * Set only by an explicit user action (Step 7 item 5: "Compact now" is not a
   * helper call and is not capped). The call is recorded, never refused.
   */
  userInitiated?: boolean;
}

/** Stands in for "no ceiling" when a user action's reservation is only being recorded. */
const RECORD_ONLY_CAP_USD = Number.MAX_SAFE_INTEGER;

/**
 * Enforces a per-day cap using conservative pre-dispatch reservations. It is
 * intentionally independent of endpoint routing so it can be unit-tested and
 * changed without making the main auxiliary service larger.
 */
export class AuxiliaryDailySpendCap {
  private capUsd: number | null = null;
  private warningDay = '';
  private readonly warnedReasons = new Set<string>();

  configure(capUsd: number | null): void {
    this.capUsd = Number.isFinite(capUsd) && (capUsd ?? -1) >= 0 ? capUsd : null;
  }

  reserve(request: AuxiliarySpendCapRequest): string | null {
    if (this.capUsd === null || request.source === 'local') return null;
    if (request.userInitiated) return this.recordUserInitiated(request);
    if (!hasModelRate(request.model)) {
      return this.warn(`Auxiliary daily spend cap is active, but ${request.model} has no known price`);
    }

    const amountUsd = this.worstCaseUsd(request);
    const fallbackSpendUsd = getLocalAiAuxiliaryHooks().fallbackSpendTodayUsd?.() ?? 0;
    // An unreadable fallback ledger is unknown spend: refuse, but do not claim the limit was reached.
    if (!Number.isFinite(fallbackSpendUsd)) {
      return this.warn('Auxiliary daily spend cap is active, but today\'s paid fallback spend could not be read');
    }
    const remainingCapUsd = Math.max(0, this.capUsd - fallbackSpendUsd);
    const reservation = reserveAuxiliarySpend({
      // The fallback DB and cost JSONL are separate; a concurrent call may
      // overshoot by one reservation, but both paths enforce the same limit.
      capUsd: remainingCapUsd,
      amountUsd,
      slot: request.slot,
      provider: request.provider,
      endpointId: request.endpointId,
      model: request.model,
    });
    if (reservation.allowed) return null;
    // Refusal can also mean an unavailable reservation store. Only arithmetic
    // exhaustion may claim that the shared daily limit has been reached.
    if (reservation.spentUsd + amountUsd > remainingCapUsd) {
      try { getLocalAiAuxiliaryHooks().helperBudgetExceeded?.(); } catch {
        // A notice failure must never authorize a capped cloud call.
      }
    }
    return this.warn(
      `Auxiliary daily spend cap would be exceeded (${reservation.spentUsd.toFixed(4)} USD already reserved)`,
    );
  }

  /**
   * A user action is never refused by the day's limit, but it still counts toward
   * it so the running total stays truthful. A model with no known price has no
   * amount to record; an unwritable ledger must not turn the action into a refusal.
   */
  private recordUserInitiated(request: AuxiliarySpendCapRequest): null {
    if (!hasModelRate(request.model)) return null;
    try {
      reserveAuxiliarySpend({
        capUsd: RECORD_ONLY_CAP_USD,
        amountUsd: this.worstCaseUsd(request),
        slot: request.slot,
        provider: request.provider,
        endpointId: request.endpointId,
        model: request.model,
      });
    } catch (err) {
      logger.warn('Could not record a user-initiated helper reservation', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  private worstCaseUsd(request: AuxiliarySpendCapRequest): number {
    const tokenCounter = getTokenCounter();
    return computeTokenCost(request.model, {
      inputTokens: tokenCounter.countTokens(request.systemPrompt) + tokenCounter.countTokens(request.userPrompt),
      outputTokens: request.maxOutputTokens,
    });
  }

  private warn(reason: string): string {
    const day = new Date().toISOString().slice(0, 10);
    if (this.warningDay !== day) {
      this.warningDay = day;
      this.warnedReasons.clear();
    }
    if (!this.warnedReasons.has(reason)) {
      this.warnedReasons.add(reason);
      logger.warn(reason, { capUsd: this.capUsd });
    }
    return reason;
  }
}
