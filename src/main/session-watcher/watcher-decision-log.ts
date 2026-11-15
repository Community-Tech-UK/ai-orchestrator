import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../logging/logger';
import type { WatcherOverride } from './watcher-post-checks';
import type { WatcherBasis, WatcherStop, WatcherVerdictError, WatcherVerdictKind } from './watcher-verdict';

const logger = getLogger('SessionWatcherLog');
const KEEP_DAYS = 60;
let lastDay = '';
let warned = false;

/** What became of one stop. `sent`, `needs_you` and `not_sent` are the outcomes the notice senders wait for. */
export type WatcherOutcome = 'sent' | 'needs_you' | 'not_sent';

/** One line per stop. Holds no conversation text: enums, counts, timings and a hashed session id only. */
export interface WatcherStopRecord {
  event: 'stop';
  session: string;
  requestCount: number;
  provider: string;
  /** Why the stop was not judged; absent when it was. */
  skipped?: string;
  judge?: { provider: string; model: string; latencyMs: number; qualified: boolean };
  /** Why the judge gave no usable verdict; absent when it did. A fixed code, never the judge's or an error's text. */
  unreliable?: WatcherVerdictError | 'call-failed' | 'timeout';
  verdict?: WatcherVerdictKind;
  stop?: WatcherStop;
  verdictBasis?: WatcherBasis;
  action?: WatcherVerdictKind;
  basis?: WatcherBasis;
  override?: WatcherOverride;
  outcome: WatcherOutcome;
  /** Why a decided reply or flag did not happen (dispatch refused, new input, deadline). */
  outcomeReason?: string;
}

/** A later line saying what happened after a stop, so both error rates can be counted without hand labelling. */
export interface WatcherFollowUpRecord {
  event: 'follow-up';
  session: string;
  requestCount: number;
  kind: 'person-message' | 'yes-clicked' | 'stop-pressed' | 'muted' | 'carried-turn';
  /** For `person-message`: whether it was a bare go-ahead, and its length. Never its text. */
  bareGoAhead?: boolean;
  chars?: number;
  /** For `carried-turn`: tool calls in the turn a carry-on started, and how many look like an outward command. */
  tools?: number;
  outwardCommands?: number;
}

const GO_AHEAD = /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|please|continue|carry on|go ahead|go on|proceed|do it|do that|keep going|approved|go for it)[\s,.!]*)+$/i;

/** True when a typed message is nothing but a go-ahead ("continue", "yes please"). */
export function isBareGoAhead(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && GO_AHEAD.test(trimmed);
}

/**
 * Shell commands that leave the computer or cannot be undone. Used only to count, after the fact, how often a
 * carried-on turn ran one: a count of turns to look at, not proof either way.
 */
const OUTWARD_COMMAND = /\b(?:git\s+(?:push|commit)|gh\s+(?:pr|release|issue)\s+(?:create|merge|close|comment)|npm\s+publish|rm\s+-[a-z]*r[a-z]*f|vercel\b|netlify\s+deploy|firebase\s+deploy|kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy)|curl\b[^|;&]{0,200}\s-X\s*(?:POST|PUT|PATCH|DELETE)|rsync\b[^|;&]{0,200}\s[\w.-]+@[\w.-]+:|scp\b[^|;&]{0,200}\s[\w.-]+@[\w.-]+:)/i;

export function isOutwardCommand(command: string): boolean {
  return OUTWARD_COMMAND.test(command.slice(0, 4_000));
}

export type WatcherLogRecord = WatcherStopRecord | WatcherFollowUpRecord;

/** A stable, non-reversible stand-in for an instance id, so the log can be shared without naming sessions. */
export function hashSessionId(instanceId: string): string {
  return createHash('sha256').update(instanceId).digest('hex').slice(0, 16);
}

function logDirectory(): string | null {
  // Tests and headless tools point the log at a scratch directory, as AIO_SESSION_POLICY_DIR does.
  const explicit = process.env['AIO_SESSION_WATCHER_DIR']?.trim();
  if (explicit) return explicit;
  if (!process.versions.electron || (process as NodeJS.Process & { type?: string }).type !== 'browser') return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as { app: { getPath(name: string): string } };
  return join(app.getPath('userData'), 'session-watcher');
}

function prune(directory: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const file of readdirSync(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) || new Date(file.slice(0, 10)).getTime() >= cutoff) continue;
    // One undeletable old file must not stop the other prunes or today's append.
    try { unlinkSync(join(directory, file)); } catch { /* retried on the next day's prune */ }
  }
}

/** Main-process-only decision log. A write failure is logged once and never reaches the caller. */
export function recordWatcherDecision(record: WatcherLogRecord): void {
  try {
    const directory = logDirectory();
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    if (lastDay !== day) { lastDay = day; prune(directory); }
    appendFileSync(join(directory, `${day}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch (error) {
    if (!warned) { warned = true; logger.warn('Could not write the session watcher log', { error: String(error) }); }
  }
}

export function _resetWatcherDecisionLogForTesting(): void {
  lastDay = '';
  warned = false;
}
