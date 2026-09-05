import type { CliUsage } from '../base-cli-adapter';
import { computeTokenCost } from '../../../../shared/data/model-pricing';
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
  private turn = empty();
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

  observe(threadId: string, total?: Record<string, unknown>, last?: Record<string, unknown>, child = false): void {
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
      } else if (!prior && this.resumed.has(threadId)) {
        // Only the latest call is attributable when resume supplied no baseline.
        delta = call && this.lastOnly.get(threadId) !== JSON.stringify(call) ? call.raw : empty();
        gross = delta.inputTokens + delta.outputTokens;
        this.estimated = true;
      } else {
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
    this.add(threadId, delta, gross, child);
  }

  fallback(threadId: string, usage?: Record<string, unknown>, child = false, turnId?: string): void {
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
    const delta = empty();
    for (const key of keys) delta[key] = Math.max(0, current.raw[key] - counted[key] + (baseline?.raw[key] ?? 0));
    const prior = this.previous.get(threadId);
    const gross = Math.max(0, current.total - (this.totalByThread.get(threadId) ?? 0) + (baseline?.gross ?? 0));
    if (gross === 0 && keys.every(key => delta[key] === 0)) return;
    // Extend the latest thread baseline only by the uncounted native-turn remainder.
    if (prior || !this.resumed.has(threadId)) {
      const raw = empty();
      for (const key of keys) raw[key] = (prior?.raw[key] ?? 0) + (this.provisional.get(threadId)?.[key] ?? 0) + delta[key];
      this.previous.set(threadId, { raw, total: (prior?.total ?? 0) + gross, detailed: true });
      this.provisional.delete(threadId);
    }
    this.add(threadId, delta, gross, child);
  }

  peek(model: string | undefined): CliUsage | undefined {
    if (!this.pending) return undefined;
    const usage = disjointCodexUsage(this.turn);
    return { ...usage, totalTokens: this.turn.inputTokens + this.turn.outputTokens, cost: computeTokenCost(model, usage), ...(this.estimated ? { isEstimated: true } : {}) };
  }

  ownsThread(threadId: string): boolean { return this.ownedThreads.has(threadId); }
  trackThread(threadId: string): void { this.ownedThreads.add(threadId); }

  take(model: string | undefined): CliUsage | undefined {
    const usage = this.peek(model);
    this.pending = false;
    this.estimated = false;
    this.turn = empty();
    return usage;
  }

  private add(threadId: string, delta: CodexTurnUsageBreakdown, gross: number, child: boolean): void {
    const thread = this.accountedByThread.get(threadId) ?? empty();
    for (const key of keys) { this.turn[key] += delta[key]; thread[key] += delta[key]; }
    this.accountedByThread.set(threadId, thread);
    this.totalByThread.set(threadId, (this.totalByThread.get(threadId) ?? 0) + gross);
    this.cumulativeTokens += gross;
    if (delta.inputTokens + delta.outputTokens > 0) this.pending = true;
    // Native child model/tier is not guaranteed to match the root configuration.
    if (child && gross > 0) this.estimated = true;
  }

  private addProvisional(threadId: string, delta: CodexTurnUsageBreakdown): void {
    const pending = this.provisional.get(threadId) ?? empty();
    for (const key of keys) pending[key] += delta[key];
    this.provisional.set(threadId, pending);
  }
}
