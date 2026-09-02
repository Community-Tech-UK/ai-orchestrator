import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type {
  BrowserApprovalRequest,
  BrowserAuditEntry,
  BrowserGatewayResult,
  BrowserGrantMode,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { BrowserApprovalsStore } from '../../core/state/browser-approvals.store';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { BrowserUnattendedPanelComponent } from './browser-unattended-panel.component';
import {
  bindBrowserApprovalDeepLink,
  browserApprovalExactOnly,
  BrowserApprovalFocus,
  browserApprovalPosition,
  browserApprovalReceivedAt,
  shortBrowserApprovalId,
} from './browser-approval-page.utils';
import {
  browserApprovalConfirmationPhrase,
  browserNodeReadinessLabel,
  browserGrantRequiresAutonomousConfirmation,
  buildBrowserGrantProposal,
  filterBrowserTargets,
  formatBrowserApprovalScope,
  formatBrowserAuditAction,
  formatBrowserAuditAge,
  formatBrowserElementContext,
  formatBrowserGrantExpiry,
  formatBrowserUploadRoots,
  isBrowserProfileNodeSelectable,
  LatestBrowserRequestGate,
  nextBrowserPageView,
  normalizeBrowserAllowedOrigins,
  presentBrowserGatewayHealth,
  reconcileBrowserProfileSelection,
  selectBrowserTarget,
  sortBrowserNodes,
  withoutBrowserRecordKey,
  type BrowserPageView,
} from './browser-page-view.utils';

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
export class BrowserPageComponent implements OnInit, AfterViewChecked {
  private readonly ipc = inject(BrowserGatewayIpcService);
  private readonly auxIpc = inject(AuxiliaryLlmIpcService);
  private readonly remoteNodes = inject(RemoteNodeStore);
  private readonly approvals = inject(BrowserApprovalsStore);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private detailGeneration = 0;
  private readonly approvalFocus = new BrowserApprovalFocus(this.host.nativeElement);

  readonly profiles = signal<BrowserProfile[]>([]);
  readonly targets = signal<BrowserTarget[]>([]);
  readonly auditEntries = signal<BrowserAuditEntry[]>([]);
  readonly approvalRequests = this.approvals.pendingRequests;
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
  private readonly latestRequests = new LatestBrowserRequestGate((error) => {
    this.errorMessage.set(error instanceof Error ? error.message : 'Browser Gateway request failed.');
  });
  readonly autonomousSubmitEnabled = signal<Record<string, boolean>>({});
  readonly autonomousDestructiveEnabled = signal<Record<string, boolean>>({});
  readonly autonomousConfirmations = signal<Record<string, string>>({});
  readonly showAuditHistory = signal(false);
  readonly activeView = signal<BrowserPageView>('browser');
  readonly focusedApprovalRequestId = signal<string | null>(null);
  readonly targetFilter = signal('');

  readonly runningProfileCount = computed(
    () => this.profiles().filter((profile) => profile.status === 'running').length,
  );

  readonly selectedProfile = computed(
    () => this.profiles().find((profile) => profile.id === this.selectedProfileId()) ?? null,
  );

  readonly openTargets = computed(() =>
    this.targets().filter((target) => target.status !== 'closed'),
  );

  readonly browserNodeOptions = computed(() => sortBrowserNodes(this.remoteNodes.nodes()));

  readonly selectedTarget = computed(
    () => this.openTargets().find((target) => target.id === this.selectedTargetId()) ?? null,
  );

  readonly filteredTargets = computed(
    () => filterBrowserTargets(this.openTargets(), this.targetFilter()),
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
  readonly healthPresentation = computed(() => presentBrowserGatewayHealth(this.health()));

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

  readonly providerCapabilityRows = computed(() => this.healthPresentation().providers.rows);

  async ngOnInit(): Promise<void> {
    bindBrowserApprovalDeepLink({
      route: this.route,
      destroyRef: this.destroyRef,
      activeView: this.activeView,
      focusedRequestId: this.focusedApprovalRequestId,
      focus: this.approvalFocus,
      refresh: () => void this.refreshApprovals(),
    });
    void this.remoteNodes.initialize();
    await this.refresh();
  }

  ngAfterViewChecked(): void { this.approvalFocus.apply(this.focusedApprovalRequestId()); }

  async refresh(): Promise<void> {
    const isCurrent = this.latestRequests.begin('refresh');
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
      if (isCurrent()) {
        this.selectedProfileId.set(reconcileBrowserProfileSelection(
          this.profiles(),
          this.selectedProfileId(),
          this.selectedTarget(),
        ));
        this.syncProfileExecutionNodeDraft();
      }
    } finally {
      if (isCurrent()) {
        this.loading.set(false);
      }
    }
  }

  async refreshProfiles(): Promise<void> {
    const response = await this.latestRequests.run('profiles', () => this.ipc.listProfiles());
    if (!response) {
      return;
    }
    this.applyGatewayArray(response, this.profiles);
    const current = this.selectedProfileId();
    const targetProfileId = this.selectedTarget()?.profileId;
    if (targetProfileId) {
      this.selectedProfileId.set(targetProfileId);
    } else if (!current || !this.profiles().some((profile) => profile.id === current)) {
      this.selectedProfileId.set(this.profiles()[0]?.id ?? null);
    }
    this.syncProfileExecutionNodeDraft();
  }

  async refreshTargets(preferredProfileId?: string): Promise<void> {
    const previousTarget = this.selectedTarget();
    const response = await this.latestRequests.run('targets', () => this.ipc.listTargets({}));
    if (!response) {
      return;
    }
    this.applyGatewayArray(response, this.targets);
    const selected = selectBrowserTarget(
      this.openTargets(),
      this.selectedTargetId(),
      preferredProfileId,
    );
    if (selected?.id !== previousTarget?.id || selected?.url !== previousTarget?.url) {
      this.resetTargetDetailState(selected?.url ?? '');
    }
    this.selectedTargetId.set(selected?.id ?? null);
    if (selected?.profileId) {
      this.selectedProfileId.set(selected.profileId);
      this.syncProfileExecutionNodeDraft();
    }
    if (selected?.url && !this.navigateUrl()) {
      this.navigateUrl.set(selected.url);
    }
  }

  async refreshAudit(): Promise<void> {
    const response = await this.latestRequests.run(
      'audit', () => this.ipc.getAuditLog({ limit: 50 }),
    );
    if (!response) {
      return;
    }
    this.applyGatewayArray(response, this.auditEntries);
  }

  async refreshApprovals(): Promise<void> { await this.approvals.refresh(true); }

  async refreshGrants(): Promise<void> {
    const response = await this.latestRequests.run(
      'grants', () => this.ipc.listGrants({ limit: 25 }),
    );
    if (!response) {
      return;
    }
    this.applyGatewayArray(response, this.activeGrants);
  }

  async refreshHealth(): Promise<void> {
    const response = await this.latestRequests.run('health', () => this.ipc.getHealth());
    if (!response) {
      return;
    }
    if (!response.success) {
      this.health.set(null);
      this.errorMessage.set(response.error?.message ?? 'Browser Gateway health check failed.');
      return;
    }
    this.health.set(response.data?.data ?? null);
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

  onProfileExecutionNodeChange(event: Event): void { this.profileExecutionNodeDraft.set((event.target as HTMLSelectElement).value || null); }

  onNavigateUrlInput(event: Event): void { this.navigateUrl.set((event.target as HTMLInputElement).value); }
  onTargetFilterInput(event: Event): void { this.targetFilter.set((event.target as HTMLInputElement).value); }

  selectView(view: BrowserPageView): void { this.activeView.set(view); }

  onViewTabKeydown(event: KeyboardEvent): void {
    const nextView = nextBrowserPageView(this.activeView(), event.key);
    if (!nextView) {
      return;
    }
    event.preventDefault();
    this.selectView(nextView);
    queueMicrotask(() => document.getElementById(`${nextView}-view-tab`)?.focus());
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

    let allowedOrigins;
    try {
      allowedOrigins = normalizeBrowserAllowedOrigins(this.createAllowedOrigins());
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

  async selectProfile(profileId: string): Promise<void> {
    this.selectedProfileId.set(profileId);
    this.syncProfileExecutionNodeDraft();
    this.selectedTargetId.set(null);
    this.resetTargetDetailState();
    await this.refreshTargets(profileId);
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
    await this.refreshTargets(profileId);
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
    this.latestRequests.invalidate('targets');
    this.selectedProfileId.set(target.profileId);
    this.selectedTargetId.set(target.id);
    this.resetTargetDetailState(target.url ?? '');
    await this.runGatewayAction(() =>
      this.ipc.selectTarget({ profileId: target.profileId!, targetId: target.id }),
    );
  }

  async navigate(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    const url = this.navigateUrl().trim();
    this.resetTargetDetailState(url);
    await this.runGatewayAction(() =>
      this.ipc.navigate({ ...request, url }),
    );
    await this.refreshTargets();
    await this.refreshAudit();
  }

  async loadSnapshot(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    const detailGeneration = this.detailGeneration;
    const isCurrentRequest = this.latestRequests.begin('snapshot');
    this.latestRequests.invalidate('extraction');
    this.extractedText.set(null);
    this.extracting.set(false);
    const response = await this.latestRequests.resolve(
      () => isCurrentRequest() && detailGeneration === this.detailGeneration,
      () => this.ipc.snapshot(request),
    );
    if (!response) {
      return;
    }
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to load snapshot.');
      return;
    }
    this.snapshot.set((response.data?.data as BrowserSnapshotView | undefined) ?? null);
    this.extractedText.set(null);
    await this.refreshAudit();
  }

  /** Distill the loaded snapshot text into clean main content via the auxiliary LLM. */
  async extractMainContent(): Promise<void> {
    const snap = this.snapshot();
    if (!snap?.text) {
      return;
    }
    const detailGeneration = this.detailGeneration;
    const isCurrentRequest = this.latestRequests.begin('extraction');
    this.extracting.set(true);
    this.extractedText.set(null);
    try {
      const response = await this.latestRequests.resolve(
        () => isCurrentRequest() && detailGeneration === this.detailGeneration
          && this.snapshot() === snap,
        () => this.auxIpc.extractWeb({ text: snap.text }),
      );
      if (!response) {
        return;
      }
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to extract main content.');
        return;
      }
      this.extractedText.set(response.data?.text ?? '');
    } finally {
      if (
        isCurrentRequest() &&
        detailGeneration === this.detailGeneration &&
        this.snapshot() === snap
      ) {
        this.extracting.set(false);
      }
    }
  }

  async captureScreenshot(): Promise<void> {
    const request = this.selectedTargetRequest();
    if (!request) {
      return;
    }
    const detailGeneration = this.detailGeneration;
    const isCurrentRequest = this.latestRequests.begin('screenshot');
    const response = await this.latestRequests.resolve(
      () => isCurrentRequest() && detailGeneration === this.detailGeneration,
      () => this.ipc.screenshot({ ...request, fullPage: true }),
    );
    if (!response) {
      return;
    }
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to capture screenshot.');
      return;
    }
    const base64 = response.data?.data;
    this.screenshotDataUrl.set(typeof base64 === 'string' ? `data:image/png;base64,${base64}` : null);
    await this.refreshAudit();
  }

  async requestUserLogin(): Promise<void> {
    const selectedTarget = this.selectedTarget();
    const profileId = selectedTarget?.profileId ?? this.selectedProfileId();
    if (!profileId) {
      return;
    }
    const targetId = selectedTarget?.profileId ? selectedTarget.id : undefined;
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
    const grant = buildBrowserGrantProposal(
      approval,
      mode,
      this.autonomousSubmitIsEnabled(approval),
      this.autonomousDestructiveIsEnabled(approval),
    );
    if (
      browserGrantRequiresAutonomousConfirmation(grant) &&
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
      this.approvals.removeRequest(approval.requestId);
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
      this.approvals.removeRequest(requestId);
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

  readonly formatGrantExpiry = formatBrowserGrantExpiry;
  readonly formatApprovalScope = formatBrowserApprovalScope;
  readonly formatElementContext = formatBrowserElementContext;
  readonly formatUploadRoots = formatBrowserUploadRoots;
  readonly exactApprovalOnly = browserApprovalExactOnly;
  readonly shortApprovalId = shortBrowserApprovalId;
  readonly approvalReceivedAt = browserApprovalReceivedAt;
  approvalPosition(approval: BrowserApprovalRequest): number { return browserApprovalPosition(approval, this.approvalRequests()); }
  autonomousSubmitIsEnabled(approval: BrowserApprovalRequest): boolean { return Boolean(this.autonomousSubmitEnabled()[approval.requestId]); }
  autonomousDestructiveIsEnabled(approval: BrowserApprovalRequest): boolean { return Boolean(this.autonomousDestructiveEnabled()[approval.requestId]); }
  autonomousConfirmation(approval: BrowserApprovalRequest): string { return this.autonomousConfirmations()[approval.requestId] ?? ''; }
  requiresAutonomousConfirmation(approval: BrowserApprovalRequest): boolean {
    const grant = buildBrowserGrantProposal(
      approval, 'autonomous',
      this.autonomousSubmitIsEnabled(approval),
      this.autonomousDestructiveIsEnabled(approval),
    );
    return browserGrantRequiresAutonomousConfirmation(grant);
  }
  confirmationPhrase(approval: BrowserApprovalRequest): string { return browserApprovalConfirmationPhrase(approval, this.profiles()); }
  profileExecutionLocationLabel(profile: BrowserProfile): string {
    const nodeId = profile.executionNodeId;
    if (!nodeId) {
      return 'Local coordinator';
    }
    const node = this.remoteNodes.nodeById(nodeId);
    return node ? `${node.name} · ${this.nodeReadinessLabel(node)}` : `${nodeId} · Missing`;
  }

  readonly nodeReadinessLabel = browserNodeReadinessLabel;
  readonly isProfileNodeSelectable = isBrowserProfileNodeSelectable;

  toggleAuditHistory(): void { this.showAuditHistory.set(!this.showAuditHistory()); }

  readonly formatAuditAction = formatBrowserAuditAction;
  readonly formatAuditAge = formatBrowserAuditAge;

  private selectedTargetRequest(): { profileId: string; targetId: string } | null {
    const target = this.selectedTarget();
    return target?.profileId ? { profileId: target.profileId, targetId: target.id } : null;
  }

  private syncProfileExecutionNodeDraft(): void { this.profileExecutionNodeDraft.set(this.selectedProfile()?.executionNodeId ?? null); }

  private resetTargetDetailState(navigateUrl = ''): void {
    ++this.detailGeneration;
    this.latestRequests.invalidate('snapshot');
    this.latestRequests.invalidate('screenshot');
    this.latestRequests.invalidate('extraction');
    this.snapshot.set(null);
    this.extractedText.set(null);
    this.screenshotDataUrl.set(null);
    this.extracting.set(false);
    this.navigateUrl.set(navigateUrl);
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

  private isRecentAuditEntry(entry: BrowserAuditEntry): boolean { return Date.now() - entry.createdAt <= recentAuditWindowMs; }

  private clearAutonomousDraft(requestId: string): void {
    this.autonomousSubmitEnabled.update((current) => withoutBrowserRecordKey(current, requestId));
    this.autonomousDestructiveEnabled.update((current) => withoutBrowserRecordKey(current, requestId));
    this.autonomousConfirmations.update((current) => withoutBrowserRecordKey(current, requestId));
  }
}
