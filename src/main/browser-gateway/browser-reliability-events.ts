/**
 * Structured reliability telemetry for the Browser Gateway (reliability
 * hardening, 2026-07-17): disconnects, reconnects, schema skew, rejected
 * writes, tool-surface diffs, and attachment lifecycle across reconnects.
 *
 * Main-process only. Events are kept in a bounded ring buffer (exposed through
 * `browser.health`) and mirrored as structured log lines. Detail values must
 * already be redaction-safe: origins not full URLs, pattern names not page
 * text, never cookies/tokens/secret values.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('BrowserReliability');

export type BrowserReliabilityEventKind =
  | 'node_disconnect'
  | 'node_reconnect'
  | 'schema_skew_stripped'
  | 'contract_mismatch'
  | 'tool_surface_restored'
  | 'tool_surface_diff'
  | 'write_rejected_save_failed'
  | 'write_rejected_session_stale'
  | 'attachment_suspended'
  | 'attachment_restored'
  | 'attachment_rebound';

export interface BrowserReliabilityEvent {
  at: number;
  kind: BrowserReliabilityEventKind;
  nodeId?: string;
  instanceId?: string;
  /** Redaction-safe context (method names, counts, origins, pattern ids). */
  detail?: Record<string, string | number | boolean | string[]>;
}

const MAX_EVENTS = 200;

export class BrowserReliabilityEvents {
  private static instance: BrowserReliabilityEvents | null = null;
  private readonly events: BrowserReliabilityEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  static getInstance(): BrowserReliabilityEvents {
    if (!this.instance) {
      this.instance = new BrowserReliabilityEvents();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  record(
    kind: BrowserReliabilityEventKind,
    context: Omit<BrowserReliabilityEvent, 'at' | 'kind'> = {},
  ): BrowserReliabilityEvent {
    const event: BrowserReliabilityEvent = { at: this.now(), kind, ...context };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    const logContext = {
      ...(event.nodeId ? { nodeId: event.nodeId } : {}),
      ...(event.instanceId ? { instanceId: event.instanceId } : {}),
      ...(event.detail ?? {}),
    };
    if (kind.startsWith('write_rejected') || kind === 'contract_mismatch') {
      logger.warn(`Browser reliability event: ${kind}`, logContext);
    } else {
      logger.info(`Browser reliability event: ${kind}`, logContext);
    }
    return event;
  }

  /** Most recent events, newest last. */
  recent(limit = 50): BrowserReliabilityEvent[] {
    const bounded = Math.max(1, Math.min(limit, MAX_EVENTS));
    return this.events.slice(-bounded);
  }

  /** Count of recorded events by kind (for health summaries/tests). */
  countByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.events) {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    }
    return counts;
  }
}

export function getBrowserReliabilityEvents(): BrowserReliabilityEvents {
  return BrowserReliabilityEvents.getInstance();
}
