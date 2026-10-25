import { TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkControlComponent } from './work-control.component';
import { GlobalPauseStore } from './global-pause.store';
import { SettingsStore } from '../settings.store';
import { GlobalPauseIpcService } from '../../services/ipc/global-pause-ipc.service';
import { InstanceStateService } from '../instance/instance-state.service';
import type { GlobalPauseState } from '@contracts/schemas/global-pause';

await resolveComponentResources(url => Promise.resolve(url.endsWith('work-control.component.html')
  ? readFileSync('src/renderer/app/core/state/global-pause/work-control.component.html', 'utf8') : ''));

describe('WorkControlComponent', () => {
  const state = signal<GlobalPauseState>({ phase: 'none', since: null, reason: null, batchId: null,
    heldInstanceIds: [], entries: [], completedNotes: 0, totalNotes: 0, resumeInterrupted: false, stale: false, summary: null });
  const command = vi.fn();
  const set = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    state.update(s => ({ ...s, phase: 'none', entries: [], completedNotes: 0, totalNotes: 0, resumeInterrupted: false }));
    TestBed.configureTestingModule({ imports: [WorkControlComponent], providers: [
      { provide: GlobalPauseStore, useValue: { state, error: signal(null), command, initialize: vi.fn() } },
      { provide: SettingsStore, useValue: { get: () => 3, set } },
      { provide: GlobalPauseIpcService, useValue: { quit: vi.fn() } },
      { provide: InstanceStateService, useValue: { state: signal({ instances: new Map() }) } },
    ] });
  });
  it('renders collection progress and allows skipping remaining model calls', () => {
    state.update(s => ({ ...s, phase: 'collecting', completedNotes: 4, totalNotes: 6 }));
    const fixture = TestBed.createComponent(WorkControlComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Writing notes: 4 of 6');
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: unknown) => (b as HTMLButtonElement).textContent?.includes('Skip the rest')) as HTMLButtonElement;
    button.click();
    expect(command).toHaveBeenCalledWith('skip-notes', undefined);
  });
  it('explains discard before deleting notes', () => {
    state.update(s => ({ ...s, phase: 'ready' }));
    const fixture = TestBed.createComponent(WorkControlComponent);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: unknown) => (b as HTMLButtonElement).textContent?.trim() === 'Discard') as HTMLButtonElement;
    button.click(); fixture.detectChanges();
    expect(command).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Deletes the saved notes');
    expect(fixture.nativeElement.textContent).toContain('stay paused');
    const confirm = [...fixture.nativeElement.querySelectorAll('button')].find((b: unknown) => (b as HTMLButtonElement).textContent?.trim() === 'Delete notes and discard') as HTMLButtonElement;
    confirm.click();
    expect(command).toHaveBeenCalledWith('discard', undefined);
  });
  it('saves a workload change through the shared setting', () => {
    const fixture = TestBed.createComponent(WorkControlComponent);
    fixture.detectChanges();
    const slider = fixture.nativeElement.querySelector('input[type=range]') as HTMLInputElement;
    slider.value = '1'; slider.dispatchEvent(new Event('change'));
    expect(set).toHaveBeenCalledWith('workloadLevel', 1);
  });
  it('explains a saved first message without displaying internal bookkeeping', () => {
    state.update(s => ({ ...s, phase: 'ready', entries: [{
      id: 'entry', kind: 'session', targetId: 'chat', displayName: 'Starting session', workspace: null,
      provider: null, originalInstanceId: 'chat', historyThreadId: null, providerSessionId: null,
      wasBusy: true, noteText: 'The first message is waiting.', noteKind: 'basic', state: 'ready',
      voidReason: 'initial-prompt-queued', createdAt: 0, updatedAt: 0,
    }] }));
    const fixture = TestBed.createComponent(WorkControlComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('initial-prompt-queued');
    expect(fixture.nativeElement.textContent).toContain('Your first message is saved and will be sent when you resume.');
  });
});
