import { Injectable, effect, inject, signal } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobilePlanQueueItemDto, MobilePlanQueueRunDto } from '../../core/models';

@Injectable({ providedIn: 'root' })
export class PlanQueueStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private generation = 0;
  readonly runs = signal<MobilePlanQueueRunDto[]>([]);
  readonly diffstat = signal('');
  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<string | null>(null);
  readonly pending = signal(false);

  constructor() {
    effect(() => {
      this.hosts.activeHost();
      this.gateway.online();
      this.gateway.planQueueEvent?.();
      void this.refresh();
    });
  }

  item(id: string): MobilePlanQueueItemDto | null {
    for (const run of this.runs()) {
      const item = run.items.find((candidate) => candidate.id === id);
      if (item) return item;
    }
    return null;
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const hostId = this.hosts.activeHost()?.id;
    if (typeof this.gateway.planQueue !== 'function' || !hostId || !this.gateway.online()) {
      this.status.set(this.runs().length ? 'ready' : 'idle');
      return;
    }
    if (!this.runs().length) this.status.set('loading');
    try {
      const body = await this.gateway.planQueue();
      if (generation !== this.generation || hostId !== this.hosts.activeHost()?.id) return;
      this.runs.set(body.runs);
      this.status.set('ready');
      this.error.set(null);
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.set('error');
      this.error.set(error instanceof Error ? error.message : 'Plan queue could not be loaded');
    }
  }

  async answer(itemId: string, optionId: string): Promise<boolean> {
    return this.act(async () => { await this.gateway.answerPlanQueue(itemId, optionId); });
  }

  async control(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    return this.act(async () => { await this.gateway.controlPlanQueue(runId, action); });
  }

  async loadDiffstat(itemId: string): Promise<void> {
    this.diffstat.set('');
    try {
      const body = await this.gateway.planQueueDiffstat(itemId);
      this.diffstat.set(body.diffstat);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Diffstat could not be loaded');
    }
  }

  private async act(run: () => Promise<void>): Promise<boolean> {
    this.pending.set(true);
    this.error.set(null);
    try {
      await run();
      await this.refresh();
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Plan queue action failed');
      return false;
    } finally {
      this.pending.set(false);
    }
  }
}
