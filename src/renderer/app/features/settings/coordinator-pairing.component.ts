import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import QRCode from 'qrcode';
import {
  PairBothIpcService,
  type PairBothCoordinatorStartResult,
} from '../../core/services/ipc/pair-both-ipc.service';
import type { PairBothSessionState } from '../../../../shared/types/pair-both.types';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

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
          <p class="hint">Open Harness on the other computer, choose worker mode, then paste this invitation.</p>
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
        <div class="pair-notice success">Pairing approved. The worker can now register normally.</div>
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

  protected readonly uiState = signal<CoordinatorPairingUiState>('idle');
  protected readonly active = signal<PairBothCoordinatorStartResult | null>(null);
  protected readonly session = signal<PairBothSessionState | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly qrCodeDataUrl = signal('');
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy(): void {
    this.clearPoll();
  }

  protected async startPairing(): Promise<void> {
    this.error.set(null);
    try {
      const active = await this.pairBoth.startCoordinatorPairing();
      this.active.set(active);
      this.session.set(active.state);
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

  private clearPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private showError(error: unknown): void {
    this.error.set(error instanceof Error ? error.message : String(error));
    this.uiState.set('error');
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
      this.uiState.set('completed');
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
