import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { SubagentUsageSample } from '../../../../shared/types/cost-session.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { InstanceIpcService } from '../services/ipc/instance-ipc.service';

@Injectable({ providedIn: 'root' })
export class SubagentUsageStore {
  private readonly samples = signal(new Map<string, Map<string, SubagentUsageSample>>());
  constructor() {
    const destroy = inject(DestroyRef);
    const base = inject(ElectronIpcService);
    const unsubscribe = base.getApi()?.onSubagentUsage(sample => base.getNgZone().run(() => this.accept(sample)));
    const removed = inject(InstanceIpcService).onInstanceRemoved(id => this.removeInstance(id));
    destroy.onDestroy(() => { unsubscribe?.(); removed(); });
  }
  accept(sample: SubagentUsageSample): void {
    if (!sample?.instanceId || !sample.toolUseId || typeof sample.final !== 'boolean'
      || ![sample.finalContextTokens, sample.toolUses, sample.durationMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return;
    this.samples.update(current => {
      const next = new Map(current);
      const samples = new Map(next.get(sample.instanceId));
      if (samples.get(sample.toolUseId)?.final) return current;
      samples.delete(sample.toolUseId); samples.set(sample.toolUseId, sample);
      if (samples.size > 200) samples.delete(samples.keys().next().value!);
      next.set(sample.instanceId, samples);
      return next;
    });
  }
  sample(instanceId: string, toolUseId: string): SubagentUsageSample | undefined { return this.samples().get(instanceId)?.get(toolUseId); }
  summary(instanceId: string): { running: number; finished: number; toolUses: number } {
    const samples = [...(this.samples().get(instanceId)?.values() ?? [])];
    return { running: samples.filter(s => !s.final).length, finished: samples.filter(s => s.final).length,
      toolUses: samples.reduce((sum, s) => sum + s.toolUses, 0) };
  }
  removeInstance(instanceId: string): void { this.samples.update(current => { const next = new Map(current); next.delete(instanceId); return next; }); }
}
