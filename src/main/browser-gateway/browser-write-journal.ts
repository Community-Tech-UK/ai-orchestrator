/**
 * Durable write journal for shared existing-tab mutations (reliability
 * hardening, 2026-07-17).
 *
 * Every app-state mutation records an intent entry, then its outcome and the
 * post-write persistence-sentinel verdict. After a channel blip an
 * interrupted multi-step flow can report exactly which writes fired AND
 * verified (`browser.write_journal`) instead of being half-applied guesswork.
 *
 * Privacy: entries NEVER contain field values or value digests — a digest of
 * a typed secret would be offline-crackable material, and the credential/
 * secret fill paths route through the same extension `type` command. Only
 * the command, target descriptor (selector/uid), field count, and value
 * LENGTH are recorded. Journal I/O is queued and fire-and-forget: it can
 * never fail or slow a mutation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getProjectStoragePaths } from '../storage/project-storage-paths';
import { getLogger } from '../logging/logger';
import type { BrowserTargetPersistenceScan } from './browser-target-persistence-sentinel';

const logger = getLogger('BrowserWriteJournal');

export type BrowserWriteOutcome = 'pending' | 'succeeded' | 'failed' | 'maybe_applied';

export type BrowserWritePersistence =
  | 'ok'
  | 'save_failed'
  | 'session_stale'
  | 'unverified';

export interface BrowserWriteJournalEntry {
  seq: number;
  at: number;
  command: string;
  selector?: string;
  uid?: string;
  /** Number of fields for fill_form. */
  fieldCount?: number;
  /**
   * Approximate length of the written value, rounded UP to a multiple of 8
   * (never the value itself; exact lengths stay off disk because the
   * credential/secret fill paths ride the same extension `type` command).
   */
  approxValueLength?: number;
  outcome: BrowserWriteOutcome;
  persistence: BrowserWritePersistence;
  /** Built-in sentinel pattern that flagged the failure (never page text). */
  matchedPattern?: string;
  /** Error reason code when the outcome is failed/maybe_applied. */
  reason?: string;
}

interface BrowserWriteJournalFile {
  profileId: string;
  targetId: string;
  updatedAt: number;
  nextSeq: number;
  entries: BrowserWriteJournalEntry[];
}

const MAX_ENTRIES = 200;
const MAX_SELECTOR_LENGTH = 300;
const MAX_REASON_LENGTH = 300;

export interface BrowserWriteJournalOptions {
  rootDir?: string;
  now?: () => number;
}

export class BrowserWriteJournal {
  private static instance: BrowserWriteJournal | null = null;
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly journals = new Map<string, BrowserWriteJournalFile>();
  private readonly loads = new Map<string, Promise<void>>();
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(options: BrowserWriteJournalOptions = {}) {
    this.rootDir = options.rootDir ?? defaultJournalRoot();
    this.now = options.now ?? Date.now;
  }

  static getInstance(): BrowserWriteJournal {
    if (!this.instance) {
      this.instance = new BrowserWriteJournal();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Record an intended mutation before dispatch. Returns the entry seq used
   * to record the outcome later.
   */
  async recordIntent(params: {
    profileId: string;
    targetId: string;
    command: string;
    payload?: Record<string, unknown>;
  }): Promise<number> {
    const journal = await this.load(params.profileId, params.targetId);
    const seq = journal.nextSeq;
    journal.nextSeq += 1;
    journal.entries.push({
      seq,
      at: this.now(),
      command: params.command,
      ...describeWritePayload(params.command, params.payload),
      outcome: 'pending',
      persistence: 'unverified',
    });
    if (journal.entries.length > MAX_ENTRIES) {
      journal.entries.splice(0, journal.entries.length - MAX_ENTRIES);
    }
    journal.updatedAt = this.now();
    this.scheduleFlush(params.profileId, params.targetId);
    return seq;
  }

  /** Record how a previously recorded intent turned out. Fire-and-forget safe. */
  async recordOutcome(params: {
    profileId: string;
    targetId: string;
    seq: number;
    outcome: Exclude<BrowserWriteOutcome, 'pending'>;
    scan?: BrowserTargetPersistenceScan;
    reason?: string;
  }): Promise<void> {
    const journal = await this.load(params.profileId, params.targetId);
    const entry = journal.entries.find((candidate) => candidate.seq === params.seq);
    if (!entry) {
      return;
    }
    entry.outcome = params.outcome;
    if (params.scan) {
      entry.persistence = params.scan.state === 'unknown' ? 'unverified' : params.scan.state;
      if (params.scan.matchedPattern) {
        entry.matchedPattern = params.scan.matchedPattern;
      }
    }
    if (params.reason) {
      entry.reason = params.reason.slice(0, MAX_REASON_LENGTH);
    }
    journal.updatedAt = this.now();
    this.scheduleFlush(params.profileId, params.targetId);
  }

  async list(
    profileId: string,
    targetId: string,
    limit = 50,
  ): Promise<BrowserWriteJournalEntry[]> {
    const journal = await this.load(profileId, targetId);
    const bounded = Math.max(1, Math.min(limit, MAX_ENTRIES));
    return journal.entries.slice(-bounded);
  }

  /** Wait for queued journal writes to hit disk (tests + shutdown). */
  async flushPending(): Promise<void> {
    await this.flushQueue;
  }

  private async load(profileId: string, targetId: string): Promise<BrowserWriteJournalFile> {
    const key = journalKey(profileId, targetId);
    const cached = this.journals.get(key);
    if (cached) {
      return cached;
    }
    let loading = this.loads.get(key);
    if (!loading) {
      loading = this.loadFromDisk(profileId, targetId);
      this.loads.set(key, loading);
    }
    await loading;
    this.loads.delete(key);
    return this.journals.get(key)!;
  }

  private async loadFromDisk(profileId: string, targetId: string): Promise<void> {
    const key = journalKey(profileId, targetId);
    if (this.journals.has(key)) {
      return;
    }
    let journal: BrowserWriteJournalFile = {
      profileId,
      targetId,
      updatedAt: this.now(),
      nextSeq: 1,
      entries: [],
    };
    try {
      const raw = await fs.readFile(this.pathFor(profileId, targetId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<BrowserWriteJournalFile>;
      if (
        parsed
        && parsed.profileId === profileId
        && parsed.targetId === targetId
        && Array.isArray(parsed.entries)
        && typeof parsed.nextSeq === 'number'
      ) {
        journal = {
          profileId,
          targetId,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : this.now(),
          nextSeq: parsed.nextSeq,
          entries: parsed.entries.slice(-MAX_ENTRIES),
        };
      }
    } catch {
      // Missing or corrupt journal → start fresh; the journal is telemetry,
      // not a source of truth for the page.
    }
    this.journals.set(key, journal);
  }

  private scheduleFlush(profileId: string, targetId: string): void {
    this.flushQueue = this.flushQueue
      .then(() => this.flushToDisk(profileId, targetId))
      .catch((error) => {
        logger.warn('Browser write-journal flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async flushToDisk(profileId: string, targetId: string): Promise<void> {
    const journal = this.journals.get(journalKey(profileId, targetId));
    if (!journal) {
      return;
    }
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const filePath = this.pathFor(profileId, targetId);
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(journal)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  }

  private pathFor(profileId: string, targetId: string): string {
    return path.join(this.rootDir, `${safeJournalId(profileId, targetId)}.json`);
  }
}

function journalKey(profileId: string, targetId: string): string {
  return `${profileId}\0${targetId}`;
}

function safeJournalId(profileId: string, targetId: string): string {
  const readable = `${profileId}-${targetId}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'target';
  const digest = createHash('sha256')
    .update(journalKey(profileId, targetId))
    .digest('hex')
    .slice(0, 24);
  return `${readable}-${digest}`;
}

/** Redaction-safe descriptor of a write payload: NO values, NO digests. */
function describeWritePayload(
  command: string,
  payload: Record<string, unknown> | undefined,
): Pick<BrowserWriteJournalEntry, 'selector' | 'uid' | 'fieldCount' | 'approxValueLength'> {
  if (!payload) {
    return {};
  }
  const selector = payload['selector'];
  const uid = payload['uid'];
  const value = payload['value'];
  const fields = payload['fields'];
  return {
    ...(typeof selector === 'string'
      ? { selector: selector.slice(0, MAX_SELECTOR_LENGTH) }
      : {}),
    ...(typeof uid === 'string' ? { uid: uid.slice(0, MAX_SELECTOR_LENGTH) } : {}),
    ...(Array.isArray(fields) ? { fieldCount: fields.length } : {}),
    ...(typeof value === 'string' && command !== 'evaluate'
      ? { approxValueLength: Math.ceil(value.length / 8) * 8 }
      : {}),
  };
}

function defaultJournalRoot(): string {
  return getProjectStoragePaths().getGlobalDomainRoot('browser-write-journal');
}

export function getBrowserWriteJournal(): BrowserWriteJournal {
  return BrowserWriteJournal.getInstance();
}
