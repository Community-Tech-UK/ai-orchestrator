import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi, type Mocked } from 'vitest';
import { PairBothIpcService } from '../../core/services/ipc/pair-both-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { WorkerModeStatus } from '../../../../shared/types/pair-both.types';
import { WorkerModeComponent } from './worker-mode.component';

// The stylesheet is irrelevant to these behaviour tests; stub it blank.
await resolveComponentResources((url) => (
  url.endsWith('.scss')
    ? Promise.resolve('')
    : Promise.reject(new Error(`Unexpected resource: ${url}`))
));

const pairedConfig = {
  nodeId: 'node-1',
  name: 'Noah PC',
  coordinatorUrl: 'ws://mac:4878',
  namespace: 'default',
  maxConcurrentInstances: 10,
  workingDirectories: [],
};

function status(overrides: Partial<WorkerModeStatus> = {}): WorkerModeStatus {
  return {
    paired: true,
    enrolled: true,
    config: pairedConfig,
    runtime: { state: 'running', pid: 1234 },
    backgroundService: false,
    runAtSignIn: false,
    runAtSignInAvailable: false,
    ...overrides,
  };
}

const UNPAIRED: WorkerModeStatus = {
  paired: false,
  enrolled: false,
  config: null,
  runtime: { state: 'stopped' },
  backgroundService: false,
  runAtSignIn: false,
  runAtSignInAvailable: false,
};

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent.includes(text));
}

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
    | 'getWorkerStatus'
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
      getWorkerStatus: vi.fn().mockResolvedValue(UNPAIRED),
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
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  function stubPlatform(platform: string): void {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  }

  async function renderServiceChoice(platform: string): Promise<HTMLElement> {
    stubPlatform(platform);
    pairBoth.getWorkerStatus.mockResolvedValue(status());
    pairBoth.applyManualPairing.mockResolvedValueOnce(pairedConfig);
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const component = fixture.componentInstance as unknown as {
      manualConfig: { set(value: string): void };
      applyManualConfig: () => Promise<void>;
    };
    component.manualConfig.set('config');
    await component.applyManualConfig();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('offers start plus open-at-sign-in after pairing, and no background service install', async () => {
    const root = await renderServiceChoice('Win32');

    expect(root.textContent).toContain('The worker runs while Harness is open on this computer.');
    expect(root.textContent).toContain('Open Harness when I sign in');
    expect(buttonWithText(root, 'Start Worker')).toBeDefined();
    // A normal Harness cannot install an OS service (needs administrator
    // rights, and the Windows wrapper was never shipped), so it is not offered.
    expect(root.textContent).not.toContain('Install background service');
  });

  it('starts the worker with open-at-sign-in on by default', async () => {
    const root = await renderServiceChoice('Win32');

    buttonWithText(root, 'Start Worker')?.click();
    await fixture.whenStable();

    expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open', { openAtLogin: true });
    // The main process persists the run mode, role and sign-in choice; a second
    // renderer write could race the settings broadcast and put back stale values.
    expect(settings.update).toHaveBeenCalledTimes(1); // rememberCoordinator only
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('starts the worker without open-at-sign-in when the box is unticked', async () => {
    const root = await renderServiceChoice('MacIntel');
    const checkbox = root.querySelector<HTMLInputElement>('.check-row input');
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));

    buttonWithText(root, 'Start Worker')?.click();
    await fixture.whenStable();

    expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open', { openAtLogin: false });
  });

  it('hides the sign-in option where the OS has no login items', async () => {
    const root = await renderServiceChoice('Linux x86_64');

    expect(root.textContent).not.toContain('Open Harness when I sign in');
    buttonWithText(root, 'Start Worker')?.click();
    await fixture.whenStable();
    expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open', { openAtLogin: false });
  });

  it('toggles open-at-sign-in from the paired view', async () => {
    stubPlatform('Win32');
    const root = await renderWithStatus(status());
    const checkbox = root.querySelector<HTMLInputElement>('.check-row input');
    expect(checkbox?.checked).toBe(false);

    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(settings.set).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      role: 'worker',
      openAtLogin: true,
    }));
  });

  it('stops and unpairs from the connected state without showing pairing tokens', async () => {
    pairBoth.getWorkerStatus.mockResolvedValue(status());
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const stopButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.includes('Stop Worker')) as HTMLButtonElement;
    stopButton.click();
    await fixture.whenStable();

    const unpairButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent.includes('Unpair this computer')) as HTMLButtonElement;
    unpairButton.click();
    await fixture.whenStable();

    expect(pairBoth.stopWorker).toHaveBeenCalledTimes(1);
    expect(pairBoth.unpairWorker).toHaveBeenCalledTimes(1);
    // Unpairing keeps the role, so the page returns to the pair actions
    // instead of the full-window role picker.
    expect(settings.set).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pair With Harness');
    expect(fixture.nativeElement.textContent).not.toMatch(/token|credential/i);
  });

  async function renderWithStatus(next: WorkerModeStatus): Promise<HTMLElement> {
    pairBoth.getWorkerStatus.mockResolvedValue(next);
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('restores the paired view after a relaunch instead of asking to pair again', async () => {
    const root = await renderWithStatus(status());

    expect(root.textContent).toContain('Paired with your main Harness');
    expect(root.textContent).toContain('Working. The main Harness has accepted this computer.');
    expect(root.textContent).toContain('ws://mac:4878');
    expect(root.textContent).not.toContain('Pair With Harness');
    expect(buttonWithText(root, 'Stop Worker')).toBeDefined();
  });

  it('says when the worker is still waiting to be accepted', async () => {
    const root = await renderWithStatus(status({ enrolled: false }));

    expect(root.textContent).toContain('waiting for the main Harness to accept this computer');
  });

  it('offers Start Worker when the paired worker is stopped, and starts it', async () => {
    const root = await renderWithStatus(status({
      runtime: { state: 'stopped', error: 'The worker stopped unexpectedly (exit code 1).' },
    }));

    expect(root.textContent).toContain('The worker stopped unexpectedly (exit code 1). Start the worker to try again.');
    pairBoth.getWorkerStatus.mockResolvedValue(status());
    buttonWithText(root, 'Start Worker')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    // Restarting from the paired view leaves the sign-in choice as it was.
    expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open', {});
    expect(buttonWithText(root, 'Stop Worker')).toBeDefined();
  });

  it('hides Start/Stop when the background service owns the worker', async () => {
    const root = await renderWithStatus(status({
      backgroundService: true,
      enrolled: false,
      runtime: { state: 'service-installed' },
    }));

    expect(root.textContent).toContain('The background service runs this worker');
    expect(buttonWithText(root, 'Start Worker')).toBeUndefined();
    expect(buttonWithText(root, 'Stop Worker')).toBeUndefined();
  });

  it('Pair Again shows the pairing options and Cancel returns to the paired view', async () => {
    const root = await renderWithStatus(status());

    buttonWithText(root, 'Pair Again')?.click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Pair With Harness');

    buttonWithText(root, 'Cancel')?.click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Paired with your main Harness');
  });

  it('Turn Off Worker Mode keeps the pairing and switches the role to main Harness', async () => {
    const root = await renderWithStatus(status());

    buttonWithText(root, 'Turn Off Worker Mode')?.click();
    await fixture.whenStable();

    expect(settings.set).toHaveBeenCalledWith('workerMode', expect.objectContaining({
      role: 'coordinator',
    }));
    expect(pairBoth.unpairWorker).not.toHaveBeenCalled();
  });

  it('offers a way out of the error state', async () => {
    pairBoth.discoverCandidates.mockRejectedValueOnce(new Error('Pairing failed'));
    const root = fixture.nativeElement as HTMLElement;
    buttonWithText(root, 'Pair With Harness')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('Pairing failed');

    buttonWithText(root, 'Try Again')?.click();
    fixture.detectChanges();

    expect(root.textContent).toContain('Pair With Harness');
  });

  it('refreshes the paired status while the page is open', async () => {
    vi.useFakeTimers();
    pairBoth.getWorkerStatus.mockResolvedValue(status({ enrolled: false }));
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('waiting for the main Harness');

    pairBoth.getWorkerStatus.mockResolvedValue(status({ enrolled: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('The main Harness has accepted this computer.');
    fixture.destroy();
    const callsAfterDestroy = pairBoth.getWorkerStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pairBoth.getWorkerStatus.mock.calls.length).toBe(callsAfterDestroy);
  });

  it('ignores a status reply that started before an unpair finished', async () => {
    const root = await renderWithStatus(status());
    let resolveStalePoll: (value: WorkerModeStatus) => void = () => undefined;
    pairBoth.getWorkerStatus
      .mockImplementationOnce(() => new Promise<WorkerModeStatus>((resolve) => { resolveStalePoll = resolve; }))
      .mockResolvedValue(UNPAIRED);

    // A poll is in flight (Stop Worker refreshes status) when Unpair runs.
    buttonWithText(root, 'Stop Worker')?.click();
    buttonWithText(root, 'Unpair this computer')?.click();
    await fixture.whenStable();
    resolveStalePoll(status());
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root.textContent).toContain('Pair With Harness');
    expect(buttonWithText(root, 'Cancel')).toBeUndefined();
  });

  it('returns to the pair actions when the pairing disappears while connected', async () => {
    vi.useFakeTimers();
    pairBoth.getWorkerStatus.mockResolvedValue(status());
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Paired with your main Harness');

    pairBoth.getWorkerStatus.mockResolvedValue(UNPAIRED);
    await vi.advanceTimersByTimeAsync(5_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Pair With Harness');
    expect(fixture.nativeElement.textContent).not.toContain('Paired with your main Harness');
  });

  it('keeps the paired view when one status check fails', async () => {
    vi.useFakeTimers();
    pairBoth.getWorkerStatus.mockResolvedValue(status());
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    pairBoth.getWorkerStatus.mockRejectedValueOnce(new Error('Unexpected end of JSON input'));
    await vi.advanceTimersByTimeAsync(5_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Paired with your main Harness');
    expect(fixture.nativeElement.textContent).not.toContain('Unexpected end of JSON input');
  });

  it('re-checks the saved pairing on Try Again when the first check failed', async () => {
    pairBoth.getWorkerStatus.mockRejectedValueOnce(new Error('Failed to read worker status'));
    fixture = TestBed.createComponent(WorkerModeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Failed to read worker status');

    pairBoth.getWorkerStatus.mockResolvedValue(status());
    buttonWithText(root, 'Try Again')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root.textContent).toContain('Paired with your main Harness');
    expect(root.textContent).not.toContain('Pair With Harness');
  });

  describe('keeping the worker running with Harness closed (Windows)', () => {
    const windowsStatus = (overrides: Partial<WorkerModeStatus> = {}) => status({ runAtSignInAvailable: true, ...overrides });

    async function renderWindowsChoice(): Promise<HTMLElement> {
      stubPlatform('Win32');
      pairBoth.getWorkerStatus.mockResolvedValue(windowsStatus());
      pairBoth.applyManualPairing.mockResolvedValueOnce(pairedConfig);
      fixture = TestBed.createComponent(WorkerModeComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      const component = fixture.componentInstance as unknown as {
        manualConfig: { set(value: string): void };
        applyManualConfig: () => Promise<void>;
      };
      component.manualConfig.set('config');
      await component.applyManualConfig();
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    it('recommends keeping the worker running with Harness closed after pairing', async () => {
      const root = await renderWindowsChoice();

      expect(root.textContent).toContain('How should this worker run?');
      expect(buttonWithText(root, 'Keep working when Harness is closed')).toBeDefined();
      expect(buttonWithText(root, 'Only while Harness is open')).toBeDefined();
      expect(buttonWithText(root, 'Cancel')).toBeUndefined();

      buttonWithText(root, 'Keep working when Harness is closed')?.click();
      await fixture.whenStable();

      expect(pairBoth.runWorker).toHaveBeenCalledWith('sign-in-task', {});
    });

    it('still offers the Harness-open mode with the sign-in option', async () => {
      const root = await renderWindowsChoice();

      buttonWithText(root, 'Only while Harness is open')?.click();
      await fixture.whenStable();

      expect(pairBoth.runWorker).toHaveBeenCalledWith('run-while-open', { openAtLogin: true });
    });

    it('describes the background worker and restarts it through the sign-in task', async () => {
      stubPlatform('Win32');
      const root = await renderWithStatus(windowsStatus({ runAtSignIn: true, runtime: { state: 'stopped' } }));

      expect(root.textContent).toContain('The background worker is stopped. Press Start Worker');
      expect(root.textContent).not.toContain('Open Harness when I sign in');
      buttonWithText(root, 'Start Worker')?.click();
      await fixture.whenStable();

      expect(pairBoth.runWorker).toHaveBeenCalledWith('sign-in-task', {});
    });

    it('says the background worker is starting until it reports in', async () => {
      const root = await renderWindowsChoice();
      pairBoth.getWorkerStatus.mockResolvedValue(windowsStatus({ runAtSignIn: true, runtime: { state: 'stopped' } }));

      buttonWithText(root, 'Keep working when Harness is closed')?.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(root.textContent).toContain('Starting the background worker...');
      expect(buttonWithText(root, 'Stop Worker')).toBeDefined();
      expect(buttonWithText(root, 'Start Worker')).toBeUndefined();
    });

    it('reports a running background worker that the main Harness accepted', async () => {
      stubPlatform('Win32');
      const root = await renderWithStatus(windowsStatus({ runAtSignIn: true }));

      expect(root.textContent).toContain('Working in the background, even with Harness closed.');
      expect(buttonWithText(root, 'Stop Worker')).toBeDefined();
    });

    it('lets a paired computer change how the worker runs, and back out', async () => {
      stubPlatform('Win32');
      const root = await renderWithStatus(windowsStatus());

      buttonWithText(root, 'Change How It Runs')?.click();
      fixture.detectChanges();
      expect(root.textContent).toContain('How should this worker run?');

      buttonWithText(root, 'Cancel')?.click();
      fixture.detectChanges();
      expect(root.textContent).toContain('Paired with your main Harness');
      expect(root.textContent).not.toContain('How should this worker run?');
    });
  });
});

