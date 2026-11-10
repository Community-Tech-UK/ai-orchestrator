import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { PromptHistoryStoreV1 } from '../../shared/types/prompt-history.types';

const logger = getLogger('PromptHistoryStore');

export interface PromptHistoryStoreBackend {
  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K];
  setMany(values: Partial<PromptHistoryStoreV1>): void;
  /** Write any pending change now; resolves once it is on disk. */
  flush(): Promise<void>;
  /** Copy the file as it is on disk, once ever, before history is first cleaned out. */
  keepBackupCopy(): Promise<void>;
}

export function promptHistoryDefaults(): PromptHistoryStoreV1 {
  return { schemaVersion: 1, byInstance: {}, byProject: {} };
}

export const PROMPT_HISTORY_SAVE_DELAY_MS = 1_000;

/**
 * Prompt history kept in memory and saved in the background.
 *
 * This replaced electron-store, whose `conf` backend re-reads and re-parses the
 * whole file on every get and set. With an 82 MB history file that cost about
 * two seconds of frozen main process per recorded prompt. The file name and
 * `PromptHistoryStoreV1` shape are unchanged, so older builds can still read it.
 */
export class PromptHistoryFileStore implements PromptHistoryStoreBackend {
  private data: PromptHistoryStoreV1;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly saveDelayMs = PROMPT_HISTORY_SAVE_DELAY_MS,
  ) {
    this.data = this.load();
  }

  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K] {
    return this.data[key];
  }

  setMany(values: Partial<PromptHistoryStoreV1>): void {
    this.data = { ...this.data, ...values };
    this.dirty = true;
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, this.saveDelayMs);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  async keepBackupCopy(): Promise<void> {
    const backupPath = path.join(path.dirname(this.filePath), 'prompt-history.before-cleanup.json');
    try {
      await fs.promises.copyFile(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
      logger.info('Kept a copy of prompt history before cleaning it', { backupPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST: an earlier cleanup already kept the copy. ENOENT: nothing saved yet.
      if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
    }
  }

  private save(): Promise<void> {
    this.writing ??= this.writePending().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  /** Writes until nothing is pending, so a change made mid-write gets its own write. */
  private async writePending(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await writeFileAtomic(this.filePath, JSON.stringify(this.data));
      } catch (error) {
        // Keep the change pending: the next change or the shutdown flush retries it.
        this.dirty = true;
        logger.warn('Failed to save prompt history', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  private load(): PromptHistoryStoreV1 {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return promptHistoryDefaults();
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Prompt history file does not hold an object');
      }
      return { ...promptHistoryDefaults(), ...(parsed as Partial<PromptHistoryStoreV1>) };
    } catch (error) {
      const asidePath = this.filePath.replace(/\.json$/, '') + `.corrupt-${Date.now()}.json`;
      fs.renameSync(this.filePath, asidePath);
      logger.warn('Prompt history file could not be read; moved it aside and started empty', {
        asidePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return promptHistoryDefaults();
    }
  }
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    const handle = await fs.promises.open(tmpPath, 'w');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
