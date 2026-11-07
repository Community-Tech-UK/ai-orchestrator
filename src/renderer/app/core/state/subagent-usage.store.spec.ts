import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SubagentUsageStore } from './subagent-usage.store';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { InstanceIpcService } from '../services/ipc/instance-ipc.service';
describe('live helper usage', () => {
  it('keeps last samples, makes final samples terminal, caps history and clears removed sessions', () => {
    let removed: (id: string) => void = () => undefined;
    TestBed.configureTestingModule({ providers: [{ provide: ElectronIpcService, useValue: { getApi: () => null } },
      { provide: InstanceIpcService, useValue: { onInstanceRemoved: (fn: typeof removed) => { removed = fn; return vi.fn(); } } }] });
    const store = TestBed.inject(SubagentUsageStore);
    const sample = { instanceId: 'i', toolUseId: 'task', finalContextTokens: 100, toolUses: 2, durationMs: 1000, final: false };
    store.accept(sample); store.accept({ ...sample, toolUses: 4, final: true }); store.accept(sample);
    expect(store.summary('i')).toEqual({ running: 0, finished: 1, toolUses: 4 });
    expect(store.sample('i', 'task')?.toolUses).toBe(4);
    for (let i = 0; i < 250; i++) store.accept({ ...sample, toolUseId: String(i) });
    expect(store.summary('i').running).toBe(200);
    removed('i'); expect(store.sample('i', '1')).toBeUndefined();
    expect(store.summary('i')).toEqual({ running: 0, finished: 0, toolUses: 0 });
  });
});
