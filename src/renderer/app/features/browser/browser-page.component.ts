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
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
  BrowserAuditEntry,
  BrowserGatewayResult,
  BrowserGrantMode,
  BrowserGrantProposal,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface BrowserSnapshotView {
  title: string;
  url: string;
  text: string;
}

@Component({
  selector: 'app-browser-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="browser-page">
      <header class="page-header">
        <div>
          <h1>Browser Gateway</h1>
          <p>Managed Chrome profiles, target selection, allowed-origin navigation, snapshots, and audit.</p>
        </div>
        <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">Refresh</button>
      </header>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <section class="status-strip">
        <div>
          <span class="metric">{{ profiles().length }}</span>
          <span class="label">Profiles</span>
        </div>
        <div>
          <span class="metric">{{ runningProfileCount() }}</span>
          <span class="label">Running</span>
        </div>
        <div>
          <span class="metric">{{ targets().length }}</span>
          <span class="label">Targets</span>
        </div>
        <div>
          <span class="metric">{{ auditEntries().length }}</span>
          <span class="label">Audit Events</span>
        </div>
      </section>

      <main class="browser-grid">
        <section class="profiles-panel">
          <div class="section-heading">
            <h2>Profiles</h2>
            <button class="btn small" type="button" [disabled]="loading()" (click)="refreshProfiles()">Reload</button>
          </div>

          <div class="create-form">
            <label>
              <span>Label</span>
              <input type="text" [value]="createLabel()" (input)="onCreateField('label', $event)" />
            </label>
            <label>
              <span>Default URL</span>
              <input type="url" [value]="createDefaultUrl()" (input)="onCreateField('defaultUrl', $event)" />
            </label>
            <label>
              <span>Allowed origins</span>
              <textarea [value]="createAllowedOrigins()" (input)="onCreateField('allowedOrigins', $event)"></textarea>
            </label>
            <button class="btn primary" type="button" [disabled]="working()" (click)="createProfile()">Create Profile</button>
          </div>

          <div class="profile-list">
            @for (profile of profiles(); track profile.id) {
              <article class="profile-row" [class.selected]="selectedProfileId() === profile.id">
                <button class="profile-main" type="button" (click)="selectProfile(profile.id)">
                  <span class="profile-label">{{ profile.label }}</span>
                  <span class="profile-meta">{{ profile.browser }} · {{ profile.mode }} · {{ profile.status }}</span>
                </button>
                <div class="row-actions">
                  <button class="btn small" type="button" [disabled]="working()" (click)="openProfile(profile.id)">Launch</button>
                  <button class="btn small" type="button" [disabled]="working()" (click)="closeProfile(profile.id)">Stop</button>
                </div>
              </article>
            } @empty {
              <div class="empty">No managed browser profiles.</div>
            }
          </div>
        </section>

        <section class="work-panel">
          <div class="section-heading">
            <h2>Target</h2>
            <button class="btn small" type="button" [disabled]="!selectedProfileId()" (click)="refreshTargets()">Refresh Targets</button>
          </div>

          <div class="target-list">
            @for (target of targets(); track target.id) {
              <button
                class="target-row"
                type="button"
                [class.selected]="selectedTargetId() === target.id"
                (click)="selectTarget(target)"
              >
                <span>{{ target.title || target.url || target.id }}</span>
                <small>{{ target.status }} · {{ target.url || 'about:blank' }}</small>
              </button>
            } @empty {
              <div class="empty">Launch a profile to load browser targets.</div>
            }
          </div>

          <div class="navigate-bar">
            <input type="url" [value]="navigateUrl()" (input)="onNavigateUrlInput($event)" />
            <button
              class="btn primary"
              data-testid="navigate-button"
              type="button"
              [disabled]="!canNavigate() || working()"
              (click)="navigate()"
            >
              Navigate
            </button>
          </div>

          <div class="toolbar">
            <button class="btn" type="button" [disabled]="!selectedTargetId() || working()" (click)="loadSnapshot()">Snapshot</button>
            <button class="btn" type="button" [disabled]="!selectedTargetId() || working()" (click)="captureScreenshot()">Screenshot</button>
          </div>

          <div class="preview-grid">
            <section class="preview-panel">
              <h3>Screenshot</h3>
              @if (screenshotDataUrl()) {
                <img data-testid="screenshot-preview" [src]="screenshotDataUrl()" alt="Browser screenshot preview" />
              } @else {
                <div class="empty">No screenshot captured.</div>
              }
            </section>
            <section class="preview-panel">
              <h3>Text Snapshot</h3>
              @if (snapshot(); as snap) {
                <div class="snapshot-title">{{ snap.title }}</div>
                <div class="snapshot-url">{{ snap.url }}</div>
                <pre>{{ snap.text }}</pre>
              } @else {
                <div class="empty">No snapshot loaded.</div>
              }
            </section>
          </div>
        </section>

        <aside class="side-panel">
          <section>
            <h2>Health</h2>
            <pre>{{ healthJson() }}</pre>
          </section>
          <section>
            <div class="section-heading">
              <h2>Pending Approvals</h2>
              <button class="btn small" type="button" [disabled]="working()" (click)="refreshApprovals()">Reload</button>
            </div>
            <div class="approval-list">
              @for (approval of approvalRequests(); track approval.requestId) {
                <article class="approval-row">
                  <div>
                    <span class="audit-action">{{ approval.requestId }}</span>
                    <span class="audit-tool">{{ approval.toolName }}</span>
                  </div>
                  <div class="audit-state">{{ approval.status }} · {{ approval.actionClass }}</div>
                  <p>{{ approval.origin || approval.url || approval.profileId }}</p>
                  <div class="row-actions wrap">
                    <button class="btn small" type="button" [disabled]="working()" (click)="approveApprovalRequest(approval, 'per_action')">Once</button>
                    <button class="btn small" type="button" [disabled]="working()" (click)="approveApprovalRequest(approval, 'session')">Session</button>
                    <button class="btn small" type="button" [disabled]="working()" (click)="approveApprovalRequest(approval, 'autonomous')">Autonomous</button>
                    <button class="btn small danger" type="button" [disabled]="working()" (click)="denyApprovalRequest(approval.requestId)">Deny</button>
                  </div>
                </article>
              } @empty {
                <div class="empty">No pending browser approvals.</div>
              }
            </div>
            <div class="autonomous-controls">
              <label class="inline-toggle">
                <input type="checkbox" [checked]="autonomousSubmitEnabled()" (change)="autonomousSubmitEnabled.set(!autonomousSubmitEnabled())" />
                <span>Submit/publish</span>
              </label>
              <label class="inline-toggle">
                <input type="checkbox" [checked]="autonomousDestructiveEnabled()" (change)="autonomousDestructiveEnabled.set(!autonomousDestructiveEnabled())" />
                <span>Delete/destructive</span>
              </label>
              <input
                type="text"
                placeholder="AUTONOMOUS"
                [value]="autonomousConfirmation()"
                (input)="onAutonomousConfirmationInput($event)"
              />
            </div>
          </section>
          <section>
            <div class="section-heading">
              <h2>Active Grants</h2>
              <button class="btn small" type="button" [disabled]="working()" (click)="refreshGrants()">Reload</button>
            </div>
            <div class="grant-list">
              @for (grant of activeGrants(); track grant.id) {
                <article class="grant-row">
                  <div>
                    <span class="audit-action">{{ grant.id }}</span>
                    <span class="audit-tool">{{ grant.mode }}</span>
                  </div>
                  <div class="audit-state">{{ grant.autonomous ? 'autonomous' : 'user approved' }}</div>
                  <p>{{ grant.allowedActionClasses.join(', ') }} · expires {{ formatGrantExpiry(grant.expiresAt) }}</p>
                  <button class="btn small danger" type="button" [disabled]="working()" (click)="revokeGrant(grant.id)">Revoke</button>
                </article>
              } @empty {
                <div class="empty">No active browser grants.</div>
              }
            </div>
          </section>
          <section>
            <h2>Audit</h2>
            <div class="audit-list">
              @for (entry of auditEntries(); track entry.id) {
                <article class="audit-row">
                  <div>
                    <span class="audit-action">{{ entry.action }}</span>
                    <span class="audit-tool">{{ entry.toolName }}</span>
                  </div>
                  <div class="audit-state">{{ entry.decision }} · {{ entry.outcome }}</div>
                  <p>{{ entry.summary }}</p>
                </article>
              } @empty {
                <div class="empty">No Browser Gateway audit entries.</div>
              }
            </div>
          </section>
        </aside>
      </main>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--text-primary);
      background: var(--bg-primary);
    }

    .browser-page {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      overflow: auto;
    }

    .page-header,
    .section-heading,
    .navigate-bar,
    .toolbar,
    .row-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .page-header {
      justify-content: space-between;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      font-size: 20px;
    }

    h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
    }

    h3 {
      font-size: 13px;
    }

    .page-header p,
    .label,
    .empty,
    .profile-meta,
    .audit-tool,
    .snapshot-url {
      font-size: 12px;
      color: var(--text-muted);
    }

    .status-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--spacing-sm);
    }

    .status-strip > div,
    .profiles-panel,
    .work-panel,
    .side-panel section,
    .preview-panel {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
    }

    .status-strip > div {
      padding: var(--spacing-sm) var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric {
      font-size: 22px;
      line-height: 1;
      font-weight: 700;
    }

    .browser-grid {
      min-height: 640px;
      display: grid;
      grid-template-columns: 320px minmax(420px, 1fr) 320px;
      gap: var(--spacing-md);
      align-items: stretch;
    }

    .profiles-panel,
    .work-panel,
    .side-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .profiles-panel,
    .work-panel,
    .side-panel section,
    .preview-panel {
      padding: var(--spacing-md);
    }

    .section-heading {
      justify-content: space-between;
    }

    .create-form,
    .profile-list,
    .target-list,
    .approval-list,
    .grant-list,
    .audit-list,
    .side-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted);
    }

    input,
    textarea {
      width: 100%;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 7px 9px;
      font-size: 12px;
    }

    textarea {
      min-height: 72px;
      resize: vertical;
      font-family: var(--font-family-mono);
    }

    .btn {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.small {
      padding: 4px 8px;
      font-size: 11px;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .profile-row,
    .approval-row,
    .grant-row,
    .audit-row {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      padding: var(--spacing-sm);
    }

    .profile-row.selected,
    .target-row.selected {
      border-color: var(--primary-color);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 28%, transparent);
    }

    .profile-main,
    .target-row {
      width: 100%;
      min-width: 0;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 0;
      cursor: pointer;
    }

    .profile-main,
    .target-row,
    .approval-row,
    .grant-row,
    .audit-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .profile-label,
    .target-row span,
    .audit-action {
      font-size: 13px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .target-row {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      padding: var(--spacing-sm);
    }

    .navigate-bar input {
      flex: 1;
      min-width: 0;
    }

    .preview-grid {
      min-height: 360px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-md);
    }

    .preview-panel {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      overflow: hidden;
    }

    img {
      width: 100%;
      max-height: 420px;
      object-fit: contain;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
    }

    pre {
      margin: 0;
      padding: var(--spacing-sm);
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 11px;
      font-family: var(--font-family-mono);
    }

    .audit-state {
      font-size: 11px;
      color: var(--success-color);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .row-actions.wrap {
      flex-wrap: wrap;
    }

    .btn.danger {
      color: var(--error-color);
      border-color: color-mix(in srgb, var(--error-color) 45%, var(--border-color));
    }

    .autonomous-controls {
      display: grid;
      gap: var(--spacing-xs);
    }

    .inline-toggle {
      flex-direction: row;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .inline-toggle input {
      width: auto;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    @media (max-width: 1180px) {
      .browser-grid {
        grid-template-columns: 1fr;
      }

      .preview-grid,
      .status-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `],
})
export class BrowserPageComponent implements OnInit {
  private readonly ipc = inject(BrowserGatewayIpcService);

  readonly profiles = signal<BrowserProfile[]>([]);
  readonly targets = signal<BrowserTarget[]>([]);
  readonly auditEntries = signal<BrowserAuditEntry[]>([]);
  readonly approvalRequests = signal<BrowserApprovalRequest[]>([]);
  readonly activeGrants = signal<BrowserPermissionGrant[]>([]);
  readonly health = signal<unknown>(null);
  readonly snapshot = signal<BrowserSnapshotView | null>(null);
  readonly screenshotDataUrl = signal<string | null>(null);
  readonly selectedProfileId = signal<string | null>(null);
  readonly selectedTargetId = signal<string | null>(null);
  readonly createLabel = signal('');
  readonly createDefaultUrl = signal('');
  readonly createAllowedOrigins = signal('');
  readonly navigateUrl = signal('');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly autonomousSubmitEnabled = signal(false);
  readonly autonomousDestructiveEnabled = signal(false);
  readonly autonomousConfirmation = signal('');

  readonly runningProfileCount = computed(
    () => this.profiles().filter((profile) => profile.status === 'running').length,
  );

  readonly selectedProfile = computed(
    () => this.profiles().find((profile) => profile.id === this.selectedProfileId()) ?? null,
  );

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

  async ngOnInit(): Promise<void> {
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
    if (!this.selectedProfileId() && this.profiles()[0]) {
      this.selectedProfileId.set(this.profiles()[0].id);
    }
  }

  async refreshTargets(): Promise<void> {
    const response = await this.ipc.listTargets({
      profileId: this.selectedProfileId() ?? undefined,
    });
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

  onNavigateUrlInput(event: Event): void {
    this.navigateUrl.set((event.target as HTMLInputElement).value);
  }

  onAutonomousConfirmationInput(event: Event): void {
    this.autonomousConfirmation.set((event.target as HTMLInputElement).value);
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
    this.selectedTargetId.set(null);
    this.snapshot.set(null);
    this.screenshotDataUrl.set(null);
    void this.refreshTargets();
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
    await this.refreshAudit();
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

  async approveApprovalRequest(
    approval: BrowserApprovalRequest,
    mode: BrowserGrantMode,
  ): Promise<void> {
    if (mode === 'autonomous' && this.autonomousConfirmation().trim() !== 'AUTONOMOUS') {
      this.errorMessage.set('Type AUTONOMOUS before approving autonomous browser control.');
      return;
    }
    const response = await this.runGatewayAction(() =>
      this.ipc.approveRequest({
        requestId: approval.requestId,
        grant: this.grantProposalForApproval(approval, mode),
        reason: 'Approved from Browser Gateway page',
      }),
    );
    if (response) {
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

  private selectedTargetRequest(): { profileId: string; targetId: string } | null {
    const profileId = this.selectedProfileId();
    const targetId = this.selectedTargetId();
    if (!profileId || !targetId) {
      return null;
    }
    return { profileId, targetId };
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

  private grantProposalForApproval(
    approval: BrowserApprovalRequest,
    mode: BrowserGrantMode,
  ): BrowserGrantProposal {
    const allowedActionClasses = new Set(approval.proposedGrant.allowedActionClasses);
    if (mode === 'autonomous') {
      if (this.autonomousSubmitEnabled()) {
        allowedActionClasses.add('submit');
      }
      if (this.autonomousDestructiveEnabled()) {
        allowedActionClasses.add('destructive');
      }
    }
    return {
      ...approval.proposedGrant,
      mode,
      allowedActionClasses: Array.from(allowedActionClasses),
      autonomous: mode === 'autonomous',
    };
  }
}
