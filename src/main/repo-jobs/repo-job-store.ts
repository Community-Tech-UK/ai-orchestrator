/**
 * Persistent Repo Job Store
 *
 * File-based persistence for repo job records, inspired by the codex-plugin-cc
 * state.mjs pattern (dual-layer: index JSON + per-job files + auto-pruning).
 *
 * Storage layout:
 *   userData/repo-jobs/
 *     index.json          — lightweight job index (id, status, timestamps)
 *     jobs/{id}.json      — full job record (result payload, context, etc.)
 *     logs/{id}.log       — append-only timestamped log (optional future use)
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { RepoJobRecord } from '../../shared/types/repo-job.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('RepoJobStore');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of jobs retained in the index. Oldest pruned first. */
const MAX_JOBS = 200;

/** Jobs older than this (ms) are eligible for age-based pruning. */
const MAX_JOB_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Index file schema version for future migrations. */
const INDEX_VERSION = 1;

// ─── Index Types ────────────────────────────────────────────────────────────

interface JobIndexEntry {
  id: string;
  status: string;
  type: string;
  name: string;
  createdAt: number;
  completedAt?: number;
}

interface JobIndex {
  version: number;
  jobs: JobIndexEntry[];
}

// ─── Store Class ────────────────────────────────────────────────────────────

export class RepoJobStore {
  private static instance: RepoJobStore;

  private readonly baseDir: string;
  private readonly jobsDir: string;
  private readonly logsDir: string;
  private readonly indexFile: string;
  private initialized = false;

  static getInstance(): RepoJobStore {
    if (!this.instance) {
      this.instance = new RepoJobStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as RepoJobStore | undefined) = undefined as unknown as RepoJobStore;
  }

  private constructor() {
    let userDataPath: string;
    try {
      userDataPath = app.getPath('userData');
    } catch {
      // Electron app not available (e.g. unit tests) — disable persistence
      userDataPath = '';
    }
    this.baseDir = userDataPath ? path.join(userDataPath, 'repo-jobs') : '';
    this.jobsDir = this.baseDir ? path.join(this.baseDir, 'jobs') : '';
    this.logsDir = this.baseDir ? path.join(this.baseDir, 'logs') : '';
    this.indexFile = this.baseDir ? path.join(this.baseDir, 'index.json') : '';
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Ensure storage directories exist. Call once at startup.
   */
  ensureReady(): void {
    if (this.initialized) return;
    if (!this.baseDir) {
      // No Electron userData available (tests, headless) — skip disk ops
      this.initialized = true;
      return;
    }
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      fs.mkdirSync(this.jobsDir, { recursive: true });
      fs.mkdirSync(this.logsDir, { recursive: true });
      this.initialized = true;
    } catch (error) {
      logger.warn('Failed to create repo-job storage directories', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load all persisted jobs into memory. Returns a Map keyed by job ID.
   */
  loadAll(): Map<string, RepoJobRecord> {
    this.ensureReady();
    const jobs = new Map<string, RepoJobRecord>();
    if (!this.baseDir) return jobs;

    const index = this.readIndex();
    if (!index) return jobs;

    for (const entry of index.jobs) {
      const job = this.readJobFile(entry.id);
      if (job) {
        jobs.set(job.id, job);
      }
    }

    logger.info('Loaded persisted repo jobs', { count: jobs.size });
    return jobs;
  }

  /**
   * Persist a single job (upsert). Updates both index and job file.
   */
  saveJob(job: RepoJobRecord): void {
    this.ensureReady();
    if (!this.baseDir) return;
    this.writeJobFile(job);
    this.upsertIndex(job);
  }

  /**
   * Persist multiple jobs efficiently (batch upsert).
   */
  saveAll(jobs: Iterable<RepoJobRecord>): void {
    this.ensureReady();
    if (!this.baseDir) return;
    const index = this.readIndex() ?? { version: INDEX_VERSION, jobs: [] };
    const indexMap = new Map(index.jobs.map((e) => [e.id, e]));

    for (const job of jobs) {
      this.writeJobFile(job);
      indexMap.set(job.id, this.toIndexEntry(job));
    }

    index.jobs = Array.from(indexMap.values())
      .sort((a, b) => b.createdAt - a.createdAt);

    this.writeIndex(index);
  }

  /**
   * Delete a job from both index and disk.
   */
  deleteJob(jobId: string): void {
    if (!this.baseDir) return;
    this.deleteJobFile(jobId);
    this.removeFromIndex(jobId);
  }

  /**
   * Prune old and excess jobs. Returns the number of jobs removed.
   *
   * Three strategies:
   *   1. Age-based: remove terminal jobs older than MAX_JOB_AGE_MS
   *   2. Count-based: keep only the newest MAX_JOBS entries
   *   3. Orphan cleanup: remove job files not in the index
   */
  /**
   * Prune old and excess jobs. Returns the IDs of removed jobs so callers
   * can sync their in-memory state.
   */
  prune(): string[] {
    this.ensureReady();
    if (!this.baseDir) return [];
    const index = this.readIndex();
    if (!index) return [];

    const now = Date.now();
    const cutoff = now - MAX_JOB_AGE_MS;
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
    const toRemove = new Set<string>();

    // 1. Age-based pruning (only terminal jobs)
    for (const entry of index.jobs) {
      if (terminalStatuses.has(entry.status) && entry.createdAt < cutoff) {
        toRemove.add(entry.id);
      }
    }

    // 2. Count-based pruning (keep newest MAX_JOBS after age removal)
    const remaining = index.jobs
      .filter((e) => !toRemove.has(e.id))
      .sort((a, b) => b.createdAt - a.createdAt);

    if (remaining.length > MAX_JOBS) {
      for (const entry of remaining.slice(MAX_JOBS)) {
        // Only prune terminal jobs to avoid killing active work
        if (terminalStatuses.has(entry.status)) {
          toRemove.add(entry.id);
        }
      }
    }

    // 3. Delete files + update index
    for (const id of toRemove) {
      this.deleteJobFile(id);
    }

    const prunedIndex: JobIndex = {
      version: INDEX_VERSION,
      jobs: index.jobs.filter((e) => !toRemove.has(e.id)),
    };
    this.writeIndex(prunedIndex);

    // 4. Orphan cleanup — job files not in the index.
    // Guard against TOCTOU race: skip files modified in the last 5 minutes,
    // since a concurrent saveJob() writes the file before updating the index.
    const validIds = new Set(prunedIndex.jobs.map((e) => e.id));
    const recentCutoff = now - 5 * 60 * 1000;
    let orphansRemoved = 0;
    try {
      const files = fs.readdirSync(this.jobsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        if (!validIds.has(id)) {
          try {
            const filePath = path.join(this.jobsDir, file);
            const stat = fs.statSync(filePath);
            // Skip recently-modified files to avoid deleting in-flight jobs
            if (stat.mtimeMs > recentCutoff) continue;
            fs.unlinkSync(filePath);
            orphansRemoved++;
          } catch { /* ignore */ }
        }
      }
    } catch { /* jobsDir may not exist yet */ }

    const total = toRemove.size + orphansRemoved;
    if (total > 0) {
      logger.info('Pruned repo jobs', {
        aged: toRemove.size,
        orphans: orphansRemoved,
        remaining: prunedIndex.jobs.length,
      });
    }
    return Array.from(toRemove);
  }

  /**
   * Append a timestamped log entry for a job (append-only).
   */
  appendLog(jobId: string, message: string): void {
    if (!this.baseDir) return;
    try {
      const logFile = path.join(this.logsDir, `${jobId}.log`);
      const entry = `[${new Date().toISOString()}] ${message}\n`;
      fs.appendFileSync(logFile, entry, 'utf-8');
    } catch { /* best-effort */ }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private readIndex(): JobIndex | null {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf-8');
      return JSON.parse(raw) as JobIndex;
    } catch {
      return null;
    }
  }

  private writeIndex(index: JobIndex): void {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('Failed to write repo-job index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readJobFile(jobId: string): RepoJobRecord | null {
    try {
      const filePath = path.join(this.jobsDir, `${jobId}.json`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as RepoJobRecord;
    } catch {
      return null;
    }
  }

  private writeJobFile(job: RepoJobRecord): void {
    try {
      const filePath = path.join(this.jobsDir, `${job.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(job, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('Failed to write repo-job file', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private deleteJobFile(jobId: string): void {
    try {
      fs.unlinkSync(path.join(this.jobsDir, `${jobId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to delete repo-job file', { jobId });
      }
    }
    // Also clean up log file
    try {
      fs.unlinkSync(path.join(this.logsDir, `${jobId}.log`));
    } catch { /* ignore */ }
  }

  private toIndexEntry(job: RepoJobRecord): JobIndexEntry {
    return {
      id: job.id,
      status: job.status,
      type: job.type,
      name: job.name,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  private upsertIndex(job: RepoJobRecord): void {
    const index = this.readIndex() ?? { version: INDEX_VERSION, jobs: [] };
    const entry = this.toIndexEntry(job);
    const existing = index.jobs.findIndex((e) => e.id === job.id);
    if (existing >= 0) {
      index.jobs[existing] = entry;
    } else {
      index.jobs.unshift(entry);
    }
    this.writeIndex(index);
  }

  private removeFromIndex(jobId: string): void {
    const index = this.readIndex();
    if (!index) return;
    index.jobs = index.jobs.filter((e) => e.id !== jobId);
    this.writeIndex(index);
  }
}

export function getRepoJobStore(): RepoJobStore {
  return RepoJobStore.getInstance();
}
