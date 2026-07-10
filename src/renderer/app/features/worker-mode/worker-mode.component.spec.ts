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
    | 'runWorker'
    | 'stopWorker'
    | 'unpairWorker'
  >>;
  let settings: {
    workerMode: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    pairBoth = {
      discoverCandidates: vi.fn().mockResolvedValue([]),
      connectWorker: vi.fn(),
      confirmWorkerCode: vi.fn(),
      waitForWorkerResult: vi.fn(),
      applyManualPairing: vi.fn(),
      parseInvitation: vi.fn(),
      runWorker: vi.fn().mockResolvedValue({ state: 'running', pid: 1234 }),
      stopWorker: vi.fn().mockResolvedValue({ state: 'stopped' }),
      unpairWorker: vi.fn().mockResolvedValue({ state: 'stopped' }),
    };
    settings = {
      workerMode: vi.fn(() => ({
        role: 'worker',
        startWorkerOnLaunch: true,
        installWorkerService: false,
      })),
      set: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [WorkerModeComponent],
      providers: [
        { provide: PairBothIpcService, useValue: pairBoth },
        { provide: SettingsStore, useValue: settings },
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
    expect(fixture.nativeElement.textContent).toContain(
      'Harness could not find another computer on this network',
    );
    expect(fixture.nativeElement.textContent).toContain('Pairing invitation');
  });

  it('offers the post-pair run mode choice before marking the worker connected', async () => {
    const config = {
      nodeId: 'node-1',
      name: 'Noah PC',
      coordinatorUrl: 'ws://mac:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    };
    pairBoth.applyManualPairing.mockResolvedValueOnce(config);

    const component = fixture.componentInstance as unknown as {
      manualConfig: { set(value: string): void };
      applyManualConfig: () => Promise<void>;
    };
    component.manualConfig.set('config');
    await component.applyManualConfig();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('How should this worker run?');
    expect(fixture.nativeElement.textContent).toContain('Run while Harness is open');
    expect(fixture.nativeElement.textContent).toContain('Install background service');
  });

  it('starts or installs the paired worker from the post-pair choice', async () => {
    const config = {
      nodeId: 'node-1',
      name: 'Noah PC',
      coordinatorUrl: 'ws://mac:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    };
    const component = fixture.componentInstance as unknown as {
      pairedConfig: { set(value: typeof config): void };
      state: { set(value: string): void };
    };
    component.pairedConfig.set(config);
    component.state.set('service-choice');
    fixture.detectChanges();

    const runButton = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Run while Harness is open')) as HTMLButtonElement;
    runButton.click();
    await fixture.whenStable();

    expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open');
    expect(settings.update).toHaveBeenCalledWith({
      workerMode: expect.objectContaining({
        startWorkerOnLaunch: true,
        installWorkerService: false,
      }),
    });

    component.state.set('service-choice');
    fixture.detectChanges();
    const serviceButton = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Install background service')) as HTMLButtonElement;
    serviceButton.click();
    await fixture.whenStable();

    expect(pairBoth.runWorker).toHaveBeenCalledWith('background-service');
  });

  it('stops and unpairs from the connected state without showing pairing tokens', async () => {
    const config = {
      nodeId: 'node-1',
      name: 'Noah PC',
      coordinatorUrl: 'ws://mac:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    };
    pairBoth.applyManualPairing.mockResolvedValueOnce(config);
    const component = fixture.componentInstance as unknown as {
      pairedConfig: { set(value: typeof config): void };
      state: { set(value: string): void };
    };
    component.pairedConfig.set(config);
    component.state.set('connected');
    fixture.detectChanges();

    const stopButton = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Stop Worker')) as HTMLButtonElement;
    stopButton.click();
    await fixture.whenStable();

    const unpairButton = Array.from(fixture.nativeElement.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Unpair this computer')) as HTMLButtonElement;
    unpairButton.click();
    await fixture.whenStable();

    expect(pairBoth.stopWorker).toHaveBeenCalledTimes(1);
    expect(pairBoth.unpairWorker).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith('workerMode', expect.objectContaining({ role: 'unset' }));
    expect(fixture.nativeElement.textContent).not.toMatch(/token|credential/i);
  });
});
