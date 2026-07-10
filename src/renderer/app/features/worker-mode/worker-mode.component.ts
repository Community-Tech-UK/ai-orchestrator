import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import {
  PairBothIpcService,
  type PairBothWorkerConfigSummary,
  type PairBothWorkerPairingState,
} from '../../core/services/ipc/pair-both-ipc.service';
import type { PairBothCandidate } from '../../../../shared/types/pair-both.types';

type WorkerModeState =
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
    <section class="worker-mode-shell" aria-labelledby="worker-mode-title">
      <header class="worker-mode-header">
        <div>
          <h1 id="worker-mode-title">Worker Mode</h1>
          <p class="worker-mode-subtitle">{{ subtitle() }}</p>
        </div>
        <button class="text-button" type="button" (click)="switchRole()">Switch Role</button>
      </header>

      @if (error()) {
        <div class="notice error" role="alert">{{ error() }}</div>
      }

      @if (networkHelp()) {
        <div class="notice guidance" role="status">{{ networkHelp() }}</div>
      }

      @if (state() === 'idle') {
        <div class="action-panel">
          <button class="primary-action" type="button" (click)="pairWithHarness()">
            Pair With Harness
          </button>
          <button class="secondary-action" type="button" (click)="state.set('manual')">
            Paste Invitation
          </button>
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

      @if (state() === 'service-choice' && pairedConfig(); as config) {
        <div class="connected-panel">
          <h2>Connected to {{ config.name }}</h2>
          <p>This computer is paired. How should this worker run?</p>
          <div class="button-row">
            <button class="primary-small" type="button" (click)="chooseRunWhileOpen()">
              Run while Harness is open
            </button>
            <button class="secondary-small" type="button" (click)="chooseBackgroundService()">
              Install background service
            </button>
          </div>
          <p class="field-label">Background service install may ask for administrator permission.</p>
        </div>
      }

      @if (state() === 'connected' && pairedConfig(); as config) {
        <div class="connected-panel">
          <h2>Connected to {{ config.name }}</h2>
          <p>This computer is ready for work.</p>
          <div class="connection-meta">
            <span>{{ config.coordinatorUrl }}</span>
            <span>{{ config.namespace }}</span>
            <span>{{ config.maxConcurrentInstances }} slots</span>
          </div>
          <div class="button-row">
            <button class="primary-small" type="button" (click)="stopWorker()">Stop Worker</button>
            <button class="secondary-small" type="button" (click)="resetPairing()">Pair Again</button>
            <button class="secondary-small" type="button" (click)="unpairWorker()">
              Unpair this computer
            </button>
            <button class="secondary-small" type="button" (click)="switchRole()">Settings</button>
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
  styles: [`
    .worker-mode-shell {
      width: 100%;
      min-height: 100%;
      padding: 32px;
      box-sizing: border-box;
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .worker-mode-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      max-width: 980px;
    }

    h1,
    h2,
    p {
      margin: 0;
      letter-spacing: 0;
    }

    h1 {
      font-size: 28px;
      font-weight: 650;
    }

    h2 {
      font-size: 20px;
      font-weight: 650;
    }

    .worker-mode-subtitle,
    .candidate-detail,
    .field-label,
    .connected-panel p {
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .action-panel,
    .status-panel,
    .manual-panel,
    .code-panel,
    .connected-panel,
    .candidate-list,
    .advanced-panel {
      width: min(720px, 100%);
    }

    .action-panel,
    .manual-panel,
    .code-panel,
    .connected-panel,
    .advanced-panel {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-secondary);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .status-panel,
    .notice {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-secondary);
      padding: 14px 16px;
      font-size: 0.9375rem;
    }

    .notice.error {
      border-color: var(--pill-error-border);
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }

    .notice.guidance {
      border-color: var(--pill-warn-border, var(--border-color));
      background: var(--pill-warn-bg, var(--bg-secondary));
      color: var(--pill-warn-fg, var(--text-primary));
    }

    .status-panel {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .primary-action,
    .secondary-action,
    .primary-small,
    .secondary-small,
    .text-button,
    .candidate-row {
      font: inherit;
      border-radius: 6px;
      cursor: pointer;
    }

    .primary-action {
      min-height: 72px;
      border: none;
      background: var(--primary-color);
      color: var(--button-on-primary);
      font-size: 18px;
      font-weight: 650;
    }

    .secondary-action,
    .primary-small,
    .secondary-small,
    .text-button {
      min-height: 36px;
      padding: 0 14px;
    }

    .secondary-action,
    .secondary-small,
    .text-button {
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .primary-small {
      border: none;
      background: var(--primary-color);
      color: var(--button-on-primary);
      font-weight: 650;
    }

    .text-button {
      align-self: flex-start;
    }

    .candidate-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .candidate-row {
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: inherit;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }

    .candidate-name {
      font-size: 16px;
      font-weight: 650;
    }

    .text-area {
      min-height: 112px;
      resize: vertical;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 10px;
      font: 0.8125rem var(--font-family-mono, monospace);
    }

    .button-row,
    .connection-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .code-label {
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .pairing-code {
      font: 700 42px var(--font-family-mono, monospace);
      letter-spacing: 0;
    }

    .connection-meta span {
      border: 1px solid var(--border-color);
      border-radius: 999px;
      padding: 4px 10px;
      color: var(--text-muted);
      font-size: 0.75rem;
    }

    .advanced-panel summary {
      cursor: pointer;
      font-weight: 650;
    }
  `],
})
export class WorkerModeComponent {
  private readonly pairBoth = inject(PairBothIpcService);
  private readonly settings = inject(SettingsStore);

  protected readonly state = signal<WorkerModeState>('idle');
  protected readonly candidates = signal<PairBothCandidate[]>([]);
  protected readonly pairingState = signal<PairBothWorkerPairingState | null>(null);
  protected readonly pairedConfig = signal<PairBothWorkerConfigSummary | null>(null);
  protected readonly manualInvitation = signal('');
  protected readonly manualConfig = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly networkHelp = signal<string | null>(null);

  protected subtitle(): string {
    if (this.pairedConfig()) {
      return 'This computer is connected as a worker.';
    }
    return 'Connect this computer to a main Harness.';
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

  protected resetPairing(): void {
    this.error.set(null);
    this.networkHelp.set(null);
    this.pairingState.set(null);
    this.candidates.set([]);
    this.manualInvitation.set('');
    this.state.set(this.pairedConfig() ? 'connected' : 'idle');
  }

  protected async chooseRunWhileOpen(): Promise<void> {
    this.error.set(null);
    try {
      const runtime = await this.pairBoth.runWorker('run-while-open');
      await this.settings.update({
        workerMode: {
          ...this.settings.workerMode(),
          startWorkerOnLaunch: true,
          installWorkerService: false,
        },
      });
      this.setRuntime(runtime);
      this.state.set('connected');
    } catch (error) {
      this.showError(error);
    }
  }

  protected async chooseBackgroundService(): Promise<void> {
    this.error.set(null);
    try {
      const runtime = await this.pairBoth.runWorker('background-service');
      await this.settings.update({
        workerMode: {
          ...this.settings.workerMode(),
          startWorkerOnLaunch: false,
          installWorkerService: true,
        },
      });
      this.setRuntime(runtime);
      this.state.set('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error.set(this.toFriendlyPairingError(message));
      this.state.set('service-choice');
    }
  }

  protected async stopWorker(): Promise<void> {
    this.error.set(null);
    try {
      await this.pairBoth.stopWorker();
    } catch (error) {
      this.showError(error);
    }
  }

  protected async unpairWorker(): Promise<void> {
    this.error.set(null);
    try {
      await this.pairBoth.unpairWorker();
      this.pairedConfig.set(null);
      await this.settings.set('workerMode', {
        ...this.settings.workerMode(),
        role: 'unset',
        lastCoordinatorName: undefined,
        lastCoordinatorUrl: undefined,
      });
      this.state.set('idle');
    } catch (error) {
      this.showError(error);
    }
  }

  protected async switchRole(): Promise<void> {
    await this.settings.set('workerMode', {
      ...this.settings.workerMode(),
      role: 'unset',
    });
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

  private setRuntime(runtime: PairBothWorkerConfigSummary['runtime']): void {
    const config = this.pairedConfig();
    if (config) {
      this.pairedConfig.set({ ...config, runtime });
    }
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.error.set(this.toFriendlyPairingError(message));
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

  private toFriendlyPairingError(message: string): string {
    if (/discover|bonjour|mdns|network|permission|firewall/i.test(message)) {
      return `${message} Try QR or paste pairing if local network discovery is blocked.`;
    }
    return message;
  }
}
