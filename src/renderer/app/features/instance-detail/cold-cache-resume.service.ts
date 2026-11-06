import { Injectable, OnDestroy, inject, signal, untracked } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { isQuotaParked } from '../../core/state/instance/instance-messaging-queue-utils';
import { SettingsStore } from '../../core/state/settings.store';
import { evaluateColdCacheResume, type ColdCacheResumeEvaluation } from './cold-cache-resume';

export type ColdCacheResumePhase = 'idle' | 'compacting' | 'failed';

@Injectable({ providedIn: 'root' })
export class ColdCacheResumeService implements OnDestroy {
  private readonly instances = inject(InstanceStore);
  private readonly messages = inject(InstanceMessagingStore);
  private readonly settings = inject(SettingsStore);
  private readonly nowMs = signal(Date.now());
  private readonly phases = signal<ReadonlyMap<string, ColdCacheResumePhase>>(new Map());
  private readonly fullHistoryOnce = signal<ReadonlySet<string>>(new Set());
  /** The one send currently waiting on a compaction, per instance. Identity tells a stale result from a newer run. */
  private readonly waiting = new Map<string, { message: string; restore: (text: string) => void }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }
  phaseFor(instanceId: string): ColdCacheResumePhase { return this.phases().get(instanceId) ?? 'idle'; }

  offerFor(instanceId: string): ColdCacheResumeEvaluation {
    if (!this.settings.settings().coldCacheCompactFirst) return { offer: false };
    this.ensureClock();
    const instance = this.instances.getInstance(instanceId);
    if (!instance) return { offer: false };
    const lastAssistantAt = instance.outputBuffer.reduce<number | undefined>((latest, message) =>
      message.type === 'assistant' && (latest === undefined || message.timestamp > latest)
        ? message.timestamp : latest, undefined);
    return evaluateColdCacheResume({
      provider: instance.provider, status: instance.status, usage: instance.contextUsage,
      lastAssistantAt, now: this.nowMs(), compacting: this.instances.isInstanceCompacting(instanceId),
      hasQueued: this.messages.getQueuedMessageCount(instanceId) > 0, quotaParked: isQuotaParked(instance),
    });
  }

  preferCompact(instanceId: string): boolean { return !this.fullHistoryOnce().has(instanceId); }
  setPreferCompact(instanceId: string, prefer: boolean): void {
    this.fullHistoryOnce.update(current => {
      const next = new Set(current);
      if (prefer) next.delete(instanceId); else next.add(instanceId);
      return next;
    });
  }
  shouldCompactFirst(instanceId: string): boolean { return this.offerFor(instanceId).offer && this.preferCompact(instanceId); }
  /** Cancel gives the text back and leaves "compacting" now; the compaction's late result is then ignored. */
  cancelPendingSend(instanceId: string): void {
    const run = this.waiting.get(instanceId);
    if (!run) return;
    this.waiting.delete(instanceId);
    this.setPhase(instanceId, 'idle');
    run.restore(run.message);
  }

  async compactThenSend(instanceId: string, message: string, send: () => void, restore: (text: string) => void): Promise<void> {
    if (this.phaseFor(instanceId) === 'compacting') { restore(message); return; }
    if (!this.shouldCompactFirst(instanceId)) {
      this.setPreferCompact(instanceId, true);
      this.setPhase(instanceId, 'idle');
      send();
      return;
    }
    const run = { message, restore };
    this.waiting.set(instanceId, run);
    this.setPhase(instanceId, 'compacting');
    let completed = false;
    try { completed = await this.instances.compactInstance(instanceId); } catch { /* restore below */ }
    // Cancelled while waiting (or replaced by a newer run): the text is already back, so do nothing.
    if (this.waiting.get(instanceId) !== run) return;
    this.waiting.delete(instanceId);
    this.setPreferCompact(instanceId, true);
    if (completed) {
      this.setPhase(instanceId, 'idle');
      send();
    } else {
      this.setPhase(instanceId, 'failed');
      restore(message);
    }
  }

  private setPhase(instanceId: string, phase: ColdCacheResumePhase): void {
    this.phases.update(current => new Map(current).set(instanceId, phase));
  }
  private ensureClock(): void {
    if (this.timer) return;
    // The first offer can be read inside a chip computed; initialise outside its tracking.
    untracked(() => this.nowMs.set(Date.now()));
    this.timer = setInterval(() => this.nowMs.set(Date.now()), 60_000);
  }
}

export function formatIdleDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
export function formatTokenEstimate(tokens: number): string { return `about ${Math.round(tokens / 1_000)}K tokens`; }
