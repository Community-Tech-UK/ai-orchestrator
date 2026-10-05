import { isIP } from 'node:net';
import type {
  BrowserApprovalRequest,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';
import { actionClassNeverGrantable, requiresAutonomousGrant } from './browser-grant-policy';
import { grantScopeForApproval } from './browser-grant-scope';
import { isOriginAllowed, normalizeOrigin } from './browser-origin-policy';

export interface BrowserAutoApproveRequest {
  approval: BrowserApprovalRequest;
  instanceId: string;
  provider: BrowserApprovalRequest['provider'];
  toolName: string;
  action: string;
  actionClass: BrowserApprovalRequest['actionClass'];
}

export type BrowserAutoApprovePredicate = (request: BrowserAutoApproveRequest) => boolean;

/** Runtime policy: local development pages carry standing operator consent. */
export function withLocalBrowserAutoApproval(
  fallback?: BrowserAutoApprovePredicate,
): BrowserAutoApprovePredicate {
  return (request) => isLocalBrowserApproval(request.approval) || Boolean(fallback?.(request));
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

function isLocalBrowserApproval(approval: BrowserApprovalRequest): boolean {
  const proposal = approval.proposedGrant;
  const origin = approval.origin ? normalizeOrigin(approval.origin) : null;
  const page = approval.url ? normalizeOrigin(approval.url) : null;
  if (!origin || !page || origin.origin !== page.origin || !isLoopbackHost(page.host)) return false;
  if (approval.status !== 'pending' || approval.expiresAt <= Date.now() || proposal.mode === 'persistent' || proposal.allowExternalNavigation) return false;
  // Manual handoffs still represent an action the operator needs to perform.
  if (approval.toolName === 'browser.request_user_login' || approval.toolName === 'browser.pause_for_manual_step') return false;
  if (proposal.allowedActionClasses.length === 0 || proposal.allowedActionClasses.some(
    (actionClass) => actionClass === 'credential' || actionClassNeverGrantable(actionClass),
  )) return false;
  return proposal.allowedOrigins.length > 0 && proposal.allowedOrigins.every((allowed) =>
    !allowed.includeSubdomains && isLoopbackHost(allowed.hostPattern.toLowerCase()),
  ) && isOriginAllowed(page.origin, proposal.allowedOrigins).allowed;
}

/**
 * Action classes that a grant may NEVER receive via auto-approval,
 * regardless of the predicate (e.g. YOLO mode). The classifier's hardStop
 * path (passwords, 2FA/OTP, captcha, tokens) proposes a grant carrying the
 * `credential` class, and in the action guard an auto-approved grant
 * executes the pending mutation directly — so a predicate-based bypass
 * would let an autonomous agent type credentials with no human in the
 * loop.
 *
 * Manual handoffs and saved-login access remain explicit human decisions,
 * even when their proposal is read-only. Enforced here so every current and
 * future caller inherits it.
 */
const AUTO_APPROVE_UNGRANTABLE_CLASSES: readonly BrowserApprovalRequest['actionClass'][] = ['credential', 'payment'];

export interface BrowserAutoApproveDeps {
  approval: BrowserApprovalRequest;
  approvalStore: Pick<BrowserApprovalStore, 'resolveRequest'>;
  grantStore: Pick<BrowserGrantStore, 'createGrant'>;
  autoApproveRequests?: BrowserAutoApprovePredicate;
  reason?: string;
  now?: () => number;
}

export function autoApproveBrowserApproval(
  deps: BrowserAutoApproveDeps,
): BrowserPermissionGrant | null {
  if (deps.approval.credentialAccess || [
    'browser.request_credential_access',
    'browser.request_user_login',
    'browser.pause_for_manual_step',
  ].includes(deps.approval.toolName)) return null;
  // Forever is a durable operator decision, never a predicate/policy upgrade.
  if (deps.approval.proposedGrant.mode === 'persistent') return null;
  const proposedClasses = deps.approval.proposedGrant.allowedActionClasses;
  if (AUTO_APPROVE_UNGRANTABLE_CLASSES.some((cls) => proposedClasses.includes(cls))) {
    return null;
  }
  let shouldApprove = false;
  try {
    shouldApprove = Boolean(deps.autoApproveRequests?.({
      approval: deps.approval,
      instanceId: deps.approval.instanceId,
      provider: deps.approval.provider,
      toolName: deps.approval.toolName,
      action: deps.approval.action,
      actionClass: deps.approval.actionClass,
    }));
  } catch {
    shouldApprove = false;
  }

  if (!shouldApprove) {
    return null;
  }

  const now = deps.now?.() ?? Date.now();
  const proposedGrant = deps.approval.proposedGrant;
  const scope = grantScopeForApproval({
    profileId: deps.approval.profileId,
    targetId: deps.approval.targetId,
    proposedNodeId: proposedGrant.nodeId,
  });
  const grant = deps.grantStore.createGrant({
    ...proposedGrant,
    // Auto-approval is the user's standing consent to proceed without
    // per-action confirmation. Grants covering submit/destructive classes must
    // carry `autonomous: true` — grantMatches() rejects non-autonomous grants
    // for those classes, so without this the auto-approved grant is instantly
    // unusable and every submit/destructive action re-prompts the user even
    // though yolo is on.
    autonomous:
      (proposedGrant.mode === 'autonomous' && proposedGrant.autonomous) ||
      requiresAutonomousGrant(proposedGrant.allowedActionClasses),
    instanceId: deps.approval.instanceId,
    provider: deps.approval.provider,
    ...scope,
    requestedBy: deps.approval.instanceId,
    decidedBy: 'user',
    decision: 'allow',
    reason: deps.reason ?? (isLocalBrowserApproval(deps.approval)
      ? 'auto_approved_localhost' : 'auto_approved_by_yolo_mode'),
    expiresAt: defaultAutoApprovedGrantExpiresAt(
      deps.approval.proposedGrant.mode,
      now,
    ),
  });
  deps.approvalStore.resolveRequest(deps.approval.requestId, {
    status: 'approved',
    grantId: grant.id,
  });
  return grant;
}

function defaultAutoApprovedGrantExpiresAt(
  mode: BrowserApprovalRequest['proposedGrant']['mode'],
  now: number,
): number {
  return mode === 'per_action'
    ? now + 30 * 60 * 1000
    : now + 8 * 60 * 60 * 1000;
}
