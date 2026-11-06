/**
 * Durable store for the Claude self wake-up per-day tally.
 *
 * Housekeeping step 11 kept the tally in memory only (its choice 14); October
 * follow-ups A#185 asked for a lasting counter. The file holds one count per
 * UTC day — the same keys `SelfWakeupTracker.tally(day)` reads — and is
 * written through on each counted request.
 *
 * Fail-soft by design: without a resolvable data directory (tests, workers)
 * loads return no history and saves are dropped, so no code path can fail
 * because a counter could not be stored. Saves replace the file atomically
 * (write a temporary file, then rename it over the tally), so a failed or
 * partial write can never destroy the last valid tally.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface SelfWakeupTallyStore {
  load(): Record<string, number>;
  save(tally: Record<string, number>): void;
}

function resolveUserDataDir(): string | null {
  try {
    // Lazy, guarded require — this module must also load in worker/test
    // contexts where electron is unavailable (same pattern as cost-attribution).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } };
    const userData = electron.app?.getPath?.('userData');
    return userData ?? null;
  } catch {
    return null;
  }
}

const TALLY_FILENAME = 'self-wakeup-tally.json';

export function createSelfWakeupTallyStore(resolveBaseDir: () => string | null = resolveUserDataDir): SelfWakeupTallyStore {
  return {
    load(): Record<string, number> {
      try {
        const base = resolveBaseDir();
        if (!base) return {};
        const file = join(base, TALLY_FILENAME);
        if (!existsSync(file)) return {};
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const tally: Record<string, number> = {};
        for (const [day, count] of Object.entries(parsed as Record<string, unknown>)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
            tally[day] = count;
          }
        }
        return tally;
      } catch {
        return {};
      }
    },
    save(tally: Record<string, number>): void {
      let temp: string | undefined;
      try {
        const base = resolveBaseDir();
        if (!base) return;
        mkdirSync(base, { recursive: true });
        const file = join(base, TALLY_FILENAME);
        // Write-then-rename: the tally file is only ever replaced by a fully
        // written temporary file, so a partial write or ENOSPC mid-save leaves
        // the previous counts in place instead of a truncated file that would
        // load as empty history.
        temp = join(base, `${TALLY_FILENAME}.${process.pid}.tmp`);
        writeFileSync(temp, `${JSON.stringify(tally)}\n`, 'utf8');
        renameSync(temp, file);
        temp = undefined;
      } catch {
        if (temp) {
          try { unlinkSync(temp); } catch { /* best-effort */ }
        }
        // A dropped counter is never worth failing a session over.
      }
    },
  };
}
