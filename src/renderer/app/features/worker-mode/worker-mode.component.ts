import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import {
  PairBothIpcService,
  type PairBothWorkerConfigSummary,
  type PairBothWorkerPairingState,
  type PairBothWorkerRunMode,
} from '../../core/services/ipc/pair-both-ipc.service';
import type {
  PairBothCandidate,
  WorkerModeStatus,
} from '../../../../shared/types/pair-both.types';

const STATUS_POLL_INTERVAL_MS = 5_000;
/** How long a just-started sign-in worker may take to take its lock. */
const SIGN_IN_START_GRACE_MS = 30_000;

type WorkerModeState =
  | 'loading'
  | 'idle'
  | 'looking'
  | 'selecting'
  | 'service-choice'
  | 'confirming'
  | 'waiting-approval'
  | 'connected'
  | 'manual'
  | 'error';

@Component({
  standalone: true,
  selector: 'app-worker-mode',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="worker-mode-shell" aria-label="Worker Mode">
      @if (error()) {
        <div class="notice error" role="alert">{{ error() }}</div>
      }

      @if (networkHelp()) {
        <div class="notice guidance" role="status">{{ networkHelp() }}</div>
      }

      @if (state() === 'loading') {
        <div class="status-panel" role="status">Checking this computer's pairing...</div>
      }

      @if (state() === 'idle') {
        <div class="action-panel">
          <p class="panel-intro">
            Pair this computer with your main Harness. You can keep using Harness here while it works.
          </p>
          <button class="primary-action" type="button" (click)="pairWithHarness()">
            Pair With Harness
          </button>
          <div class="button-row">
            <button class="secondary-small" type="button" (click)="state.set('manual')">
              Paste Invitation
            </button>
            @if (pairedConfig()) {
              <button class="secondary-small" type="button" (click)="resetPairing()">Cancel</button>
            }
          </div>
        </div>
      }

      @if (state() === 'looking') {
        <div class="status-panel" role="status">
          <strong>Looking for Harness on your network...</strong>
          <span>{{ osPermissionCopy() }}</span>
        </div>
      }

      @if (state() === 'selecting') {
        <div class="candidate-list">
          @for (candidate of candidates(); track candidate.id) {
            <button class="candidate-row" type="button" (click)="connect(candidate)">
              <span class="candidate-name">Found {{ candidate.friendlyName }}</span>
              <span class="candidate-detail">{{ candidate.host }}:{{ candidate.port }}</span>
            </button>
          }
        </div>
      }

      @if (state() === 'manual') {
        <div class="manual-panel">
          <label class="field-label" for="worker-invitation">Pairing invitation</label>
          <textarea
            id="worker-invitation"
            class="text-area"
            [value]="manualInvitation()"
            (input)="manualInvitation.set($any($event.target).value)"
          ></textarea>
          <div class="button-row">
            <button class="primary-small" type="button" (click)="connectFromInvitation()">
              Connect
            </button>
            <button class="secondary-small" type="button" (click)="resetPairing()">Cancel</button>
          </div>
        </div>
      }

      @if (state() === 'confirming' && pairingState(); as pairing) {
        <div class="code-panel">
          <span class="code-label">Confirm the code matches on both computers</span>
          <strong class="pairing-code">{{ pairing.shortCode }}</strong>
          <div class="button-row">
            <button class="primary-small" type="button" (click)="confirmCode()">Code Matches</button>
            <button class="secondary-small" type="button" (click)="resetPairing()">Cancel</button>
          </div>
        </div>
      }

      @if (state() === 'waiting-approval') {
        <div class="status-panel" role="status">Waiting for approval on the main Harness...</div>
      }

      @if (state() === 'error') {
        <div class="button-row">
          <button class="secondary-small" type="button" (click)="tryAgain()">Try Again</button>
        </div>
      }

      @if (state() === 'service-choice' && pairedConfig()) {
        <div class="connected-panel">
          <h2>Paired with your main Harness</h2>
          @if (workerStatus()?.runAtSignInAvailable) {
            <p>How should this worker run?</p>
            <div class="button-row">
              <button class="primary-small" type="button" (click)="chooseRunAtSignIn()">
                Keep working when Harness is closed
              </button>
            </div>
            <p class="field-label">
              Recommended. Starts when you sign in to Windows and restarts itself if it stops.
            </p>
            <p>Or run it only while Harness is open on this computer:</p>
          } @else {
            <p>This computer is paired. The worker runs while Harness is open on this computer.</p>
          }
          @if (canOpenAtLogin) {
            <label class="check-row">
              <input
                type="checkbox"
                [checked]="openAtLoginChoice()"
                (change)="openAtLoginChoice.set($any($event.target).checked)"
              />
              Open Harness when I sign in, so this computer keeps working after a restart
            </label>
          }
          <div class="button-row">
            <button
              type="button"
              [class.primary-small]="!workerStatus()?.runAtSignInAvailable"
              [class.secondary-small]="workerStatus()?.runAtSignInAvailable"
              (click)="chooseRunWhileOpen()"
            >
              {{ workerStatus()?.runAtSignInAvailable ? 'Only while Harness is open' : 'Start Worker' }}
            </button>
            @if (runChoiceReopened()) {
              <button class="secondary-small" type="button" (click)="resetPairing()">Cancel</button>
            }
          </div>
        </div>
      }

      @if (state() === 'connected' && pairedConfig(); as config) {
        <div class="connected-panel">
          <h2>Paired with your main Harness</h2>
          <p class="worker-status" [class.status-warning]="statusIsWarning()" role="status">
            {{ statusLine() }}
          </p>
          @if (canOpenAtLogin && !workerStatus()?.backgroundService && !workerStatus()?.runAtSignIn) {
            <label class="check-row">
              <input
                type="checkbox"
                [checked]="settings.workerMode().openAtLogin === true"
                (change)="setOpenAtLogin($any($event.target).checked)"
              />
              Open Harness when I sign in
            </label>
          }
          <div class="connection-meta">
            @if (config.coordinatorUrl) {
              <span>{{ config.coordinatorUrl }}</span>
            }
            @if (config.name) {
              <span>{{ config.name }}</span>
            }
            <span>{{ config.namespace }}</span>
          </div>
          <div class="button-row">
            @if (!workerStatus()?.backgroundService) {
              @if (workerRunning() || signInStarting()) {
                <button class="primary-small" type="button" (click)="stopWorker()">Stop Worker</button>
              } @else {
                <button class="primary-small" type="button" (click)="startWorker()">Start Worker</button>
              }
            }
            @if (workerStatus()?.runAtSignInAvailable) {
              <button class="secondary-small" type="button" (click)="changeRunMode()">
                Change How It Runs
              </button>
            }
            <button class="secondary-small" type="button" (click)="pairAgain()">Pair Again</button>
            <button class="secondary-small" type="button" (click)="unpairWorker()">
              Unpair this computer
            </button>
            @if (settings.workerMode().role === 'worker') {
              <button class="secondary-small" type="button" (click)="turnOffWorkerMode()">
                Turn Off Worker Mode
              </button>
            }
          </div>
        </div>
      }

      <details class="advanced-panel">
        <summary>Advanced pairing</summary>
        <label class="field-label" for="manual-config">Pairing link or canonical config</label>
        <textarea
          id="manual-config"
          class="text-area"
          [value]="manualConfig()"
          (input)="manualConfig.set($any($event.target).value)"
        ></textarea>
        <button class="secondary-small" type="button" (click)="applyManualConfig()">
          Apply Pairing Details
        </button>
      </details>
    </section>
  `,
  styleUrl: './worker-mode.component.scss',
})
export class WorkerModeComponent {
  private readonly pairBoth = inject(PairBothIpcService);
  protected readonly settings = inject(SettingsStore);

  protected readonly state = signal<WorkerModeState>('loading');
  protected readonly candidates = signal<PairBothCandidate[]>([]);
  protected readonly pairingState = signal<PairBothWorkerPairingState | null>(null);
  protected readonly pairedConfig = signal<PairBothWorkerConfigSummary | null>(null);
  protected readonly workerStatus = signal<WorkerModeStatus | null>(null);
  protected readonly manualInvitation = signal('');
  protected readonly manualConfig = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly networkHelp = signal<string | null>(null);
  protected readonly openAtLoginChoice = signal(true);
  /** The run-mode choice was reopened from the paired view, so it offers Cancel. */
  protected readonly runChoiceReopened = signal(false);
  /**
   * Electron login items exist on Windows and macOS only. (A Windows/macOS OS
   * service install needs administrator rights a normal Harness does not have,
   * so it is no longer offered here; the worker CLI still installs one.)
   */
  protected readonly canOpenAtLogin = /mac|win/i.test(navigator.platform);
  /** When the sign-in worker was last started from this page (see SIGN_IN_START_GRACE_MS). */
  private readonly signInStartedAt = signal<number | null>(null);
  /** Only the newest status request may update the view. */
  private statusRequestId = 0;

  protected readonly workerRunning = computed(() => this.workerStatus()?.runtime.state === 'running');

  /**
   * The sign-in worker reports "running" only once it holds its lock, a few
   * seconds after the task starts it. Until then say it is starting rather
   * than stopped (and offer Stop, not a second Start).
   */
  protected readonly signInStarting = computed(() => {
    const status = this.workerStatus();
    const startedAt = this.signInStartedAt();
    return Boolean(
      status?.runAtSignIn
      && status.runtime.state !== 'running'
      && startedAt !== null
      && Date.now() - startedAt < SIGN_IN_START_GRACE_MS,
    );
  });

  protected readonly statusIsWarning = computed(() => {
    const status = this.workerStatus();
    if (!status || status.backgroundService || this.signInStarting()) {
      return false;
    }
    return status.runtime.state !== 'running' || !status.enrolled;
  });

  protected readonly statusLine = computed(() => {
    const status = this.workerStatus();
    if (!status) {
      return 'Checking the worker...';
    }
    if (status.backgroundService) {
      return 'The background service runs this worker, even when Harness is closed.';
    }
    if (status.runAtSignIn) {
      if (this.signInStarting()) {
        return 'Starting the background worker...';
      }
      if (status.runtime.state !== 'running') {
        return 'The background worker is stopped. Press Start Worker to start it; it then also starts whenever you sign in to Windows.';
      }
      return status.enrolled
        ? 'Working in the background, even with Harness closed. The main Harness has accepted this computer.'
        : 'Running in the background and waiting for the main Harness to accept this computer. If this does not change within a minute, pair again.';
    }
    if (status.runtime.state === 'running') {
      return status.enrolled
        ? 'Working. The main Harness has accepted this computer.'
        : 'Starting up and waiting for the main Harness to accept this computer. If this does not change within a minute, pair again.';
    }
    if (status.runtime.error) {
      return `${status.runtime.error} Start the worker to try again.`;
    }
    return 'The worker is stopped. Start it to take work from the main Harness.';
  });

  constructor() {
    void this.refreshStatus({ restoreState: true });
    // Keep the connected view honest: the worker can be accepted, crash, or be
    // stopped elsewhere (role change, quit-time cleanup) while this page is open.
    const timer = setInterval(() => {
      if (this.state() === 'connected') {
        void this.refreshStatus();
      }
    }, STATUS_POLL_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async pairWithHarness(): Promise<void> {
    this.error.set(null);
    this.networkHelp.set(this.osPermissionCopy());
    this.state.set('looking');
    try {
      const candidates = await this.pairBoth.discoverCandidates();
      this.candidates.set(candidates);
      if (candidates.length > 0) {
        this.networkHelp.set(null);
        this.state.set('selecting');
      } else {
        this.networkHelp.set(
          'Harness could not find another computer on this network. Show the QR code on the main Harness, or paste its pairing invitation here.',
        );
        this.state.set('manual');
      }
    } catch (error) {
      this.showError(error);
    }
  }

  protected async connect(candidate: PairBothCandidate): Promise<void> {
    this.error.set(null);
    try {
      this.pairingState.set(await this.pairBoth.connectWorker(candidate));
      this.state.set('confirming');
    } catch (error) {
      this.showError(error);
    }
  }

  protected async connectFromInvitation(): Promise<void> {
    try {
      await this.connect(this.pairBoth.parseInvitation(this.manualInvitation()));
    } catch (error) {
      this.showError(error);
    }
  }

  protected async confirmCode(): Promise<void> {
    this.error.set(null);
    this.state.set('waiting-approval');
    try {
      await this.pairBoth.confirmWorkerCode();
      const config = await this.pairBoth.waitForWorkerResult();
      this.pairedConfig.set(config);
      await this.rememberCoordinator(config);
      this.state.set('service-choice');
    } catch (error) {
      this.showError(error);
    }
  }

  protected async applyManualConfig(): Promise<void> {
    this.error.set(null);
    try {
      const config = await this.pairBoth.applyManualPairing(this.manualConfig());
      this.pairedConfig.set(config);
      await this.rememberCoordinator(config);
      this.state.set('service-choice');
    } catch (error) {
      this.showError(error);
    }
  }

  /** Leave whatever pairing step is showing and return to the saved state. */
  protected resetPairing(): void {
    this.error.set(null);
    this.runChoiceReopened.set(false);
    this.networkHelp.set(null);
    this.pairingState.set(null);
    this.candidates.set([]);
    this.manualInvitation.set('');
    this.state.set(this.pairedConfig() ? 'connected' : 'idle');
  }

  /**
   * Leave the error state. If the saved pairing was never read (the first
   * status check failed), check again rather than assuming "unpaired".
   */
  protected tryAgain(): void {
    if (this.workerStatus() === null && this.pairedConfig() === null) {
      this.error.set(null);
      this.state.set('loading');
      void this.refreshStatus({ restoreState: true });
      return;
    }
    this.resetPairing();
  }

  /** Show the pairing options again; the current pairing stays until a new one lands. */
  protected pairAgain(): void {
    this.resetPairing();
    this.state.set('idle');
  }

  // The run-mode IPC persists workerMode (role, launch and service flags) in
  // the main process. Writing it again from here raced the settings-changed
  // broadcast and could write a stale role back, which stops the worker.
  protected async chooseRunWhileOpen(): Promise<void> {
    await this.runWorker('run-while-open', 'service-choice', {
      openAtLogin: this.canOpenAtLogin && this.openAtLoginChoice(),
    });
  }

  /** Windows: hand the worker to a sign-in task so it runs with Harness closed. */
  protected async chooseRunAtSignIn(): Promise<void> {
    await this.runWorker('sign-in-task', 'service-choice');
  }

  protected async startWorker(): Promise<void> {
    await this.runWorker(this.workerStatus()?.runAtSignIn ? 'sign-in-task' : 'run-while-open', 'connected');
  }

  /** Show the run-mode choice again for an already paired computer. */
  protected changeRunMode(): void {
    this.error.set(null);
    this.runChoiceReopened.set(true);
    this.state.set('service-choice');
  }

  protected async stopWorker(): Promise<void> {
    this.error.set(null);
    this.signInStartedAt.set(null);
    try {
      await this.pairBoth.stopWorker();
    } catch (error) {
      this.error.set(this.toFriendlyPairingError(error));
    }
    await this.refreshStatus();
  }

  protected async unpairWorker(): Promise<void> {
    this.error.set(null);
    try {
      await this.pairBoth.unpairWorker();
      this.pairedConfig.set(null);
      this.state.set('idle');
    } catch (error) {
      this.showError(error);
    }
    // Also supersedes any poll that started before the unpair finished.
    await this.refreshStatus();
  }

  protected async setOpenAtLogin(openAtLogin: boolean): Promise<void> {
    this.error.set(null);
    try {
      await this.settings.set('workerMode', {
        ...this.settings.workerMode(),
        openAtLogin,
      });
    } catch (error) {
      this.error.set(this.toFriendlyPairingError(error));
    }
  }

  /** Keep the pairing saved but stop being a worker until switched back on. */
  protected async turnOffWorkerMode(): Promise<void> {
    this.error.set(null);
    try {
      await this.settings.set('workerMode', {
        ...this.settings.workerMode(),
        role: 'coordinator',
      });
    } catch (error) {
      this.error.set(this.toFriendlyPairingError(error));
    }
    await this.refreshStatus();
  }

  private async runWorker(
    mode: PairBothWorkerRunMode,
    stateOnFailure: Extract<WorkerModeState, 'connected' | 'service-choice'>,
    options: { openAtLogin?: boolean } = {},
  ): Promise<void> {
    this.error.set(null);
    try {
      await this.pairBoth.runWorker(mode, options);
      this.signInStartedAt.set(mode === 'sign-in-task' ? Date.now() : null);
      this.runChoiceReopened.set(false);
      this.state.set('connected');
    } catch (error) {
      this.error.set(this.toFriendlyPairingError(error));
      this.state.set(stateOnFailure);
    }
    await this.refreshStatus();
  }

  private async refreshStatus(options: { restoreState?: boolean } = {}): Promise<void> {
    const requestId = ++this.statusRequestId;
    let status: WorkerModeStatus | null;
    try {
      status = await this.pairBoth.getWorkerStatus();
    } catch (error) {
      if (options.restoreState && requestId === this.statusRequestId) {
        this.showError(error);
      }
      return;
    }
    if (requestId !== this.statusRequestId) {
      return;
    }
    this.workerStatus.set(status);
    if (status?.paired && status.config) {
      this.pairedConfig.set({ ...status.config, runtime: status.runtime });
    } else if (status && !status.paired) {
      // Unpaired elsewhere (or the config was removed): drop the stale view.
      this.pairedConfig.set(null);
      if (this.state() === 'connected') {
        this.state.set('idle');
      }
    }
    if (options.restoreState && this.state() === 'loading') {
      this.state.set(status?.paired ? 'connected' : 'idle');
    }
  }

  private async rememberCoordinator(config: PairBothWorkerConfigSummary): Promise<void> {
    await this.settings.update({
      workerMode: {
        ...this.settings.workerMode(),
        lastCoordinatorName: config.name,
        lastCoordinatorUrl: config.coordinatorUrl ?? '',
      },
    });
  }

  private showError(error: unknown): void {
    this.error.set(this.toFriendlyPairingError(error));
    this.state.set('error');
  }

  protected osPermissionCopy(): string {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('mac')) {
      return 'macOS may ask whether Harness can find devices on your local network. Allow it so this computer can find your other Harness machine.';
    }
    if (platform.includes('win')) {
      return 'Windows may ask whether Harness can accept private network connections. Allow private networks so your other computer can pair.';
    }
    return 'Your operating system or firewall may ask for local network access. Allow it so Harness can find your other computer.';
  }

  private toFriendlyPairingError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/discover|bonjour|mdns|network|permission|firewall/i.test(message)) {
      return `${message} Try QR or paste pairing if local network discovery is blocked.`;
    }
    return message;
  }
}
