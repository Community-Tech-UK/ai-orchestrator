/**
 * WS16 — recall traces: what each retrieval surface returned, and which of
 * those items were later USED. Traces answer "which memory influenced which
 * run" and feed the harness's local suite as weak labels.
 *
 * In-memory + bounded (no schema migration): the app already persists the
 * durable stores themselves; traces are an observability ring for the current
 * session, queryable by the eval CLI's local suite. `queryHash` (not the raw
 * query) is the default key so traces never leak query text into telemetry,
 * while `rawQuery`/`sanitizedQuery` are retained locally for offline
 * sanitizer analysis.
 */

export type RetrievalSurface = 'rlm' | 'codemem' | 'lessons';

export interface RecallTrace {
  id: string;
  surface: RetrievalSurface;
  queryHash: string;
  rawQuery?: string;
  sanitizedQuery?: string;
  /** Returned item ids with scores, in rank order. */
  returned: Array<{ id: string; score: number }>;
  usedIds: string[];
  ts: number;
}

/** djb2 — deterministic, dependency-free query hashing. */
export function hashQuery(query: string): string {
  let h = 5381;
  for (let i = 0; i < query.length; i++) {
    h = ((h << 5) + h + query.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

const DEFAULT_MAX_TRACES = 2_000;

export interface RecordTraceInput {
  surface: RetrievalSurface;
  query: string;
  returned: Array<{ id: string; score: number }>;
  rawQuery?: string;
  sanitizedQuery?: string;
  now?: number;
  /** Deterministic id supplier (avoids RNG in worker/test contexts). */
  idFor?: (seq: number) => string;
}

export class RecallTraceStore {
  private readonly traces: RecallTrace[] = [];
  private seq = 0;

  constructor(private readonly maxTraces = DEFAULT_MAX_TRACES) {}

  record(input: RecordTraceInput): RecallTrace {
    const seq = ++this.seq;
    const id = input.idFor ? input.idFor(seq) : `trace-${seq}`;
    const trace: RecallTrace = {
      id,
      surface: input.surface,
      queryHash: hashQuery(input.query),
      ...(input.rawQuery !== undefined ? { rawQuery: input.rawQuery } : {}),
      ...(input.sanitizedQuery !== undefined ? { sanitizedQuery: input.sanitizedQuery } : {}),
      returned: input.returned,
      usedIds: [],
      ts: input.now ?? Date.now(),
    };
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.splice(0, this.traces.length - this.maxTraces);
    }
    return trace;
  }

  /**
   * Mark items as used. Matches the MOST RECENT trace on the surface that both
   * returned the id and has not already recorded it as used, so a later
   * reference credits the retrieval that surfaced it. Returns the ids that
   * matched a trace (newly credited).
   */
  markUsed(surface: RetrievalSurface, usedIds: readonly string[]): string[] {
    const credited: string[] = [];
    for (const usedId of usedIds) {
      for (let i = this.traces.length - 1; i >= 0; i--) {
        const trace = this.traces[i];
        if (trace.surface !== surface) continue;
        if (!trace.returned.some((r) => r.id === usedId)) continue;
        if (trace.usedIds.includes(usedId)) continue;
        trace.usedIds.push(usedId);
        credited.push(usedId);
        break;
      }
    }
    return credited;
  }

  all(): readonly RecallTrace[] {
    return this.traces;
  }

  bySurface(surface: RetrievalSurface): RecallTrace[] {
    return this.traces.filter((t) => t.surface === surface);
  }

  clear(): void {
    this.traces.length = 0;
    this.seq = 0;
  }
}

let singleton: RecallTraceStore | null = null;

export function getRecallTraceStore(): RecallTraceStore {
  if (!singleton) singleton = new RecallTraceStore();
  return singleton;
}

export function _resetRecallTraceStoreForTesting(): void {
  singleton = null;
}
