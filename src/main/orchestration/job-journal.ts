/**
 * JobJournal — lightweight JSONL-based persistence for long-running
 * orchestration jobs.
 *
 * Inspired by codex-plugin-cc:scripts/lib/job-control.mjs (claude2.md §5):
 * persisting job state to disk so `/orchestration status` works hours later
 * and survives daemon restarts.
 *
 * Design:
 *   - Each journal write appends a JSON line to `.aio/jobs.jsonl`.
 *   - The file is an append-only log; the current state of any job is the last
 *     entry for its id.
 *   - On boot, `JobJournal.load()` replays the log to reconstruct in-memory
 *     state in O(n) lines.
 *   - The journal file is gitignored (runtime data), not the `.aio/` markdown
 *     files (which are git-trackable per the project-story convention).
 *
 * The journal coexists with the SQLite OperatorRunStore; the journal is the
 * lightweight "are we still running?" surface; the SQL store is the rich
 * query surface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('JobJournal');

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  title: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface JournalEntry extends JobRecord {
  _seq: number;
}

export class JobJournal {
  private static instance: JobJournal | null = null;
  private readonly journalPath: string;
  private jobs = new Map<string, JobRecord>();
  private seq = 0;

  private constructor(private readonly journalDir: string) {
    this.journalPath = path.join(journalDir, 'jobs.jsonl');
    this.load();
  }

  static getInstance(journalDir?: string): JobJournal {
    if (!this.instance) {
      const dir = journalDir ?? path.join(process.cwd(), '.aio');
      this.instance = new JobJournal(dir);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private load(): void {
    if (!fs.existsSync(this.journalPath)) return;
    try {
      const lines = fs.readFileSync(this.journalPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as JournalEntry;
        this.jobs.set(entry.id, entry);
        if (entry._seq >= this.seq) this.seq = entry._seq + 1;
      }
      logger.info('Loaded job journal', { jobCount: this.jobs.size, path: this.journalPath });
    } catch (err) {
      logger.warn('Failed to load job journal — starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private append(record: JobRecord): void {
    const entry: JournalEntry = { ...record, _seq: this.seq++ };
    try {
      fs.mkdirSync(this.journalDir, { recursive: true });
      fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.error('Failed to append to job journal', err instanceof Error ? err : undefined);
    }
  }

  upsert(record: Omit<JobRecord, 'updatedAt'>): JobRecord {
    const existing = this.jobs.get(record.id);
    const updated: JobRecord = {
      ...existing,
      ...record,
      updatedAt: Date.now(),
    };
    this.jobs.set(updated.id, updated);
    this.append(updated);
    return updated;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(filter?: { status?: JobStatus }): JobRecord[] {
    const all = Array.from(this.jobs.values());
    if (!filter?.status) return all;
    return all.filter((j) => j.status === filter.status);
  }

  /** Mark a job as running. */
  start(id: string, title: string, metadata?: Record<string, unknown>): JobRecord {
    return this.upsert({
      id,
      title,
      status: 'running',
      createdAt: this.jobs.get(id)?.createdAt ?? Date.now(),
      metadata,
    });
  }

  /** Mark a job as completed. */
  complete(id: string, metadata?: Record<string, unknown>): JobRecord {
    const existing = this.jobs.get(id);
    return this.upsert({
      id,
      title: existing?.title ?? id,
      status: 'completed',
      createdAt: existing?.createdAt ?? Date.now(),
      completedAt: Date.now(),
      metadata: { ...existing?.metadata, ...metadata },
    });
  }

  /** Mark a job as failed. */
  fail(id: string, error: string, metadata?: Record<string, unknown>): JobRecord {
    const existing = this.jobs.get(id);
    return this.upsert({
      id,
      title: existing?.title ?? id,
      status: 'failed',
      createdAt: existing?.createdAt ?? Date.now(),
      completedAt: Date.now(),
      error,
      metadata: { ...existing?.metadata, ...metadata },
    });
  }
}

export function getJobJournal(): JobJournal {
  return JobJournal.getInstance();
}
