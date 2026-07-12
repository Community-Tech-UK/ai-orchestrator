/**
 * Contract test: the legacy IPC module must be a thin shim over the
 * contracts package during Phase 1 migration.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IPC_CHANNELS as legacyChannels } from '@shared/types/ipc.types';
import { IPC_CHANNELS } from '../index';

const ROOT = resolve(__dirname, '../../../../..');

describe('IPC_CHANNELS identity contract', () => {
  const legacyPath = resolve(ROOT, 'src/shared/types/ipc.types.ts');
  const legacySource = readFileSync(legacyPath, 'utf-8');

  it('legacy IPC shim forwards IPC_CHANNELS directly from contracts', () => {
    expect(legacyChannels).toBe(IPC_CHANNELS);
  });

  it('legacy IPC shim does not define a local IPC_CHANNELS object', () => {
    expect(legacySource).not.toMatch(/export const IPC_CHANNELS\s*=\s*\{/);
  });

  it('legacy IPC shim re-exports contract types', () => {
    expect(legacySource).toMatch(
      /export\s+type\s+\*\s+from\s+['"]@contracts\/types\/provider-runtime-events['"];?/,
    );
    expect(legacySource).toMatch(
      /export\s+type\s+\*\s+from\s+['"]@contracts\/types\/transport['"];?/,
    );
  });

  it('defines the complete RLM storage maintenance channel surface', () => {
    expect(IPC_CHANNELS).toMatchObject({
      RLM_STORAGE_GET_HEALTH: 'rlm-storage:get-health',
      RLM_STORAGE_PREVIEW_MAINTENANCE: 'rlm-storage:preview-maintenance',
      RLM_STORAGE_RUN_MAINTENANCE: 'rlm-storage:run-maintenance',
      RLM_STORAGE_GET_MAINTENANCE_STATUS: 'rlm-storage:get-maintenance-status',
      RLM_STORAGE_MAINTENANCE_PROGRESS: 'rlm-storage:maintenance-progress',
    });
  });
});
