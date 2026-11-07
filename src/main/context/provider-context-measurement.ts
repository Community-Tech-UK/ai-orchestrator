import type { ClaudeControlReply } from '../cli/adapters/claude-control-channel';
import type { ContextAttributionReport } from '../../shared/types/context-attribution.types';
import type { ContextProviderMeasurement } from '../../shared/types/provider-measured-context.types';
import { mapClaudeContextUsage } from './claude-context-usage';
import { buildContextAdvice, contextAdviceEstimate } from './context-advice';
import { getCacheAnalyticsService } from './cache-analytics-service';

interface MeasurementInstance { id: string; sessionId: string; requestCount: number; restartEpoch: number;
  adapterGeneration?: number; parentId?: string | null; metadata?: Record<string, unknown> }
interface MeasurementAdapter { requestContextUsage?: () => Promise<ClaudeControlReply> }
/** Cache and coalesce token-count requests; only the panel initiates them. */
export class ProviderContextMeasurementService {
  private readonly cache = new Map<string, { stamp: string; reply: Promise<ContextProviderMeasurement> }>();
  measure(instance: MeasurementInstance, adapter: MeasurementAdapter | undefined,
    estimate: () => Promise<ContextAttributionReport>): Promise<ContextProviderMeasurement> {
    const stamp = `${instance.sessionId}:${instance.requestCount}:${instance.restartEpoch}:${instance.adapterGeneration}`;
    const prior = this.cache.get(instance.id);
    if (prior?.stamp === stamp) return prior.reply;
    const reply = this.query(instance, adapter, estimate);
    this.cache.delete(instance.id); this.cache.set(instance.id, { stamp, reply });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return reply;
  }
  private async query(instance: MeasurementInstance, adapter: MeasurementAdapter | undefined,
    estimate: () => Promise<ContextAttributionReport>): Promise<ContextProviderMeasurement> {
    let status: Exclude<ContextProviderMeasurement['status'], 'measured'> = adapter ? 'not-supported' : 'not-running';
    const lastRewrite = getCacheAnalyticsService().getReport(instance.id).lastBreak;
    const facts = { instance, ...(lastRewrite?.cause && lastRewrite.missedTokens !== undefined
      ? { cacheRewrite: { cause: lastRewrite.cause, missedTokens: lastRewrite.missedTokens } } : {}) };
    if (typeof adapter?.requestContextUsage === 'function') {
      try {
        const reply = await adapter.requestContextUsage();
        if (reply.ok) {
          const measured = mapClaudeContextUsage(reply.payload);
          if (measured) return { status: 'measured', measured, advice: buildContextAdvice(measured, facts) };
          status = 'error';
        } else status = reply.code === 'timeout' || reply.code === 'not-running' ? reply.code : 'error';
      } catch { status = 'error'; }
    }
    try { return { status, advice: buildContextAdvice(contextAdviceEstimate(await estimate()), facts) }; }
    catch { return { status, advice: [] }; }
  }
}
