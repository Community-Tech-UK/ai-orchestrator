import { promises as fs } from 'node:fs';
import { CredentialAuthorizationService } from './browser-credential-authorization-store';
import { BrowserCampaignService } from './browser-campaign-store';
import { BrowserEscalationService, type BrowserEscalation } from './browser-escalation-store';
import {
  SqliteCredentialAuthorizationStore,
  SqliteEscalationRecordStore,
  SqliteBrowserCampaignStore,
} from './browser-unattended-sqlite-stores';
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
 * the IPC handlers (user-approved dialogs) and the gateway service share the
 * same instances, so a James-approved authorization is immediately visible to
 * browser.fill_credential and a paused campaign immediately stops grants.
 *
 * Authorizations and campaigns are user-approved only: created via renderer
 * IPC, never via an MCP tool.
 */

const logger = getLogger('BrowserUnattendedServices');

let credentialAuthorizationService: CredentialAuthorizationService | null = null;
let campaignService: BrowserCampaignService | null = null;
let escalationService: BrowserEscalationService | null = null;
let escalationNotify: ((escalation: BrowserEscalation) => void) | null = null;

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
  return {
    locked: getBrowserCredentialSession().locked,
    passwordSourceConfigured: configured,
  };
}
