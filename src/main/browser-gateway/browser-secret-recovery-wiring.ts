import type { BrowserApprovalRequest, BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import { supportsBrowserExtensionSecretRecovery } from './browser-extension-credential-compatibility';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { credentialScopeForProfile } from './browser-grant-scope';
import { BrowserSecretRecoveryOperations, type SecretRecoveryApprovalStore } from './browser-secret-recovery-operations';
import { checkSessionOperation, type CheckSessionDeps } from './browser-session-relogin';
import { withBrowserSessionOfInstance } from './browser-session-context';
import { getBrowserEscalationService, getBrowserLoginRecipeStore } from './browser-unattended-services';

type SessionService = Pick<CheckSessionDeps, 'snapshot' | 'queryElements' | 'navigate' | 'fillCredential' | 'click' | 'waitFor'>;

/** Builds the recovery operations from the gateway service's own parts. */
export function createBrowserSecretRecoveryOperations(parts: {
  approvalStore: SecretRecoveryApprovalStore;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  extensionContactState: BrowserExtensionContactStateReader;
  service: SessionService;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}): BrowserSecretRecoveryOperations {
  return new BrowserSecretRecoveryOperations({
    approvalStore: parts.approvalStore,
    getExistingTab: (profileId, targetId) => parts.extensionTabStore.getTab(profileId, targetId) ?? undefined,
    sendCommand: (attachment, command, payload, timeoutMs) =>
      parts.existingTabOperations.sendCommand(attachment, command, payload, timeoutMs),
    supportsRecovery: (attachment, profileId) => supportsBrowserExtensionSecretRecovery(
      parts.extensionContactState, credentialScopeForProfile(profileId), attachment.extensionInstanceId),
    checkLogin: (approval) => checkLoginForRecovery(parts.service, approval),
    inSession: (instanceId, work) => withBrowserSessionOfInstance(instanceId, work),
    result: parts.result,
  });
}

/**
 * The remembered sign-in fingerprint's verdict on the live page, with the
 * session's own grants. Never re-logs in: recovery only reports.
 */
async function checkLoginForRecovery(service: SessionService, approval: BrowserApprovalRequest): Promise<boolean | null> {
  if (!approval.targetId) return null;
  const outcome = await checkSessionOperation({
    fingerprints: getBrowserLoginRecipeStore(),
    escalations: getBrowserEscalationService(),
    // Bound calls: the service's methods live on its prototype, so a spread would drop them.
    snapshot: (req) => service.snapshot(req),
    queryElements: (req) => service.queryElements(req),
    navigate: (req) => service.navigate(req),
    fillCredential: (req) => service.fillCredential(req),
    click: (req) => service.click(req),
    waitFor: (req) => service.waitFor(req),
  }, {
    instanceId: approval.instanceId,
    provider: approval.provider,
    profileId: approval.profileId,
    targetId: approval.targetId,
    autoRelogin: false,
  });
  return outcome.state === 'logged_in' ? true : outcome.state === 'logged_out' ? false : null;
}

/**
 * Interrupts a person asked for: Stop in the window, phone, chat channel or thin
 * client, or Pause. A steering message typed in the window arrives as the same
 * 'renderer-ipc' interrupt as Stop, so it cancels too; that is safe (nothing is
 * released) and the agent asks again if it still needs access.
 */
const PERSON_STOP_ORIGINS = new Set(['renderer-ipc', 'mobile-gateway', 'channel-command', 'thin-client', 'pause']);

/**
 * A removed session's browser access recovery must never run afterwards, nor
 * one whose task a person stopped (Stop prevents dispatch and continuation).
 * Automatic interrupts (main-side steering, tool-loop or usage limits) do not count.
 */
export function cancelSecretRecoveriesWhenStopped(
  sources: {
    onSessionRemoved?: (listener: (instanceId: string) => void) => void;
    onSessionInterrupted?: (listener: (event: { instanceId: string; origin?: string }) => void) => void;
  },
  expire: (instanceId: string) => void,
): void {
  sources.onSessionRemoved?.((instanceId) => expire(instanceId));
  sources.onSessionInterrupted?.(({ instanceId, origin }) => {
    if (origin && PERSON_STOP_ORIGINS.has(origin)) expire(instanceId);
  });
}
