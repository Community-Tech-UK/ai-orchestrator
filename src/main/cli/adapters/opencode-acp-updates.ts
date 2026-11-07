import type { AcpRetryStateUpdate } from '../../../shared/types/cli.types';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpChildActivity } from './acp-delegated-task-liveness';

const MAX_SUMMARY_CHARS = 96_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Metadata-only child ownership; never append child answers to the parent transcript. */
export class OpenCodeAcpUpdates {
  private readonly children = new Map<string, { rootId: string; title: string; createdAt: number }>();
  private readonly compactions = new Map<string, { id: string; completed: boolean; summary: string; truncated: boolean }>();

  constructor(private readonly onCompactionFailed: () => void = () => undefined) {}

  clear(): void { this.children.clear(); this.compactions.clear(); }

  child(update: Record<string, unknown>, parentId: string): AcpChildActivity | false | undefined {
    const meta = update['_meta'];
    if (!record(meta) || !Object.hasOwn(meta, 'opencode/child-session')) return undefined;
    const child = meta['opencode/child-session'];
    if (!record(child) || typeof child['id'] !== 'string' || typeof child['parentID'] !== 'string') return false;
    const ancestor = this.children.get(child['parentID']);
    if (child['parentID'] !== parentId && !ancestor) return false;
    const previous = this.children.get(child['id']);
    if (!previous && this.children.size >= 128) return false;
    const rootId = ancestor?.rootId ?? child['id'];
    const root = this.children.get(rootId);
    const entry = { rootId, title: root?.title ?? (typeof child['title'] === 'string' ? child['title'] : ''), createdAt: root?.createdAt ?? previous?.createdAt ?? Date.now() };
    this.children.set(child['id'], entry);
    return { sessionId: rootId, title: entry.title, createdAt: entry.createdAt };
  }

  retry(update: Record<string, unknown>): AcpRetryStateUpdate | null | undefined {
    const meta = update['_meta'];
    if (!record(meta) || !Object.hasOwn(meta, 'opencode/retry')) return undefined;
    const retry = meta['opencode/retry'];
    if (retry === null) return null;
    if (!record(retry)) return undefined;
    // Provider error bodies may contain prompts, keys or URLs. Only surface safe status.
    const status = record(retry['error']) ? retry['error']['status'] : undefined;
    return { sessionUpdate: 'retry_state', type: 'retrying',
      ...(typeof retry['attempt'] === 'number' && Number.isFinite(retry['attempt']) ? { attempt: retry['attempt'] } : {}),
      ...(typeof status === 'number' && Number.isInteger(status) ? { reason: `Provider returned HTTP ${status}.` } : {}),
    };
  }

  /** False means a keyed marker was handled without another output. */
  compaction(update: Record<string, unknown>, newId: () => string): OutputMessage | false | undefined {
    const meta = update['_meta'];
    const chunk = update['sessionUpdate'] === 'compaction_summary_chunk';
    const marker = update['sessionUpdate'] === 'compaction_update' || chunk ? update
      : record(meta) && record(meta['opencode/compaction']) ? meta['opencode/compaction'] : undefined;
    if (!marker) return undefined;
    const key = marker['compactionId'] ?? marker['messageId'];
    // A summary chunk carries no status of its own; it belongs to a compaction already started.
    if (chunk && (typeof key !== 'string' || !this.compactions.has(key))) return undefined;
    const status = chunk ? 'in_progress' : marker['status'];
    if (!['started', 'in_progress', 'completed', 'failed', 'cancelled'].includes(String(status))) return undefined;
    if (status === 'failed') this.onCompactionFailed();
    if (typeof key !== 'string') return undefined;
    if (!this.compactions.has(key) && this.compactions.size >= 128) return false;
    const state = this.compactions.get(key) ?? { id: newId(), completed: false, summary: '', truncated: false };
    if (chunk && record(marker['content']) && marker['content']['type'] === 'text' && typeof marker['content']['text'] === 'string') {
      const combined = state.summary + marker['content']['text'];
      state.truncated ||= combined.length > MAX_SUMMARY_CHARS;
      state.summary = combined.slice(0, MAX_SUMMARY_CHARS);
      this.compactions.set(key, state);
      return false; // The completed row carries the whole summary once.
    } else if (!chunk && (marker['summary'] === null || Array.isArray(marker['summary']))) {
      const text = ((marker['summary'] as unknown[] | null) ?? []).filter(record)
        .filter(block => block['type'] === 'text' && typeof block['text'] === 'string').map(block => block['text']).join('\n\n');
      state.summary = text.slice(0, MAX_SUMMARY_CHARS);
      state.truncated = text.length > MAX_SUMMARY_CHARS;
    }
    if (status === 'completed' && state.completed) return false;
    const firstCompletion = status === 'completed' && !state.completed;
    if (firstCompletion) state.completed = true;
    this.compactions.set(key, state);
    const content = status === 'completed' ? 'Compaction completed.' : status === 'failed' ? 'Compaction failed.' : status === 'cancelled' ? 'Compaction cancelled.' : 'Compacting the session…';
    return { id: state.id, timestamp: Date.now(), type: 'system', content,
      metadata: { source: 'acp-compaction', transport: 'acp', phase: status, streaming: status === 'started' || status === 'in_progress', accumulatedContent: content,
        // Record the boundary on the status row once, without appending another notice.
        ...(firstCompletion ? { threadCompacted: true, providerCompaction: 'completed' } : {}),
        ...(state.summary ? { compactionSummary: state.summary, compactionSummaryTruncated: state.truncated } : {}),
      } };
  }
}
