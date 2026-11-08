import { scheduleAutomationDeadline } from './automation-deadline-timer';
import { automationRunDeadline } from './automation-run-clock';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { withRunLimits } from './automation-run-policy';
import { monitorAssistantOutput, writeFullOutput, type RunTracking } from './automation-runner-helpers';

interface LoopLimit {
  run: AutomationRun;
  deadline: number;
  minutes: number;
  cap: number;
  processedTokens: number;
  timer: () => void;
  output: RunTracking;
}
/** Loop adapters publish builder events under the synthetic automation chat id; gate calls carry the loop correlation id. */
export class AutomationLoopRunLimits {
  private readonly limits = new Map<string, LoopLimit>();
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly now: () => number,
    private readonly fail: (loopId: string, reason: string, output: { summary?: string; fullRef?: string }) => void,
    private readonly recordUsage: (runId: string, instanceId: string, source: 'provider' | 'attributed', tokens: number) => number) {}
  track(loopId: string, run: AutomationRun): void {
    if (!run.configSnapshot) return;
    this.clear(loopId);
    const action = withRunLimits(run.configSnapshot.action, run.configSnapshot.schedule);
    const deadline = automationRunDeadline(run, action.maxRunMinutes!, this.now());
    const timer = scheduleAutomationDeadline(deadline, this.now, () => { this.check(loopId); });
    this.limits.set(loopId, { run, deadline, minutes: action.maxRunMinutes!, cap: action.maxProcessedTokens!, processedTokens: run.processedTokens ?? 0, timer,
      output: { runId: run.id, automationId: run.automationId, quietReplyEligible: false, seenAssistantOutput: false, outputChunks: [] } });
    this.unsubscribe ??= subscribeCostAttribution(record => {
      for (const [id, limit] of this.limits) {
        if (record.source !== 'one-shot' || !(record.correlationId === id || record.correlationId?.startsWith(`${id}::`))) continue;
        const usage = record.usage;
        if (usage) this.addUsage(limit, 'attributed', [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]);
        this.check(id);
      }
    });
  }
  observe(envelope: ProviderRuntimeEventEnvelope): void {
    for (const [id, limit] of this.limits) {
      if (envelope.instanceId !== `automation:${limit.run.automationId}:${limit.run.id}`) continue;
      const event = envelope.event;
      if (event.kind === 'output') {
        limit.output.outputChunks.push({ kind: event.messageType ?? 'output', content: event.content, timestamp: this.now() });
        if (event.messageType === 'assistant' && event.content.trim()) limit.output.lastAssistantOutput = event.content;
      }
      if (event.kind === 'complete') this.addUsage(limit, 'provider', [event.inputTokens, event.cacheReadTokens, event.cacheWriteTokens]);
      this.check(id);
    }
  }
  private addUsage(limit: LoopLimit, source: 'provider' | 'attributed', counts: (number | undefined)[]): void {
    const tokens = counts.reduce<number>((sum, n) => sum + (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0), 0);
    if (tokens > 0) limit.processedTokens = this.recordUsage(limit.run.id, `automation:${limit.run.automationId}:${limit.run.id}`, source, tokens);
  }
  check(loopId: string): boolean {
    const limit = this.limits.get(loopId);
    if (!limit) return false;
    const reason = this.now() >= limit.deadline ? `Stopped after ${limit.minutes} minutes`
      : limit.processedTokens > limit.cap ? 'Stopped: token cap' : undefined;
    if (!reason) return false;
    const fullRef = writeFullOutput(limit.output);
    this.clear(loopId);
    this.fail(loopId, reason, { summary: limit.output.lastAssistantOutput?.slice(0, 4000), fullRef });
    return true;
  }
  output(loopId: string): string | undefined { return this.limits.get(loopId)?.output.lastAssistantOutput; }
  monitorOutput(loopId: string): string | undefined {
    const tracking = this.limits.get(loopId)?.output;
    return tracking ? monitorAssistantOutput(tracking) : undefined;
  }
  saveOutput(loopId: string): string | undefined {
    const limit = this.limits.get(loopId); return limit ? writeFullOutput(limit.output) : undefined;
  }
  clear(loopId: string): void {
    const limit = this.limits.get(loopId); if (limit) limit.timer();
    this.limits.delete(loopId);
    if (!this.limits.size) { this.unsubscribe?.(); this.unsubscribe = undefined; }
  }
}
