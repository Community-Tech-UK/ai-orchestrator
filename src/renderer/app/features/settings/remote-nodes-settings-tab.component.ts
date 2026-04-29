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
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

interface RegisteredNodeRecord {
  sessionId?: string;
  nodeId?: string;
  nodeName?: string;
  transportToken?: string;
  token?: string;
  issuedAt?: number;
  createdAt?: number;
  lastSeenAt?: number;
  authMethod?: 'pairing_credential' | 'manual_pairing';
  pairingLabel?: string;
}

interface NodeHealthEntry {
  id: string;
  name: string;
  status: WorkerNodeInfo['status'];
  address?: string;
  createdAt?: number;
  connectedAt?: number;
  lastHeartbeat?: number;
  lastSeenAt?: number;
  pairingLabel?: string;
  supportsBrowser: boolean;
  supportsGpu: boolean;
  supportedClis: string[];
}

@Component({
  standalone: true,
  selector: 'app-remote-nodes-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-nodes-settings-tab.component.html',
  styleUrl: './remote-nodes-settings-tab.component.scss',
})
export class RemoteNodesSettingsTabComponent implements OnInit, OnDestroy {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly clipboard = inject(CLIPBOARD_SERVICE);

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
          createdAt: registered?.issuedAt ?? registered?.createdAt,
          connectedAt: live?.connectedAt,
          lastHeartbeat: live?.lastHeartbeat,
          lastSeenAt: registered?.lastSeenAt,
          pairingLabel: registered?.pairingLabel,
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
    if (!confirm('Generate a new manual pairing token? The previous manual token will no longer be offered for registration.')) {
      return;
    }
    this.regenerating.set(true);
    this.error.set(null);
    try {
      const newToken = await this.ipc.regenerateToken();
      if (newToken) {
        await this.store.set('remoteNodesEnrollmentToken', newToken);
        await Promise.all([
          this.refreshPairings(),
          this.refreshStatus(),
        ]);
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
      await Promise.all([
        this.refreshPairings(),
        this.refreshStatus(),
      ]);
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
    const result = await this.clipboard.copyText(text, { label: 'remote node token' });
    if (!result.ok) {
      // Clipboard access is not always available in the Electron sandbox.
      console.error('Failed to copy remote node value:', result.reason, result.cause);
    }
  }
}
