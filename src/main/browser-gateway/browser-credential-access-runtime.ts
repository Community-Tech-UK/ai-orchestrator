import type { BrowserCredentialAccessDependencies } from './browser-credential-access-service';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { getBrowserApprovalStore } from './browser-approval-store';
import { getBrowserGrantStore } from './browser-grant-store';
import { getBrowserAuditStore } from './browser-audit-store';
import { BrowserGatewayResultRecorder } from './browser-gateway-result';
import { getBrowserCredentialAuthorizationService, getBrowserCredentialVault } from './browser-unattended-services';
import { findCredentialAccessSession, notifyCredentialAccessDecision, resolveCredentialAccessSession } from './browser-credential-access-session';
import { getBrowserGatewayService } from './browser-gateway-service';
import { getBrowserExtensionTabStore } from './browser-extension-tab-store';
import { getBrowserTargetRegistry } from './browser-target-registry';
import { getBrowserProfileStore } from './browser-profile-store';
import { getBrowserExtensionContactState } from './browser-extension-contact-state';
import { supportsSecureBrowserExtensionCredentialFill } from './browser-extension-credential-compatibility';
import { credentialScopeForProfile } from './browser-grant-scope';
import { normaliseBindableOrigin } from './browser-credential-origin';
import { CredentialVaultError } from './browser-credential-vault';
import { getSettingsManager } from '../core/config/settings-manager';
import { getRemoteNodeRosterService } from '../remote-node/remote-node-roster-service';
import { isMissingExtensionTabError } from './browser-extension-command-failures';
import { withBrowserSessionOfInstance } from './browser-session-context';
import { getLogger } from '../logging/logger';

const logger = getLogger('BrowserCredentialAccess');

interface CredentialTarget {
  origin: string;
  scope: string;
  computerName: string;
  computerId: string;
}

/** Live main-process composition. Nothing returned here contains page text or a secret. */
export function createCredentialAccessDependencies(): BrowserCredentialAccessDependencies {
  const resultRecorder = new BrowserGatewayResultRecorder(getBrowserAuditStore());
  return {
    store: getBrowserApprovalStore(),
    authorizations: getBrowserCredentialAuthorizationService(),
    vault: getBrowserCredentialVault(),
    grants: getBrowserGrantStore(),
    resolveSession: resolveCredentialAccessSession,
    findSession: findCredentialAccessSession,
    readTarget: readCredentialTarget,
    now: Date.now,
    result: (input) => resultRecorder.record(input),
    notify: notifyCredentialAccessDecision,
    preApproveAgentFolderLogins: () => getSettingsManager().getAll().browserPreApproveAgentFolderLogins === true,
  };
}

async function readCredentialTarget(profileId: string, targetId: string, context: BrowserGatewayContext = {}): Promise<CredentialTarget> {
  const before = requireTarget(profileId, targetId);
  // The operator's approval reaches here from the window, outside any session.
  // Run the live check as the requesting session: the extension refuses an
  // owner-less command on a tab that session holds (17 Nov 2026, ct-test-mac).
  const read = () => getBrowserGatewayService().snapshot({ ...context, profileId, targetId, requireLive: true });
  const snapshot = await (context.instanceId ? withBrowserSessionOfInstance(context.instanceId, read) : read()).catch((error: unknown) => {
    unavailable('snapshot_threw', error instanceof Error ? error.message : 'unknown');
  });
  if (snapshot.decision !== 'allowed' || snapshot.outcome !== 'succeeded' || !snapshot.data) {
    const reason = snapshot.reason ?? '';
    if (profileId.startsWith('existing-tab:') && isMissingExtensionTabError(reason)) {
      throw new CredentialVaultError('The sign-in tab has closed', 'target_closed');
    }
    if (reason.includes('browser_secret_observation_blocked_for_tainted_origin')) {
      throw new CredentialVaultError('The tab is locked after a password was typed into it', 'target_secret_protected');
    }
    if (reason.includes('browser_tab_held_by_another_session')) {
      throw new CredentialVaultError('Another session is using this tab', 'target_held_by_another_session');
    }
    if (reason.includes('browser_extension_session_claims_unavailable') || reason.includes('shared_tab_secure_credential_fill_unavailable')) {
      throw new CredentialVaultError('A current secure browser extension is required', 'shared_tab_secure_credential_fill_unavailable');
    }
    unavailable(`snapshot_${snapshot.decision}_${snapshot.outcome}`, reason);
  }
  const after = requireTarget(profileId, targetId);
  if (before.scope !== after.scope || before.computerId !== after.computerId) {
    unavailable('computer_changed_during_check');
  }
  let origin: string;
  try {
    origin = normaliseBindableOrigin(snapshot.data.url);
  } catch {
    throw new CredentialVaultError('The browser website could not be confirmed', 'origin_mismatch');
  }
  if (profileId.startsWith('existing-tab:') && getBrowserExtensionTabStore().getTab(profileId, targetId)?.origin !== origin) {
    throw new CredentialVaultError('The browser website changed during validation', 'origin_mismatch');
  }
  return { ...after, origin };
}

/** Exact trusted target identity for secure fill; unavailable targets fail scope matching. */
export function resolveCredentialComputerId(profileId: string, targetId: string): string | undefined {
  const target = getBrowserTargetRegistry().listTargets(profileId).find((candidate) => candidate.id === targetId);
  if (!target || target.profileId !== profileId || target.status === 'closed' || target.stale) return undefined;
  let computerId: string;
  if (profileId.startsWith('existing-tab:')) {
    const attachment = getBrowserExtensionTabStore().getTab(profileId, targetId);
    if (!attachment || attachment.suspendedAt !== undefined) return undefined;
    computerId = attachment.nodeId ?? 'local';
    if (computerId !== credentialScopeForProfile(profileId) || (target.nodeId ?? 'local') !== computerId) return undefined;
  } else {
    const profile = getBrowserProfileStore().getProfile(profileId);
    if (profile?.status !== 'running') return undefined;
    computerId = profile.executionNodeId ?? 'local';
  }
  if (computerId !== 'local') {
    const node = getRemoteNodeRosterService().get(computerId);
    if (!node?.connected || node.status === 'disconnected' || node.status === 'connecting') return undefined;
  }
  return computerId;
}

function requireTarget(profileId: string, targetId: string): Omit<CredentialTarget, 'origin'> {
  const target = getBrowserTargetRegistry().listTargets(profileId).find((candidate) => candidate.id === targetId);
  if (target?.profileId === profileId && target.status === 'closed' && !target.stale) {
    throw new CredentialVaultError('The sign-in tab has closed', 'target_closed');
  }
  if (!target || target.profileId !== profileId || target.stale) {
    unavailable(!target ? 'target_not_registered' : 'target_stale');
  }
  const shared = profileId.startsWith('existing-tab:');
  const attachment = shared ? getBrowserExtensionTabStore().getTab(profileId, targetId) : null;
  const profile = shared ? null : getBrowserProfileStore().getProfile(profileId);
  if (shared && (!attachment || attachment.suspendedAt !== undefined)) {
    unavailable(!attachment ? 'tab_not_attached' : 'tab_suspended');
  }
  if (!shared && (!profile || profile.status !== 'running')) unavailable('profile_not_running');
  const scope = credentialScopeForProfile(profileId);
  const computerId = shared ? attachment!.nodeId ?? 'local' : profile!.executionNodeId ?? 'local';
  if (shared && (computerId !== scope || (target!.nodeId ?? 'local') !== computerId)) {
    unavailable('attachment_computer_mismatch');
  }
  let computerName = 'This computer';
  if (computerId !== 'local') {
    const node = getRemoteNodeRosterService().get(computerId);
    if (!node?.connected || node.status === 'disconnected' || node.status === 'connecting') {
      throw new CredentialVaultError('The browser computer is disconnected', 'computer_offline');
    }
    computerName = node.name;
  }
  if (shared) {
    if (getSettingsManager().getAll().browserAllowSharedTabCredentialFill !== true) {
      throw new CredentialVaultError('Saved login access on shared tabs is disabled', 'shared_tab_credential_fill_not_allowed');
    }
    if (!supportsSecureBrowserExtensionCredentialFill(getBrowserExtensionContactState(), computerId, attachment!.extensionInstanceId)) {
      throw new CredentialVaultError('A current secure browser extension is required', 'shared_tab_secure_credential_fill_unavailable');
    }
  }
  return { scope, computerName, computerId };
}

/**
 * Log the real reason and refuse. Only a leading snake_case error code of a
 * failure message is kept, so page text that reached an error cannot reach the log.
 */
function unavailable(cause: string, detail?: string): never {
  const code = /^[a-z][a-z0-9_]{2,80}$/.exec((detail ?? '').split(':')[0] ?? '')?.[0];
  logger.warn('Saved-login tab check failed', { cause, ...(code ? { detail: code } : {}) });
  throw new CredentialVaultError('The browser target is unavailable', 'target_unavailable');
}
