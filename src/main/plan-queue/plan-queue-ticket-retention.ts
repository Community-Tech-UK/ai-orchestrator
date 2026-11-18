/**
 * How long a Linear ticket's text is kept. It is other people's text, so it stays only while a job can still use it.
 *
 * - **The brief file** (`plan-queue-ticket-brief-file.ts`) is deleted when the job reaches `landed`, `skipped` or `parked` (a
 *   job set aside, discarded or stopped by a cancelled run is parked), and when its run is cancelled. A sweep at start-up and
 *   once an hour deletes any brief file whose job is missing or in one of those states, so a delete that was interrupted is
 *   finished later. A Resume writes the file again, because every round writes it from the table.
 * - **The table keeps the approved text and any held change** while the job can be resumed, a set-aside job included.
 * - **The text is cleared** (approved text, held change and hashes emptied, the time recorded) when the job is landed, skipped
 *   or discarded, when its run is cancelled, and when it has been set aside for 30 days. After that only the identifier, the
 *   approved title, the address and the ids that place the ticket remain, and a Resume reads the ticket again and asks James
 *   (`plan-queue-ticket-guard.ts`, the `cleared` question).
 *
 * What this does not remove: a session's own history keeps the prompts it was sent, as with any prompt.
 *
 * Nothing here logs or returns ticket text. The table work of the sweep runs with no `await`, so it sees the table as it is and
 * a Resume cannot slip between its read and its clear: a job being resumed is named in `holdForResume`, and neither the sweep
 * nor a cancelled run clears its text.
 */
import { getLogger } from '../logging/logger';
import { getPlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store-singleton';
import type { PlanQueueLinearTicketStore, TicketRetentionRow } from './plan-queue-linear-ticket-store';
import { deleteTicketBriefFile, sweepTicketBriefFiles } from './plan-queue-ticket-brief-file';
import { isTerminalItemState } from './plan-queue-state';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueTicketRetention');

/** How long a set-aside job keeps its ticket's text. */
export const TICKET_TEXT_KEPT_SET_ASIDE_MS = 30 * 24 * 60 * 60_000;
/** How often the sweep runs after the one at start-up. */
export const TICKET_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface TicketRetentionDependencies {
  table(): PlanQueueLinearTicketStore | null;
  /** Deletes one job's brief file; nothing to do when there is none. */
  deleteBrief(itemId: string): Promise<void>;
  /** Deletes every brief file whose job `keep` does not name. */
  sweepBriefs(keep: (itemId: string) => boolean, now: number): Promise<number>;
  now(): number;
}

export interface TicketRetention {
  /** A job was saved: when it has reached a final state its brief file goes, and its text too when it is landed, skipped or discarded. */
  noteItem(item: Pick<PlanQueueItem, 'id' | 'state' | 'discardedAt'>): void;
  /** A run was cancelled: every job of it is final, so each loses its brief file and its text. */
  noteRunCancelled(runId: string): void;
  /** One pass of the clean-up. Safe to run while jobs are running or being resumed; resolves when its files are removed. */
  sweep(): Promise<void>;
  /** Names a job being resumed, so nothing clears its text until the Resume is over. Returns the release. */
  holdForResume(itemId: string): () => void;
  /** Runs the sweep now and every hour. */
  start(): void;
  stop(): void;
}

/** True when this row's text is due to go: the job is final and one of the listed moments has come. */
function textIsDue(row: TicketRetentionRow, now: number): boolean {
  if (!isTerminalItemState(row.state as PlanQueueItem['state'])) return false;
  return row.state !== 'parked' || row.discardedAt !== null || row.runStatus === 'cancelled' || now - row.setAsideAt >= TICKET_TEXT_KEPT_SET_ASIDE_MS;
}

export function createTicketRetention(deps: TicketRetentionDependencies): TicketRetention {
  const resuming = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let sweeping: Promise<void> | null = null;

  const isResuming = (itemId: string): boolean => (resuming.get(itemId) ?? 0) > 0;

  const deleteBrief = (itemId: string): void => {
    // Fixed words and the item id only. The sweep finishes a delete that failed here.
    void deps.deleteBrief(itemId).catch(() => logger.warn('A ticket brief file could not be deleted; the next sweep tries again', { itemId }));
  };

  /** A failure here must not break the save that called it: the text stays a little longer and the next sweep clears it. */
  const clear = (itemId: string): void => {
    if (isResuming(itemId)) return;
    try {
      const table = deps.table();
      const row = table?.get(itemId);
      if (table && row && row.textClearedAt === null) table.clearText(itemId, deps.now());
    } catch {
      logger.warn('Ticket text could not be cleared; the next sweep tries again', { itemId });
    }
  };

  function noteItem(item: Pick<PlanQueueItem, 'id' | 'state' | 'discardedAt'>): void {
    if (!isTerminalItemState(item.state)) return;
    deleteBrief(item.id);
    if (item.state !== 'parked' || item.discardedAt != null) clear(item.id);
  }

  function noteRunCancelled(runId: string): void {
    let rows: TicketRetentionRow[] = [];
    try {
      rows = deps.table()?.retentionRows() ?? [];
    } catch {
      logger.warn('The jobs of a cancelled run could not be listed; the next sweep clears their text', { runId });
    }
    for (const row of rows) {
      if (row.runId !== runId || !isTerminalItemState(row.state as PlanQueueItem['state'])) continue;
      deleteBrief(row.itemId);
      clear(row.itemId);
    }
  }

  async function sweepOnce(): Promise<void> {
    const table = deps.table();
    if (!table) return;
    const now = deps.now();
    // Everything up to the files runs in one turn: the rows are read and the text cleared with nothing in between.
    const rows = table.retentionRows();
    for (const row of rows) {
      if (row.textClearedAt !== null || isResuming(row.itemId)) continue;
      if (textIsDue(row, now)) table.clearText(row.itemId, now);
    }
    const active = new Set(rows.filter((row) => !isTerminalItemState(row.state as PlanQueueItem['state'])).map((row) => row.itemId));
    const removed = await deps.sweepBriefs((itemId) => active.has(itemId) || isResuming(itemId), now);
    if (removed > 0) logger.info('Ticket brief files removed by the sweep', { removed });
  }

  /** One sweep at a time: an hourly pass that finds the last one still running joins it. */
  function sweep(): Promise<void> {
    sweeping ??= sweepOnce().finally(() => { sweeping = null; });
    return sweeping;
  }

  return {
    noteItem,
    noteRunCancelled,
    sweep,
    holdForResume(itemId) {
      resuming.set(itemId, (resuming.get(itemId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (resuming.get(itemId) ?? 1) - 1;
        if (left > 0) resuming.set(itemId, left); else resuming.delete(itemId);
      };
    },
    start() {
      if (timer) return;
      const run = (): void => { void sweep().catch((error: unknown) => logger.warn('The ticket text sweep failed', { error: error instanceof Error ? error.message : String(error) })); };
      run();
      timer = setInterval(run, TICKET_RETENTION_SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

let instance: TicketRetention | null = null;

/** The app's one retention, over the real ticket table, brief folder and clock. */
export function getTicketRetention(): TicketRetention {
  instance ??= createTicketRetention({
    table: getPlanQueueLinearTicketStore,
    deleteBrief: deleteTicketBriefFile,
    sweepBriefs: sweepTicketBriefFiles,
    now: Date.now,
  });
  return instance;
}

/** A test stands in a retention with its own clock; `null` puts the real one back. */
export function _setTicketRetentionForTesting(retention: TicketRetention | null): void {
  instance?.stop();
  instance = retention;
}
