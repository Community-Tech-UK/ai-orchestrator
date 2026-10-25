import { TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkControlComponent } from '../../renderer/app/core/state/global-pause/work-control.component';
import { GlobalPauseStore as RendererPauseStore } from '../../renderer/app/core/state/global-pause/global-pause.store';
import { GlobalPauseIpcService } from '../../renderer/app/core/services/ipc/global-pause-ipc.service';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { GlobalPauseStore } from '../../main/global-pause/global-pause-store';
import { GlobalPauseService } from '../../main/global-pause/global-pause-service';
import type { GlobalPauseRuntime } from '../../main/global-pause/global-pause-runtime.types';
import { WorkAdmission } from '../../main/work-admission/work-admission';
import { defaultDriverFactory } from '../../main/db/better-sqlite3-driver';
import type { SqliteDriver } from '../../main/db/sqlite-driver';
import { createTables, createMigrationsTable, runMigrations } from '../../main/persistence/rlm/rlm-schema';
import type { GlobalPauseState } from '@contracts/schemas/global-pause';

await resolveComponentResources(url => Promise.resolve(url.endsWith('work-control.component.html')
  ? readFileSync('src/renderer/app/core/state/global-pause/work-control.component.html', 'utf8') : ''));

describe('Work controls with the real persisted pause service', () => {
  let db: SqliteDriver;
  let service: GlobalPauseService;
  let admission: WorkAdmission;
  let resumed: string[];
  let notesRequested: string[];
  beforeEach(() => {
    db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    admission = new WorkAdmission({ cpuCount: () => 8, loadAverage: () => [0, 0] });
    resumed = []; notesRequested = [];
    const runtime: GlobalPauseRuntime = {
      sessions: () => [
        { id: 'agent', displayName: 'Writing session', busy: true, lastRequest: 'Fix export', lastReply: 'Added a guard', helperReplies: [] },
        { id: 'basic', displayName: 'Parked session', busy: true, lastRequest: 'Check imports', lastReply: 'Waiting for quota', helperReplies: [], unavailableReason: 'Waiting for quota' },
      ],
      engines: async () => [], pauseEngines: async () => undefined, stopHelpers: async () => undefined,
      interruptSession: async () => true,
      collectNote: async session => { notesRequested.push(session.id); return 'Task\nFix export\nDone\nAdded a guard\nIn progress\nBuild\nNext step\nVerify\nWaiting on James\nNothing'; },
      resumeSession: async entry => { resumed.push(entry.targetId); return entry.targetId; },
      resumeEngine: async () => undefined, level: () => admission.getWorkloadLevel(),
    };
    service = new GlobalPauseService({ store: new GlobalPauseStore(db), runtime, setAdmissionPhase: phase => admission.setGlobalPhase(phase) });
    service.bootstrap();
    const workload = signal(3);
    TestBed.configureTestingModule({ imports: [WorkControlComponent], providers: [
      { provide: GlobalPauseIpcService, useValue: {
        getState: async () => ({ success: true, data: service.getState() }),
        onStateChanged: (callback: (state: GlobalPauseState) => void) => {
          service.on('state-changed', callback); return () => service.off('state-changed', callback);
        },
        command: async (command: string, payload?: { withNotes?: boolean; instanceId?: string }) => {
          switch (command) {
            case 'hold': service.hold(); break;
            case 'release': service.release(); break;
            case 'restart': await service.pauseForRestart({ withNotes: payload?.withNotes === true }); break;
            case 'resume': await service.resume(); break;
            case 'pick-up': service.manualInput(payload?.instanceId ?? ''); break;
          }
          return { success: true, data: service.getState() };
        },
      } },
      { provide: SettingsStore, useValue: { get: () => workload(), set: async (_key: string, value: 1 | 2 | 3 | 4 | 5) => {
        workload.set(value); admission.setWorkloadLevel(value);
      } } },
      { provide: InstanceStateService, useValue: { state: signal({ instances: new Map() }) } },
    ] });
  });
  afterEach(() => { TestBed.resetTestingModule(); service.shutdown(); admission.dispose(); db.close(); });
  const create = async () => {
    const fixture = TestBed.createComponent(WorkControlComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture;
  };
  const click = (root: HTMLElement, text: string) => {
    const button = [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
    if (!button) throw new Error(`No button: ${text}`);
    button.click();
  };
  it('holds a scripted queue job, releases it and applies the workload slider to the next start', async () => {
    const fixture = await create();
    click(fixture.nativeElement, 'Hold new work'); await fixture.whenStable(); fixture.detectChanges();
    let started = 0;
    admission.defer('scripted-job', 'queue-job', () => { started++; });
    expect(started).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('Holding new work');
    click(fixture.nativeElement, 'Release'); await fixture.whenStable(); fixture.detectChanges();
    expect(started).toBe(1);
    const slider = fixture.nativeElement.querySelector('input[type=range]') as HTMLInputElement;
    slider.value = '1'; slider.dispatchEvent(new Event('change'));
    await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Lightest');
    expect(admission.check('queue-job', { activeCount: 1 }).allowed).toBe(false);
  });
  it('collects an agent note and a basic note, allows manual pickup and resumes only the remaining session', async () => {
    const fixture = await create();
    click(fixture.nativeElement, 'Pause for restart'); await fixture.whenStable(); fixture.detectChanges();
    expect(notesRequested).toEqual(['agent']);
    expect(Object.fromEntries(service.getState().entries.map(e => [e.targetId, e.noteKind]))).toEqual({ agent: 'agent', basic: 'basic' });
    expect(fixture.nativeElement.textContent).toContain('Resume');
    expect(admission.check('queue-job').allowed).toBe(false);
    await TestBed.inject(RendererPauseStore).pickUp('agent');
    expect(service.getState().entries.find(e => e.targetId === 'agent')).toMatchObject({ state: 'void', noteText: null });
    fixture.detectChanges(); click(fixture.nativeElement, 'Resume');
    await fixture.whenStable(); fixture.detectChanges();
    expect(resumed).toEqual(['basic']);
    expect(admission.check('queue-job').allowed).toBe(true);
  });
});
