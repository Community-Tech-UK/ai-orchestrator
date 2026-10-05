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

export function findCredentialAccessSession(taskScope: string): CredentialAccessSession | undefined {
  const matches = listSessions?.().filter((session) => session.taskScope === taskScope) ?? [];
  // A logical conversation running twice is ambiguous: never choose another task.
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveCredentialTaskScope(instanceId?: string): string | undefined {
  return resolveCredentialAccessSession(instanceId)?.taskScope;
}

export function resetCredentialAccessSessionResolverForTesting(): void {
  resolveSession = undefined;
  listSessions = undefined;
  decisionNotifier = undefined;
}
