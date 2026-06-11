import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { CodePreviewBlockComponent } from './ui/code-preview-block.component';
import type { ServiceStatus } from '../../../../shared/types/service.types';
import type {
  RemoteWorkerRepairCommand,
  RemoteWorkerRepairDiagnostic,
} from '../../../../shared/types/worker-node.types';
import type { NodeHealthEntry } from './remote-nodes-browser-automation';
import {
  formatServiceConfigStatus,
  repairActionLabel,
  shouldShowRepairDiagnostic,
} from './remote-nodes-repair-ui';

@Component({
  standalone: true,
  selector: 'app-remote-node-repair-panel',
  imports: [CodePreviewBlockComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (diagnostic(); as diagnostic) {
      @if (shouldShowRepairDiagnostic(diagnostic)) {
        <div class="repair-panel">
          @if (error()) {
            <div class="repair-error">{{ error() }}</div>
          }
          <div class="repair-panel-header">
            <span class="repair-status" [class.error]="diagnostic.status === 'depaired'">
              {{ diagnostic.status }}
            </span>
            <span>{{ repairActionLabel(diagnostic.recommendedAction) }}</span>
          </div>
          <p class="repair-hint">{{ diagnostic.summary }}</p>

          @if (diagnostic.lastRejectedRegistration) {
            <div class="repair-meta">
              <span>Rejected {{ diagnostic.lastRejectedRegistration.count }} time(s)</span>
              <span>Last rejected {{ formatRelativeTime(diagnostic.lastRejectedRegistration.lastSeenAt) }}</span>
              <span>{{ diagnostic.lastRejectedRegistration.reason }}</span>
            </div>
          }

          @if (diagnostic.coordinatorUrls.length > 0) {
            <div class="repair-meta">
              @for (url of diagnostic.coordinatorUrls; track url) {
                <span>{{ url }}</span>
              }
            </div>
          }

          @if (diagnostic.recommendedAction === 'check_connectivity') {
            <p class="repair-hint">No recent failed registration was seen. Check the remote service or network path first.</p>
          }

          @if (diagnostic.recommendedAction === 'configure_tls') {
            <p class="repair-hint warning">Repair command generation is blocked until the coordinator exposes a worker-reachable non-mTLS endpoint or the worker has separate TLS trust/client-certificate configuration.</p>
          }

          @if (diagnostic.availableActions.includes('check_service_status')) {
            <div class="repair-actions">
              <button class="repair-btn" type="button" [disabled]="busy()" (click)="checkServiceStatus()">
                Check service status
              </button>
            </div>
            @if (serviceConfigDetail()) {
              <p class="repair-hint">{{ serviceConfigDetail() }}</p>
            }
          }

          @if (diagnostic.recommendedAction === 'choose_platform') {
            <label class="repair-field">
              <span>Repair command platform</span>
              <select [value]="platformSelection()" (change)="setPlatform($any($event.target).value)">
                <option value="">Choose platform</option>
                <option value="win32">Windows</option>
              </select>
            </label>
          }

          @if (diagnostic.recommendedAction === 'copy_windows_command' || diagnostic.recommendedAction === 'choose_platform') {
            <div class="repair-actions">
              <button
                class="repair-btn primary"
                type="button"
                [disabled]="busy() || (diagnostic.recommendedAction === 'choose_platform' && platformSelection() !== 'win32')"
                (click)="generateRepairCommand()"
              >
                {{ busy() ? 'Generating...' : 'Generate repair command' }}
              </button>
            </div>
          }

          @if (command(); as command) {
            <div class="repair-meta">
              <span>Expires {{ formatExpiry(command.expiresAt) }}</span>
              <span>{{ command.configPath }}</span>
              <span>Regenerate after app restart or expiry.</span>
            </div>
            <app-code-preview-block
              label="Windows Repair Command"
              [code]="command.command"
              (copyRequested)="copyRepairCommand($event)"
            />
          }
        </div>
      }
    }
  `,
  styles: [`
    .repair-panel {
      padding: 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .repair-panel-header,
    .repair-meta,
    .repair-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .repair-status {
      padding: 0.125rem 0.5rem;
      border-radius: 12px;
      background: var(--pill-neutral-bg);
      color: var(--pill-neutral-fg);
      text-transform: capitalize;
      font-weight: 600;
    }
    .repair-status.error {
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }
    .repair-hint {
      margin: 0;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .repair-hint.warning {
      color: var(--warning-color);
    }
    .repair-error {
      padding: 0.4rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }
    .repair-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .repair-field select {
      max-width: 240px;
      padding: 0.45rem 0.5rem;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      font: inherit;
    }
    .repair-btn {
      min-height: 1.875rem;
      padding: 0.35rem 0.75rem;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font: inherit;
      font-size: 0.8125rem;
      cursor: pointer;
    }
    .repair-btn.primary {
      border-color: transparent;
      background: var(--primary-color);
      color: var(--button-on-primary);
    }
    .repair-btn:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `],
})
export class RemoteNodeRepairPanelComponent implements OnChanges {
  @Input({ required: true }) entry!: NodeHealthEntry;

  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly clipboard = inject(CLIPBOARD_SERVICE);

  protected readonly diagnostic = signal<RemoteWorkerRepairDiagnostic | null>(null);
  protected readonly command = signal<RemoteWorkerRepairCommand | null>(null);
  protected readonly platformSelection = signal<'win32' | ''>('');
  protected readonly serviceStatus = signal<ServiceStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly shouldShowRepairDiagnostic = shouldShowRepairDiagnostic;
  protected readonly repairActionLabel = repairActionLabel;
  private repairContextKey = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['entry']) {
      const nextKey = this.buildRepairContextKey(this.entry);
      if (nextKey !== this.repairContextKey) {
        this.repairContextKey = nextKey;
        void this.refreshDiagnostic();
      }
    }
  }

  protected async refreshDiagnostic(): Promise<void> {
    this.command.set(null);
    this.error.set(null);
    this.serviceStatus.set(null);
    this.diagnostic.set(await this.ipc.diagnoseRepair(this.entry.id));
  }

  protected setPlatform(platform: 'win32' | ''): void {
    this.platformSelection.set(platform);
    this.command.set(null);
  }

  protected async checkServiceStatus(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.serviceStatus.set(await this.ipc.getServiceStatus(this.entry.id));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected serviceConfigDetail(): string {
    return formatServiceConfigStatus(this.serviceStatus(), this.entry.platform);
  }

  protected async generateRepairCommand(): Promise<void> {
    const diagnostic = this.diagnostic();
    let options: { platform: 'win32'; operatorConfirmedPlatform: true } | undefined;
    if (diagnostic?.recommendedAction === 'choose_platform') {
      if (this.platformSelection() !== 'win32') {
        return;
      }
      options = { platform: 'win32', operatorConfirmedPlatform: true };
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      this.command.set(await this.ipc.generateRepairCommand(this.entry.id, options));
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async copyRepairCommand(command: string): Promise<void> {
    const result = await this.clipboard.copyText(command, { label: 'remote worker repair command' });
    if (!result.ok) {
      this.error.set(result.reason);
    }
  }

  protected formatExpiry(timestamp: number): string {
    const remainingMs = timestamp - Date.now();
    if (remainingMs <= 0) {
      return 'now';
    }
    const remainingMinutes = Math.round(remainingMs / 60_000);
    return remainingMinutes < 60
      ? `in ${remainingMinutes}m`
      : `in ${Math.round(remainingMinutes / 60)}h`;
  }

  protected formatRelativeTime(timestamp?: number): string {
    if (!timestamp) {
      return 'never';
    }
    const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
    if (deltaMinutes < 1) {
      return 'just now';
    }
    return deltaMinutes < 60
      ? `${deltaMinutes}m ago`
      : `${Math.round(deltaMinutes / 60)}h ago`;
  }

  private buildRepairContextKey(entry: NodeHealthEntry): string {
    return [
      entry.id,
      entry.name,
      entry.status,
      entry.platform ?? '',
      entry.connectedAt ?? '',
      entry.lastSeenAt ?? '',
    ].join('|');
  }
}
