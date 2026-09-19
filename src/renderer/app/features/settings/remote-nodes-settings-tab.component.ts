/**
 * Remote Nodes Settings Tab
 * Configure remote worker node connections from within Settings.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import * as QRCode from 'qrcode';
import { SettingsStore } from '../../core/state/settings.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import {
  RemoteNodeIpcService,
  RemoteNodeServerStatus,
  type BrowserAutomationConfigInput,
} from '../../core/services/ipc/remote-node-ipc.service';
import type {
  RemotePairingCredentialInfo,
  RemoteNodeRosterEntry,
} from '../../../../shared/types/worker-node.types';
import type { HarnessRole } from '../../../../shared/types/pair-both.types';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import { ValidationRowComponent } from './ui/validation-row.component';
import { CopyRowComponent } from './ui/copy-row.component';
import { CodePreviewBlockComponent } from './ui/code-preview-block.component';
import { DangerZoneComponent } from './ui/danger-zone.component';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import type { SettingsSectionTab } from './settings-navigation';
import {
  type RemoteNodesSection,
  isRemoteNodesSection,
  buildRemoteNodesSectionTabs,
  syncSelectedNodeAfterRosterChange,
} from './remote-nodes-section-state';
import {
  type NodeHealthEntry,
  buildNodeHealthEntries,
  withPatchedBrowserAutomation,
  withPatchedExtensionRelay,
  withPatchedAndroidAutomation,
} from './remote-nodes-browser-automation';
import { type AndroidAutomationConfigDraft } from './remote-node-android-config.component';
import { CoordinatorPairingComponent } from './coordinator-pairing.component';
import { RemoteNodeListComponent } from './remote-node-list.component';
import { RemoteNodeDetailComponent, type RemoteNodeDetailAction } from './remote-node-detail.component';
import {
  buildCanonicalConnectionConfig,
  buildPairingCommand,
  buildPairingLink,
  formatPairingCredentialLabel,
  formatExpiry,
  formatRelativeTime,
  selectPairingConnectionHost,
  selectPairingConnectionPort,
  type PairingCopyInput,
} from './remote-nodes-pairing-ui';

export type { RemoteNodesSection };

@Component({
  standalone: true,
  selector: 'app-remote-nodes-settings-tab',
  imports: [
    SaveStateBannerComponent,
    ValidationRowComponent,
    CopyRowComponent,
    CodePreviewBlockComponent,
    DangerZoneComponent,
    SettingsSectionTabsComponent,
    CoordinatorPairingComponent,
    RemoteNodeListComponent,
    RemoteNodeDetailComponent,
  ],
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
  protected readonly draftAutoOffloadAndroid = signal(true);
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

  protected readonly liveNodes = signal<RemoteNodeRosterEntry[]>([]);
  protected readonly connectedCount = signal(0);

  // Task-based section navigation (Task 3) and Computers list/detail selection (Task 4).
  protected readonly activeSection = signal<RemoteNodesSection>('overview');
  protected readonly selectedNodeId = signal<string | null>(null);
  private nodeSelectionInitialDone = false;

  // Async state for the per-node config forms owned by RemoteNodeDetailComponent
  // (Task 4) — the drafts themselves live in the child; this component keeps the
  // authoritative in-flight/error state and performs the IPC calls.
  protected readonly baBusy = signal(false);
  protected readonly aaBusy = signal(false);
  // Tier 3 — guided profile login.
  protected readonly loginBusy = signal(false);
  protected readonly loginNotice = signal<string | null>(null);

  protected readonly error = signal<string | null>(null);

  private unsubscribeNodeEvent: (() => void) | null = null;
  private unsubscribeNodesChanged: (() => void) | null = null;

  readonly selectedNode = computed<RemoteNodeRosterEntry | null>(() => {
    const id = this.selectedNodeId();
    if (!id) {
      return null;
    }
    return this.liveNodes().find((node) => node.id === id) ?? null;
  });

  readonly hasDraftChanges = computed(() => {
    return (
      this.draftPort() !== this.store.remoteNodesServerPort() ||
      this.draftHost() !== this.store.remoteNodesServerHost() ||
      this.draftNamespace() !== this.store.remoteNodesNamespace() ||
      this.draftRequireTls() !== this.store.remoteNodesRequireTls() ||
      this.draftTlsMode() !== this.store.remoteNodesTlsMode() ||
      this.draftAutoOffloadBrowser() !== this.store.remoteNodesAutoOffloadBrowser() ||
      this.draftAutoOffloadAndroid() !== this.store.remoteNodesAutoOffloadAndroid() ||
      this.draftAutoOffloadGpu() !== this.store.remoteNodesAutoOffloadGpu()
    );
  });

  readonly configSaveState = computed<SaveState>(() => {
    if (this.applying()) {
      return 'saving';
    }
    if (!this.hasDraftChanges()) {
      return 'saved';
    }
    return this.serverStatus().running ? 'restart' : 'dirty';
  });

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

  readonly pairingCommandPreview = () => {
    const pairing = this.activePairing();
    return pairing ? this.buildPairingCommand(pairing.token) : '';
  };

  readonly nodeHealthEntries = (): NodeHealthEntry[] => {
    return buildNodeHealthEntries(this.liveNodes());
  };

  /** Tabs for the shared section switcher; badges reflect live counts. */
  protected sectionTabs(): SettingsSectionTab[] {
    return buildRemoteNodesSectionTabs(this.pendingPairings().length, this.connectedCount());
  }

  protected onSectionChange(id: string): void {
    if (isRemoteNodesSection(id)) {
      this.activeSection.set(id);
    }
  }

  protected goToSection(id: RemoteNodesSection): void {
    this.activeSection.set(id);
  }

  private syncSelectedNode(nodes: RemoteNodeRosterEntry[]): void {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: this.selectedNodeId(), initialSelectionDone: this.nodeSelectionInitialDone },
      nodes,
    );
    this.nodeSelectionInitialDone = next.initialSelectionDone;
    if (next.selectedNodeId !== this.selectedNodeId()) {
      this.selectedNodeId.set(next.selectedNodeId);
    }
  }

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
      this.connectedCount.set(nodes.filter(isRemoteNodeOnline).length);
      this.syncSelectedNode(nodes);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeNodeEvent?.();
    this.unsubscribeNodesChanged?.();
  }

  protected syncDraftsFromStore(): void {
    this.draftPort.set(this.store.remoteNodesServerPort());
    this.draftHost.set(this.store.remoteNodesServerHost());
    this.draftNamespace.set(this.store.remoteNodesNamespace());
    this.draftRequireTls.set(this.store.remoteNodesRequireTls());
    this.draftTlsMode.set(this.store.remoteNodesTlsMode());
    this.draftAutoOffloadBrowser.set(this.store.remoteNodesAutoOffloadBrowser());
    this.draftAutoOffloadAndroid.set(this.store.remoteNodesAutoOffloadAndroid());
    this.draftAutoOffloadGpu.set(this.store.remoteNodesAutoOffloadGpu());
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await this.ipc.getServerStatus();
      this.serverStatus.set(status);
      if (!status.running) {
        this.connectedCount.set(0);
      }
    } catch {
      // Non-fatal — server may simply not be running
    }
  }

  private async refreshNodes(): Promise<void> {
    try {
      const nodes = await this.ipc.listNodes();
      this.liveNodes.set(nodes);
      this.connectedCount.set(nodes.filter(isRemoteNodeOnline).length);
      this.syncSelectedNode(nodes);
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

  async changeComputerRole(role: HarnessRole): Promise<void> {
    await this.store.set('workerMode', {
      ...this.store.workerMode(),
      role,
    });
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
      await this.store.set('remoteNodesAutoOffloadAndroid', this.draftAutoOffloadAndroid());
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
    if (token) await this.writeClipboard(token);
  }

  async copyLegacyConnectionConfig(): Promise<void> {
    const token = this.store.remoteNodesEnrollmentToken();
    if (token) await this.writeClipboard(JSON.stringify(this.buildConnectionConfig(token), null, 2));
  }

  async copyPairingLink(token: string): Promise<void> {
    await this.writeClipboard(this.buildPairingLink(token));
  }

  async copyPairingCommand(token: string): Promise<void> {
    await this.writeClipboard(this.buildPairingCommand(token));
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

  async resetConnection(entry: NodeHealthEntry): Promise<void> {
    this.error.set(null);
    const reset = await this.ipc.resetConnection(entry.id).catch((err: Error) => void this.error.set(err.message));
    if (reset === false) this.error.set(`${entry.name} is not connected, so there is no connection to reset.`);
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

  protected formatPairingCredentialLabel = formatPairingCredentialLabel;

  /**
   * Single entry point for every user intent emitted by RemoteNodeDetailComponent
   * (Task 4). The child owns per-node draft/open-close UI state; this method
   * owns the authoritative async operations, confirmations, and error surface —
   * unchanged from the pre-Task-4 per-method behavior, just parameterized by
   * the emitted action instead of reading the component's own draft signals.
   */
  protected onDetailAction(action: RemoteNodeDetailAction): void {
    switch (action.type) {
      case 'revoke':
        void this.revokeNode(action.nodeId);
        break;
      case 'reset-connection': {
        const entry = this.nodeHealthEntries().find((e) => e.id === action.nodeId);
        if (entry) {
          void this.resetConnection(entry);
        }
        break;
      }
      case 'configure-browser':
        void this.applyBrowserConfigFor(action.nodeId, action.config, action.extensionRelayEnabled);
        break;
      case 'configure-android':
        void this.applyAndroidConfigFor(action.nodeId, action.config);
        break;
      case 'run-login':
        void this.runLoginOnNodeFor(action.nodeId, action.url);
        break;
      case 'copy':
        void this.writeClipboard(action.value);
        break;
      case 'repair':
        // No-op: app-remote-node-repair-panel is fully self-contained (its own
        // IPC calls and state) — nothing for the parent to do.
        break;
    }
  }

  /** Fire the login Chrome on the node (opens on that machine's screen). */
  private async runLoginOnNodeFor(nodeId: string, url: string): Promise<void> {
    const entry = this.nodeHealthEntries().find((e) => e.id === nodeId);
    const ok = confirm(
      `Open a login Chrome on "${entry?.name ?? nodeId}"?\n\n` +
      "Chrome opens on that computer's screen and the node's managed Chrome is " +
      'stopped first. You must be at that machine (or on remote desktop) to log in.',
    );
    if (!ok) {
      return;
    }
    this.loginBusy.set(true);
    this.loginNotice.set(null);
    this.error.set(null);
    try {
      await this.ipc.runBrowserLogin(nodeId, url.trim() || undefined);
      this.loginNotice.set(
        `Chrome is opening on ${entry?.name ?? nodeId}. Log in there, then close that window — the session will be reused.`,
      );
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loginBusy.set(false);
    }
  }

  /** Push the drafted browser-automation config to the node (service-scoped). */
  private async applyBrowserConfigFor(
    nodeId: string,
    config: BrowserAutomationConfigInput,
    extensionRelayEnabled: boolean,
  ): Promise<void> {
    const entry = this.nodeHealthEntries().find((e) => e.id === nodeId);
    const wasEnabled = entry?.browserAutomation?.enabled ?? entry?.browserAutomationReady ?? false;

    // Confirm the first time automation is turned on — it's a sensitive,
    // ungoverned capability, so make enabling a deliberate action (the IPC layer
    // shares the trusted-operator model with service.restart; this is the
    // in-app authorization gate).
    if (config.enabled && !wasEnabled) {
      const ok = confirm(
        `Enable browser automation on "${entry?.name ?? nodeId}"?\n\n` +
        'Agents spawned on this node will be able to drive a logged-in Chrome ' +
        'with no per-action approval. Only do this on a trusted node with a ' +
        'dedicated automation profile.',
      );
      if (!ok) {
        return;
      }
    }

    this.baBusy.set(true);
    this.error.set(null);
    try {
      const summary = await this.ipc.updateBrowserAutomation(nodeId, config, {
        enabled: extensionRelayEnabled,
      });
      // Apply the authoritative summary the node returned immediately, rather
      // than waiting for the next heartbeat — keeps the roster + detail view in
      // sync without a second Configure click.
      const browserSummary = summary?.browserAutomation;
      if (browserSummary) {
        this.liveNodes.update((nodes) =>
          withPatchedBrowserAutomation(nodes, nodeId, browserSummary),
        );
      }
      const relaySummary = summary?.extensionRelay;
      if (relaySummary) {
        this.liveNodes.update((nodes) =>
          withPatchedExtensionRelay(nodes, nodeId, relaySummary),
        );
      }
      // Reconcile with the registry in the background (best-effort).
      void this.refreshNodes();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.baBusy.set(false);
    }
  }

  private async applyAndroidConfigFor(
    nodeId: string,
    payload: AndroidAutomationConfigDraft,
  ): Promise<void> {
    const entry = this.nodeHealthEntries().find((e) => e.id === nodeId);
    const wasEnabled = entry?.androidAutomation?.enabled ?? entry?.androidAutomationReady ?? false;

    if (payload.enabled && !wasEnabled) {
      const ok = confirm(
        `Enable Android automation on "${entry?.name ?? nodeId}"?\n\n` +
        'Agents spawned on this node will be able to control the leased Android ' +
        'device or emulator through mobile-mcp. Only enable this on a trusted node.',
      );
      if (!ok) {
        return;
      }
    }

    this.aaBusy.set(true);
    this.error.set(null);
    try {
      const summary = await this.ipc.updateAndroidAutomation(nodeId, payload);
      if (summary) {
        this.liveNodes.update((nodes) => withPatchedAndroidAutomation(nodes, nodeId, summary));
      }
      void this.refreshNodes();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.aaBusy.set(false);
    }
  }

  protected pairingExpiresSoon(pairing: RemotePairingCredentialInfo): boolean {
    return pairing.expiresAt - Date.now() <= 15 * 60_000;
  }

  protected formatExpiry = formatExpiry;
  protected formatRelativeTime = formatRelativeTime;

  private buildConnectionConfig(token: string): Record<string, unknown> {
    return buildCanonicalConnectionConfig(this.buildPairingCopyInput(token));
  }

  private buildPairingLink(token: string): string {
    return buildPairingLink(this.buildPairingCopyInput(token));
  }

  private buildPairingCommand(token: string): string {
    return buildPairingCommand(this.buildPairingCopyInput(token));
  }

  private buildPairingCopyInput(token: string): PairingCopyInput {
    return {
      token,
      label: this.pendingPairings().find((pairing) => pairing.token === token)?.label,
      host: selectPairingConnectionHost(this.serverStatus(), this.store.remoteNodesServerHost()),
      port: selectPairingConnectionPort(this.serverStatus(), this.store.remoteNodesServerPort()),
      namespace: this.store.remoteNodesNamespace(),
      requireTls: this.serverStatus().requireTls ?? this.store.remoteNodesRequireTls(),
    };
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
