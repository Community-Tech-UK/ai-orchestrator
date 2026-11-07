import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { ActionDispatchService } from '../../../core/services/action-dispatch.service';
import { CostIpcService } from '../../../core/services/ipc/cost-ipc.service';
import { InstanceStore } from '../../../core/state/instance.store';
import type { SessionSpendBreakdown } from '../../../../../shared/types/cost-session.types';
@Injectable({ providedIn: 'root' })
export class SessionStatusService {
  private readonly instances = inject(InstanceStore);
  private readonly cost = inject(CostIpcService);
  readonly instanceId = signal<string | null>(null);
  readonly breakdown = signal<SessionSpendBreakdown | null>(null);
  readonly loading = signal(false);
  private generation = 0;
  constructor() {
    const actionCleanup = inject(ActionDispatchService).register({ id: 'session.open-status',
      run: () => { const id = this.instances.selectedInstance()?.id; if (id) this.openFor(id); } });
    const costCleanup = this.cost.onCostUsageRecorded(data => {
      const entry = data as { instanceId?: string; sessionId?: string };
      const id = this.instanceId(); const instance = id ? this.instances.getInstance(id) : null;
      if (id && instance && (entry.instanceId === id || entry.sessionId === instance.sessionId)) void this.refresh(id);
    });
    inject(DestroyRef).onDestroy(() => { actionCleanup(); costCleanup(); this.generation++; });
  }
  openFor(instanceId: string): void { this.instanceId.set(instanceId); this.breakdown.set(null); void this.refresh(instanceId); }
  close(): void { this.generation++; this.instanceId.set(null); this.breakdown.set(null); this.loading.set(false); }
  private async refresh(id: string): Promise<void> {
    const generation = ++this.generation;
    const instance = this.instances.getInstance(id);
    if (!instance) { this.close(); return; }
    this.loading.set(true);
    try {
      const response = await this.cost.costGetSessionBreakdown(id, instance.sessionId);
      if (generation === this.generation && this.instanceId() === id) this.breakdown.set(response.success ? response.data ?? null : null);
    } catch { if (generation === this.generation) this.breakdown.set(null); }
    finally { if (generation === this.generation) this.loading.set(false); }
  }
}
