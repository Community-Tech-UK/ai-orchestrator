import type { Instance } from '../../../shared/types/instance.types';
import type { CopilotModelCache } from '../../../shared/types/cost-session.types';
import { copilotEventsPath, readCopilotCheckpointTail } from '../../cli/adapters/copilot/copilot-usage-checkpoint';
import { resolveCopilotProfileHome } from '../../cli/adapters/copilot/copilot-account-home-resolver';
import { getCostTracker, type CostTracker } from './cost-tracker';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CopilotCreditRecorder');
interface RecorderOptions {
  tracker?: CostTracker;
  resolveHome?: (instance: Instance) => string;
  delay?: () => Promise<void>;
}
/** Checkpoint accounting is independent of ACP/SDK token reporting. */
export class CopilotCreditRecorder {
  private static instance: CopilotCreditRecorder | null = null;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, CopilotModelCache[]>();
  private readonly warned = new Set<string>();
  private readonly tracker: CostTracker;
  constructor(private readonly options: RecorderOptions = {}) { this.tracker = options.tracker ?? getCostTracker(); }
  static getInstance(): CopilotCreditRecorder { return this.instance ??= new CopilotCreditRecorder(); }
  static _resetForTesting(): void { this.instance = null; }
  getCopilotCacheState(instanceId: string): CopilotModelCache[] { return this.cache.get(instanceId) ?? []; }
  bookAfterTurn(instance: Instance, costEntryId: string | undefined): Promise<void> {
    if (instance.provider !== 'copilot' || instance.executionLocation?.type === 'remote') return Promise.resolve();
    const snapshot = { ...instance };
    const key = instance.sessionId;
    const next = (this.chains.get(key) ?? Promise.resolve()).then(() => this.book(snapshot, costEntryId)).catch(() => {
      if (!this.warned.has(key)) { this.warned.add(key); logger.debug('Copilot credits unavailable for session', { instanceId: instance.id }); }
    });
    this.chains.set(key, next);
    void next.then(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }
  private async book(instance: Instance, entryId: string | undefined): Promise<void> {
    const home = this.options.resolveHome?.(instance) ?? resolveCopilotProfileHome(instance.copilotAccountProfileId ?? 'legacy', { createIfMissing: false });
    const path = copilotEventsPath(home, instance.sessionId);
    const booked = this.tracker.getLastProviderCreditCheckpoint(instance.sessionId);
    let tail = await readCopilotCheckpointTail(path);
    if (!tail.last || tail.last.eventId === booked?.eventId) {
      await (this.options.delay?.() ?? new Promise<void>(resolve => setTimeout(resolve, 1500)));
      tail = await readCopilotCheckpointTail(path);
    }
    const last = tail.last;
    if (!last) return;
    this.cache.set(instance.id, last.modelCache);
    if (last.eventId === booked?.eventId) return;
    const base = booked?.totalNano ?? tail.previous?.totalNanoAiu;
    const premiumBase = booked?.premiumTotal ?? tail.previous?.totalPremiumRequests;
    if (base === undefined || premiumBase === undefined) {
      // No booked row and no previous checkpoint. On a truncated tail the
      // stream's history is unknown: never charge the running total as new
      // spend (no backfill). A complete tail means the stream really starts
      // here, so the running total is the spend and the base is zero.
      if (tail.truncated) return;
    }
    const from = base ?? 0;
    if (last.totalNanoAiu < from) return; // unknown/reset stream: never invent a charge
    const fromPremium = premiumBase ?? 0;
    const entry = entryId ?? this.tracker.recordUsage(instance.id, instance.sessionId, instance.currentModel || 'copilot',
      0, 0, 0, 0, 0, 0, false, { provider: 'copilot' }).id;
    this.tracker.attachProviderCredits(entry, { creditsNano: last.totalNanoAiu - from,
      premiumRequests: Math.max(0, last.totalPremiumRequests - fromPremium), checkpointEventId: last.eventId,
      checkpointTotalNano: last.totalNanoAiu, checkpointPremiumTotal: last.totalPremiumRequests });
  }
}
export function getCopilotCreditRecorder(): CopilotCreditRecorder { return CopilotCreditRecorder.getInstance(); }
