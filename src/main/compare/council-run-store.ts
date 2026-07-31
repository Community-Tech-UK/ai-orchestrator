/**
 * Council Run Store — durable persistence for Ask Council (WS-B6 progressive
 * compare) runs.
 *
 * Multi-provider compare had ZERO persistence before WS-B6: `compare()` was a
 * synchronous in-memory `Promise.all` with no survivable state. Council runs
 * are low-volume (a human clicks "Ask Council" occasionally) and each run's
 * payload is small (a handful of provider answers, capped by MAX_PROVIDERS) —
 * a SQLite table would be relational/query machinery this feature doesn't
 * need. Instead this mirrors the LF-6 durable-loop-memory pattern
 * (`loop-memory.ts`'s `DurableLoopMemoryStore`): a single JSON file capped at
 * MAX_RUNS entries, replaced via synchronous read-modify-write. That's safe
 * without an explicit lock because there is only one main process and no
 * `await` between the read and the write, so two `saveRun` calls can't
 * interleave within Node's single-threaded event loop.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { CouncilRun } from '@contracts/schemas/command';
import { getLogger } from '../logging/logger';

const logger = getLogger('CouncilRunStore');

/** Oldest runs are pruned first once this cap is exceeded. */
const MAX_RUNS = 20;

const STORE_VERSION = 1;

interface CouncilRunsFile {
  version: number;
  /** Newest-first. */
  runs: CouncilRun[];
}

function resolveDefaultFilePath(): string {
  try {
    const userDataPath = app.getPath('userData');
    return userDataPath ? path.join(userDataPath, 'council-runs.json') : '';
  } catch {
    // Electron app not available (unit tests, headless) — disable persistence.
    return '';
  }
}

export class CouncilRunStore {
  private static instance: CouncilRunStore | null = null;
  private readonly filePath: string;

  static getInstance(): CouncilRunStore {
    CouncilRunStore.instance ??= new CouncilRunStore(resolveDefaultFilePath());
    return CouncilRunStore.instance;
  }

  static _resetForTesting(): void {
    CouncilRunStore.instance = null;
  }

  /** `filePath` is injectable so tests can point at a real temp file for a genuine round trip. */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  loadAll(): CouncilRun[] {
    return this.read().runs;
  }

  getRun(runId: string): CouncilRun | null {
    return this.read().runs.find((r) => r.id === runId) ?? null;
  }

  /** Most recently started run, if any — used to rehydrate after a renderer reload/app restart. */
  getLatest(): CouncilRun | null {
    const runs = this.read().runs;
    return runs.length > 0 ? runs[0] : null;
  }

  saveRun(run: CouncilRun): void {
    if (!this.filePath) return;
    const data = this.read();
    const existingIndex = data.runs.findIndex((r) => r.id === run.id);
    if (existingIndex >= 0) {
      data.runs[existingIndex] = run;
    } else {
      data.runs.unshift(run);
    }
    if (data.runs.length > MAX_RUNS) {
      data.runs.length = MAX_RUNS;
    }
    this.write(data);
  }

  private read(): CouncilRunsFile {
    if (!this.filePath) return { version: STORE_VERSION, runs: [] };
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CouncilRunsFile> | null;
      if (!parsed || !Array.isArray(parsed.runs)) return { version: STORE_VERSION, runs: [] };
      return { version: parsed.version ?? STORE_VERSION, runs: parsed.runs };
    } catch {
      return { version: STORE_VERSION, runs: [] };
    }
  }

  private write(data: CouncilRunsFile): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      logger.warn('Failed to write council runs store', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function getCouncilRunStore(): CouncilRunStore {
  return CouncilRunStore.getInstance();
}
