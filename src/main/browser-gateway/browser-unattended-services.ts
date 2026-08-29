import { promises as fs } from 'node:fs';
import { CredentialAuthorizationService } from './browser-credential-authorization-store';
import { BrowserCampaignService } from './browser-campaign-store';
import { BrowserEscalationService, type BrowserEscalation } from './browser-escalation-store';
import {
  SqliteCredentialAuthorizationStore,
  SqliteEscalationRecordStore,
  SqliteBrowserCampaignStore,
  SqliteVaultOriginBindingStore,
} from './browser-unattended-sqlite-stores';
import { CredentialVault } from './browser-credential-vault';
import { createBwRunner } from './browser-bw-runner';
import { getBrowserCampaignRuntime } from './browser-campaign-runtime';
import { getBrowserCredentialSession } from './browser-credential-session';
import { unlockCredentialVault, type UnlockResult } from './browser-credential-unlock';
import { getSettingsManager } from '../core/config/settings-manager';
import { generateId } from '../../shared/utils/id-generator';
import { getLogger } from '../logging/logger';

/**
 * App-root singletons for the unattended browser-automation layer, backed by
 * the SQLite stores (migration 040). These are the ONLY construction points —
 * the IPC handlers (approval dialogs), the privileged `aio-mcp
 * browser-credentials` CLI and the gateway service share the same instances, so
 * a newly granted authorization is immediately visible to
 * browser.fill_credential and a paused campaign immediately stops grants.
 *
 * Campaigns are user-approved only: created via renderer IPC, never via an MCP
 * tool. Authorizations were too until 2026-08-29, when the operator authorised
 * a privileged CLI door (`aio-mcp browser-credentials`) so unattended portal
 * logins need no GUI step; it shares these same instances.
 */

const logger = getLogger('BrowserUnattendedServices');

let credentialAuthorizationService: CredentialAuthorizationService | null = null;
let campaignService: BrowserCampaignService | null = null;
let escalationService: BrowserEscalationService | null = null;
let escalationNotify: ((escalation: BrowserEscalation) => void) | null = null;

let credentialVault: CredentialVault | null = null;

/**
 * Shared credential vault. The renderer enrolment dialog and the gateway's
 * fill path must be the same instance, so an item James enrols is immediately
 * bound for browser.fill_credential without a restart.
 */
export function getBrowserCredentialVault(): CredentialVault {
  if (!credentialVault) {
    credentialVault = new CredentialVault({
      runner: createBwRunner(),
      bindings: new SqliteVaultOriginBindingStore(),
      getSession: () => getBrowserCredentialSession().getToken(),
    });
  }
  return credentialVault;
}

export function getBrowserCredentialAuthorizationService(): CredentialAuthorizationService {
  if (!credentialAuthorizationService) {
    credentialAuthorizationService = new CredentialAuthorizationService(
      new SqliteCredentialAuthorizationStore(),
    );
  }
  return credentialAuthorizationService;
}

export function getBrowserCampaignService(): BrowserCampaignService {
  if (!campaignService) {
    campaignService = new BrowserCampaignService({
      store: new SqliteBrowserCampaignStore(),
      // Any transition away from 'active' (pause/kill/expire/complete/budget
      // trip) immediately revokes the campaign's live child grants, so the
      // standing authority and its leases can never disagree.
      onStateChange: (campaign) => {
        try {
          getBrowserCampaignRuntime()?.handleCampaignStateChange(campaign);
        } catch (error) {
          logger.warn('Campaign state-change hook failed', {
            campaignId: campaign.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  }
  return campaignService;
}

export function getBrowserEscalationService(): BrowserEscalationService {
  if (!escalationService) {
    escalationService = new BrowserEscalationService({
      store: new SqliteEscalationRecordStore(),
      // Persistent store — the default in-process counter ids would collide
      // across restarts, so use globally unique ids.
      idFactory: () => generateId(),
      notify: (escalation) => {
        try {
          escalationNotify?.(escalation);
        } catch (error) {
          // Escalations must always be recordable; a failing pager is logged only.
          logger.warn('Browser escalation notify hook failed', {
            escalationId: escalation.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  }
  return escalationService;
}

/** Wire the push-notification hook (e.g. mobile-gateway push). Late-bound so
 * the escalation service does not depend on the mobile gateway at import time. */
export function setBrowserEscalationNotifyHook(
  hook: (escalation: BrowserEscalation) => void,
): void {
  escalationNotify = hook;
}

/**
 * Resolve the vault master password from a secure local source: the
 * AIO_BW_MASTER_PASSWORD_FILE env var, falling back to the
 * browserVaultMasterPasswordFile setting. Returns '' when unconfigured or
 * unreadable — the unlock then fails with `empty_password`. The password is
 * returned to the caller (main-process memory) only; never logged.
 */
async function readMasterPassword(): Promise<string> {
  const envPath = process.env['AIO_BW_MASTER_PASSWORD_FILE']?.trim();
  let filePath = envPath;
  if (!filePath) {
    try {
      filePath = getSettingsManager().getAll().browserVaultMasterPasswordFile?.trim();
    } catch {
      filePath = '';
    }
  }
  if (!filePath) {
    return '';
  }
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim();
  } catch (error) {
    logger.warn('Vault master-password file is not readable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * Unlock the browser credential vault from the UI. Returns only
 * `{unlocked, reason?}` — the BW_SESSION token stays inside
 * getBrowserCredentialSession() in main-process memory.
 */
export async function unlockBrowserCredentialVault(): Promise<UnlockResult> {
  return unlockCredentialVault({
    runner: createBwRunner(),
    session: getBrowserCredentialSession(),
    getMasterPassword: readMasterPassword,
  });
}

/** Re-lock the vault (drop the in-memory session token). */
export function lockBrowserCredentialVault(): void {
  getBrowserCredentialSession().lock();
}

/**
 * Auto-unlock the vault at gateway startup when the operator has opted into
 * hands-free unlocking (`browserVaultAutoUnlock`) and a master-password source
 * is configured. Best-effort and non-blocking: startup never waits on
 * `bw unlock`, and a failure just leaves the vault locked (browser.fill_credential
 * reports itself unavailable until an unlock succeeds). Never logs the password
 * or the session token.
 */
export async function maybeAutoUnlockBrowserCredentialVault(): Promise<void> {
  // Two operator-owned opt-ins, neither agent-writable: the UI-set
  // `browserVaultAutoUnlock` flag, or the launch env var (which, when set, is
  // itself the intent to auto-unlock). A tool-call can set neither.
  const envConfigured = Boolean(process.env['AIO_BW_MASTER_PASSWORD_FILE']?.trim());
  let flagEnabled = false;
  try {
    flagEnabled = getSettingsManager().getAll().browserVaultAutoUnlock === true;
  } catch {
    flagEnabled = false;
  }
  if (!flagEnabled && !envConfigured) {
    return;
  }
  const status = getBrowserVaultStatus();
  if (!status.locked) {
    return;
  }
  if (!status.passwordSourceConfigured) {
    logger.warn('Vault auto-unlock enabled but no master-password source is configured');
    return;
  }
  try {
    const result = await unlockBrowserCredentialVault();
    if (result.unlocked) {
      logger.info('Browser credential vault auto-unlocked');
    } else {
      logger.warn('Browser credential vault auto-unlock failed', { reason: result.reason });
    }
  } catch (error) {
    logger.warn('Browser credential vault auto-unlock threw', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Subscribe to settings changes so flipping `browserVaultAutoUnlock` on (or
 * pointing `browserVaultMasterPasswordFile` at a file while auto-unlock is on)
 * unlocks the vault immediately — no restart needed. Idempotent: a second call
 * replaces the prior listener.
 */
let autoUnlockUnsubscribe: (() => void) | null = null;

export function watchVaultAutoUnlockSetting(): void {
  autoUnlockUnsubscribe?.();
  let manager: ReturnType<typeof getSettingsManager>;
  try {
    manager = getSettingsManager();
  } catch {
    return;
  }
  const listener = (key: string): void => {
    if (key === 'browserVaultAutoUnlock' || key === 'browserVaultMasterPasswordFile') {
      void maybeAutoUnlockBrowserCredentialVault();
    }
  };
  manager.on('setting-changed', listener);
  autoUnlockUnsubscribe = () => manager.off('setting-changed', listener);
}

export interface BrowserVaultStatus {
  locked: boolean;
  /** Whether a master-password source is configured (env var or setting). */
  passwordSourceConfigured: boolean;
  /**
   * Whether autonomous sign-in on the operator's OWN shared Chrome tabs is on.
   *
   * Surfaced here so the Browser screen can say so out loud. Since 2026-08-29
   * an agent can turn this on itself and can grant itself the matching standing
   * authorization, so the setting row is no longer a reliable place to notice
   * it: this is the state most worth seeing at a glance.
   */
  sharedTabCredentialFillEnabled: boolean;
}

export function getBrowserVaultStatus(): BrowserVaultStatus {
  let configured = Boolean(process.env['AIO_BW_MASTER_PASSWORD_FILE']?.trim());
  if (!configured) {
    try {
      configured = Boolean(
        getSettingsManager().getAll().browserVaultMasterPasswordFile?.trim(),
      );
    } catch {
      configured = false;
    }
  }
  let sharedTabCredentialFillEnabled = false;
  try {
    sharedTabCredentialFillEnabled = Boolean(
      getSettingsManager().getAll().browserAllowSharedTabCredentialFill,
    );
  } catch (error) {
    // Defaulting to false hides the banner, and this is the control the whole
    // 2026-08-29 widening was justified by, so the failure must not be silent.
    sharedTabCredentialFillEnabled = false;
    logger.warn('Could not read browserAllowSharedTabCredentialFill for vault status', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    locked: getBrowserCredentialSession().locked,
    passwordSourceConfigured: configured,
    sharedTabCredentialFillEnabled,
  };
}
