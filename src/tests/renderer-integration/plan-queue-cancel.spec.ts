import { provideZonelessChangeDetection, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../renderer/app/core/services/ipc/copilot-account-ipc.service';
import { PlanQueueIpcService, type PlanQueueStateChangedPush } from '../../renderer/app/core/services/ipc/plan-queue-ipc.service';
import { ProviderAccountIpcService } from '../../renderer/app/core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { PlanQueueStore } from '../../renderer/app/core/state/plan-queue.store';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';
import { PlanQueuePageComponent } from '../../renderer/app/features/plan-queue/plan-queue-page.component';

const resources = new Map<string, string>();
for (const directory of ['src/renderer/app/features/plan-queue', 'src/renderer/app/features/plan-queue/components']) {
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.html') || name.endsWith('.scss')) {
      resources.set(name, readFileSync(resolve(directory, name), 'utf8'));
    }
  }
}
await resolveComponentResources(url => {
  const resource = [...resources].find(([name]) => url.endsWith(name));
  if (resource) return Promise.resolve(resource[1]);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

const run: PlanQueueRunDto = {
  id: 'run', parentInstanceId: 'parent', kind: 'plans', workspaceCwd: '/example/project', status: 'paused',
  config: { workerSlots: 3, verificationSlots: 2, maxRounds: 3, maxLoadAverage: 30, postMergeGate: [], verifierGates: [], relaxSettings: false },
  workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [],
};
const snapshot = (runs: PlanQueueRunDto[] = [run]) => ({ success: true, data: { runs, alerts: [] } });

describe('Plan Queue cancellation across live page updates', () => {
  let push: (event: PlanQueueStateChangedPush) => void;
  let list: ReturnType<typeof vi.fn>;
  let control: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    list = vi.fn().mockResolvedValue(snapshot());
    control = vi.fn().mockResolvedValue({ success: true, data: null });
    await TestBed.configureTestingModule({ imports: [PlanQueuePageComponent], providers: [
      provideZonelessChangeDetection(), PlanQueueStore,
      { provide: PlanQueueIpcService, useValue: {
        list, control,
        onStateChanged: (callback: typeof push) => { push = callback; return () => undefined; },
      } },
      { provide: InstanceStore, useValue: { rootInstances: signal([]) } },
      { provide: SettingsStore, useValue: { settings: signal({ planQueueRouting: { workers: [], verifiers: [] } }) } },
      { provide: ProviderAccountIpcService, useValue: { list: async () => ({ profiles: [], pools: {} }) } },
      { provide: CopilotAccountIpcService, useValue: { list: async () => [] } },
    ] }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(PlanQueuePageComponent);
    fixture.autoDetectChanges();
    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('.pq-cancel')).not.toBeNull());
    const controls = fixture.nativeElement.querySelector('app-plan-queue-run-controls') as HTMLElement;
    (controls.querySelector('.pq-cancel') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(controls.querySelector('.pq-confirm-yes')).not.toBeNull());
    return { fixture, controls };
  }

  it.each(['paused', 'running'] as const)('preserves confirmation during ordinary %s run updates', async status => {
    list.mockResolvedValue(snapshot([{ ...run, status }]));
    const { fixture, controls } = await render();
    push({ runId: run.id, run: { ...run, status, workerProvider: 'codex' } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-plan-queue-run-controls')).toBe(controls);
    (controls.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(control).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', runId: 'run' });
  });

  it.each(['success', 'failure'] as const)('keeps confirmation while a full refresh is pending and after %s', async outcome => {
    const { fixture, controls } = await render();
    let release!: (result: unknown) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    push({ runId: 'unavailable-run', run: null });
    try {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-plan-queue-run-controls')).toBe(controls);
      expect(controls.querySelector('.pq-confirm-yes')).not.toBeNull();
    } finally {
      release(outcome === 'success' ? snapshot() : { success: false, error: { message: 'Refresh failed' } });
    }
    await vi.waitFor(() => expect(TestBed.inject(PlanQueueStore).isLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-plan-queue-run-controls')).toBe(controls);
    if (outcome === 'failure') expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Refresh failed');
    (controls.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(control).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', runId: 'run' });
  });

  it('still shows initial loading before the first snapshot arrives', async () => {
    let release!: (result: unknown) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const fixture = TestBed.createComponent(PlanQueuePageComponent);
    fixture.detectChanges();
    try {
      expect(fixture.nativeElement.querySelector('.pq-loading')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.pq-empty')).toBeNull();
    } finally { release(snapshot()); }
    await vi.waitFor(() => expect(TestBed.inject(PlanQueueStore).isLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-cancel')).not.toBeNull();
  });

  it('removes a stale run when the refreshed snapshot is empty', async () => {
    const { fixture } = await render();
    list.mockResolvedValueOnce(snapshot([]));
    push({ runId: run.id, run: null });
    await vi.waitFor(() => expect(TestBed.inject(PlanQueueStore).isLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-plan-queue-run-controls')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-empty')).not.toBeNull();
    expect(control).not.toHaveBeenCalled();
  });
});
