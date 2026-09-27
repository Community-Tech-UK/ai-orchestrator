import { Injectable, effect, inject, signal } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileLoopDetailDto, MobileLoopRunDto } from '../../core/models';

@Injectable({ providedIn: 'root' })
export class LoopStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private generation = 0;
  readonly runs = signal<MobileLoopRunDto[]>([]);
  readonly detail = signal<MobileLoopDetailDto | null>(null);
  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<string | null>(null);
  readonly pendingId = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.hosts.activeHost();
      this.gateway.online();
      this.gateway.loopEvent?.();
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const hostId = this.hosts.activeHost()?.id;
    if (typeof this.gateway.loops !== 'function' || !hostId || !this.gateway.online()) {
      this.status.set(this.runs().length ? 'ready' : 'idle');
      return;
    }
    this.status.set(this.runs().length ? 'ready' : 'loading');
    try {
      const runs = await this.gateway.loops();
      if (generation !== this.generation || hostId !== this.hosts.activeHost()?.id) return;
      this.runs.set(runs);
      this.status.set('ready');
      this.error.set(null);
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.set('error');
      this.error.set(error instanceof Error ? error.message : 'Loops could not be loaded');
    }
  }

  async open(id: string): Promise<void> {
    const generation = this.generation;
    this.detail.set(null);
    try {
      const detail = await this.gateway.loop(id);
      if (generation !== this.generation) return;
      this.detail.set(detail);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error.set(error instanceof Error ? error.message : 'Loop could not be loaded');
    }
  }

  async control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<boolean> {
    this.pendingId.set(id);
    this.error.set(null);
    try {
      const outcome = await this.gateway.controlLoop(id, action);
      if (!outcome.ok) this.error.set(outcome.error);
      await this.refresh();
      if (this.detail()?.run.id === id) await this.open(id);
      return outcome.ok;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Loop control failed');
      return false;
    } finally {
      this.pendingId.set(null);
    }
  }
}
