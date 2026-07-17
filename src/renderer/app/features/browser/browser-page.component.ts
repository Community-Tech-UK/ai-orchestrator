import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
  BrowserAuditEntry,
  BrowserElementContext,
  BrowserGatewayResult,
  BrowserGrantMode,
  BrowserGrantProposal,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { BrowserUnattendedPanelComponent } from './browser-unattended-panel.component';

interface BrowserSnapshotView { title: string; url: string; text: string }

const recentAuditWindowMs = 15 * 60 * 1000;

@Component({
  selector: 'app-browser-page',
  standalone: true,
  imports: [CommonModule, BrowserUnattendedPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './browser-page.component.html',
  styleUrl: './browser-page.component.scss',
})
export class BrowserPageComponent implements OnInit {
  private readonly ipc = inject(BrowserGatewayIpcService);
  private readonly auxIpc = inject(AuxiliaryLlmIpcService);
  private readonly remoteNodes = inject(RemoteNodeStore);

  readonly profiles = signal<BrowserProfile[]>([]);
  readonly targets = signal<BrowserTarget[]>([]);
  readonly auditEntries = signal<BrowserAuditEntry[]>([]);
  readonly approvalRequests = signal<BrowserApprovalRequest[]>([]);
  readonly activeGrants = signal<BrowserPermissionGrant[]>([]);
  readonly health = signal<unknown>(null);
  readonly snapshot = signal<BrowserSnapshotView | null>(null);
  readonly extractedText = signal<string | null>(null);
  readonly extracting = signal(false);
  readonly screenshotDataUrl = signal<string | null>(null);
  readonly selectedProfileId = signal<string | null>(null);
  readonly selectedTargetId = signal<string | null>(null);
  readonly createLabel = signal('');
  readonly createDefaultUrl = signal('');
  readonly createAllowedOrigins = signal('');
  readonly profileExecutionNodeDraft = signal<string | null>(null);
  readonly navigateUrl = signal('');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly autonomousSubmitEnabled = signal<Record<string, boolean>>({});
  readonly autonomousDestructiveEnabled = signal<Record<string, boolean>>({});
  readonly autonomousConfirmations = signal<Record<string, string>>({});
  readonly showAuditHistory = signal(false);
  readonly showUnattendedSection = signal(false);

  readonly runningProfileCount = computed(
    () => this.profiles().filter((profile) => profile.status === 'running').length,
  );

  readonly selectedProfile = computed(
    () => this.profiles().find((profile) => profile.id === this.selectedProfileId()) ?? null,
  );

  readonly browserNodeOptions = computed(() => [...this.remoteNodes.nodes()].sort((a, b) => {
    const rank = (node: RemoteNodeRosterEntry): number =>
      node.capabilities.hasBrowserMcp ? 0 : node.capabilities.hasBrowserRuntime ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  }));

  readonly selectedTarget = computed(
    () => this.targets().find((target) => target.id === this.selectedTargetId()) ?? null,
  );

  readonly canNavigate = computed(
    () => Boolean(
      this.selectedProfileId() &&
      this.selectedTargetId() &&
      this.navigateUrl().trim() &&
      this.selectedTarget()?.driver !== 'extension',
    ),
  );

  readonly healthJson = computed(() => JSON.stringify(this.health() ?? {}, null, 2));

  readonly canSaveProfileExecutionNode = computed(() => {
    const profile = this.selectedProfile();
    if (!profile) {
      return false;
    }
    return (profile.executionNodeId ?? null) !== this.profileExecutionNodeDraft();
  });

  readonly recentAuditEntries = computed(
    () => this.auditEntries().filter((entry) => this.isRecentAuditEntry(entry)),
  );

  readonly olderAuditEntries = computed(
    () => this.auditEntries().filter((entry) => !this.isRecentAuditEntry(entry)),
  );

  readonly providerCapabilityRows = computed(() => {
    const details = (this.health() as {
      providerCapabilityDetails?: Record<string, {
        available?: boolean;
        message?: string;
        status?: string;
      }>;
    } | null)?.providerCapabilityDetails;
    if (!details) {
      return [];
    }
    return Object.entries(details).map(([name, detail]) => ({
      name,
      available: Boolean(detail.available),
      message: detail.message ?? detail.status ?? 'Unavailable',
    }));
  });

  async ngOnInit(): Promise<void> {
    void this.remoteNodes.initialize();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      await Promise.all([
        this.refreshProfiles(),
        this.refreshTargets(),
        this.refreshAudit(),
        this.refreshApprovals(),
        this.refreshGrants(),
        this.refreshHealth(),
      ]);
    } finally {
      this.loading.set(false);
    }
  }

  async refreshProfiles(): Promise<void> {
    const response = await this.ipc.listProfiles();
    this.applyGatewayArray(response, this.profiles);
    const current = this.selectedProfileId();
    if (!current || !this.profiles().some((profile) => profile.id === current)) {
      this.selectedProfileId.set(this.profiles()[0]?.id ?? null);
    }
    this.syncProfileExecutionNodeDraft();
  }

  async refreshTargets(): Promise<void> {
    const response = await this.ipc.listTargets({});
    this.applyGatewayArray(response, this.targets);
    const selected = this.targets().find((target) => target.status === 'selected') ?? this.targets()[0];
    this.selectedTargetId.set(selected?.id ?? null);
    if (selected?.url) {
      this.navigateUrl.set(selected.url);
    }
  }

  async refreshAudit(): Promise<void> {
    const response = await this.ipc.getAuditLog({ limit: 50 });
    this.applyGatewayArray(response, this.auditEntries);
  }

  async refreshApprovals(): Promise<void> {
    const response = await this.ipc.listApprovalRequests({ status: 'pending', limit: 25 });
    this.applyGatewayArray(response, this.approvalRequests);
  }

  async refreshGrants(): Promise<void> {
    const response = await this.ipc.listGrants({ limit: 25 });
    this.applyGatewayArray(response, this.activeGrants);
  }

  async refreshHealth(): Promise<void> {
    const response = await this.ipc.getHealth();
    if (response.success) {
      this.health.set(response.data?.data ?? null);
    }
  }

  onCreateField(field: 'label' | 'defaultUrl' | 'allowedOrigins', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (field === 'label') {
      this.createLabel.set(value);
    } else if (field === 'defaultUrl') {
      this.createDefaultUrl.set(value);
    } else {
      this.createAllowedOrigins.set(value);
    }
  }

  onProfileExecutionNodeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.profileExecutionNodeDraft.set(value || null);
  }

  onNavigateUrlInput(event: Event): void {
    this.navigateUrl.set((event.target as HTMLInputElement).value);
  }

  onAutonomousConfirmationInput(approval: BrowserApprovalRequest, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.autonomousConfirmations.update((current) => ({
      ...current,
      [approval.requestId]: value,
    }));
  }

  toggleAutonomousSubmit(approval: BrowserApprovalRequest): void {
    this.autonomousSubmitEnabled.update((current) => ({
      ...current,
      [approval.requestId]: !current[approval.requestId],
    }));
  }

  toggleAutonomousDestructive(approval: BrowserApprovalRequest): void {
    this.autonomousDestructiveEnabled.update((current) => ({
      ...current,
      [approval.requestId]: !current[approval.requestId],
    }));
  }

  async createProfile(): Promise<void> {
    const label = this.createLabel().trim();
    if (!label) {
      this.errorMessage.set('Profile label is required.');
      return;
    }

    let allowedOrigins: BrowserAllowedOrigin[];
    try {
      allowedOrigins = this.normalizeAllowedOrigins(this.createAllowedOrigins());
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Allowed origins could not be parsed.',
      );
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.ipc.createProfile({
        label,
        mode: 'session',
        browser: 'chrome',
        allowedOrigins,
        defaultUrl: this.createDefaultUrl().trim() || undefined,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to create profile.');
        return;
      }
      await this.refreshProfiles();
      await this.refreshAudit();
    } finally {
      this.working.set(false);
    }
  }

  selectProfile(profileId: string): void {
    this.selectedProfileId.set(profileId);
    this.syncProfileExecutionNodeDraft();
    this.selectedTargetId.set(null);
    this.snapshot.set(null);
    this.screenshotDataUrl.set(null);
    void this.refreshTargets();
  }

  async updateProfileExecutionNode(): Promise<void> {
    const profile = this.selectedProfile();
    if (!profile) {
      return;
    }
    const nodeId = this.profileExecutionNodeDraft();
    const node = nodeId ? this.remoteNodes.nodeById(nodeId) : undefined;
    if (nodeId && (!node || !this.isProfileNodeSelectable(node))) {
      this.errorMessage.set('Selected node is not ready for remote browser automation.');
      return;
    }
    const updated = await this.runGatewayAction(() =>
      this.ipc.updateProfile({
        profileId: profile.id,
        executionNodeId: nodeId,
      }),
    );
    if (!updated) {
      return;
    }
    await this.refreshProfiles();
    await this.refreshTargets();
  }

  async openProfile(profileId: string): Promise<void> {
    await this.runGatewayAction(() => this.ipc.openProfile({ profileId }));
    this.selectedProfileId.set(profileId);
    await this.refreshTargets();
  }

  async closeProfile(profileId: string): Promise<void> {
    await this.runGatewayAction(() => this.ipc.closeProfile({ profileId }));
    await this.refreshProfiles();
    await this.refreshTargets();
  }

  async selectTarget(target: BrowserTarget): Promise<void> {
    if (!target.profileId) {
      return;
    }
    this.selectedProfileId.set(target.profileId);
    this.selectedTargetId.set(target.id);
    if (target.url) {
      this.navigateUrl.set(target.url);
    }
    await this.runGatewayAction(() =>
      this.ipc.selectTarget({ profileId: target.profileId!, targetId: target.id }),
    );
  }

  async navigate(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    await this.runGatewayAction(() =>
      this.ipc.navigate({ ...request, url: this.navigateUrl().trim() }),
    );
    await this.refreshTargets();
    await this.refreshAudit();
  }

  async loadSnapshot(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    const response = await this.ipc.snapshot(request);
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to load snapshot.');
      return;
    }
    this.snapshot.set((response.data?.data as BrowserSnapshotView | undefined) ?? null);
    this.extractedText.set(null);
    await this.refreshAudit();
  }

  /**
   * Distill the loaded snapshot's raw page text into clean main content via the
   * auxiliary `webExtract` slot (local/cheap model). Advisory; leaves the raw
   * snapshot intact and surfaces an error rather than throwing.
   */
  async extractMainContent(): Promise<void> {
    const snap = this.snapshot();
    if (!snap?.text) {
      return;
    }
    this.extracting.set(true);
    this.extractedText.set(null);
    try {
      const response = await this.auxIpc.extractWeb({ text: snap.text });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to extract main content.');
        return;
      }
      this.extractedText.set(response.data?.text ?? '');
    } finally {
      this.extracting.set(false);
    }
  }

  async captureScreenshot(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    const response = await this.ipc.screenshot({ ...request, fullPage: true });
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to capture screenshot.');
      return;
    }
    const base64 = response.data?.data;
    this.screenshotDataUrl.set(typeof base64 === 'string' ? `data:image/png;base64,${base64}` : null);
    await this.refreshAudit();
  }

  async requestUserLogin(): Promise<void> {
    const profileId = this.selectedProfileId();
    if (!profileId) {
      return;
    }
    const selectedTarget = this.selectedTarget();
    const targetId = selectedTarget?.profileId === profileId ? selectedTarget.id : undefined;
    const response = await this.runGatewayAction(() =>
      this.ipc.requestUserLogin({
        profileId,
        ...(targetId ? { targetId } : {}),
        reason: 'Login check requested from Browser Gateway page',
      }),
    );
    if (response) {
      await this.refreshApprovals();
    }
  }

  async approveApprovalRequest(
    approval: BrowserApprovalRequest,
    mode: BrowserGrantMode,
  ): Promise<void> {
    const phrase = this.confirmationPhrase(approval);
    const grant = this.grantProposalForApproval(approval, mode);
    if (
      this.grantRequiresAutonomousConfirmation(grant) &&
      this.autonomousConfirmation(approval).trim() !== phrase
    ) {
      this.errorMessage.set(
        `Type ${phrase} to allow publishing or deleting without another prompt.`,
      );
      return;
    }
    const response = await this.runGatewayAction(() =>
      this.ipc.approveRequest({
        requestId: approval.requestId,
        grant,
        reason: 'Approved from Browser Gateway page',
      }),
    );
    if (response) {
      this.clearAutonomousDraft(approval.requestId);
      await Promise.all([this.refreshApprovals(), this.refreshGrants()]);
    }
  }

  async denyApprovalRequest(requestId: string): Promise<void> {
    const response = await this.runGatewayAction(() =>
      this.ipc.denyRequest({
        requestId,
        reason: 'Denied from Browser Gateway page',
      }),
    );
    if (response) {
      await this.refreshApprovals();
    }
  }

  async revokeGrant(grantId: string): Promise<void> {
    const response = await this.runGatewayAction(() =>
      this.ipc.revokeGrant({
        grantId,
        reason: 'Revoked from Browser Gateway page',
      }),
    );
    if (response) {
      await this.refreshGrants();
    }
  }

  formatGrantExpiry(expiresAt: number): string {
    return new Date(expiresAt).toLocaleString();
  }

  formatApprovalScope(approval: BrowserApprovalRequest): string {
    const origins = approval.proposedGrant.allowedOrigins
      .map((origin) =>
        `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? `:${origin.port}` : ''}`,
      )
      .join(', ');
    const actions = approval.proposedGrant.allowedActionClasses.join(', ');
    return `${approval.proposedGrant.mode} · ${actions}${origins ? ` · ${origins}` : ''}`;
  }

  formatElementContext(element: BrowserElementContext): string {
    return [
      element.accessibleName,
      element.label,
      element.visibleText,
      element.role,
      element.inputType,
      element.inputName,
      element.placeholder,
      element.nearbyText,
    ].filter(Boolean).join(' · ');
  }
  formatUploadRoots(approval: BrowserApprovalRequest): string {
    return approval.proposedGrant.uploadRoots?.join(', ') ?? '';
  }
  autonomousSubmitIsEnabled(approval: BrowserApprovalRequest): boolean {
    return Boolean(this.autonomousSubmitEnabled()[approval.requestId]);
  }
  autonomousDestructiveIsEnabled(approval: BrowserApprovalRequest): boolean {
    return Boolean(this.autonomousDestructiveEnabled()[approval.requestId]);
  }
  autonomousConfirmation(approval: BrowserApprovalRequest): string {
    return this.autonomousConfirmations()[approval.requestId] ?? '';
  }
  requiresAutonomousConfirmation(approval: BrowserApprovalRequest): boolean {
    const grant = this.grantProposalForApproval(approval, 'autonomous');
    return this.grantRequiresAutonomousConfirmation(grant);
  }
  confirmationPhrase(approval: BrowserApprovalRequest): string {
    const profileLabel = this.profiles().find((profile) => profile.id === approval.profileId)?.label;
    if (profileLabel) {
      return profileLabel;
    }
    const location = approval.origin ?? approval.url;
    if (location) {
      try {
        return new URL(location).host;
      } catch {
        return location;
      }
    }
    return approval.profileId;
  }
  profileExecutionLocationLabel(profile: BrowserProfile): string {
    const nodeId = profile.executionNodeId;
    if (!nodeId) {
      return 'Local coordinator';
    }
    const node = this.remoteNodes.nodeById(nodeId);
    return node ? `${node.name} · ${this.nodeReadinessLabel(node)}` : `${nodeId} · Missing`;
  }

  nodeReadinessLabel(node: RemoteNodeRosterEntry): string {
    if (node.status === 'disconnected') {
      return 'Disconnected';
    }
    if (node.capabilities.hasBrowserMcp) {
      return 'Ready';
    }
    if (node.capabilities.hasBrowserRuntime) {
      return 'Chrome only';
    }
    return 'Off';
  }

  isProfileNodeSelectable(node: RemoteNodeRosterEntry): boolean {
    return node.capabilities.hasBrowserMcp && node.status !== 'disconnected';
  }

  toggleAuditHistory(): void {
    this.showAuditHistory.set(!this.showAuditHistory());
  }

  toggleUnattendedSection(): void {
    this.showUnattendedSection.set(!this.showUnattendedSection());
  }

  formatAuditAction(action: string): string {
    return action
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatAuditAge(createdAt: number): string {
    const elapsedMs = Math.max(0, Date.now() - createdAt);
    if (elapsedMs < 60_000) {
      return 'now';
    }
    const elapsedMinutes = Math.floor(elapsedMs / 60_000);
    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
      return `${elapsedHours}h`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) {
      return `${elapsedDays}d`;
    }
    return new Date(createdAt).toLocaleDateString();
  }

  private selectedTargetRequest(): { profileId: string; targetId: string } | null {
    const profileId = this.selectedProfileId();
    const targetId = this.selectedTargetId();
    if (!profileId || !targetId) {
      return null;
    }
    return { profileId, targetId };
  }

  private syncProfileExecutionNodeDraft(): void {
    this.profileExecutionNodeDraft.set(this.selectedProfile()?.executionNodeId ?? null);
  }

  private async runGatewayAction(
    fn: () => Promise<IpcResponse<BrowserGatewayResult<unknown>>>,
  ): Promise<boolean> {
    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await fn();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Browser Gateway action failed.');
        return false;
      }
      await this.refreshAudit();
      return true;
    } finally {
      this.working.set(false);
    }
  }

  private applyGatewayArray<T>(
    response: IpcResponse<BrowserGatewayResult<T[]>>,
    target: { set(value: T[]): void },
  ): void {
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Browser Gateway request failed.');
      return;
    }
    target.set(Array.isArray(response.data?.data) ? response.data.data : []);
  }

  private normalizeAllowedOrigins(raw: string): BrowserAllowedOrigin[] {
    return raw
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        let parsed: URL;
        try {
          const withScheme = /^https?:\/\//i.test(entry) ? entry : `https://${entry}`;
          parsed = new URL(withScheme.replace('://*.', '://wildcard.'));
        } catch {
          throw new Error(`Allowed origin is invalid: ${entry}`);
        }
        const wildcard = parsed.hostname.startsWith('wildcard.');
        return {
          scheme: parsed.protocol === 'http:' ? 'http' : 'https',
          hostPattern: wildcard ? parsed.hostname.replace(/^wildcard\./, '') : parsed.hostname,
          port: parsed.port ? Number(parsed.port) : undefined,
          includeSubdomains: wildcard || entry.includes('*.'),
        };
      });
  }

  private isRecentAuditEntry(entry: BrowserAuditEntry): boolean {
    return Date.now() - entry.createdAt <= recentAuditWindowMs;
  }

  private grantProposalForApproval(
    approval: BrowserApprovalRequest,
    mode: BrowserGrantMode,
  ): BrowserGrantProposal {
    const allowedActionClasses = mode === 'autonomous'
      ? this.autonomousActionClasses(approval)
      : new Set(approval.proposedGrant.allowedActionClasses);
    return {
      ...approval.proposedGrant,
      mode,
      allowedActionClasses: Array.from(allowedActionClasses),
      autonomous: mode === 'autonomous',
    };
  }
  private autonomousActionClasses(approval: BrowserApprovalRequest): Set<BrowserActionClass> {
    const allowedActionClasses = new Set(approval.proposedGrant.allowedActionClasses);
    if (this.autonomousSubmitIsEnabled(approval)) {
      allowedActionClasses.add('submit');
    }
    if (this.autonomousDestructiveIsEnabled(approval)) {
      allowedActionClasses.add('destructive');
    }
    return allowedActionClasses;
  }
  private grantRequiresAutonomousConfirmation(grant: BrowserGrantProposal): boolean {
    return grant.allowedActionClasses.some((actionClass) =>
      actionClass === 'submit' || actionClass === 'destructive');
  }
  private clearAutonomousDraft(requestId: string): void {
    this.autonomousSubmitEnabled.update((current) => this.withoutKey(current, requestId));
    this.autonomousDestructiveEnabled.update((current) => this.withoutKey(current, requestId));
    this.autonomousConfirmations.update((current) => this.withoutKey(current, requestId));
  }
  private withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
  }
}
