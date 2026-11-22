import type { BrowserApprovalRequest } from '@contracts/types/browser';

/** Trusted Harness state only. An agent cannot supply or substitute its task identity. */
export interface CredentialAccessSession {
  instanceId: string;
  taskScope: string;
  sessionName: string;
}

let resolveSession: ((instanceId: string) => CredentialAccessSession | undefined) | undefined;
let listSessions: (() => CredentialAccessSession[]) | undefined;
let decisionNotifier: ((approval: BrowserApprovalRequest) => void | Promise<void>) | undefined;

export function setCredentialAccessDecisionNotifier(
  notify: (approval: BrowserApprovalRequest) => void | Promise<void>,
): void {
  decisionNotifier = notify;
}

export async function notifyCredentialAccessDecision(approval: BrowserApprovalRequest): Promise<void> {
  await decisionNotifier?.(approval);
}

export function setCredentialAccessSessionResolver(
  resolve: (instanceId: string) => CredentialAccessSession | undefined,
  list: () => CredentialAccessSession[],
): void {
  resolveSession = resolve;
  listSessions = list;
}

export function resolveCredentialAccessSession(instanceId?: string): CredentialAccessSession | undefined {
  return instanceId ? resolveSession?.(instanceId) : undefined;
}

/** The requesting instance owns its request while it still runs that conversation. */
export function findCredentialAccessSession(taskScope: string, requesterInstanceId: string): CredentialAccessSession | undefined {
  const requester = resolveCredentialAccessSession(requesterInstanceId);
  if (requester?.taskScope === taskScope) return requester;
  const matches = listSessions?.().filter((session) => session.taskScope === taskScope) ?? [];
  // Otherwise follow the conversation only to its sole open copy: never choose between two.
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Reasons on the grants BrowserCredentialAccessService mints. Each such grant
 * carries a credential authorization: revoking the grant must revoke it, and
 * the service, not the approve handler, wakes the requesting session.
 */
export type CredentialAccessGrantReason =
  | 'saved_login_access_approved'
  | 'saved_login_preapproved_by_setting'
  | 'agent_login_creation_approved';

const CREDENTIAL_ACCESS_GRANT_REASONS: ReadonlySet<string> = new Set<CredentialAccessGrantReason>([
  'saved_login_access_approved', 'saved_login_preapproved_by_setting', 'agent_login_creation_approved',
]);

export function isCredentialAccessGrantReason(reason: string | undefined): boolean {
  return reason !== undefined && CREDENTIAL_ACCESS_GRANT_REASONS.has(reason);
}

export function resolveCredentialTaskScope(instanceId?: string): string | undefined {
  return resolveCredentialAccessSession(instanceId)?.taskScope;
}

export function resetCredentialAccessSessionResolverForTesting(): void {
  resolveSession = undefined;
  listSessions = undefined;
  decisionNotifier = undefined;
}
