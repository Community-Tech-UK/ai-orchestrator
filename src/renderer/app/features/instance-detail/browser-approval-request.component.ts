import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type {
  BrowserApprovalRequest,
  BrowserElementContext,
  BrowserGrantMode,
  BrowserGrantProposal,
} from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import {
  CREDENTIAL_ACCESS_DURATIONS,
  type CredentialAccessDuration,
  credentialAccessChoice,
  credentialAccessMovement,
  credentialAccessPurpose,
} from '../../core/state/browser-approvals-banner.rules';

@Component({
  selector: 'app-browser-approval-request',
  standalone: true,
  imports: [],
  templateUrl: './browser-approval-request.component.html',
  styleUrl: './browser-approval-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserApprovalRequestComponent implements OnInit, OnDestroy {
  private readonly browserGateway = inject(BrowserGatewayIpcService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  instanceId = input<string | null>(null);

  readonly pendingRequests = signal<BrowserApprovalRequest[]>([]);
  readonly workingRequestId = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  private readonly grantModes = signal<Record<string, BrowserGrantMode>>({});
  private readonly autonomousConfirmations = signal<Record<string, string>>({});
  private readonly credentialChoices = signal<Record<string, CredentialAccessDuration>>({});
  readonly credentialDurations = CREDENTIAL_ACCESS_DURATIONS;
  credentialPurpose = credentialAccessPurpose;
  credentialMovement = credentialAccessMovement;

  constructor() {
    effect(() => {
      const instanceId = this.instanceId();
      this.errorMessage.set(null);
      this.grantModes.set({});
      this.autonomousConfirmations.set({});
      this.credentialChoices.set({});
      if (!instanceId) {
        this.pendingRequests.set([]);
        return;
      }
      void this.refreshPendingRequests();
    });
  }

  ngOnInit(): void {
    void this.refreshPendingRequests();
    this.refreshTimer = setInterval(() => {
      void this.refreshPendingRequests();
    }, 3000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refreshPendingRequests(): Promise<void> {
    const instanceId = this.instanceId();
    if (!instanceId || this.refreshInFlight) {
      if (!instanceId) {
        this.pendingRequests.set([]);
      }
      return;
    }

    this.refreshInFlight = true;
    try {
      const response = await this.browserGateway.listApprovalRequests({
        instanceId,
        status: 'pending',
        limit: 25,
      });
      if (this.instanceId() !== instanceId) {
        return;
      }
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load browser requests.');
        return;
      }
      this.pendingRequests.set(response.data?.data ?? []);
    } finally {
      this.refreshInFlight = false;
    }
  }

  selectedMode(approval: BrowserApprovalRequest): BrowserGrantMode {
    return this.grantModes()[approval.requestId] ?? approval.proposedGrant.mode;
  }

  onModeChange(approval: BrowserApprovalRequest, event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as BrowserGrantMode;
    this.grantModes.update((current) => ({
      ...current,
      [approval.requestId]: mode,
    }));
  }

  credentialDuration(approval: BrowserApprovalRequest): CredentialAccessDuration {
    return this.credentialChoices()[approval.requestId] ?? 'task';
  }

  onCredentialDurationChange(approval: BrowserApprovalRequest, event: Event): void {
    const value = (event.target as HTMLSelectElement).value as CredentialAccessDuration;
    this.credentialChoices.update((current) => ({ ...current, [approval.requestId]: value }));
  }

  onAutonomousConfirmationInput(approval: BrowserApprovalRequest, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.autonomousConfirmations.update((current) => ({
      ...current,
      [approval.requestId]: value,
    }));
  }

  async approveRequest(approval: BrowserApprovalRequest): Promise<void> {
    if (this.workingRequestId()) {
      return;
    }
    const confirmationPhrase = this.confirmationPhrase(approval);
    if (
      this.requiresAutonomousConfirmation(approval) &&
      this.autonomousConfirmation(approval).trim() !== confirmationPhrase
    ) {
      this.errorMessage.set(
        `Type ${confirmationPhrase} to allow publishing or deleting without another prompt.`,
      );
      return;
    }

    this.workingRequestId.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.approveRequest({
        requestId: approval.requestId,
        grant: approval.credentialAccess ? approval.proposedGrant : this.grantProposalForApproval(approval, this.selectedMode(approval)),
        ...(approval.credentialAccess ? {
          credentialAccess: credentialAccessChoice(this.credentialDuration(approval)),
        } : {}),
        reason: 'Approved from session page',
      });
      if (!response.success || response.data?.decision !== 'allowed' || response.data.outcome !== 'succeeded') {
        this.errorMessage.set(response.error?.message ?? response.data?.reason?.replaceAll('_', ' ') ?? 'Approval could not be completed. The request is still waiting.');
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refreshPendingRequests();
    } catch {
      this.errorMessage.set('Approval could not be completed. Try again after checking the connection.');
    } finally {
      this.workingRequestId.set(null);
    }
  }

  async denyRequest(approval: BrowserApprovalRequest): Promise<void> {
    if (this.workingRequestId()) {
      return;
    }

    this.workingRequestId.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.denyRequest({
        requestId: approval.requestId,
        reason: 'Denied from session page',
      });
      if (!response.success || response.data?.decision !== 'allowed' || response.data.outcome !== 'succeeded') {
        this.errorMessage.set(response.error?.message ?? response.data?.reason?.replaceAll('_', ' ') ?? 'The request could not be denied.');
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refreshPendingRequests();
    } catch {
      this.errorMessage.set('The request could not be denied. Try again after checking the connection.');
    } finally {
      this.workingRequestId.set(null);
    }
  }

  isWorking(approval: BrowserApprovalRequest): boolean {
    const workingId = this.workingRequestId();
    return Boolean(workingId && workingId === approval.requestId);
  }

  formatApprovalScope(approval: BrowserApprovalRequest): string {
    const mode = this.selectedMode(approval);
    const actions = approval.proposedGrant.allowedActionClasses.join(', ');
    const origins = approval.proposedGrant.allowedOrigins
      .map((origin) =>
        `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? `:${origin.port}` : ''}`,
      )
      .join(', ');
    return `${mode} - ${actions}${origins ? ` - ${origins}` : ''}`;
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
    ].filter(Boolean).join(' - ');
  }

  formatExpiry(expiresAt: number): string {
    return new Date(expiresAt).toLocaleString();
  }

  requiresAutonomousConfirmation(approval: BrowserApprovalRequest): boolean {
    if (approval.credentialAccess) return false;
    return approval.proposedGrant.allowedActionClasses.some(
      (actionClass) => actionClass === 'submit' || actionClass === 'destructive',
    );
  }

  confirmationPhrase(approval: BrowserApprovalRequest): string {
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

  autonomousConfirmation(approval: BrowserApprovalRequest): string {
    return this.autonomousConfirmations()[approval.requestId] ?? '';
  }

  private grantProposalForApproval(
    approval: BrowserApprovalRequest,
    mode: BrowserGrantMode,
  ): BrowserGrantProposal {
    return {
      ...approval.proposedGrant,
      mode,
      autonomous: mode === 'autonomous',
    };
  }

  private removeRequest(requestId: string): void {
    this.pendingRequests.update((requests) =>
      requests.filter((request) => request.requestId !== requestId),
    );
    this.autonomousConfirmations.update((current) => {
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }
}
