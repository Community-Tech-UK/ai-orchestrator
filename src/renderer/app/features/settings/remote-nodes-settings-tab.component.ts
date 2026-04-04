/**
 * Remote Nodes Settings Tab
 * Configure remote worker node connections from within Settings.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService, RemoteNodeServerStatus } from '../../core/services/ipc/remote-node-ipc.service';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';

@Component({
  standalone: true,
  selector: 'app-remote-nodes-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="remote-nodes-tab">
      <h3 class="section-title">Remote Nodes</h3>
      <p class="section-desc">Allow remote machines to connect as worker nodes.</p>

      @if (error()) {
        <div class="error-msg">{{ error() }}</div>
      }

      <!-- Enable toggle -->
      <div class="connection-card">
        <div class="card-row">
          <div class="card-info">
            <span class="card-name">Enable Remote Node Server</span>
          </div>
          <label class="toggle-label">
            <input
              type="checkbox"
              class="toggle-input"
              [checked]="store.remoteNodesEnabled()"
              (change)="toggleEnabled()"
            />
            <span class="toggle-track">
              <span class="toggle-thumb"></span>
            </span>
          </label>
        </div>

        <p class="field-hint" style="margin: 0;">
          @if (serverStatus().running) {
            <span class="status-badge connected">Running on {{ serverStatus().host ?? store.remoteNodesServerHost() }}:{{ serverStatus().port ?? store.remoteNodesServerPort() }}</span>
          } @else {
            <span class="status-badge disconnected">Server stopped</span>
          }
        </p>
      </div>

      @if (store.remoteNodesEnabled()) {
        <!-- Server Config -->
        <div class="connection-card">
          <span class="card-name">Server Configuration</span>

          <div class="field-group">
            <label class="field-label" for="rn-port">Port</label>
            <input
              id="rn-port"
              type="number"
              class="field-input"
              [value]="draftPort()"
              (input)="draftPort.set(+$any($event.target).value)"
              min="1024"
              max="65535"
              placeholder="4878"
            />
          </div>

          <div class="field-group">
            <label class="field-label" for="rn-host">Host</label>
            <input
              id="rn-host"
              type="text"
              class="field-input"
              [value]="draftHost()"
              (input)="draftHost.set($any($event.target).value)"
              placeholder="0.0.0.0"
            />
          </div>

          <div class="field-group">
            <label class="field-label" for="rn-namespace">Namespace</label>
            <input
              id="rn-namespace"
              type="text"
              class="field-input"
              [value]="draftNamespace()"
              (input)="draftNamespace.set($any($event.target).value)"
              placeholder="default"
            />
            <p class="field-hint">Logical grouping name for this node cluster.</p>
          </div>

          <div class="field-group">
            <div class="card-row">
              <label class="field-label" for="rn-require-tls">Require TLS</label>
              <label class="toggle-label">
                <input
                  id="rn-require-tls"
                  type="checkbox"
                  class="toggle-input"
                  [checked]="draftRequireTls()"
                  (change)="draftRequireTls.set(!draftRequireTls())"
                />
                <span class="toggle-track">
                  <span class="toggle-thumb"></span>
                </span>
              </label>
            </div>
          </div>

          @if (draftRequireTls()) {
            <div class="field-group">
              <label class="field-label" for="rn-tls-mode">TLS Mode</label>
              <select
                id="rn-tls-mode"
                class="field-input"
                [value]="draftTlsMode()"
                (change)="draftTlsMode.set($any($event.target).value)"
              >
                <option value="auto">Auto (self-signed)</option>
                <option value="custom">Custom certificate</option>
              </select>
            </div>
          }

          <div class="field-group">
            <div class="card-row">
              <label class="field-label" for="rn-offload-browser">Auto-offload Browser Tasks</label>
              <label class="toggle-label">
                <input
                  id="rn-offload-browser"
                  type="checkbox"
                  class="toggle-input"
                  [checked]="draftAutoOffloadBrowser()"
                  (change)="draftAutoOffloadBrowser.set(!draftAutoOffloadBrowser())"
                />
                <span class="toggle-track">
                  <span class="toggle-thumb"></span>
                </span>
              </label>
            </div>
            <p class="field-hint">Automatically route browser-dependent tasks to capable remote nodes.</p>
          </div>

          <div class="field-group">
            <div class="card-row">
              <label class="field-label" for="rn-offload-gpu">Auto-offload GPU Tasks</label>
              <label class="toggle-label">
                <input
                  id="rn-offload-gpu"
                  type="checkbox"
                  class="toggle-input"
                  [checked]="draftAutoOffloadGpu()"
                  (change)="draftAutoOffloadGpu.set(!draftAutoOffloadGpu())"
                />
                <span class="toggle-track">
                  <span class="toggle-thumb"></span>
                </span>
              </label>
            </div>
            <p class="field-hint">Automatically route GPU-intensive tasks to capable remote nodes.</p>
          </div>

          @if (hasDraftChanges()) {
            <button
              class="btn btn-primary"
              type="button"
              (click)="applyAndRestart()"
              [disabled]="applying()"
            >
              {{ applying() ? 'Applying...' : 'Apply & Restart Server' }}
            </button>
          }
        </div>

        <!-- Auth Token -->
        <div class="connection-card">
          <span class="card-name">Enrollment Token</span>
          <p class="field-hint" style="margin: 0 0 0.5rem;">Remote nodes use this token to authenticate when joining.</p>

          @if (!customTokenMode()) {
            <div class="token-row">
              <input
                type="{{ tokenRevealed() ? 'text' : 'password' }}"
                class="field-input token-input"
                [value]="store.remoteNodesEnrollmentToken() || '(not set)'"
                readonly
                style="font-family: var(--font-family-mono, monospace); letter-spacing: 0.04em;"
              />
              <button
                class="btn btn-icon"
                type="button"
                (click)="tokenRevealed.set(!tokenRevealed())"
                [attr.aria-label]="tokenRevealed() ? 'Hide token' : 'Show token'"
                title="{{ tokenRevealed() ? 'Hide' : 'Show' }}"
              >
                @if (tokenRevealed()) {
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                } @else {
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
              <button
                class="btn btn-icon"
                type="button"
                (click)="copyToken()"
                [disabled]="!store.remoteNodesEnrollmentToken()"
                title="Copy token"
                aria-label="Copy token"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
            </div>

            <div class="btn-row">
              <button
                class="btn btn-primary"
                type="button"
                (click)="regenerateToken()"
                [disabled]="regenerating()"
              >
                {{ regenerating() ? 'Regenerating...' : 'Regenerate' }}
              </button>
              <button
                class="btn btn-secondary"
                type="button"
                (click)="customTokenMode.set(true)"
              >
                Set Custom Token
              </button>
            </div>

            <div style="margin-top: 0.75rem; border-top: 1px solid var(--border-color, #333); padding-top: 0.75rem;">
              <button
                class="btn btn-primary"
                type="button"
                (click)="copyConnectionConfig()"
                [disabled]="!store.remoteNodesEnrollmentToken()"
              >
                Copy Connection Config
              </button>
              <p class="field-hint" style="margin-top: 0.375rem;">Copies a JSON config for remote nodes to use when connecting.</p>
            </div>
          } @else {
            <label class="field-label" for="rn-custom-token">Custom Token (min 16 characters)</label>
            <input
              id="rn-custom-token"
              type="text"
              class="field-input"
              [value]="customTokenValue()"
              (input)="customTokenValue.set($any($event.target).value)"
              placeholder="Enter secure token..."
              style="font-family: var(--font-family-mono, monospace);"
            />
            <div class="btn-row">
              <button
                class="btn btn-primary"
                type="button"
                (click)="saveCustomToken()"
                [disabled]="customTokenValue().length < 16 || savingToken()"
              >
                {{ savingToken() ? 'Saving...' : 'Save Token' }}
              </button>
              <button
                class="btn btn-secondary"
                type="button"
                (click)="customTokenMode.set(false); customTokenValue.set('')"
              >
                Cancel
              </button>
            </div>
          }
        </div>

        <!-- Registered Nodes -->
        <div class="connection-card">
          <span class="card-name">Registered Nodes</span>

          @if (registeredNodeEntries().length === 0) {
            <p class="field-hint" style="margin: 0;">No nodes have registered yet. Share the enrollment token with remote machines to connect them.</p>
          } @else {
            @for (entry of registeredNodeEntries(); track entry.id) {
              <div class="node-row">
                <span class="node-id">{{ entry.id }}</span>
                <button
                  class="btn btn-danger"
                  type="button"
                  (click)="revokeNode(entry.id)"
                  style="padding: 0.25rem 0.625rem; font-size: 0.8125rem;"
                >
                  Revoke
                </button>
              </div>
            }
          }
        </div>

        <!-- Connected Nodes Status -->
        <div class="connection-card">
          <div class="card-row">
            <span class="card-name">Connected Nodes</span>
            <span class="status-badge" [class]="connectedCount() > 0 ? 'status-badge connected' : 'status-badge disconnected'">
              {{ connectedCount() }} {{ connectedCount() === 1 ? 'node' : 'nodes' }} connected
            </span>
          </div>

          @for (node of liveNodes(); track node.id) {
            <div class="node-row">
              <div>
                <span class="node-id">{{ node.name }}</span>
                <span class="field-hint" style="margin: 0 0 0 0.5rem;">{{ node.address }}</span>
              </div>
              <span class="status-badge" [class]="'status-badge ' + node.status">{{ node.status }}</span>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .remote-nodes-tab { display: flex; flex-direction: column; gap: 1rem; }

    .section-title {
      margin: 0; font-size: 1.25rem; font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    .section-desc {
      margin: 0; font-size: 0.875rem;
      color: var(--text-muted, #888);
    }

    .connection-card {
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 1rem;
      background: var(--bg-secondary, #1e1e1e);
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
    }

    .card-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-info {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    .card-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    .status-badge {
      padding: 0.125rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      text-transform: capitalize;
      font-weight: 500;
    }

    .status-badge.connected {
      background: color-mix(in srgb, var(--success-color, #22c55e) 15%, transparent);
      color: var(--success-color, #22c55e);
    }

    .status-badge.connecting {
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
    }

    .status-badge.disconnected {
      background: color-mix(in srgb, var(--text-muted, #6b7280) 15%, transparent);
      color: var(--text-muted, #6b7280);
    }

    .status-badge.degraded {
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
    }

    .status-badge.error {
      background: color-mix(in srgb, var(--error-color, #ef4444) 15%, transparent);
      color: var(--error-color, #ef4444);
    }

    .error-msg {
      padding: 0.5rem;
      border-radius: 4px;
      font-size: 0.8125rem;
      background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent);
      color: var(--error-color, #ef4444);
      border: 1px solid color-mix(in srgb, var(--error-color, #ef4444) 30%, transparent);
    }

    .field-label {
      font-size: 0.8125rem;
      color: var(--text-muted, #888);
    }

    .field-hint {
      margin: 0 0 0.375rem;
      font-size: 0.75rem;
      color: var(--text-muted, #6b7280);
    }

    .field-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .field-input {
      padding: 0.5rem;
      border: 1px solid var(--border-color, #333);
      border-radius: 4px;
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.875rem;
      width: 100%;
      box-sizing: border-box;
    }

    .btn {
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      align-self: flex-start;
    }

    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary-color, #3b82f6); color: white; }
    .btn-primary:hover:not(:disabled) { opacity: 0.9; }
    .btn-secondary { background: var(--bg-primary, #0f0f0f); color: var(--text-primary, #e5e5e5); border: 1px solid var(--border-color, #333); }
    .btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.06); }
    .btn-danger { background: var(--error-color, #ef4444); color: white; }
    .btn-danger:hover:not(:disabled) { opacity: 0.9; }

    .btn-icon {
      padding: 0.5rem;
      background: var(--bg-primary, #0f0f0f);
      border: 1px solid var(--border-color, #333);
      color: var(--text-muted, #888);
      display: flex;
      align-items: center;
      justify-content: center;
      align-self: auto;
      flex-shrink: 0;
    }

    .btn-icon:hover:not(:disabled) {
      color: var(--text-primary, #e5e5e5);
      background: rgba(255,255,255,0.06);
    }

    .token-row {
      display: flex;
      gap: 0.375rem;
      align-items: center;
    }

    .token-input {
      flex: 1;
      min-width: 0;
    }

    .btn-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    /* Toggle switch */
    .toggle-label {
      position: relative;
      display: inline-flex;
      align-items: center;
      cursor: pointer;
    }

    .toggle-input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-track {
      display: inline-flex;
      align-items: center;
      width: 36px;
      height: 20px;
      border-radius: 10px;
      background: var(--border-color, #444);
      transition: background 0.2s ease;
      padding: 2px;
      box-sizing: border-box;
    }

    .toggle-input:checked + .toggle-track {
      background: var(--primary-color, #3b82f6);
    }

    .toggle-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: white;
      transition: transform 0.2s ease;
    }

    .toggle-input:checked + .toggle-track .toggle-thumb {
      transform: translateX(16px);
    }

    /* Node rows */
    .node-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.375rem 0;
      border-top: 1px solid var(--border-color, #333);
    }

    .node-row:first-of-type {
      border-top: none;
    }

    .node-id {
      font-family: var(--font-family-mono, monospace);
      font-size: 0.8125rem;
      color: var(--text-primary, #e5e5e5);
      word-break: break-all;
    }
  `]
})
export class RemoteNodesSettingsTabComponent implements OnInit, OnDestroy {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(RemoteNodeIpcService);

  // Server status
  protected readonly serverStatus = signal<RemoteNodeServerStatus>({ running: false });

  // Draft config signals (local state — not written to store until Apply is clicked)
  protected readonly draftPort = signal(0);
  protected readonly draftHost = signal('');
  protected readonly draftNamespace = signal('');
  protected readonly draftRequireTls = signal(false);
  protected readonly draftTlsMode = signal<'auto' | 'custom'>('auto');
  protected readonly draftAutoOffloadBrowser = signal(true);
  protected readonly draftAutoOffloadGpu = signal(false);

  // Token UI
  protected readonly tokenRevealed = signal(false);
  protected readonly customTokenMode = signal(false);
  protected readonly customTokenValue = signal('');

  // Async operation flags
  protected readonly applying = signal(false);
  protected readonly regenerating = signal(false);
  protected readonly savingToken = signal(false);

  // Live node data
  protected readonly liveNodes = signal<WorkerNodeInfo[]>([]);
  protected readonly connectedCount = signal(0);

  // Error
  protected readonly error = signal<string | null>(null);

  private unsubscribeNodeEvent: (() => void) | null = null;

  readonly hasDraftChanges = () => {
    return (
      this.draftPort() !== this.store.remoteNodesServerPort() ||
      this.draftHost() !== this.store.remoteNodesServerHost() ||
      this.draftNamespace() !== this.store.remoteNodesNamespace() ||
      this.draftRequireTls() !== this.store.remoteNodesRequireTls() ||
      this.draftTlsMode() !== this.store.remoteNodesTlsMode() ||
      this.draftAutoOffloadBrowser() !== this.store.remoteNodesAutoOffloadBrowser() ||
      this.draftAutoOffloadGpu() !== this.store.remoteNodesAutoOffloadGpu()
    );
  };

  readonly registeredNodeEntries = () => {
    const nodes = this.store.remoteNodesRegisteredNodes();
    return Object.keys(nodes).map(id => ({ id, data: nodes[id] }));
  };

  async ngOnInit(): Promise<void> {
    this.syncDraftsFromStore();
    await this.refreshStatus();

    this.unsubscribeNodeEvent = this.ipc.onNodeEvent(() => {
      void this.refreshNodes();
      this.connectedCount.set(
        this.liveNodes().filter(n => n.status === 'connected').length
      );
    });

    await this.refreshNodes();
  }

  ngOnDestroy(): void {
    this.unsubscribeNodeEvent?.();
  }

  private syncDraftsFromStore(): void {
    this.draftPort.set(this.store.remoteNodesServerPort());
    this.draftHost.set(this.store.remoteNodesServerHost());
    this.draftNamespace.set(this.store.remoteNodesNamespace());
    this.draftRequireTls.set(this.store.remoteNodesRequireTls());
    this.draftTlsMode.set(this.store.remoteNodesTlsMode());
    this.draftAutoOffloadBrowser.set(this.store.remoteNodesAutoOffloadBrowser());
    this.draftAutoOffloadGpu.set(this.store.remoteNodesAutoOffloadGpu());
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await this.ipc.getServerStatus();
      this.serverStatus.set(status);
      this.connectedCount.set(status.connectedCount ?? 0);
    } catch {
      // Non-fatal — server may simply not be running
    }
  }

  private async refreshNodes(): Promise<void> {
    try {
      const nodes = await this.ipc.listNodes();
      this.liveNodes.set(nodes);
      this.connectedCount.set(nodes.filter(n => n.status === 'connected').length);
    } catch {
      // Non-fatal
    }
  }

  async toggleEnabled(): Promise<void> {
    const current = this.store.remoteNodesEnabled();
    await this.store.set('remoteNodesEnabled', !current);

    if (!current) {
      // Was disabled, now enabling — start server
      await this.applyAndRestart();
    } else {
      // Was enabled, now disabling — stop server
      try {
        await this.ipc.stopServer();
        await this.refreshStatus();
      } catch (err) {
        this.error.set((err as Error).message);
      }
    }
  }

  async applyAndRestart(): Promise<void> {
    this.applying.set(true);
    this.error.set(null);
    try {
      await this.store.set('remoteNodesServerPort', this.draftPort());
      await this.store.set('remoteNodesServerHost', this.draftHost());
      await this.store.set('remoteNodesNamespace', this.draftNamespace());
      await this.store.set('remoteNodesRequireTls', this.draftRequireTls());
      await this.store.set('remoteNodesTlsMode', this.draftTlsMode());
      await this.store.set('remoteNodesAutoOffloadBrowser', this.draftAutoOffloadBrowser());
      await this.store.set('remoteNodesAutoOffloadGpu', this.draftAutoOffloadGpu());

      await this.ipc.stopServer();
      await this.ipc.startServer({ port: this.draftPort(), host: this.draftHost() });
      await this.refreshStatus();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.applying.set(false);
    }
  }

  async copyToken(): Promise<void> {
    const token = this.store.remoteNodesEnrollmentToken();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // Clipboard not available in all environments
    }
  }

  async copyConnectionConfig(): Promise<void> {
    const token = this.store.remoteNodesEnrollmentToken();
    const namespace = this.store.remoteNodesNamespace();
    if (!token) return;

    const config = {
      token,
      namespace,
      host: this.store.remoteNodesServerHost(),
      port: this.store.remoteNodesServerPort(),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    } catch {
      // Clipboard not available in all environments
    }
  }

  async regenerateToken(): Promise<void> {
    if (!confirm('Regenerate the enrollment token? Existing unregistered nodes will need the new token to connect.')) {
      return;
    }
    this.regenerating.set(true);
    this.error.set(null);
    try {
      const newToken = await this.ipc.regenerateToken();
      if (newToken) {
        await this.store.set('remoteNodesEnrollmentToken', newToken);
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.regenerating.set(false);
    }
  }

  async saveCustomToken(): Promise<void> {
    const token = this.customTokenValue().trim();
    if (token.length < 16) return;

    this.savingToken.set(true);
    this.error.set(null);
    try {
      await this.ipc.setToken(token);
      await this.store.set('remoteNodesEnrollmentToken', token);
      this.customTokenMode.set(false);
      this.customTokenValue.set('');
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.savingToken.set(false);
    }
  }

  async revokeNode(nodeId: string): Promise<void> {
    if (!confirm(`Revoke node "${nodeId}"? It will no longer be able to connect.`)) {
      return;
    }
    this.error.set(null);
    try {
      await this.ipc.revokeNode(nodeId);
      await this.refreshNodes();
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
