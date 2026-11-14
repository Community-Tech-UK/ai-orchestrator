/**
 * When a job's computer goes away (spec: "When the other computer goes away"): the job is held and says so, checked
 * every few seconds; after ten minutes it carries on here from its last checkpoint. A computer that comes back
 * before then has its work collected first. The far copy of a job that carried on here is removed once the computer
 * is back, from a list that survives a restart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../../logging/logger';
import type { RemoteJobItem } from './queue-job-remote';

const logger = getLogger('PlanQueueRemoteAway');

export const AWAY_LIMIT_MS = 10 * 60_000;
export const AWAY_CHECK_MS = 15_000;

/** What a computer still holds that this Mac no longer wants. */
export interface PendingRemoval {
  nodeId: string;
  label: string;
  repoRoot: string;
  item: Pick<RemoteJobItem, 'id' | 'sourceRef' | 'branchName'>;
}

export class PendingRemovals {
  private entries: PendingRemoval[] | null = null;
  constructor(private readonly file?: string) {}

  private load(): PendingRemoval[] {
    if (this.entries) return this.entries;
    try {
      const parsed: unknown = this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
      this.entries = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch { this.entries = []; }
    return this.entries;
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.load()));
    } catch (error) { logger.warn('Could not save the list of jobs to remove from other computers', { error: String(error) }); }
  }

  add(entry: PendingRemoval): void {
    const list = this.load();
    if (list.some(other => other.item.id === entry.item.id && other.nodeId === entry.nodeId)) return;
    list.push(entry);
    this.persist();
  }

  list(): readonly PendingRemoval[] { return this.load(); }

  delete(itemId: string, nodeId: string): void {
    this.entries = this.load().filter(entry => !(entry.item.id === itemId && entry.nodeId === nodeId));
    this.persist();
  }
}

function isEntry(value: unknown): value is PendingRemoval {
  const entry = value as PendingRemoval | null;
  return typeof entry?.nodeId === 'string' && typeof entry.label === 'string' && typeof entry.repoRoot === 'string'
    && typeof entry.item?.id === 'string' && typeof entry.item.sourceRef === 'string';
}

/** One check loop per held job; `tick` says whether to keep going. */
export class AwayWatch {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  constructor(private readonly everyMs = AWAY_CHECK_MS) {}

  start(itemId: string, tick: () => Promise<'again' | 'done'>): void {
    this.stop(itemId);
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      tick().then(result => { if (result === 'done') this.stop(itemId); },
        (error: unknown) => {
          // A job that cannot be read any more (deleted) would otherwise log this every few seconds for good.
          logger.warn('Checking a job whose computer was away failed; no longer checking', { itemId, error: error instanceof Error ? error.message : String(error) });
          this.stop(itemId);
        })
        .finally(() => { running = false; });
    }, this.everyMs);
    timer.unref?.();
    this.timers.set(itemId, timer);
  }

  stop(itemId: string): void {
    const timer = this.timers.get(itemId);
    if (timer) clearInterval(timer);
    this.timers.delete(itemId);
  }

  stopAll(): void { for (const id of [...this.timers.keys()]) this.stop(id); }
  isWatching(itemId: string): boolean { return this.timers.has(itemId); }
}
