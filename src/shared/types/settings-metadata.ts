import { CORE_SETTINGS_METADATA } from './settings-metadata-core';
import { INTEGRATION_SETTINGS_METADATA } from './settings-metadata-integrations';
import { REVIEW_NETWORK_SETTINGS_METADATA } from './settings-metadata-review-network';
import { RUNTIME_SETTINGS_METADATA } from './settings-metadata-runtime';
import type { SettingMetadata } from './settings-metadata.types';

export type { SettingMetadata } from './settings-metadata.types';

export const SETTINGS_METADATA: SettingMetadata[] = [
  { key: 'codexBackupKeepThree', label: 'Keep only the newest 3 Codex backups', description: 'At startup, remove older automatic Codex backups; clean-up and archive copies stay.', type: 'boolean', category: 'memory', hidden: true, requiresRestart: true, keywords: ['storage', 'backups'] },
  ...CORE_SETTINGS_METADATA,
  ...RUNTIME_SETTINGS_METADATA,
  ...REVIEW_NETWORK_SETTINGS_METADATA,
  ...INTEGRATION_SETTINGS_METADATA,
];
