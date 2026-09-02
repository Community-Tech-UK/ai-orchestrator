import type {
  BrowserActionClass,
  BrowserPermissionGrant,
  BrowserProvider,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import { CREDENTIAL_CHALLENGE_REASON } from './browser-action-classifier';
import type {
  BrowserGatewayActionGuardOptions,
  BrowserGatewayMutationPreparation,
} from './browser-gateway-action-guard.types';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserGrantStore } from './browser-grant-store';
import {
  actionClassRequiresAutonomy,
  findMatchingBrowserGrant,
} from './browser-grant-policy';

type ExactApprovalStore = Pick<BrowserApprovalStore, 'getRequest'>;
type ExactGrantStore = Pick<BrowserGrantStore, 'listGrants'>;

export interface BrowserExactApprovalInput {
  context: BrowserGatewayContext & { profileId: string; targetId: string; requestId?: string };
  requestId?: string;
  instanceId: string;
  provider: BrowserProvider;
  profileId: string;
  targetId: string;
  nodeId?: string;
  toolName: string;
  action: string;
  actionClass: BrowserActionClass;
  origin: string;
  liveOrigin: string;
  url: string;
  selector: string;
  hardStop: boolean;
  reason?: string;
  grant?: BrowserPermissionGrant;
}

type BrowserExactApprovalRedemption =
  | { status: 'reserved'; grant: BrowserPermissionGrant; requestId: string }
  | { status: 'in_progress'; requestId: string };

/** Validates and synchronously reserves an exact approved hard-stop retry. */
export class BrowserExactApprovalRedeemer {
  private readonly reservations = new Set<string>();

  constructor(
    private readonly approvals: ExactApprovalStore,
    private readonly grants: ExactGrantStore,
    private readonly result: BrowserGatewayActionGuardOptions['result'],
  ) {}

  prepare(input: BrowserExactApprovalInput): BrowserGatewayMutationPreparation | null {
    const redemption = this.redeem(input);
    if (!redemption) return null;
    if (redemption.status === 'reserved') {
      return {
        grant: redemption.grant,
        actionClass: input.actionClass,
        origin: input.origin,
        url: input.url,
        exactApprovalRequestId: redemption.requestId,
      };
    }
    return {
      result: this.result({
        context: input.context,
        profileId: input.profileId,
        targetId: input.targetId,
        action: input.action,
        toolName: input.toolName,
        actionClass: input.actionClass,
        decision: 'requires_user',
        outcome: 'not_run',
        requestId: redemption.requestId,
        reason: 'approval_redemption_in_progress',
        summary: `${input.toolName} is already executing this one-use approval`,
        origin: input.origin,
        url: input.url,
        data: null,
      }),
    };
  }

  private redeem(input: BrowserExactApprovalInput): BrowserExactApprovalRedemption | null {
    if (!input.requestId || !isRedeemableHardStop(input)) return null;
    const grant = input.grant ?? this.findGrant(input);
    if (!grant || !approvalMatches(this.approvals, input, grant)) return null;
    if (this.reservations.has(input.requestId)) {
      return { status: 'in_progress', requestId: input.requestId };
    }
    this.reservations.add(input.requestId);
    return { status: 'reserved', grant, requestId: input.requestId };
  }

  release(requestId: string | undefined): void {
    if (requestId) this.reservations.delete(requestId);
  }

  private findGrant(input: BrowserExactApprovalInput): BrowserPermissionGrant | undefined {
    return findMatchingBrowserGrant({
      grants: this.grants.listGrants({
        instanceId: input.instanceId,
        profileId: input.profileId,
        nodeId: input.nodeId,
      }),
      instanceId: input.instanceId,
      provider: input.provider,
      nodeId: input.nodeId,
      profileId: input.profileId,
      targetId: input.targetId,
      origin: input.origin,
      liveOrigin: input.liveOrigin,
      actionClass: input.actionClass,
      autonomousRequired: actionClassRequiresAutonomy(input.actionClass),
    }).grant;
  }
}

function approvalMatches(
  store: ExactApprovalStore,
  input: BrowserExactApprovalInput,
  grant: BrowserPermissionGrant,
): boolean {
  const approval = store.getRequest(input.requestId!, input.instanceId);
  return Boolean(
    approval && approval.status === 'approved' && approval.grantId === grant.id &&
    approval.instanceId === input.instanceId && approval.provider === input.provider &&
    approval.profileId === input.profileId && approval.targetId === input.targetId &&
    approval.toolName === input.toolName && approval.action === input.action &&
    approval.actionClass === input.actionClass && approval.origin === input.origin &&
    approval.url === input.url && approval.selector === input.selector
  );
}

function isRedeemableHardStop(input: BrowserExactApprovalInput): boolean {
  return input.hardStop && (
    input.actionClass === 'unknown' ||
    (input.actionClass === 'credential' && input.reason === CREDENTIAL_CHALLENGE_REASON)
  );
}
