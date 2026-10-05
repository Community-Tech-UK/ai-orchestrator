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
  };
}

async function readCredentialTarget(profileId: string, targetId: string, context: BrowserGatewayContext = {}): Promise<CredentialTarget> {
  const before = requireTarget(profileId, targetId);
  const snapshot = await getBrowserGatewayService().snapshot({ ...context, profileId, targetId, requireLive: true }).catch(() => {
    throw new CredentialVaultError('The browser target could not be confirmed live', 'target_unavailable');
  });
  if (snapshot.decision !== 'allowed' || snapshot.outcome !== 'succeeded' || !snapshot.data) {
    throw new CredentialVaultError('The browser target could not be confirmed live', 'target_unavailable');
  }
  const after = requireTarget(profileId, targetId);
  if (before.scope !== after.scope || before.computerId !== after.computerId) {
    throw new CredentialVaultError('The browser computer changed during validation', 'target_unavailable');
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
  if (!target || target.profileId !== profileId || target.status === 'closed' || target.stale) {
    throw new CredentialVaultError('The browser target is unavailable', 'target_unavailable');
  }
  const shared = profileId.startsWith('existing-tab:');
  const attachment = shared ? getBrowserExtensionTabStore().getTab(profileId, targetId) : null;
  const profile = shared ? null : getBrowserProfileStore().getProfile(profileId);
  if ((shared && (!attachment || attachment.suspendedAt !== undefined)) || (!shared && (!profile || profile.status !== 'running'))) {
    throw new CredentialVaultError('The browser target is unavailable', 'target_unavailable');
  }
  const scope = credentialScopeForProfile(profileId);
  const computerId = shared ? attachment!.nodeId ?? 'local' : profile!.executionNodeId ?? 'local';
  if (shared && (computerId !== scope || (target.nodeId ?? 'local') !== computerId)) {
    throw new CredentialVaultError('The browser attachment does not match this computer', 'target_unavailable');
  }
  let computerName = 'This computer';
  if (computerId !== 'local') {
    const node = getRemoteNodeRosterService().get(computerId);
    if (!node?.connected || node.status === 'disconnected' || node.status === 'connecting') {
      throw new CredentialVaultError('The browser computer is disconnected', 'target_unavailable');
    }
    computerName = node.name;
  }
  if (shared) {
    if (getSettingsManager().getAll().browserAllowSharedTabCredentialFill !== true) {
      throw new CredentialVaultError('Saved login access on shared tabs is disabled', 'shared_tab_credential_fill_not_allowed');
    }
    if (!supportsSecureBrowserExtensionCredentialFill(getBrowserExtensionContactState(), computerId)) {
      throw new CredentialVaultError('A current secure browser extension is required', 'shared_tab_secure_credential_fill_unavailable');
    }
  }
  return { scope, computerName, computerId };
}
