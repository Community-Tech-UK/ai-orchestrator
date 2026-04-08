/**
 * Settings Export/Import Service
 *
 * Exports and imports app settings, channel credentials, access policies,
 * and remote node identities to/from a JSON file. Useful for preserving
 * configuration across app reinstalls.
 */

import { app, dialog } from 'electron';
import * as fs from 'fs';
import { getLogger } from '../../logging/logger';
import { getSettingsManager } from './settings-manager';
import { ChannelCredentialStore } from '../../channels/channel-credential-store';
import { ChannelAccessPolicyStore } from '../../channels/channel-access-policy-store';
import { getRLMDatabase } from '../../persistence/rlm-database';
import type { AppSettings } from '../../../shared/types/settings.types';

const logger = getLogger('SettingsExport');

/** Schema version for forward-compatibility checks */
const EXPORT_VERSION = 1;

export interface SettingsExportData {
  version: number;
  exportedAt: string;
  appVersion: string;

  /** All app settings from electron-store */
  appSettings: Partial<AppSettings>;

  /** Saved channel credentials (Discord/WhatsApp tokens) */
  channelCredentials: { platform: string; token: string }[];

  /** Saved channel access policies (paired senders, mode) */
  channelAccessPolicies: {
    platform: string;
    mode: string;
    allowedSenders: string[];
  }[];

  /** Registered remote worker node identities */
  remoteNodeIdentities: string; // JSON string from settings
}

/**
 * Build the export payload from current app state.
 */
export function buildExportData(): SettingsExportData {
  const settings = getSettingsManager();
  const db = getRLMDatabase().getRawDb();
  const credStore = new ChannelCredentialStore(db);
  const policyStore = new ChannelAccessPolicyStore(db);

  const allSettings = settings.getAll();

  // Channel credentials
  const creds = credStore.getAll().map(c => ({
    platform: c.platform,
    token: c.token,
  }));

  // Channel access policies
  const policies = policyStore.getAll().map(p => ({
    platform: p.platform,
    mode: p.mode,
    allowedSenders: JSON.parse(p.allowed_senders_json) as string[],
  }));

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    appSettings: allSettings,
    channelCredentials: creds,
    channelAccessPolicies: policies,
    remoteNodeIdentities: allSettings.remoteNodesRegisteredNodes ?? '{}',
  };
}

/**
 * Show a save dialog and write the export file.
 * Returns the file path on success, or null if the user cancelled.
 */
export async function exportSettings(): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: 'Export Settings',
    defaultPath: `ai-orchestrator-settings-${formatDate()}.json`,
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) return null;

  const data = buildExportData();
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info('Settings exported', {
    path: result.filePath,
    credentials: data.channelCredentials.length,
    policies: data.channelAccessPolicies.length,
  });
  return result.filePath;
}

/**
 * Show an open dialog, read the file, validate, and apply.
 * Returns a summary of what was imported, or null if cancelled.
 */
export async function importSettings(): Promise<ImportResult | null> {
  const result = await dialog.showOpenDialog({
    title: 'Import Settings',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as SettingsExportData;

  return applyImport(data);
}

export interface ImportResult {
  settingsRestored: boolean;
  credentialsRestored: number;
  policiesRestored: number;
  remoteNodesRestored: boolean;
}

/**
 * Apply an import payload to the current app state.
 */
export function applyImport(data: SettingsExportData): ImportResult {
  if (!data.version || data.version > EXPORT_VERSION) {
    throw new Error(
      `Unsupported export version ${data.version}. This app supports version ${EXPORT_VERSION}.`
    );
  }

  const result: ImportResult = {
    settingsRestored: false,
    credentialsRestored: 0,
    policiesRestored: 0,
    remoteNodesRestored: false,
  };

  // 1. Restore app settings
  if (data.appSettings && typeof data.appSettings === 'object') {
    const settings = getSettingsManager();
    // Don't blindly replace — merge on top of current to avoid losing
    // settings that exist in a newer version but not in the export.
    settings.update(data.appSettings as Partial<AppSettings>);
    result.settingsRestored = true;
    logger.info('App settings restored from import');
  }

  // 2. Restore channel credentials
  if (Array.isArray(data.channelCredentials)) {
    const db = getRLMDatabase().getRawDb();
    const credStore = new ChannelCredentialStore(db);
    for (const cred of data.channelCredentials) {
      if (cred.platform && cred.token) {
        credStore.save(cred.platform, cred.token);
        result.credentialsRestored++;
      }
    }
    logger.info('Channel credentials restored', { count: result.credentialsRestored });
  }

  // 3. Restore channel access policies
  if (Array.isArray(data.channelAccessPolicies)) {
    const db = getRLMDatabase().getRawDb();
    const policyStore = new ChannelAccessPolicyStore(db);
    for (const policy of data.channelAccessPolicies) {
      if (policy.platform) {
        policyStore.save(policy.platform, {
          mode: (policy.mode as 'pairing' | 'allowlist' | 'disabled') ?? 'pairing',
          allowedSenders: policy.allowedSenders ?? [],
          pendingPairings: [],
          maxPending: 3,
          codeExpiryMs: 5 * 60 * 1000,
        });
        result.policiesRestored++;
      }
    }
    logger.info('Channel access policies restored', { count: result.policiesRestored });
  }

  // 4. Restore remote node identities
  if (data.remoteNodeIdentities && data.remoteNodeIdentities !== '{}') {
    const settings = getSettingsManager();
    settings.set('remoteNodesRegisteredNodes', data.remoteNodeIdentities);
    result.remoteNodesRestored = true;
    logger.info('Remote node identities restored');
  }

  return result;
}

function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
