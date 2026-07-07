import { app } from 'electron';
import { getLogger } from '../logging/logger';
import { getJitterScheduler } from '../tasks/jitter-scheduler';
import { registerCleanup } from '../util/cleanup-registry';
import {
  getArtifactCleanupService,
  type ArtifactCleanupService,
} from './artifact-cleanup-service';

const logger = getLogger('ArtifactCleanupMaintenance');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_INTERVAL_MS = DAY_MS;
const TASK_ID = 'artifact-cleanup-maintenance';

export interface ArtifactCleanupMaintenanceOptions {
  intervalMs?: number;
  retentionMs?: number;
  limit?: number;
  dryRun?: boolean;
  now?: () => number;
  userDataPath?: string;
  service?: ArtifactCleanupService;
}

let scheduled = false;

export function initializeArtifactCleanupMaintenance(
  options: ArtifactCleanupMaintenanceOptions = {},
): void {
  if (scheduled) {
    return;
  }

  const intervalMs = resolvePositiveNumber(
    options.intervalMs ?? process.env['AIO_ARTIFACT_CLEANUP_INTERVAL_MS'],
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs <= 0) {
    return;
  }

  getJitterScheduler().schedule({
    id: TASK_ID,
    name: 'Artifact cleanup maintenance',
    intervalMs,
    jitterPercent: 20,
    maxCatchUp: 1,
    handler: () => {
      void runArtifactCleanupMaintenance(options);
    },
  });
  registerCleanup(stopArtifactCleanupMaintenance);
  scheduled = true;
}

export function stopArtifactCleanupMaintenance(): void {
  getJitterScheduler().unschedule(TASK_ID);
  scheduled = false;
}

export async function runArtifactCleanupMaintenance(
  options: ArtifactCleanupMaintenanceOptions = {},
) {
  const now = options.now?.() ?? Date.now();
  const retentionMs = resolvePositiveNumber(
    options.retentionMs ?? process.env['AIO_ARTIFACT_CLEANUP_RETENTION_MS'],
    DEFAULT_RETENTION_MS,
  );
  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const result = await (options.service ?? getArtifactCleanupService()).cleanup({
    olderThan: now - retentionMs,
    dryRun: options.dryRun ?? false,
    limit: options.limit ?? 100,
    allowedRoots: [userDataPath],
    protectedRoots: [],
  });

  if (result.removed.length > 0 || result.errors.length > 0) {
    logger.info('Artifact cleanup maintenance completed', {
      candidates: result.candidates.length,
      removed: result.removed.length,
      errors: result.errors.length,
    });
  }

  return result;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
