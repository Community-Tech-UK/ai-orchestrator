/**
 * Deletes the recovery copies `changeDocumentFile` leaves beside queue documents once nothing can
 * still be writing into them. A copy is kept so an editor that was saving into the old file at the
 * moment of an update loses nothing; a week after its last change that can no longer happen.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { isRecoveryCopyName } from './plan-queue-document-mutation';

const logger = getLogger('PlanQueueRecoveryCopies');

export const RECOVERY_COPY_KEPT_MS = 7 * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

/** Hourly: removes copies older than a week from the folders of documents the queue has worked on. */
export class PlanQueueRecoveryCopies {
  private nextSweepAt = 0;

  sweepDue(folders: () => readonly string[], now = Date.now()): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_EVERY_MS;
    void this.sweep(folders(), now).catch((error: unknown) => logger.warn('Plan queue: could not remove old recovery copies', { error: String(error) }));
  }

  async sweep(folders: readonly string[], now: number): Promise<void> {
    for (const folder of folders) {
      // A folder can be gone or unreadable; its copies wait for the next sweep.
      const names = await fs.readdir(folder).catch(() => [] as string[]);
      let removed = 0;
      for (const name of names.filter(isRecoveryCopyName)) {
        const file = path.join(folder, name);
        try {
          const stat = await fs.lstat(file);
          // A rename keeps the modified time, so the change time is when the copy was set aside or last written.
          if (!stat.isFile() || stat.ctimeMs > now - RECOVERY_COPY_KEPT_MS) continue;
          await fs.unlink(file);
          removed += 1;
        } catch (error) {
          // The dev and installed apps can both sweep a folder; a copy the other removed is not a failure.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('Plan queue: could not remove a recovery copy', { file, error: String(error) });
        }
      }
      if (removed) logger.info('Plan queue: removed old recovery copies', { folder, removed });
    }
  }
}
