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
import * as QRCode from 'qrcode';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService, RemoteNodeServerStatus } from '../../core/services/ipc/remote-node-ipc.service';
import type { RemotePairingCredentialInfo, WorkerNodeInfo } from '../../../../shared/types/worker-node.types';

interface RegisteredNodeRecord {
  nodeId?: string;
  nodeName?: string;
  token?: string;
  createdAt?: number;
}

interface NodeHealthEntry {
  id: string;
  name: string;
  status: WorkerNodeInfo['status'];
  address?: string;
  createdAt?: number;
  connectedAt?: number;
  lastHeartbeat?: number;
  supportsBrowser: boolean;
  supportsGpu: boolean;
  supportedClis: string[];
}

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

        <p class="field-hint connection-summary">
          @if (serverStatus().running) {
            <span class="status-badge connected">Running on {{ serverStatus().host ?? store.remoteNodesServerHost() }}:{{ serverStatus().port ?? store.remoteNodesServerPort() }}</span>
            <span>{{ serverStatus().registeredCount ?? nodeHealthEntries().length }} registered</span>
            <span>{{ serverStatus().pendingPairingCount ?? pendingPairings().length }} pending pairing credentials</span>
          } @else {
            <span class="status-badge disconnected">Server stopped</span>
          }
        </p>

        @if (serverStatus().running && serverStatus().localIps?.length) {
          <p class="field-hint connection-summary">
            Workers should connect to
            @for (ip of serverStatus().localIps!; track ip; let last = $last) {
              <span class="machine-ip">{{ ip }}:{{ serverStatus().port ?? store.remoteNodesServerPort() }}</span>@if (!last) {<span> or </span>}
            }
          </p>
        }
      </div>

      @if (store.remoteNodesEnabled()) {
        <div class="connection-card">
          <span class="card-name">Server Configuration</span>

          <div class="field-grid">
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

        <div class="connection-card">
          <div class="card-row">
            <div>
              <span class="card-name">Quick Pairing</span>
              <p class="field-hint section-inline-hint">Issue one-time credentials, then share a link or QR code with the remote machine.</p>
            </div>
            <span class="status-badge" [class]="pendingPairings().length > 0 ? 'status-badge connecting' : 'status-badge disconnected'">
              {{ pendingPairings().length }} pending
            </span>
          </div>

          <div class="field-grid">
            <div class="field-group">
              <label class="field-label" for="rn-pairing-label">Label</label>
              <input
                id="rn-pairing-label"
                type="text"
                class="field-input"
                [value]="pairingLabel()"
                (input)="pairingLabel.set($any($event.target).value)"
                placeholder="Studio MacBook"
              />
            </div>

            <div class="field-group">
              <label class="field-label" for="rn-pairing-ttl">Credential Lifetime</label>
              <select
                id="rn-pairing-ttl"
                class="field-input"
                [value]="pairingTtlMinutes()"
                (change)="pairingTtlMinutes.set(+$any($event.target).value)"
              >
                <option [value]="15">15 minutes</option>
                <option [value]="60">1 hour</option>
                <option [value]="240">4 hours</option>
                <option [value]="1440">24 hours</option>
              </select>
            </div>
          </div>

          <div class="btn-row">
            <button
              class="btn btn-primary"
              type="button"
              (click)="createPairingCredential()"
              [disabled]="pairingBusy() || !serverStatus().running"
            >
              {{ pairingBusy() ? 'Issuing...' : 'Issue One-Time Credential' }}
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              (click)="refreshPairings()"
              [disabled]="pairingBusy()"
            >
              Refresh
            </button>
          </div>

          @if (!serverStatus().running) {
            <p class="field-hint">Start the remote-node server before sharing pairing credentials.</p>
          }

          @if (activePairing(); as pairing) {
            <div class="pairing-presentation">
              <div class="pairing-qr-shell">
                @if (pairingQrCode()) {
                  <img
                    class="pairing-qr-image"
                    [src]="pairingQrCode() || ''"
                    alt="Pairing QR code"
                  />
                } @else {
                  <div class="pairing-qr-placeholder">QR preview unavailable</div>
                }
              </div>

              <div class="pairing-details">
                <div class="field-group">
                  <span class="field-label">One-Time Credential</span>
                  <input
                    type="text"
                    class="field-input mono"
                    [value]="pairing.token"
                    readonly
                  />
                </div>

                <div class="field-group">
                  <span class="field-label">Pairing Link</span>
                  <input
                    type="text"
                    class="field-input mono"
                    [value]="pairingLink()"
                    readonly
                  />
                </div>

                <div class="field-group">
                  <span class="field-label">Connection Config</span>
                  <pre class="config-preview">{{ pairingConfigPreview() }}</pre>
                </div>

                <div class="meta-row">
                  <span>{{ pairing.label || 'Unlabeled credential' }}</span>
                  <span [class.warning-text]="pairingExpiresSoon(pairing)">
                    Expires {{ formatExpiry(pairing.expiresAt) }}
                  </span>
                  <span>Created {{ formatRelativeTime(pairing.createdAt) }}</span>
                </div>

                <div class="btn-row">
                  <button class="btn btn-secondary small" type="button" (click)="copyPairingToken(pairing.token)">
                    Copy Token
                  </button>
                  <button class="btn btn-secondary small" type="button" (click)="copyPairingLink(pairing.token)">
                    Copy Link
                  </button>
                  <button class="btn btn-secondary small" type="button" (click)="copyPairingConfig(pairing.token)">
                    Copy Config
                  </button>
                  <button class="btn btn-danger small" type="button" (click)="revokePairing(pairing.token)">
                    Revoke
                  </button>
                </div>
              </div>
            </div>
          }

          @if (pendingPairings().length > 0) {
            <div class="field-group">
              <span class="field-label">Pending Credentials</span>
              @for (pairing of pendingPairings(); track pairing.token) {
                <div class="node-row">
                  <div>
                    <span class="node-id">{{ pairing.label || abbreviateToken(pairing.token) }}</span>
                    <div class="node-meta">
                      <span>{{ abbreviateToken(pairing.token) }}</span>
                      <span [class.warning-text]="pairingExpiresSoon(pairing)">Expires {{ formatExpiry(pairing.expiresAt) }}</span>
                    </div>
                  </div>
                  <div class="btn-row compact">
                    <button class="btn btn-secondary small" type="button" (click)="copyPairingLink(pairing.token)">
                      Copy Link
                    </button>
                    <button class="btn btn-danger small" type="button" (click)="revokePairing(pairing.token)">
                      Revoke
                    </button>
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <div class="connection-card">
          <div class="card-row">
            <div>
              <span class="card-name">Legacy Enrollment Token</span>
              <p class="field-hint section-inline-hint">Compatibility fallback for older workers that do not yet support one-time pairing.</p>
            </div>
          </div>

          @if (!customTokenMode()) {
            <div class="token-row">
              <input
                [type]="tokenRevealed() ? 'text' : 'password'"
                class="field-input token-input mono"
                [value]="store.remoteNodesEnrollmentToken() || '(not set)'"
                readonly
              />
              <button
                class="btn btn-icon"
                type="button"
                (click)="tokenRevealed.set(!tokenRevealed())"
                [attr.aria-label]="tokenRevealed() ? 'Hide token' : 'Show token'"
                [title]="tokenRevealed() ? 'Hide' : 'Show'"
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
              <button
                class="btn btn-secondary"
                type="button"
                (click)="copyLegacyConnectionConfig()"
                [disabled]="!store.remoteNodesEnrollmentToken()"
              >
                Copy Legacy Config
              </button>
            </div>
          } @else {
            <label class="field-label" for="rn-custom-token">Custom Token (min 16 characters)</label>
            <input
              id="rn-custom-token"
              type="text"
              class="field-input mono"
              [value]="customTokenValue()"
              (input)="customTokenValue.set($any($event.target).value)"
              placeholder="Enter secure token..."
            />
            <div class="btn-row">
              <button
                class="btn btn-primary"
                type="button"
                (click)="saveCustomToken()"
                [disabled]="customTokenValue().trim().length < 16 || savingToken()"
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

        <div class="connection-card">
          <div class="card-row">
            <span class="card-name">Node Health</span>
            <span class="status-badge" [class]="connectedCount() > 0 ? 'status-badge connected' : 'status-badge disconnected'">
              {{ connectedCount() }} {{ connectedCount() === 1 ? 'node' : 'nodes' }} connected
            </span>
          </div>

          @if (nodeHealthEntries().length === 0) {
            <p class="field-hint">No nodes have registered yet. Issue a one-time credential above, or share the legacy token with older workers.</p>
          } @else {
            @for (entry of nodeHealthEntries(); track entry.id) {
              <div class="node-health-card">
                <div class="node-row node-row-header">
                  <div>
                    <span class="node-id">{{ entry.name }}</span>
                    <div class="node-meta">
                      <span>{{ entry.id }}</span>
                      @if (entry.address) {
                        <span>{{ entry.address }}</span>
                      }
                    </div>
                  </div>
                  <div class="status-actions">
                    <span class="status-badge" [class]="'status-badge ' + entry.status">{{ entry.status }}</span>
                    <button
                      class="btn btn-danger small"
                      type="button"
                      (click)="revokeNode(entry.id)"
                    >
                      Revoke
                    </button>
                  </div>
                </div>

                <div class="node-meta">
                  <span>Registered {{ formatRelativeTime(entry.createdAt) }}</span>
                  @if (entry.connectedAt) {
                    <span>Connected {{ formatRelativeTime(entry.connectedAt) }}</span>
                  }
                  @if (entry.lastHeartbeat) {
                    <span>Heartbeat {{ formatRelativeTime(entry.lastHeartbeat) }}</span>
                  }
                </div>

                @if (entry.supportsBrowser || entry.supportsGpu || entry.supportedClis.length > 0) {
                  <div class="badge-row">
                    @if (entry.supportsBrowser) {
                      <span class="capability-chip">Browser</span>
                    }
                    @if (entry.supportsGpu) {
                      <span class="capability-chip">GPU</span>
                    }
                    @for (cli of entry.supportedClis; track cli) {
                      <span class="capability-chip">{{ cli }}</span>
                    }
                  </div>
                }
              </div>
            }
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

    .connection-summary {
      margin: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.625rem;
      align-items: center;
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

    .field-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.75rem;
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

    .mono {
      font-family: var(--font-family-mono, monospace);
      letter-spacing: 0.03em;
    }

    .remote-nodes-tab .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.25rem;
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.2;
      white-space: nowrap;
      align-self: flex-start;
      font-family: inherit;
    }

    .remote-nodes-tab .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .remote-nodes-tab .btn-primary { background: var(--primary-color, #3b82f6); color: #000; }
    .remote-nodes-tab .btn-primary:hover:not(:disabled) { opacity: 0.9; }
    .remote-nodes-tab .btn-secondary { background: var(--bg-primary, #0f0f0f); color: var(--text-primary, #e5e5e5); border: 1px solid var(--border-color, #333); }
    .remote-nodes-tab .btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.06); }
    .remote-nodes-tab .btn-danger { background: var(--error-color, #ef4444); color: white; }
    .remote-nodes-tab .btn-danger:hover:not(:disabled) { opacity: 0.9; }
    .remote-nodes-tab .btn.small { min-height: 1.875rem; padding: 0.35rem 0.75rem; font-size: 0.8125rem; }

    .remote-nodes-tab .btn-icon {
      width: auto;
      height: auto;
      min-height: 0;
      padding: 0.5rem;
      background: var(--bg-primary, #0f0f0f);
      border: 1px solid var(--border-color, #333);
      color: var(--text-muted, #888);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: auto;
      flex-shrink: 0;
    }

    .remote-nodes-tab .btn-icon:hover:not(:disabled) {
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

    .btn-row.compact {
      justify-content: flex-end;
    }

    .section-inline-hint {
      margin: 0.125rem 0 0;
    }

    .pairing-presentation {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: 1rem;
      align-items: start;
      padding-top: 0.25rem;
    }

    .pairing-qr-shell {
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      background: var(--bg-primary, #0f0f0f);
      min-height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.75rem;
      box-sizing: border-box;
    }

    .pairing-qr-image {
      width: 100%;
      max-width: 220px;
      height: auto;
      display: block;
    }

    .pairing-qr-placeholder {
      color: var(--text-muted, #888);
      font-size: 0.8125rem;
      text-align: center;
    }

    .pairing-details {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .config-preview {
      margin: 0;
      padding: 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border-color, #333);
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.75rem;
      line-height: 1.45;
      overflow: auto;
      font-family: var(--font-family-mono, monospace);
    }

    .meta-row,
    .node-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.625rem;
      font-size: 0.75rem;
      color: var(--text-muted, #6b7280);
    }

    .warning-text {
      color: #f59e0b;
    }

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

    .node-row-header {
      padding-top: 0;
    }

    .node-id {
      font-family: var(--font-family-mono, monospace);
      font-size: 0.8125rem;
      color: var(--text-primary, #e5e5e5);
      word-break: break-all;
    }

    .machine-ip {
      font-family: var(--font-family-mono, monospace);
      font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    .node-health-card {
      border-top: 1px solid var(--border-color, #333);
      padding-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .node-health-card:first-of-type {
      border-top: none;
      padding-top: 0;
    }

    .status-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }

    .capability-chip {
      border-radius: 999px;
      border: 1px solid var(--border-color, #333);
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.75rem;
      padding: 0.2rem 0.55rem;
      text-transform: capitalize;
    }

    @media (max-width: 720px) {
      .pairing-presentation {
        grid-template-columns: 1fr;
      }

      .pairing-qr-shell {
        min-height: 0;
      }

      .token-row {
        flex-wrap: wrap;
      }

      .status-actions {
        justify-content: flex-start;
      }
    }
  `]
})
export class RemoteNodesSettingsTabComponent implements OnInit, OnDestroy {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(RemoteNodeIpcService);

  protected readonly serverStatus = signal<RemoteNodeServerStatus>({ running: false });

  protected readonly draftPort = signal(0);
  protected readonly draftHost = signal('');
  protected readonly draftNamespace = signal('');
  protected readonly draftRequireTls = signal(false);
  protected readonly draftTlsMode = signal<'auto' | 'custom'>('auto');
  protected readonly draftAutoOffloadBrowser = signal(true);
  protected readonly draftAutoOffloadGpu = signal(false);

  protected readonly tokenRevealed = signal(false);
  protected readonly customTokenMode = signal(false);
  protected readonly customTokenValue = signal('');
  protected readonly pairingLabel = signal('');
  protected readonly pairingTtlMinutes = signal(60);
  protected readonly pendingPairings = signal<RemotePairingCredentialInfo[]>([]);
  protected readonly pairingQrCode = signal<string | null>(null);

  protected readonly applying = signal(false);
  protected readonly regenerating = signal(false);
  protected readonly savingToken = signal(false);
  protected readonly pairingBusy = signal(false);

  protected readonly liveNodes = signal<WorkerNodeInfo[]>([]);
  protected readonly connectedCount = signal(0);

  protected readonly error = signal<string | null>(null);

  private unsubscribeNodeEvent: (() => void) | null = null;
  private unsubscribeNodesChanged: (() => void) | null = null;

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

  readonly activePairing = () => this.pendingPairings()[0] ?? null;

  readonly pairingLink = () => {
    const pairing = this.activePairing();
    return pairing ? this.buildPairingLink(pairing.token) : '';
  };

  readonly pairingConfigPreview = () => {
    const pairing = this.activePairing();
    return pairing
      ? JSON.stringify(this.buildConnectionConfig(pairing.token), null, 2)
      : '';
  };

  readonly nodeHealthEntries = (): NodeHealthEntry[] => {
    const registeredNodes = this.store.remoteNodesRegisteredNodes() as Record<string, RegisteredNodeRecord>;
    const liveById = new Map(this.liveNodes().map((node) => [node.id, node]));
    const ids = new Set<string>([
      ...Object.keys(registeredNodes),
      ...liveById.keys(),
    ]);
    const rank: Record<WorkerNodeInfo['status'], number> = {
      connected: 0,
      degraded: 1,
      connecting: 2,
      disconnected: 3,
    };

    return [...ids]
      .map((id) => {
        const registered = registeredNodes[id];
        const live = liveById.get(id);
        return {
          id,
          name: live?.name ?? registered?.nodeName ?? id,
          status: live?.status ?? 'disconnected',
          address: live?.address,
          createdAt: registered?.createdAt,
          connectedAt: live?.connectedAt,
          lastHeartbeat: live?.lastHeartbeat,
          supportsBrowser: live?.capabilities.hasBrowserRuntime ?? false,
          supportsGpu: Boolean(live?.capabilities.gpuName),
          supportedClis: live?.capabilities.supportedClis ?? [],
        };
      })
      .sort((left, right) => {
        const statusDiff = rank[left.status] - rank[right.status];
        if (statusDiff !== 0) {
          return statusDiff;
        }
        return left.name.localeCompare(right.name);
      });
  };

  async ngOnInit(): Promise<void> {
    this.syncDraftsFromStore();
    await Promise.all([
      this.refreshStatus(),
      this.refreshNodes(),
      this.refreshPairings(),
    ]);

    this.unsubscribeNodeEvent = this.ipc.onNodeEvent(() => {
      void this.refreshNodes();
      void this.refreshStatus();
    });

    this.unsubscribeNodesChanged = this.ipc.onNodesChanged((nodes) => {
      this.liveNodes.set(nodes);
      this.connectedCount.set(nodes.filter((node) => node.status === 'connected').length);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeNodeEvent?.();
    this.unsubscribeNodesChanged?.();
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
      this.connectedCount.set(nodes.filter((node) => node.status === 'connected').length);
    } catch {
      // Non-fatal.
    }
  }

  protected async refreshPairings(): Promise<void> {
    try {
      const pairings = await this.ipc.listPairingCredentials();
      this.pendingPairings.set(pairings);
      await this.updatePairingQrCode();
    } catch {
      this.pendingPairings.set([]);
      this.pairingQrCode.set(null);
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

  async createPairingCredential(): Promise<void> {
    if (!this.serverStatus().running) {
      return;
    }

    this.pairingBusy.set(true);
    this.error.set(null);
    try {
      const pairing = await this.ipc.issuePairingCredential({
        label: this.pairingLabel().trim() || undefined,
        ttlMs: this.pairingTtlMinutes() * 60_000,
      });

      if (pairing) {
        this.pairingLabel.set('');
      }

      await Promise.all([
        this.refreshPairings(),
        this.refreshStatus(),
      ]);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.pairingBusy.set(false);
    }
  }

  async copyToken(): Promise<void> {
    const token = this.store.remoteNodesEnrollmentToken();
    if (!token) return;
    await this.writeClipboard(token);
  }

  async copyLegacyConnectionConfig(): Promise<void> {
    const token = this.store.remoteNodesEnrollmentToken();
    if (!token) return;
    await this.writeClipboard(JSON.stringify(this.buildConnectionConfig(token), null, 2));
  }

  async copyPairingToken(token: string): Promise<void> {
    await this.writeClipboard(token);
  }

  async copyPairingLink(token: string): Promise<void> {
    await this.writeClipboard(this.buildPairingLink(token));
  }

  async copyPairingConfig(token: string): Promise<void> {
    await this.writeClipboard(JSON.stringify(this.buildConnectionConfig(token), null, 2));
  }

  async revokePairing(token: string): Promise<void> {
    if (!confirm('Revoke this one-time pairing credential?')) {
      return;
    }

    this.error.set(null);
    try {
      await this.ipc.revokePairingCredential(token);
      await Promise.all([
        this.refreshPairings(),
        this.refreshStatus(),
      ]);
    } catch (err) {
      this.error.set((err as Error).message);
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

  protected abbreviateToken(token: string): string {
    return token.length <= 18
      ? token
      : `${token.slice(0, 8)}...${token.slice(-6)}`;
  }

  protected pairingExpiresSoon(pairing: RemotePairingCredentialInfo): boolean {
    return pairing.expiresAt - Date.now() <= 15 * 60_000;
  }

  protected formatExpiry(timestamp: number): string {
    const remainingMs = timestamp - Date.now();
    if (remainingMs <= 0) {
      return 'now';
    }

    const remainingMinutes = Math.round(remainingMs / 60_000);
    if (remainingMinutes < 60) {
      return `in ${remainingMinutes}m`;
    }

    const remainingHours = Math.round(remainingMinutes / 60);
    if (remainingHours < 48) {
      return `in ${remainingHours}h`;
    }

    const remainingDays = Math.round(remainingHours / 24);
    return `in ${remainingDays}d`;
  }

  protected formatRelativeTime(timestamp?: number): string {
    if (!timestamp) {
      return 'never';
    }

    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 60_000) {
      return 'just now';
    }

    const deltaMinutes = Math.round(deltaMs / 60_000);
    if (deltaMinutes < 60) {
      return `${deltaMinutes}m ago`;
    }

    const deltaHours = Math.round(deltaMinutes / 60);
    if (deltaHours < 48) {
      return `${deltaHours}h ago`;
    }

    const deltaDays = Math.round(deltaHours / 24);
    return `${deltaDays}d ago`;
  }

  private buildConnectionConfig(token: string): Record<string, unknown> {
    return {
      token,
      namespace: this.store.remoteNodesNamespace(),
      host: this.getConnectionHost(),
      port: this.store.remoteNodesServerPort(),
      requireTls: this.serverStatus().requireTls ?? this.store.remoteNodesRequireTls(),
    };
  }

  private buildPairingLink(token: string): string {
    const params = new URLSearchParams({
      host: this.getConnectionHost(),
      port: String(this.store.remoteNodesServerPort()),
      namespace: this.store.remoteNodesNamespace(),
      token,
      requireTls: String(this.serverStatus().requireTls ?? this.store.remoteNodesRequireTls()),
    });
    return `ai-orchestrator://remote-node/pair?${params.toString()}`;
  }

  private getConnectionHost(): string {
    const configuredHost = this.serverStatus().host ?? this.store.remoteNodesServerHost();
    const localIps = this.serverStatus().localIps ?? [];
    return configuredHost === '0.0.0.0' && localIps.length > 0
      ? localIps[0]
      : configuredHost;
  }

  private async updatePairingQrCode(): Promise<void> {
    const pairing = this.activePairing();
    if (!pairing) {
      this.pairingQrCode.set(null);
      return;
    }

    try {
      const dataUrl = await QRCode.toDataURL(this.buildPairingLink(pairing.token), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
      });
      this.pairingQrCode.set(dataUrl);
    } catch {
      this.pairingQrCode.set(null);
    }
  }

  private async writeClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access is not always available in the Electron sandbox.
    }
  }
}
