/**
 * Settings Export/Import Service
 *
 * Exports and imports portable, non-secret app settings to/from a JSON file.
 * Credentials, device identities, and machine-local paths stay out of the
 * export by design.
 */

import { app, dialog } from 'electron';
import * as fs from 'fs';
import { getLogger } from '../../logging/logger';
import { getSettingsManager } from './settings-manager';
import {
  coerceRendererSettingsUpdate,
  getSettingsToolPolicy,
} from './settings-control-policy';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from '../../../shared/types/settings.types';

const logger = getLogger('SettingsExport');

/** Schema version for forward-compatibility checks */
const EXPORT_VERSION = 1;

export interface SettingsExportData {
  version: number;
  exportedAt: string;
  appVersion: string;

  /** Portable, non-secret app settings from electron-store. */
  appSettings: Partial<AppSettings>;
  /** Keys intentionally excluded because they are secrets or machine-local. */
  skippedSettings: string[];
}

const MACHINE_LOCAL_SETTING_KEYS = new Set<keyof AppSettings>([
  'defaultWorkingDirectory',
  'chromeDevtoolsAttachProfileId',
  'browserVaultMasterPasswordFile',
  'voiceLocalSttWorkerNodeId',
  'remoteNodesEnabled',
  'remoteNodesServerHost',
  'remoteNodesServerPort',
  'remoteNodesNamespace',
  'remoteNodesRequireTls',
  'remoteNodesTlsMode',
  'thinClientWsEnabled',
  'thinClientWsHost',
  'thinClientWsPort',
  'mobileGatewayEnabled',
  'mobileGatewayPort',
  'mobileGatewayBindInterface',
  'mobileGatewayApnsBundleId',
  'mobileGatewayApnsProduction',
  'projectPluginTrust',
]);

/**
 * Build the export payload from current app state.
 */
export function buildExportData(): SettingsExportData {
  const settings = getSettingsManager();
  const allSettings = settings.getAll();
  const appSettings = filterPortableSettings(allSettings);

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    appSettings,
    skippedSettings: listSkippedSettings(allSettings),
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
    settings: Object.keys(data.appSettings).length,
    skipped: data.skippedSettings.length,
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
  settingsImported: number;
  settingsSkipped: number;
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
    settingsImported: 0,
    settingsSkipped: 0,
  };

  if (data.appSettings && typeof data.appSettings === 'object') {
    const { settings: portableSettings, skipped } = sanitizeImportedSettings(
      data.appSettings as Record<string, unknown>,
    );
    const settings = getSettingsManager();
    if (Object.keys(portableSettings).length > 0) {
      // Merge over current settings so newer app versions keep defaults for
      // keys absent from older exports.
      settings.update(portableSettings);
      result.settingsRestored = true;
    }
    result.settingsImported = Object.keys(portableSettings).length;
    result.settingsSkipped = skipped;
    logger.info('App settings restored from import', {
      settings: result.settingsImported,
      skipped,
    });
  }

  return result;
}

export function filterPortableSettings(settings: AppSettings): Partial<AppSettings> {
  const portable: Partial<AppSettings> = {};
  for (const key of Object.keys(settings) as (keyof AppSettings)[]) {
    if (isPortableSettingKey(key)) {
      (portable as Record<string, unknown>)[key] = settings[key];
    }
  }
  return portable;
}

export function isPortableSettingKey(key: keyof AppSettings): boolean {
  if (MACHINE_LOCAL_SETTING_KEYS.has(key)) {
    return false;
  }
  return getSettingsToolPolicy(key).tier !== 'secret';
}

function listSkippedSettings(settings: AppSettings): string[] {
  return (Object.keys(settings) as (keyof AppSettings)[])
    .filter((key) => !isPortableSettingKey(key))
    .sort();
}

function sanitizeImportedSettings(
  rawSettings: Record<string, unknown>,
): { settings: Partial<AppSettings>; skipped: number } {
  const candidate: Record<string, unknown> = {};
  let skipped = 0;

  for (const [key, value] of Object.entries(rawSettings)) {
    if (!hasOwn(DEFAULT_SETTINGS, key) || !isPortableSettingKey(key)) {
      skipped++;
      continue;
    }
    candidate[key] = value;
  }

  return {
    settings: coerceRendererSettingsUpdate(candidate),
    skipped,
  };
}

function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}
