import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi, type Mocked } from 'vitest';
import { PairBothIpcService } from '../../core/services/ipc/pair-both-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import { WorkerModeComponent } from './worker-mode.component';

describe('WorkerModeComponent', () => {
  let fixture: ComponentFixture<WorkerModeComponent>;
  let pairBoth: Mocked<Pick<
    PairBothIpcService,
    | 'discoverCandidates'
    | 'connectWorker'
    | 'confirmWorkerCode'
    | 'waitForWorkerResult'
    | 'applyManualPairing'
    | 'parseInvitation'
  >>;

  beforeEach(async () => {
    pairBoth = {
      discoverCandidates: vi.fn().mockResolvedValue([]),
      connectWorker: vi.fn(),
      confirmWorkerCode: vi.fn(),
      waitForWorkerResult: vi.fn(),
      applyManualPairing: vi.fn(),
      parseInvitation: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [WorkerModeComponent],
      providers: [
        { provide: PairBothIpcService, useValue: pairBoth },
        {
          provide: SettingsStore,
          useValue: {
            workerMode: vi.fn(() => ({
              role: 'worker',
              startWorkerOnLaunch: true,
              installWorkerService: false,
            })),
            set: vi.fn().mockResolvedValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
  });

  it('shows the primary Pair With Harness action', () => {
    const button = fixture.debugElement.query(By.css('.primary-action'));

    expect(button.nativeElement.textContent).toContain('Pair With Harness');
  });

  it('falls back to invitation paste when discovery finds no coordinators', async () => {
    fixture.debugElement.query(By.css('.primary-action')).nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(pairBoth.discoverCandidates).toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Pairing invitation');
  });
});
