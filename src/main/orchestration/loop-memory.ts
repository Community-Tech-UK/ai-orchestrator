/**
 * LF-6 (loopfixex.md) — cross-loop memory.
 *
 * Every loop otherwise starts cold and re-discovers the same dead-ends.
 * Anthropic's third pillar (agentic memory) + Huntley's "capture the why" call
 * for persistent, retrievable learnings. On a loop's terminal/CRITICAL the
 * coordinator distills a learning record (failure modes, dead-ends, winning
 * approach), keyed by workspace; on the next run it surfaces the top-K relevant
 * learnings into the prompt — token-bounded and labelled "prior observations
 * (not binding)" so they inform without dictating.
 *
 * The store is behind a DI seam (`LoopMemoryStore`). Two implementations:
 *  - `InMemoryLoopMemoryStore` — process-scoped default (within-session only).
 *  - `DurableLoopMemoryStore` — JSON-file-backed under userData (survives app
 *    restart) and best-effort mirrors to the EpisodicStore so loop learnings
 *    join the app's memory subsystem. The host wires this via
 *    `LoopCoordinator.setLoopMemoryStore(...)`, passing the storage path (so
 *    this module never imports electron).
 * Both key by `normalizeProjectMemoryKey` and satisfy "a dead-end recorded in
 * run 1 is surfaced in run 2".
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { normalizeProjectMemoryKey } from '../memory/project-memory-key';
import { redactForEgress } from '../security/content-egress-gate';

const logger = getLogger('LoopMemory');

export interface LoopLearningRecord {
  /** Raw workspace path; normalized to a stable key by the store. */
  workspaceCwd: string;
  /** The loop's goal (initial prompt). */
  goal: string;
  /** Terminal status or 'critical' for an in-run dead-end. */
  status: string;
  /** Terminal timestamp when known; distinguishes resumable vs ended provider-limit. */
  endedAt?: number | null;
  /** End reason / convergence note — the "why". */
  reason: string;
  /** Specific observations: dead-ends, deferred items, winning approach. */
  observations: string[];
  /** Stamp (ms). Optional; the store fills it if absent. */
  createdAt?: number;
}

export interface LoopMemoryStore {
  recordLearning(record: LoopLearningRecord): void | Promise<void>;
  /** Return up to `limit` rendered prior-observation lines for the workspace, newest first. */
  surfaceLearnings(workspaceCwd: string, limit: number): string[] | Promise<string[]>;
}

/**
 * Loop learnings are durable memory and may later be surfaced to a model. Keep
 * the stored record safe at the write boundary rather than trusting every
 * caller to pre-sanitize goals, reasons, and observations.
 */
function redactLearningForStorage(record: LoopLearningRecord): LoopLearningRecord {
  return {
    ...record,
    goal: redactForEgress(record.goal, { kind: 'memory' }).content,
    reason: redactForEgress(record.reason, { kind: 'memory' }).content,
    observations: record.observations.map((observation) =>
      redactForEgress(observation, { kind: 'memory' }).content),
  };
}

/** Max characters for a single rendered observation line (bounds prompt cost). */
const MAX_LINE_CHARS = 300;

/**
 * Render a learning record into a single, bounded prompt line. Pure.
 */
export function renderLearningLine(record: LoopLearningRecord): string {
  const obs = record.observations.filter((o) => o.trim()).slice(0, 4).join('; ');
  const line = `[${record.status}] goal "${truncate(record.goal, 80)}" — ${truncate(record.reason, 120)}` +
    (obs ? ` · ${obs}` : '');
  return truncate(line, MAX_LINE_CHARS);
}

/**
 * Distill a loop's end/CRITICAL state into a learning record. Pure — the caller
 * supplies the loop facts so this doesn't depend on LoopState's full shape.
 */
export function distillLearning(input: {
  workspaceCwd: string;
  goal: string;
  status: string;
  endedAt?: number | null;
  reason: string;
  lastCompletionOutcome?: string;
  deferredItems?: string[];
  deadEnds?: string[];
}): LoopLearningRecord {
  const observations: string[] = [];
  if (input.lastCompletionOutcome) observations.push(`last completion outcome: ${input.lastCompletionOutcome}`);
  for (const d of input.deadEnds ?? []) observations.push(`dead-end: ${d}`);
  for (const d of input.deferredItems ?? []) observations.push(`deferred: ${d}`);
  const record: LoopLearningRecord = {
    workspaceCwd: input.workspaceCwd,
    goal: input.goal,
    status: input.status,
    reason: input.reason,
    observations,
  };
  if (input.endedAt !== undefined) record.endedAt = input.endedAt;
  return record;
}

function truncate(value: string, max: number): string {
  const v = (value ?? '').trim();
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}

/**
 * Default process-scoped in-memory store. Keyed by normalized project key so
 * sibling/nested paths in the same project share learnings. Bounded to the most
 * recent N records per key.
 */
export class InMemoryLoopMemoryStore implements LoopMemoryStore {
  private readonly byKey = new Map<string, LoopLearningRecord[]>();
  private readonly maxPerKey = 20;

  recordLearning(record: LoopLearningRecord): void {
    const safeRecord = redactLearningForStorage(record);
    const key = normalizeProjectMemoryKey(safeRecord.workspaceCwd);
    if (!key) return;
    const list = this.byKey.get(key) ?? [];
    list.push({ ...safeRecord, createdAt: safeRecord.createdAt ?? Date.now() });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.byKey.set(key, list);
  }

  surfaceLearnings(workspaceCwd: string, limit: number): string[] {
    const key = normalizeProjectMemoryKey(workspaceCwd);
    if (!key) return [];
    const list = this.byKey.get(key) ?? [];
    return list.slice(-Math.max(0, limit)).reverse().map(renderLearningLine);
  }

  /** Test helper — clears all recorded learnings. */
  _resetForTesting(): void {
    this.byKey.clear();
  }
}

/** The default singleton store the coordinator uses unless a host overrides it. */
export const defaultLoopMemoryStore = new InMemoryLoopMemoryStore();

/** Map a loop terminal status to the EpisodicStore's coarse outcome. */
export function loopStatusToOutcome(
  status: string,
  endedAt?: number | null,
): 'success' | 'partial' | 'failure' {
  if (status === 'completed') return 'success';
  if (status === 'provider-limit' && endedAt != null) return 'failure';
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'cost-exceeded' ||
    status === 'needs-human-arbitration' ||
    status === 'reviewer-unreliable' ||
    status === 'reviewer-unavailable' ||
    status === 'builder-unreliable'
  ) return 'failure';
  return 'partial'; // completed-needs-review, no-progress, cap-reached, resumable provider-limit
}

interface DurableLearningsFile {
  version: 1;
  byKey: Record<string, LoopLearningRecord[]>;
}

/**
 * LF-6 — durable, file-backed cross-loop memory. Persists learnings as JSON
 * (atomic temp-file + rename) under a host-provided path, so they survive app
 * restarts, and best-effort mirrors each learning into the EpisodicStore so it
 * participates in the app's memory subsystem. The storage path is injected by
 * the host (which knows `app.getPath('userData')`) — this module never imports
 * electron, keeping it worker/test-safe.
 */
export class DurableLoopMemoryStore implements LoopMemoryStore {
  private readonly maxPerKey: number;
  private readonly mirrorToEpisodic: boolean;

  constructor(
    private readonly filePath: string,
    opts: { maxPerKey?: number; mirrorToEpisodic?: boolean } = {},
  ) {
    this.maxPerKey = opts.maxPerKey ?? 20;
    this.mirrorToEpisodic = opts.mirrorToEpisodic ?? true;
  }

  recordLearning(record: LoopLearningRecord): void {
    const safeRecord = redactLearningForStorage(record);
    const key = normalizeProjectMemoryKey(safeRecord.workspaceCwd);
    if (!key) return;
    const stamped: LoopLearningRecord = { ...safeRecord, createdAt: safeRecord.createdAt ?? Date.now() };
    // Synchronous read-modify-write: there is no `await` between `read()` and
    // `write()`, so the whole sequence runs to completion within one tick of
    // Node's single-threaded event loop — two `recordLearning` calls can't
    // interleave, and there is only one main process. So this is atomic without
    // an explicit lock (the deliberate reason for sync fs here).
    const data = this.read();
    const list = data.byKey[key] ?? [];
    list.push(stamped);
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    data.byKey[key] = list;
    this.write(data);
    if (this.mirrorToEpisodic) this.mirror(stamped);
  }

  surfaceLearnings(workspaceCwd: string, limit: number): string[] {
    const key = normalizeProjectMemoryKey(workspaceCwd);
    if (!key) return [];
    const list = this.read().byKey[key] ?? [];
    return list.slice(-Math.max(0, limit)).reverse().map(renderLearningLine);
  }

  private read(): DurableLearningsFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DurableLearningsFile>;
      if (parsed && typeof parsed === 'object' && parsed.byKey && typeof parsed.byKey === 'object') {
        return { version: 1, byKey: parsed.byKey as Record<string, LoopLearningRecord[]> };
      }
    } catch {
      // missing / corrupt file → start fresh (never throw into the loop)
    }
    return { version: 1, byKey: {} };
  }

  private write(data: DurableLearningsFile): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, this.filePath); // atomic replace
    } catch (err) {
      logger.warn('DurableLoopMemoryStore: failed to persist learnings', {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Best-effort: mirror a learning into the EpisodicStore (memory subsystem). */
  private mirror(record: LoopLearningRecord): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getEpisodicStore } = require('../memory/episodic-store') as typeof import('../memory/episodic-store');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { randomUUID } = require('crypto') as typeof import('crypto');
      getEpisodicStore().addSession({
        sessionId: `loop:${normalizeProjectMemoryKey(record.workspaceCwd)}:${record.createdAt ?? 0}:${randomUUID().slice(0, 8)}`,
        summary: `Loop ${record.status}: ${record.goal} — ${record.reason}`,
        keyEvents: record.observations.slice(0, 8),
        outcome: loopStatusToOutcome(record.status, record.endedAt),
        lessonsLearned: record.observations.slice(0, 8),
        timestamp: record.createdAt ?? Date.now(),
      });
    } catch {
      // EpisodicStore unavailable / shape mismatch — durable file is the source of truth.
    }
  }
}
