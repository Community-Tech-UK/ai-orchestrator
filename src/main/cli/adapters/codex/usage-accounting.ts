import type { CodexUsageTokens } from '../../../../shared/types/codex-ephemeral-usage.types';
import type { CliUsage } from '../base-cli-adapter';
import { computeTokenCost, CODEX_LONG_PROMPT_THRESHOLD } from '../../../../shared/data/model-pricing';
import { disjointCodexUsage, resolveCodexTurnUsageBreakdown, tokenCount, type CodexTurnUsageBreakdown } from './token-usage-breakdown';

const empty = (): CodexTurnUsageBreakdown => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 });
const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens'] as const;
interface Snapshot { raw: CodexTurnUsageBreakdown; total: number; detailed: boolean }
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function snapshot(value: Record<string, unknown> | undefined): Snapshot | undefined {
  if (!value) return undefined;
  const input = value['inputTokens'] ?? value['input_tokens'];
  const output = value['outputTokens'] ?? value['output_tokens'];
  const total = value['totalTokens'] ?? value['total_tokens'];
  // Malformed fields must never replace a known cumulative baseline.
  if ([input, output, total].some(field => field !== undefined && !valid(field))) return undefined;
  const detailed = valid(input) && valid(output);
  if (!detailed && !valid(total)) return undefined;
  const raw = resolveCodexTurnUsageBreakdown(value);
  return { raw, total: tokenCount(total) || raw.inputTokens + raw.outputTokens, detailed };
}

/** Native thread counters are independent. Cache/reasoning remain subsets until pricing. */
export class CodexUsageAccounting {
  private readonly previous = new Map<string, Snapshot>();
  private readonly ownedThreads = new Set<string>();
  private readonly provisional = new Map<string, CodexTurnUsageBreakdown>();
  private readonly resumed = new Set<string>();
  private readonly accountedByThread = new Map<string, CodexTurnUsageBreakdown>();
  private readonly totalByThread = new Map<string, number>();
  private readonly nativeTurnBaselines = new Map<string, { raw: CodexTurnUsageBreakdown; gross: number }>();
  private readonly nativeTurnIds = new Map<string, string>();
  private readonly completedNativeTurns = new Map<string, Set<string>>();
  private readonly lastOnly = new Map<string, string>();
  private readonly interruptedEstimates = new Map<string, { output: number; turnId?: string }[]>();
  private readonly settledInterruptedTurns = new Map<string, Set<string>>();
  private readonly evidence = new Map<string, Set<keyof CodexUsageTokens>>();
  private readonly outputEstimateThreads = new Set<string>();
  private readonly estimatedThreads = new Set<string>();
  private turn = empty();
  private longPromptTurn = empty();
  private estimated = false;
  private pending = false;
  cumulativeTokens = 0;

  beginTurn(threadId: string, resumed = false): void {
    this.ownedThreads.add(threadId);
    // Root charge boundaries do not end native child turns or erase their receipts.
    this.nativeTurnIds.delete(threadId);
    this.beginNativeTurn(threadId);
    if (this.previous.has(threadId)) this.lastOnly.delete(threadId);
    if (resumed && !this.previous.has(threadId)) this.resumed.add(threadId);
  }

  seed(threadId: string, total: Record<string, unknown>): void {
    const baseline = snapshot(total);
    if (!baseline) return;
    this.previous.set(threadId, baseline);
    this.provisional.delete(threadId);
    this.resumed.delete(threadId);
  }

  beginNativeTurn(threadId: string, turnId?: string): void {
    this.ownedThreads.add(threadId);
    if (turnId && (this.nativeTurnIds.get(threadId) === turnId || this.completedNativeTurns.get(threadId)?.has(turnId))) return;
    if (turnId) {
      this.nativeTurnIds.set(threadId, turnId);
      // A distinct native turn makes an identical last-only call attributable again.
      this.lastOnly.delete(threadId);
    }
    this.nativeTurnBaselines.set(threadId, {
      raw: { ...(this.accountedByThread.get(threadId) ?? empty()) },
      gross: this.totalByThread.get(threadId) ?? 0,
    });
  }

  observe(threadId: string, total?: Record<string, unknown>, last?: Record<string, unknown>, child = false, requestContextWindow?: number): void {
    this.ownedThreads.add(threadId);
    const current = snapshot(total);
    const call = snapshot(last);
    const prior = this.previous.get(threadId);
    let delta = empty();
    let gross = 0;
    if (current) {
      const reset = prior && (current.total < prior.total || current.detailed && prior.detailed
        && (current.raw.inputTokens < prior.raw.inputTokens || current.raw.outputTokens < prior.raw.outputTokens));
      if (prior && !reset) {
        if (current.detailed && prior.detailed) {
          for (const key of keys) delta[key] = Math.max(0, current.raw[key] - prior.raw[key] - (this.provisional.get(threadId)?.[key] ?? 0));
        } else {
          delta = current.total > prior.total ? call?.raw ?? empty() : empty();
          this.estimated = true;
        }
        gross = Math.max(0, current.total - prior.total);
        if (current.detailed && prior.detailed) {
          const estimates = this.interruptedEstimates.get(threadId);
          if (estimates?.length) {
            const nativeTurnId = this.nativeTurnIds.get(threadId);
            const sameTurn = nativeTurnId !== undefined && estimates.some(estimate => estimate.turnId === nativeTurnId);
            const unreportedOutput = sameTurn
              ? delta.outputTokens
              : call?.detailed ? Math.max(0, delta.outputTokens - call.raw.outputTokens) : 0;
            const credit = this.consumeInterruptedEstimate(threadId, unreportedOutput, sameTurn ? nativeTurnId : undefined);
            delta.outputTokens -= credit;
            gross = Math.max(0, gross - credit);
          }
        }
      } else if (!prior && this.resumed.has(threadId)) {
        // Only the latest call is attributable when resume supplied no baseline.
        delta = call && this.lastOnly.get(threadId) !== JSON.stringify(call) ? call.raw : empty();
        gross = delta.inputTokens + delta.outputTokens;
        this.estimated = true;
      } else {
        if (reset) this.interruptedEstimates.delete(threadId);
        delta = current.raw;
        gross = current.total;
      }
      if (!current.detailed && prior?.detailed && !reset) {
        this.previous.set(threadId, { ...prior, total: current.total });
      } else {
        this.previous.set(threadId, current);
        if (current.detailed) this.provisional.delete(threadId);
      }
      this.resumed.delete(threadId);
      if (gross > 0 && delta.inputTokens + delta.outputTokens === 0 && call) {
        if (!current.detailed) delta = call.raw;
        this.estimated = true;
      }
      if (!current.detailed && prior?.detailed) this.addProvisional(threadId, delta);
    } else if (call) {
      // Without cumulative identity, identical calls and repeated snapshots are ambiguous.
      const fingerprint = JSON.stringify(call);
      if (this.lastOnly.get(threadId) === fingerprint) return;
      this.lastOnly.set(threadId, fingerprint);
      delta = call.raw;
      gross = delta.inputTokens + delta.outputTokens;
      this.estimated = true;
      if (prior?.detailed) {
        this.addProvisional(threadId, delta);
        this.previous.set(threadId, { ...prior, total: prior.total + gross });
      } else if (!prior && !this.resumed.has(threadId)) {
        // Fresh threads have a known zero origin even before the first total.
        this.addProvisional(threadId, delta);
        this.previous.set(threadId, { raw: empty(), total: gross, detailed: true });
      }
    }
    this.noteEvidence(threadId, current?.detailed ? total : call ? last : current ? total : undefined);
    this.add(threadId, delta, gross, child, call?.detailed ? call.raw : undefined, requestContextWindow);
  }

  fallback(threadId: string, usage?: Record<string, unknown>, child = false, turnId?: string): void {
    if (turnId && this.settledInterruptedTurns.get(threadId)?.has(turnId)) return;
    const current = snapshot(usage);
    if (!current?.detailed || turnId && this.completedNativeTurns.get(threadId)?.has(turnId)) return;
    if (turnId) {
      const nativeId = this.nativeTurnIds.get(threadId);
      if (nativeId && nativeId !== turnId) this.beginNativeTurn(threadId, turnId);
      else this.nativeTurnIds.set(threadId, turnId);
      const completed = this.completedNativeTurns.get(threadId) ?? new Set<string>();
      completed.add(turnId);
      this.completedNativeTurns.set(threadId, completed);
    }
    const counted = this.accountedByThread.get(threadId) ?? empty();
    const baseline = this.nativeTurnBaselines.get(threadId);
    const estimate = this.interruptedEstimates.get(threadId)?.find(entry => turnId && entry.turnId === turnId);
    const estimateCredit = estimate
      ? Math.min(estimate.output, current.raw.outputTokens)
      : 0;
    const delta = empty();
    for (const key of keys) delta[key] = Math.max(0, current.raw[key] - counted[key] + (baseline?.raw[key] ?? 0));
    const prior = this.previous.get(threadId);
    const gross = Math.max(0, current.total - (this.totalByThread.get(threadId) ?? 0) + (baseline?.gross ?? 0));
    if (gross === 0 && keys.every(key => delta[key] === 0) && estimateCredit === 0) return;
    // Extend the latest thread baseline only by the uncounted native-turn remainder.
    if (prior || !this.resumed.has(threadId)) {
      const raw = empty();
      for (const key of keys) raw[key] = (prior?.raw[key] ?? 0) + (this.provisional.get(threadId)?.[key] ?? 0) + delta[key]
        + (key === 'outputTokens' ? estimateCredit : 0);
      this.previous.set(threadId, { raw, total: (prior?.total ?? 0) + gross + estimateCredit, detailed: true });
      this.provisional.delete(threadId);
    }
    if (estimate && turnId) this.removeInterruptedEstimate(threadId, turnId);
    this.noteEvidence(threadId, usage);
    this.add(threadId, delta, gross, child);
  }

  /** Approximate output when Codex aborts after streaming but reports no new usage. */
  estimateInterruptedOutput(threadId: string, streamedCharacters: number): void {
    if (!Number.isFinite(streamedCharacters) || streamedCharacters <= 0) return;
    const nativeTurnId = this.nativeTurnIds.get(threadId);
    if (nativeTurnId && this.interruptedEstimates.get(threadId)?.some(estimate => estimate.turnId === nativeTurnId)) return;
    const output = Math.ceil(streamedCharacters / 4);
    const delta = { ...empty(), outputTokens: output };
    const estimates = this.interruptedEstimates.get(threadId) ?? [];
    estimates.push({ output, turnId: nativeTurnId });
    this.interruptedEstimates.set(threadId, estimates);
    this.estimatedThreads.add(threadId);
    this.outputEstimateThreads.add(threadId);
    this.add(threadId, delta, output, false);
    this.estimated = true;
  }

  peek(model: string | undefined): CliUsage | undefined {
    if (!this.pending) return undefined;
    const usage = disjointCodexUsage(this.turn);
    const long = disjointCodexUsage(this.longPromptTurn);
    // A large turn aggregate proves no request size. Only native last samples
    // enter this bucket; base pricing remains valid across mixed-size requests.
    const premium = computeTokenCost(model, { ...long, requestInputTokens: CODEX_LONG_PROMPT_THRESHOLD + 1 }) - computeTokenCost(model, long);
    return { ...usage, totalTokens: this.turn.inputTokens + this.turn.outputTokens, cost: computeTokenCost(model, usage) + premium, ...(this.estimated ? { isEstimated: true } : {}) };
  }

  ownsThread(threadId: string): boolean { return this.ownedThreads.has(threadId); }
  hasThreadSnapshot(threadId: string): boolean { return this.previous.has(threadId); }
  trackThread(threadId: string): void { this.ownedThreads.add(threadId); }

  accountedThreadIds(): string[] { return [...this.accountedByThread.keys()]; }
  ownedThreadIds(): string[] { return [...this.ownedThreads]; }
  clearOwnership(): void { this.ownedThreads.clear(); }

  /** Cumulative native subsets, independent of per-turn take()/peek() drains. */
  threadTokens(threadId: string): CodexUsageTokens {
    const raw = this.accountedByThread.get(threadId) ?? empty();
    const evidence = this.evidence.get(threadId);
    const estimated = this.estimatedThreads.has(threadId);
    return {
      input: evidence?.has('input') ? raw.inputTokens : null,
      cache: evidence?.has('cache') ? Math.min(raw.inputTokens, raw.cacheReadTokens) : null,
      output: evidence?.has('output') || this.outputEstimateThreads.has(threadId) ? raw.outputTokens : null,
      reasoning: evidence?.has('reasoning') ? Math.min(raw.outputTokens, raw.reasoningTokens) : null,
      total: evidence?.has('total') || this.outputEstimateThreads.has(threadId) ? this.totalByThread.get(threadId) ?? 0 : null,
      estimated,
    };
  }

  private noteEvidence(threadId: string, usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const fields = new Set<keyof CodexUsageTokens>();
    if (valid(usage['inputTokens'] ?? usage['input_tokens'])) fields.add('input');
    if (valid(usage['outputTokens'] ?? usage['output_tokens'])) fields.add('output');
    if (valid(usage['cachedInputTokens'] ?? usage['cached_input_tokens'])) fields.add('cache');
    if (valid(usage['reasoningOutputTokens'] ?? usage['reasoning_output_tokens'])) fields.add('reasoning');
    if (valid(usage['totalTokens'] ?? usage['total_tokens']) || fields.has('input') && fields.has('output')) fields.add('total');
    const previous = this.evidence.get(threadId);
    this.evidence.set(threadId, previous ? new Set([...previous].filter(key => fields.has(key))) : fields);
  }

  take(model: string | undefined): CliUsage | undefined {
    const usage = this.peek(model);
    this.pending = false;
    this.estimated = false;
    this.turn = empty();
    this.longPromptTurn = empty();
    return usage;
  }

  private add(threadId: string, delta: CodexTurnUsageBreakdown, gross: number, child: boolean, call?: CodexTurnUsageBreakdown, requestContextWindow?: number): void {
    // Some CLI versions put a multicall aggregate in `last`. A request must
    // fit the window reported by that thread; an absent window proves no size.
    const requestSized = valid(requestContextWindow) && requestContextWindow > 0 && call
      && call.inputTokens + call.outputTokens <= requestContextWindow;
    if (call && call.inputTokens > CODEX_LONG_PROMPT_THRESHOLD && gross > 0 && !requestSized) this.estimated = true;
    if (call && call.inputTokens > CODEX_LONG_PROMPT_THRESHOLD && gross > 0 && requestSized) {
      // Coalesced notifications cannot price older requests exactly. Retain
      // only the identifiable last request and mark the remainder estimated.
      const input = Math.min(delta.inputTokens, call.inputTokens);
      const output = Math.min(delta.outputTokens, call.outputTokens);
      this.longPromptTurn.inputTokens += input;
      this.longPromptTurn.outputTokens += output;
      this.longPromptTurn.cacheReadTokens += Math.min(input, delta.cacheReadTokens, call.cacheReadTokens);
      this.longPromptTurn.reasoningTokens += Math.min(output, delta.reasoningTokens, call.reasoningTokens);
    }
    if (gross > 0 && (!call || keys.some(key => delta[key] !== call[key]))) this.estimated = true;
    const thread = this.accountedByThread.get(threadId) ?? empty();
    for (const key of keys) { this.turn[key] += delta[key]; thread[key] += delta[key]; }
    this.accountedByThread.set(threadId, thread);
    this.totalByThread.set(threadId, (this.totalByThread.get(threadId) ?? 0) + gross);
    this.cumulativeTokens += gross;
    if (delta.inputTokens + delta.outputTokens > 0) this.pending = true;
    if (this.estimated) this.estimatedThreads.add(threadId);
    // Native child model/tier is not guaranteed to match the root configuration.
    if (child && gross > 0) this.estimated = true;
  }

  private addProvisional(threadId: string, delta: CodexTurnUsageBreakdown): void {
    const pending = this.provisional.get(threadId) ?? empty();
    for (const key of keys) pending[key] += delta[key];
    this.provisional.set(threadId, pending);
  }

  private consumeInterruptedEstimate(threadId: string, available: number, onlyTurnId?: string): number {
    const estimates = this.interruptedEstimates.get(threadId);
    if (!estimates || available <= 0) return 0;
    let remaining = available;
    for (const estimate of estimates) {
      if (onlyTurnId && estimate.turnId !== onlyTurnId) continue;
      const credit = Math.min(estimate.output, remaining);
      estimate.output -= credit;
      remaining -= credit;
      if (credit > 0 && !onlyTurnId && estimate.turnId) {
        const settled = this.settledInterruptedTurns.get(threadId) ?? new Set<string>();
        settled.add(estimate.turnId);
        this.settledInterruptedTurns.set(threadId, settled);
      }
      if (remaining === 0) break;
    }
    const pending = estimates.filter(estimate => estimate.output > 0);
    if (pending.length) this.interruptedEstimates.set(threadId, pending);
    else this.interruptedEstimates.delete(threadId);
    return available - remaining;
  }

  private removeInterruptedEstimate(threadId: string, turnId: string): void {
    const pending = this.interruptedEstimates.get(threadId)?.filter(estimate => estimate.turnId !== turnId);
    if (pending?.length) this.interruptedEstimates.set(threadId, pending);
    else this.interruptedEstimates.delete(threadId);
  }
}
