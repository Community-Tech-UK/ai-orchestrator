/**
 * "Where your usage went": the main-process service behind the card.
 *
 * It joins three read-only sources into one dataset of the last 7 days of Claude
 * requests, then hands that to the shared calculator:
 *
 *   1. Claude's own transcripts: one record per request (sizes, times, helpers).
 *   2. The cost log in the RLM database: which Harness session a transcript is.
 *   3. The daily cost-attribution logs: helper parentage and the effort setting.
 *
 * Reading the transcripts can take a while on a big machine, so the work runs in
 * the background and callers get an honest status back straight away:
 * `scanning` (with progress) until the first dataset exists, then `ready`. A later
 * refresh keeps serving the previous dataset and says it is `refreshing`.
 */

import { getLogger } from '../logging/logger';
import { USAGE_WINDOW_MS } from '../../shared/usage-insight/usage-cause-rules';
import { calculateUsageCauses } from '../../shared/usage-insight/usage-cause-calculator';
import type {
  UsageInsightNote,
  UsageInsightReport,
  UsageInsightRequest,
  UsageInsightResponse,
  UsageRequestFact,
  UsageScanProgress,
  UsageSessionFact,
} from '../../shared/usage-insight/usage-insight.types';
import type { AttributionDigest, EffortPoint } from './usage-attribution-reader';
import type { TranscriptScan } from './claude-transcript-usage-scanner';

const logger = getLogger('UsageInsight');

const DEFAULT_REFRESH_AFTER_MS = 5 * 60 * 1000;
const MAX_PARENT_DEPTH = 12;

/** Claude session id -> the Harness sessions that ran it, oldest first. */
export type SessionLinks = Map<string, string[]>;

export interface SessionLinksResult {
  links: SessionLinks;
  /** The lookup could not run, so no session is linked. The report says so. */
  unavailable?: boolean;
}

export interface UsageInsightDeps {
  scanner: {
    refresh(onProgress?: (progress: UsageScanProgress) => void, signal?: AbortSignal): Promise<void>;
    collect(): TranscriptScan;
  };
  attribution: { read(sinceMs: number): Promise<AttributionDigest> };
  loadSessionLinks(sinceMs: number): Promise<SessionLinksResult>;
  /** `remote` is true for a session running on another computer, whose transcripts are kept there. */
  resolveInstance(instanceId: string): { provider: string; sessionId?: string; remote?: boolean } | undefined;
  now?: () => number;
  refreshAfterMs?: number;
}

export interface UsageDataset {
  generatedAt: number;
  requests: UsageRequestFact[];
  sessions: Map<string, UsageSessionFact>;
  /** Harness session id -> the Claude sessions it has run. */
  instanceSessions: Map<string, Set<string>>;
  notes: UsageInsightNote[];
}

/** After a failed read, wait this long before trying again on its own. */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

export class UsageInsightService {
  private dataset: UsageDataset | null = null;
  private running: Promise<void> | null = null;
  private progress: UsageScanProgress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  private lastError: string | null = null;
  private failedAt = 0;
  private readonly reports = new Map<string, UsageInsightReport>();
  private readonly abort = new AbortController();

  constructor(private readonly deps: UsageInsightDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Answers straight away with whatever is known, and starts a refresh when one is due. */
  getResponse(request: UsageInsightRequest): UsageInsightResponse {
    let scopeInstance: { instanceId: string; sessionId?: string } | null = null;
    if (request.instanceId) {
      const instance = this.deps.resolveInstance(request.instanceId);
      if (!instance) return { status: 'unsupported', reason: 'unknown-instance' };
      if (instance.provider !== 'claude') return { status: 'unsupported', reason: 'not-claude' };
      if (instance.remote === true) return { status: 'unsupported', reason: 'remote' };
      scopeInstance = { instanceId: request.instanceId, sessionId: instance.sessionId };
    }

    this.ensureFresh(request.refresh === true);

    const dataset = this.dataset;
    if (dataset) {
      return {
        status: 'ready',
        report: this.reportFor(dataset, scopeInstance),
        refreshing: this.running !== null,
        ...(this.running === null && this.lastError ? { refreshError: this.lastError } : {}),
      };
    }
    if (this.running === null && this.lastError) return { status: 'error', message: this.lastError };
    return { status: 'scanning', progress: { ...this.progress } };
  }

  /** Stops any read in progress. The next request starts again from the saved positions. */
  dispose(): void {
    this.abort.abort();
  }

  private ensureFresh(force: boolean): void {
    if (this.running || this.abort.signal.aborted) return;
    const refreshAfter = this.deps.refreshAfterMs ?? DEFAULT_REFRESH_AFTER_MS;
    const stale = !this.dataset || this.now() - this.dataset.generatedAt > refreshAfter;
    const mayRetry = this.lastError === null || this.now() - this.failedAt > RETRY_AFTER_FAILURE_MS;
    if (!force && !(stale && mayRetry)) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  private async run(): Promise<void> {
    const startedAt = Date.now();
    try {
      const sinceMs = this.now() - USAGE_WINDOW_MS;
      await this.deps.scanner.refresh((progress) => {
        this.progress = progress;
      }, this.abort.signal);
      const [attribution, linkResult] = await Promise.all([
        this.deps.attribution.read(sinceMs),
        this.deps.loadSessionLinks(sinceMs),
      ]);
      const scan = this.deps.scanner.collect();
      this.dataset = buildDataset(scan, attribution, linkResult.links, this.now(), {
        linksUnavailable: linkResult.unavailable === true,
      });
      this.reports.clear();
      this.lastError = null;
      logger.info('Usage insight dataset built', {
        requests: this.dataset.requests.length,
        sessions: this.dataset.sessions.size,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.failedAt = this.now();
      logger.warn('Usage insight scan failed', { error: this.lastError });
    }
  }

  private reportFor(dataset: UsageDataset, scope: { instanceId: string; sessionId?: string } | null): UsageInsightReport {
    const key = scope ? `session:${scope.instanceId}:${scope.sessionId ?? ''}` : 'all';
    const cached = this.reports.get(key);
    if (cached) return cached;

    let report: UsageInsightReport;
    if (scope) {
      const sessionIds = new Set(dataset.instanceSessions.get(scope.instanceId) ?? []);
      if (scope.sessionId) sessionIds.add(scope.sessionId);
      report = calculateUsageCauses({
        requests: dataset.requests,
        sessions: dataset.sessions,
        now: dataset.generatedAt,
        scope: { kind: 'session', instanceId: scope.instanceId },
        scopeSessionIds: sessionIds,
        notes: dataset.notes,
      });
    } else {
      report = calculateUsageCauses({
        requests: dataset.requests,
        sessions: dataset.sessions,
        now: dataset.generatedAt,
        scope: { kind: 'all' },
        notes: dataset.notes,
      });
    }
    this.reports.set(key, report);
    return report;
  }
}

function rootOf(instanceId: string, parents: ReadonlyMap<string, string>): string {
  let current = instanceId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parent = parents.get(current);
    if (!parent || parent === current) return current;
    current = parent;
  }
  return current;
}

function mergeEfforts(instanceIds: readonly string[], efforts: ReadonlyMap<string, EffortPoint[]>): EffortPoint[] {
  const lists = instanceIds.map((id) => efforts.get(id)).filter((list): list is EffortPoint[] => list !== undefined);
  if (lists.length === 0) return [];
  return lists.length === 1 ? lists[0] : lists.flat().sort((a, b) => a.at - b.at);
}

/** Joins the three sources. Exported so the join can be tested without files. */
export function buildDataset(
  scan: TranscriptScan,
  attribution: AttributionDigest,
  links: SessionLinks,
  generatedAt: number,
  options: { linksUnavailable?: boolean } = {},
): UsageDataset {
  // Session ids named by recent turns in the cost-attribution log win over older cost-log rows.
  const instancesBySession = new Map<string, string[]>();
  for (const [sessionId, instanceIds] of links) instancesBySession.set(sessionId, [...instanceIds]);
  for (const [sessionId, instanceId] of attribution.sessionToInstance) {
    const list = instancesBySession.get(sessionId) ?? [];
    if (!list.includes(instanceId)) list.push(instanceId);
    instancesBySession.set(sessionId, list);
  }

  const sessionIds = new Set<string>(scan.sessionStarts.keys());
  for (const request of scan.requests) sessionIds.add(request.sessionId);

  const sessions = new Map<string, UsageSessionFact>();
  const instanceSessions = new Map<string, Set<string>>();
  for (const sessionId of sessionIds) {
    const instanceIds = instancesBySession.get(sessionId) ?? [];
    const primary = instanceIds[instanceIds.length - 1];
    const startPromptTokens = scan.sessionStarts.get(sessionId);
    sessions.set(sessionId, {
      sessionId,
      ...(startPromptTokens !== undefined ? { startPromptTokens } : {}),
      ...(primary ? { instanceId: primary } : {}),
      groupKey: primary ? `harness:${rootOf(primary, attribution.parentByInstance)}` : sessionId,
      isHelperSession: primary !== undefined && attribution.parentByInstance.has(primary),
      efforts: mergeEfforts(instanceIds, attribution.effortByInstance),
    });
    for (const instanceId of instanceIds) {
      const set = instanceSessions.get(instanceId) ?? new Set<string>();
      set.add(sessionId);
      instanceSessions.set(instanceId, set);
    }
  }

  // Anything that was not readable is reported, so a thin result is never mistaken for a full one.
  const notes: UsageInsightNote[] = [...scan.notes];
  if (attribution.unreadableFiles > 0) notes.push({ code: 'cost-log-unreadable', count: attribution.unreadableFiles });
  if (options.linksUnavailable) notes.push({ code: 'session-links-unavailable' });

  return { generatedAt, requests: scan.requests, sessions, instanceSessions, notes };
}
