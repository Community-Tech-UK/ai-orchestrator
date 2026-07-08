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
} from '../../core/services/ipc/remote-node-ipc.service';
import type {
  RemotePairingCredentialInfo,
  RemoteNodeRosterEntry,
} from '../../../../shared/types/worker-node.types';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { InlineHelpComponent } from '../../shared/help/inline-help.component';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import { ValidationRowComponent } from './ui/validation-row.component';
import { CopyRowComponent } from './ui/copy-row.component';
import { CodePreviewBlockComponent } from './ui/code-preview-block.component';
import { DangerZoneComponent } from './ui/danger-zone.component';
import {
  type NodeHealthEntry,
  buildNodeHealthEntries,
  browserAutomationState,
  browserAutomationLabel,
  extensionRelayState,
  extensionRelayLabel,
  androidAutomationState,
  androidAutomationLabel,
  withPatchedBrowserAutomation,
  withPatchedExtensionRelay,
  withPatchedAndroidAutomation,
  loginCommandPreview,
} from './remote-nodes-browser-automation';
import {
  RemoteNodeAndroidConfigComponent,
  type AndroidAutomationConfigDraft,
} from './remote-node-android-config.component';
import { RemoteNodeRepairPanelComponent } from './remote-node-repair-panel.component';
import { CoordinatorPairingComponent } from './coordinator-pairing.component';
import {
  buildCanonicalConnectionConfig,
  buildNodeDiagnostics,
  buildPairingCommand,
  buildPairingLink,
  formatPairingCredentialLabel,
  formatNodeCapacity,
  formatNodePlatformLabel,
  selectPairingConnectionHost,
  selectPairingConnectionPort,
  type PairingCopyInput,
} from './remote-nodes-pairing-ui';

@Component({
  standalone: true,
  selector: 'app-remote-nodes-settings-tab',
  imports: [
    InlineHelpComponent,
    SaveStateBannerComponent,
    ValidationRowComponent,
    CopyRowComponent,
    CodePreviewBlockComponent,
    DangerZoneComponent,
    RemoteNodeAndroidConfigComponent,
    RemoteNodeRepairPanelComponent,
    CoordinatorPairingComponent,
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

  // Per-node browser-automation config form (one node configured at a time).
  protected readonly configuringNodeId = signal<string | null>(null);
  protected readonly baDraftEnabled = signal(false);
  protected readonly baDraftProfileDir = signal('');
  protected readonly baDraftHeadless = signal(false);
  protected readonly baDraftExtensionRelayEnabled = signal(false);
  protected readonly baBusy = signal(false);
  // Per-node Android automation config form (one node configured at a time).
  protected readonly androidConfiguringNodeId = signal<string | null>(null);
  protected readonly aaBusy = signal(false);
  // Tier 3 — guided profile login.
  protected readonly loginUrlDraft = signal('https://www.facebook.com');
  protected readonly loginBusy = signal(false);
  protected readonly loginNotice = signal<string | null>(null);

  protected readonly error = signal<string | null>(null);

  private unsubscribeNodeEvent: (() => void) | null = null;
  private unsubscribeNodesChanged: (() => void) | null = null;

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

  async copyNodeDiagnostics(entry: NodeHealthEntry): Promise<void> {
    await this.writeClipboard(JSON.stringify(this.buildNodeDiagnostics(entry), null, 2));
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

  protected browserAutomationState = browserAutomationState;
  protected browserAutomationLabel = browserAutomationLabel;
  protected extensionRelayState = extensionRelayState;
  protected extensionRelayLabel = extensionRelayLabel;
  protected androidAutomationState = androidAutomationState;
  protected androidAutomationLabel = androidAutomationLabel;
  protected formatPairingCredentialLabel = formatPairingCredentialLabel;
  protected formatNodePlatformLabel = formatNodePlatformLabel;
  protected formatNodeCapacity = formatNodeCapacity;

  protected openBrowserConfig(entry: NodeHealthEntry): void {
    this.configuringNodeId.set(entry.id);
    this.baDraftEnabled.set(entry.browserAutomation?.enabled ?? entry.browserAutomationReady);
    this.baDraftProfileDir.set(entry.browserAutomation?.profileDir ?? '');
    this.baDraftHeadless.set(entry.browserAutomation?.headless ?? false);
    this.baDraftExtensionRelayEnabled.set(entry.extensionRelay?.enabled ?? entry.extensionRelayReady);
  }

  protected cancelBrowserConfig(): void { this.configuringNodeId.set(null); }

  protected openAndroidConfig(entry: NodeHealthEntry): void {
    this.androidConfiguringNodeId.set(entry.id);
  }

  protected cancelAndroidConfig(): void { this.androidConfiguringNodeId.set(null); }

  /**
   * The exact login command that "Run on node" would execute, for the node's
   * reported profile + platform. Empty until the profile has been applied (so
   * the previewed command matches what actually runs). Returns '' on any
   * unsafe/unknown input rather than throwing into the template.
   */
  protected loginCommandPreview(entry: NodeHealthEntry): string {
    return loginCommandPreview(entry, this.loginUrlDraft());
  }

  async copyLoginCommand(entry: NodeHealthEntry): Promise<void> {
    const command = this.loginCommandPreview(entry);
    if (command) {
      await this.writeClipboard(command);
    }
  }

  /** Fire the login Chrome on the node (opens on that machine's screen). */
  async runLoginOnNode(entry: NodeHealthEntry): Promise<void> {
    const ok = confirm(
      `Open a login Chrome on "${entry.name}"?\n\n` +
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
      await this.ipc.runBrowserLogin(entry.id, this.loginUrlDraft().trim() || undefined);
      this.loginNotice.set(
        `Chrome is opening on ${entry.name}. Log in there, then close that window — the session will be reused.`,
      );
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loginBusy.set(false);
    }
  }

  /** Push the drafted browser-automation config to the node (service-scoped). */
  async applyBrowserConfig(): Promise<void> {
    const nodeId = this.configuringNodeId();
    if (!nodeId) {
      return;
    }
    const entry = this.nodeHealthEntries().find((e) => e.id === nodeId);
    const wasEnabled = entry?.browserAutomation?.enabled ?? entry?.browserAutomationReady ?? false;

    // Confirm the first time automation is turned on — it's a sensitive,
    // ungoverned capability, so make enabling a deliberate action (the IPC layer
    // shares the trusted-operator model with service.restart; this is the
    // in-app authorization gate).
    if (this.baDraftEnabled() && !wasEnabled) {
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
      const profileDir = this.baDraftProfileDir().trim();
      const summary = await this.ipc.updateBrowserAutomation(nodeId, {
        enabled: this.baDraftEnabled(),
        headless: this.baDraftHeadless(),
        ...(profileDir ? { profileDir } : {}),
      }, {
        enabled: this.baDraftExtensionRelayEnabled(),
      });
      // Apply the authoritative summary the node returned immediately, rather
      // than waiting for the next heartbeat — keeps the badge + login section in
      // sync without a second Configure click.
      const browserSummary = summary?.browserAutomation;
      if (browserSummary) {
        this.liveNodes.update((nodes) =>
          withPatchedBrowserAutomation(nodes, nodeId, browserSummary),
        );
        this.baDraftProfileDir.set(browserSummary.profileDir);
        this.baDraftHeadless.set(browserSummary.headless);
      }
      const relaySummary = summary?.extensionRelay;
      if (relaySummary) {
        this.liveNodes.update((nodes) =>
          withPatchedExtensionRelay(nodes, nodeId, relaySummary),
        );
        this.baDraftExtensionRelayEnabled.set(relaySummary.enabled);
      }
      // Reconcile with the registry in the background (best-effort).
      void this.refreshNodes();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.baBusy.set(false);
    }
  }

  async applyAndroidConfig(payload: AndroidAutomationConfigDraft): Promise<void> {
    const nodeId = this.androidConfiguringNodeId();
    if (!nodeId) {
      return;
    }
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
    return buildCanonicalConnectionConfig(this.buildPairingCopyInput(token));
  }

  private buildPairingLink(token: string): string {
    return buildPairingLink(this.buildPairingCopyInput(token));
  }

  private buildPairingCommand(token: string): string {
    return buildPairingCommand(this.buildPairingCopyInput(token));
  }

  private buildNodeDiagnostics(entry: NodeHealthEntry): Record<string, unknown> {
    return buildNodeDiagnostics(entry);
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
