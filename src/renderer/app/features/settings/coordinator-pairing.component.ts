import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import QRCode from 'qrcode';
import {
  PairBothIpcService,
  type PairBothCoordinatorStartResult,
} from '../../core/services/ipc/pair-both-ipc.service';
import type { PairBothSessionState } from '../../../../shared/types/pair-both.types';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';

/**
 * After pairing, refresh the node list this often until the paired computer
 * shows up (or ten minutes pass): the store's live updates may not be running
 * if its first load failed.
 */
const WATCH_INTERVAL_MS = 5_000;
const WATCH_ATTEMPTS = 120;

type CoordinatorPairingUiState =
  | 'idle'
  | 'waiting'
  | 'confirming'
  | 'approved-waiting'
  | 'completed'
  | 'error';

@Component({
  standalone: true,
  selector: 'app-coordinator-pairing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="pair-both-card" aria-labelledby="pair-both-title">
      <div class="card-row">
        <div>
          <h4 id="pair-both-title">Pair Another Computer</h4>
          <p class="hint">
            Open Harness on the other computer and choose worker mode. Windows may ask whether
            Harness can accept private network connections; allow private networks so the worker can pair.
          </p>
        </div>
        @if (uiState() === 'idle' || uiState() === 'completed' || uiState() === 'error') {
          <button class="btn btn-primary" type="button" (click)="startPairing()">Pair Another Computer</button>
        } @else {
          <button class="btn btn-secondary" type="button" (click)="stopPairing()">Stop Pairing</button>
        }
      </div>

      @if (error()) {
        <div class="pair-notice error">{{ error() }}</div>
      }

      @if (discoveryNotice()) {
        <div class="pair-notice warn">{{ discoveryNotice() }}</div>
      }

      @if (uiState() === 'waiting' && active(); as activePairing) {
        <div class="pair-notice">
          <strong>Waiting for a worker...</strong>
          <span>Pairing expires {{ formatExpiry(activePairing.state.expiresAt) }}.</span>
        </div>
        <div class="invitation-box">
          @if (qrCodeDataUrl()) {
            <img class="invitation-qr" [src]="qrCodeDataUrl()" alt="Pairing invitation QR code">
          }
          <textarea class="invitation-text" readonly [value]="activePairing.invitation"></textarea>
          <button class="btn btn-secondary small" type="button" (click)="copyInvitation()">Copy Invitation</button>
        </div>
      }

      @if (uiState() === 'confirming' && session(); as sessionState) {
        <div class="confirm-box">
          <span class="hint">{{ sessionState.workerHello?.machineName ?? 'Worker' }} wants to pair</span>
          <strong class="pair-code">{{ sessionState.shortCode }}</strong>
          <div class="button-row">
            <button class="btn btn-primary" type="button" (click)="approve(sessionState.sessionId)">
              Approve {{ sessionState.workerHello?.machineName ?? 'Worker' }}
            </button>
            <button class="btn btn-secondary" type="button" (click)="reject(sessionState.sessionId)">Reject</button>
          </div>
        </div>
      }

      @if (uiState() === 'approved-waiting' && session(); as sessionState) {
        <div class="pair-notice">
          <strong>Approved {{ sessionState.workerHello?.machineName ?? 'worker' }}.</strong>
          <span>Waiting for {{ sessionState.workerHello?.machineName ?? 'the worker' }} to confirm the code.</span>
        </div>
      }

      @if (uiState() === 'completed') {
        @if (newlyConnectedNode(); as node) {
          <div class="pair-notice success" role="status">
            {{ node.name }} is connected. Your main Harness can now send it work.
          </div>
        } @else {
          <div class="pair-notice success" role="status">
            <strong>Paired with {{ pairedMachineName() }}.</strong>
            <span>Now press Start Worker on {{ pairedMachineName() }}. This message will change once it connects.</span>
          </div>
        }
      }
    </section>
  `,
  styles: [`
    .pair-both-card {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1rem;
      background: var(--bg-secondary);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .card-row,
    .button-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    h4,
    p {
      margin: 0;
      letter-spacing: 0;
    }

    h4 {
      font-size: 1rem;
      font-weight: 650;
      color: var(--text-primary);
    }

    .hint {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .btn {
      min-height: 2.25rem;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font: inherit;
      font-size: 0.875rem;
      font-weight: 500;
    }

    .btn.small {
      min-height: 1.875rem;
      padding: 0.35rem 0.75rem;
      font-size: 0.8125rem;
      align-self: flex-start;
    }

    .btn-primary {
      background: var(--primary-color);
      color: var(--button-on-primary);
    }

    .btn-secondary {
      background: var(--bg-primary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .pair-notice,
    .confirm-box,
    .invitation-box {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      padding: 0.75rem;
    }

    .pair-notice {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      color: var(--text-primary);
      font-size: 0.875rem;
    }

    .pair-notice.error {
      border-color: var(--pill-error-border);
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }

    .pair-notice.success {
      border-color: var(--pill-ok-border);
      background: var(--pill-ok-bg);
      color: var(--pill-ok-fg);
    }

    .pair-notice.warn {
      border-color: var(--pill-warn-border, var(--border-color));
      background: var(--pill-warn-bg, var(--bg-primary));
      color: var(--pill-warn-fg, var(--text-primary));
    }

    .invitation-box,
    .confirm-box {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
    }

    .invitation-qr {
      width: 176px;
      height: 176px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      background: #fff;
      padding: 8px;
      object-fit: contain;
    }

    .invitation-text {
      min-height: 84px;
      resize: vertical;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      padding: 0.5rem;
      font: 0.75rem var(--font-family-mono, monospace);
    }

    .pair-code {
      font: 700 2.25rem var(--font-family-mono, monospace);
      letter-spacing: 0;
      color: var(--text-primary);
    }
  `],
})
export class CoordinatorPairingComponent implements OnDestroy {
  private readonly pairBoth = inject(PairBothIpcService);
  private readonly clipboard = inject(CLIPBOARD_SERVICE);
  private readonly remoteNodes = inject(RemoteNodeStore);

  protected readonly uiState = signal<CoordinatorPairingUiState>('idle');
  protected readonly active = signal<PairBothCoordinatorStartResult | null>(null);
  protected readonly session = signal<PairBothSessionState | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly qrCodeDataUrl = signal('');
  protected readonly discoveryNotice = signal<string | null>(null);
  protected readonly pairedMachineName = signal('the other computer');
  /**
   * Computers already online when pairing finished. Pairing does not tell this
   * Harness the new worker's node id, so "connected" means a computer that was
   * not online then has come online since. One that goes offline (a re-paired
   * worker restarting) leaves the set, so its return counts too.
   */
  private readonly onlineAtCompletion = signal<ReadonlySet<string> | null>(null);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  protected readonly newlyConnectedNode = computed(() => {
    const before = this.onlineAtCompletion();
    if (!before) {
      return null;
    }
    // The pairing gives the worker this machine name as its node name
    // (pair-both-session-store.ts), so a match is the computer just paired.
    // Anything else coming online is some other computer: never name it.
    const paired = hostLabel(this.pairedMachineName());
    const matches = this.remoteNodes.connectedNodes()
      .filter((node) => !before.has(node.id) && hostLabel(node.name) === paired);
    // Two new computers with the same name: do not guess which one paired.
    return matches.length === 1 ? matches[0] : null;
  });

  constructor() {
    void this.remoteNodes.initialize().catch(() => undefined);
    effect(() => {
      const before = this.onlineAtCompletion();
      if (!before) {
        return;
      }
      const online = new Set(this.remoteNodes.connectedNodes().map((node) => node.id));
      const stillOnline = [...before].filter((id) => online.has(id));
      if (stillOnline.length !== before.size) {
        this.onlineAtCompletion.set(new Set(stillOnline));
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearPoll();
  }

  protected async startPairing(): Promise<void> {
    this.error.set(null);
    this.onlineAtCompletion.set(null);
    try {
      const active = await this.pairBoth.startCoordinatorPairing();
      this.active.set(active);
      this.session.set(active.state);
      this.discoveryNotice.set(active.discoveryDisabledReason ?? null);
      await this.generateInvitationQr(active.invitation);
      this.uiState.set('waiting');
      this.startPoll();
    } catch (error) {
      this.showError(error);
    }
  }

  protected async stopPairing(): Promise<void> {
    this.clearPoll();
    await this.pairBoth.stopCoordinatorPairing();
    this.active.set(null);
    this.session.set(null);
    this.qrCodeDataUrl.set('');
    this.discoveryNotice.set(null);
    this.uiState.set('idle');
  }

  protected async copyInvitation(): Promise<void> {
    const invitation = this.active()?.invitation;
    if (invitation) {
      await this.clipboard.copyText(invitation, { label: 'pairing invitation' });
    }
  }

  protected async approve(sessionId: string): Promise<void> {
    this.error.set(null);
    try {
      const latest = await this.pairBoth.approveCoordinatorPairing(sessionId);
      this.session.set(latest);
      this.applySessionUiState(latest);
    } catch (error) {
      this.showError(error);
    }
  }

  protected async reject(sessionId: string): Promise<void> {
    this.error.set(null);
    try {
      this.session.set(await this.pairBoth.rejectCoordinatorPairing(sessionId));
      this.qrCodeDataUrl.set('');
      this.uiState.set('idle');
      this.clearPoll();
    } catch (error) {
      this.showError(error);
    }
  }

  protected formatExpiry(timestamp: number): string {
    const remainingMinutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000));
    return remainingMinutes <= 1 ? 'soon' : `in ${remainingMinutes}m`;
  }

  private startPoll(): void {
    this.clearPoll();
    this.pollTimer = setInterval(() => {
      void this.refreshCoordinatorState();
    }, 1_000);
  }

  private async refreshCoordinatorState(): Promise<void> {
    const latest = await this.pairBoth.getCoordinatorState();
    if (!latest) {
      return;
    }
    this.session.set(latest);
    this.applySessionUiState(latest);
  }

  /**
   * Snapshot the computers online now, from a fresh list (the store may not
   * have loaded yet, and an empty snapshot would make every computer already
   * online look newly connected), then keep refreshing until the paired
   * computer appears.
   */
  private async watchForPairedComputer(): Promise<void> {
    for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
      }
      if (this.destroyed || this.uiState() !== 'completed' || this.newlyConnectedNode()) {
        return;
      }
      try {
        await this.remoteNodes.refresh();
      } catch {
        // Without a trustworthy list, name nobody yet; try again shortly.
        continue;
      }
      if (this.uiState() === 'completed' && !this.onlineAtCompletion()) {
        this.onlineAtCompletion.set(new Set(this.remoteNodes.connectedNodes().map((node) => node.id)));
      }
    }
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.error.set(this.toFriendlyError(message));
    this.uiState.set('error');
  }

  private toFriendlyError(message: string): string {
    if (/listen|bind|permission|firewall|network/i.test(message)) {
      return `${message} Use the QR code or copied invitation if local network pairing is blocked.`;
    }
    return message;
  }

  private async generateInvitationQr(invitation: string): Promise<void> {
    try {
      this.qrCodeDataUrl.set(await QRCode.toDataURL(invitation, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 176,
      }));
    } catch {
      this.qrCodeDataUrl.set('');
    }
  }

  private applySessionUiState(latest: PairBothSessionState): void {
    if (latest.status === 'completed' || latest.payloadDelivered) {
      const justCompleted = this.uiState() !== 'completed';
      if (justCompleted) {
        this.pairedMachineName.set(latest.workerHello?.machineName ?? 'the other computer');
      }
      this.uiState.set('completed');
      if (justCompleted) {
        void this.watchForPairedComputer();
      }
      this.clearPoll();
      return;
    }
    if (latest.status === 'confirming' && latest.shortCode && latest.workerHello) {
      this.uiState.set(
        latest.coordinatorApproved && !latest.workerConfirmed ? 'approved-waiting' : 'confirming',
      );
    }
  }
}

/** The registered node name is the exact machine name; only case and spacing at the ends can differ. */
function hostLabel(name: string): string {
  return name.trim().toLowerCase();
}
