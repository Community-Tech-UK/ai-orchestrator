import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileAutomationDto, MobileAutomationRunResponse } from '../../core/models';

type AutomationLoadStatus = 'loading' | 'loaded' | 'error';

function outcomeLabel(outcome: MobileAutomationRunResponse): string {
  if (outcome.status === 'skipped') return `Skipped: ${outcome.reason}`;
  if (outcome.status === 'started') return 'Started';
  return 'Queued';
}

@Injectable({ providedIn: 'root' })
export class AutomationStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private readonly value = signal<{ hostId: string; epoch: number; items: MobileAutomationDto[] } | null>(null);
  private readonly loadStatus = signal<AutomationLoadStatus>('loading');
  private readonly operation = signal<{ hostId: string; automationId: string; pending: boolean; message: string | null } | null>(null);
  private intent: { hostId: string; automationId: string; key: string } | null = null;
  private runGeneration = 0;
  private generation = 0;

  readonly online = this.gateway.online;
  readonly hostId = computed(() => this.hosts.activeHost()?.id ?? null);
  readonly hostName = computed(() => this.hosts.activeHost()?.name ?? 'Host');
  readonly status = this.loadStatus.asReadonly();
  readonly hasCurrentList = computed(() => {
    const hostId = this.hostId();
    const value = this.value();
    return this.online() && this.loadStatus() === 'loaded' && hostId !== null &&
      this.gateway.dataHostId() === hostId && value !== null &&
      // A list fetched under a previous connection is never authority for a
      // reconnected one, even before the refresh effect marks it loading.
      value.hostId === hostId && value.epoch === this.gateway.connectionEpoch();
  });
  readonly automations = computed(() => {
    const value = this.value();
    const hostId = this.hosts.activeHost()?.id;
    if (!value || value.hostId !== hostId || this.gateway.dataHostId() !== hostId) return [];
    return value.items;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.generation++; this.cancelRun(); });
    effect(() => {
      const host = this.hosts.activeHost();
      const ready = this.online() && this.gateway.dataHostId() === host?.id;
      untracked(() => {
        this.generation += 1;
        if (this.value()?.hostId !== host?.id) this.value.set(null);
        if (this.intent?.hostId !== host?.id || this.operation()?.hostId !== host?.id) this.cancelRun();
        if (host && ready) void this.refresh();
      });
    });
  }

  running(id: string): boolean { return this.currentOperation(id)?.pending ?? false; }
  feedbackFor(id: string): string | null { return this.currentOperation(id)?.message ?? null; }

  private currentOperation(id: string) {
    const operation = this.operation();
    const hostId = this.hosts.activeHost()?.id;
    return operation && operation.hostId === hostId && this.gateway.dataHostId() === hostId && operation.automationId === id ? operation : null;
  }

  cancelRun(): void {
    this.runGeneration++;
    this.intent = null;
    this.operation.set(null);
  }

  async refresh(): Promise<void> {
    const host = this.hosts.activeHost();
    if (!host || !this.online() || this.gateway.dataHostId() !== host.id) return;
    const generation = ++this.generation;
    // Record which connection this list was fetched under: authority dies with it.
    const epoch = this.gateway.connectionEpoch();
    this.loadStatus.set('loading');
    try {
      const items = await this.gateway.automations();
      if (generation !== this.generation || host !== this.hosts.activeHost()) return;
      this.value.set({ hostId: host.id, epoch, items });
      if (this.intent && !items.some(item => item.id === this.intent?.automationId && item.enabled)) this.cancelRun();
      this.loadStatus.set('loaded');
    } catch {
      if (generation !== this.generation || host !== this.hosts.activeHost()) return;
      this.value.set({ hostId: host.id, epoch, items: [] });
      this.loadStatus.set('error');
    }
  }

  async runNow(item: MobileAutomationDto): Promise<boolean> {
    const host = this.hosts.activeHost();
    // An id alone cannot carry the host/list authority of the confirmation.
    if (!host || !this.hasCurrentList() ||
        !item.enabled || !this.automations().includes(item) || this.running(item.id)) return false;
    if (this.intent?.hostId !== host.id || this.intent.automationId !== item.id) {
      this.cancelRun();
      this.intent = { hostId: host.id, automationId: item.id, key: `mobile-${crypto.randomUUID()}` };
    }
    const intent = this.intent;
    const generation = ++this.runGeneration;
    const current = () => generation === this.runGeneration && host.id === this.hosts.activeHost()?.id;
    this.operation.set({ hostId: host.id, automationId: item.id, pending: true, message: null });
    try {
      const outcome = await this.gateway.runAutomation(item.id, intent.key);
      if (!current()) return false;
      this.intent = null; // Only a definitive response finishes this logical intent.
      this.operation.set({ hostId: host.id, automationId: item.id, pending: false, message: outcomeLabel(outcome) });
      return true;
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : 'Run now failed';
        // Transport failure may follow a successful fire. Keep the same key.
        this.operation.set({ hostId: host.id, automationId: item.id, pending: false, message });
      }
      return false;
    }
  }
}
