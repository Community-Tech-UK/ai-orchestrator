import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type {
  BrowserApprovalRequest,
  BrowserApproveRequestPayload,
} from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import {
  CREDENTIAL_ACCESS_DURATIONS,
  type CredentialAccessDuration,
  credentialAccessChoice,
  credentialAccessErrorText,
  credentialAccessWords,
} from '../../core/state/browser-approvals-banner.rules';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { presentError } from '../../../../shared/present-error';
import {
  type BrowserAllowChoiceId,
  browserApprovalFailureText,
  presentBrowserApproval,
} from './browser-approval-request.rules';

type ApprovalPayload = Pick<BrowserApproveRequestPayload, 'grant' | 'reason' | 'credentialAccess'>;

@Component({
  selector: 'app-browser-approval-request',
  standalone: true,
  imports: [AioTooltipDirective],
  templateUrl: './browser-approval-request.component.html',
  styleUrl: './browser-approval-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserApprovalRequestComponent implements OnInit, OnDestroy {
  private readonly browserGateway = inject(BrowserGatewayIpcService);
  private readonly remoteNodes = inject(RemoteNodeStore);
  /** `process.platform` of the computer Harness runs on, so "this Mac" and "this PC" read right. */
  private readonly localPlatform = inject(ElectronIpcService).platform;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  private destroyed = false;

  instanceId = input<string | null>(null);

  readonly pendingRequests = signal<BrowserApprovalRequest[]>([]);
  readonly workingRequestId = signal<string | null>(null);
  /** Which button was pressed, so only that one reads "Allowing…". */
  private readonly workingChoice = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetail = signal<string | null>(null);
  private readonly typedPhrases = signal<Record<string, string>>({});
  private readonly credentialChoices = signal<Record<string, CredentialAccessDuration>>({});
  readonly credentialDurations = CREDENTIAL_ACCESS_DURATIONS;
  credentialError = credentialAccessErrorText;

  /** What each pending request says, in plain words, and which buttons it can take. */
  readonly views = computed(() => {
    const nodes = new Map(this.remoteNodes.nodes().map((node) => [node.id, node] as const));
    return this.pendingRequests().map((approval) => presentBrowserApproval(approval, {
      node: (nodeId) => nodes.get(nodeId),
      localPlatform: this.localPlatform,
      credentialDuration: this.credentialDuration(approval),
    }));
  });

  constructor() {
    effect(() => {
      const instanceId = this.instanceId();
      this.clearError();
      this.pendingRequests.set([]);
      this.typedPhrases.set({});
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
    this.destroyed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refreshPendingRequests(): Promise<void> {
    const instanceId = this.instanceId();
    if (this.destroyed || !instanceId || this.refreshInFlight) {
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
      if (this.destroyed || this.instanceId() !== instanceId) {
        return;
      }
      if (!response.success) {
        this.setFailure("Harness couldn't load the browser requests. Check Details, then try again.", response.error);
        return;
      }
      this.pendingRequests.set(response.data?.data ?? []);
    } catch (error) {
      if (!this.destroyed && this.instanceId() === instanceId) {
        this.setFailure("Harness couldn't load the browser requests. Check Details, then try again.", error);
      }
    } finally {
      this.refreshInFlight = false;
      if (!this.destroyed && this.instanceId() && this.instanceId() !== instanceId) void this.refreshPendingRequests();
    }
  }

  credentialDuration(approval: BrowserApprovalRequest): CredentialAccessDuration {
    return this.credentialChoices()[approval.requestId] ?? 'task';
  }

  savedLoginLabel(approval: BrowserApprovalRequest): string {
    return credentialAccessWords(this.credentialDuration(approval)).allow;
  }

  onCredentialDurationChange(approval: BrowserApprovalRequest, event: Event): void {
    const value = (event.target as HTMLSelectElement).value as CredentialAccessDuration;
    this.credentialChoices.update((current) => ({ ...current, [approval.requestId]: value }));
  }

  onPhraseInput(approval: BrowserApprovalRequest, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.typedPhrases.update((current) => ({ ...current, [approval.requestId]: value }));
  }

  typedPhrase(approval: BrowserApprovalRequest): string {
    return this.typedPhrases()[approval.requestId] ?? '';
  }

  /** One of the three scope buttons. The grant it sends is the one the card showed for that button. */
  async approveRequest(approval: BrowserApprovalRequest, choiceId: BrowserAllowChoiceId): Promise<void> {
    if (this.workingRequestId()) {
      return;
    }
    const view = this.views().find((candidate) => candidate.approval.requestId === approval.requestId);
    const choice = view?.choices.find((candidate) => candidate.id === choiceId);
    if (!view || !choice) {
      return;
    }
    if (choice.needsPhrase && this.typedPhrase(approval).trim() !== view.phrase) {
      this.errorMessage.set(`Type ${view.phrase} to allow publishing or deleting without another prompt.`);
      return;
    }
    await this.submitApproval(approval, { grant: choice.grant, reason: choice.auditReason }, choiceId);
  }

  /** A saved login has no "once": the length picked in the card is the permission. */
  async approveSavedLogin(approval: BrowserApprovalRequest): Promise<void> {
    if (this.workingRequestId()) {
      return;
    }
    await this.submitApproval(approval, {
      grant: approval.proposedGrant,
      credentialAccess: credentialAccessChoice(this.credentialDuration(approval)),
      reason: 'Approved from session page',
    }, 'saved-login');
  }

  private async submitApproval(
    approval: BrowserApprovalRequest,
    payload: ApprovalPayload,
    pressed: string,
  ): Promise<void> {
    this.workingRequestId.set(approval.requestId);
    this.workingChoice.set(pressed);
    this.clearError();
    try {
      const response = await this.browserGateway.approveRequest({
        requestId: approval.requestId,
        ...payload,
      });
      if (!response.success || response.data?.decision !== 'allowed' || response.data.outcome !== 'succeeded') {
        const reason = response.data?.reason;
        this.setFailure(
          reason
            ? (approval.credentialAccess ? credentialAccessErrorText(reason) : browserApprovalFailureText(reason))
            : "Approval couldn't be completed. Check Details, then try again. The request is still waiting.",
          response.error ?? reason,
        );
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refreshPendingRequests();
    } catch (error) {
      this.setFailure("Approval couldn't be completed. Check the connection, then try again.", error);
    } finally {
      this.workingRequestId.set(null);
      this.workingChoice.set(null);
    }
  }

  async denyRequest(approval: BrowserApprovalRequest): Promise<void> {
    if (this.workingRequestId()) {
      return;
    }

    this.workingRequestId.set(approval.requestId);
    this.clearError();
    try {
      const response = await this.browserGateway.denyRequest({
        requestId: approval.requestId,
        reason: 'Denied from session page',
      });
      if (!response.success || response.data?.decision !== 'allowed' || response.data.outcome !== 'succeeded') {
        const reason = response.data?.reason;
        this.setFailure(reason ? browserApprovalFailureText(reason) : "The request couldn't be denied. Check Details, then try again.", response.error ?? reason);
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refreshPendingRequests();
    } catch (error) {
      this.setFailure("The request couldn't be denied. Check the connection, then try again.", error);
    } finally {
      this.workingRequestId.set(null);
    }
  }

  isWorking(approval: BrowserApprovalRequest, pressed?: string): boolean {
    const workingId = this.workingRequestId();
    if (!workingId || workingId !== approval.requestId) {
      return false;
    }
    return pressed === undefined || this.workingChoice() === pressed;
  }

  private clearError(): void {
    this.errorMessage.set(null);
    this.errorDetail.set(null);
  }

  private setFailure(sentence: string, diagnostic: unknown): void {
    this.errorMessage.set(sentence);
    this.errorDetail.set(presentError(diagnostic).rawDetail || null);
  }

  private removeRequest(requestId: string): void {
    this.pendingRequests.update((requests) =>
      requests.filter((request) => request.requestId !== requestId),
    );
    this.typedPhrases.update((current) => {
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }
}
