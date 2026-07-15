import { computeTokenCost, hasModelRate } from '../../shared/data/model-pricing';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import { reserveAuxiliarySpend } from '../core/system/cost-attribution';
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
}

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
    if (!hasModelRate(request.model)) {
      return this.warn(`Auxiliary daily spend cap is active, but ${request.model} has no known price`);
    }

    const tokenCounter = getTokenCounter();
    const amountUsd = computeTokenCost(request.model, {
      inputTokens: tokenCounter.countTokens(request.systemPrompt) + tokenCounter.countTokens(request.userPrompt),
      outputTokens: request.maxOutputTokens,
    });
    const reservation = reserveAuxiliarySpend({
      capUsd: this.capUsd,
      amountUsd,
      slot: request.slot,
      provider: request.provider,
      endpointId: request.endpointId,
      model: request.model,
    });
    if (reservation.allowed) return null;
    return this.warn(
      `Auxiliary daily spend cap would be exceeded (${reservation.spentUsd.toFixed(4)} USD already reserved)`,
    );
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
