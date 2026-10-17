import type { AcpRetryStateUpdate } from '../../../shared/types/cli.types';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpChildActivity } from './acp-delegated-task-liveness';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Metadata-only child ownership; never append child answers to the parent transcript. */
export class OpenCodeAcpUpdates {
  private readonly children = new Map<string, { rootId: string; title: string; createdAt: number }>();
  private readonly compactions = new Map<string, string>();

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

  compaction(update: Record<string, unknown>, newId: () => string): OutputMessage | undefined {
    const meta = update['_meta'];
    const marker = update['sessionUpdate'] === 'compaction_update' ? update
      : record(meta) && record(meta['opencode/compaction']) ? meta['opencode/compaction'] : undefined;
    if (!marker) return undefined;
    const status = marker['status'];
    if (!['started', 'in_progress', 'completed', 'failed'].includes(String(status))) return undefined;
    const key = marker['compactionId'] ?? marker['messageId'];
    if (typeof key !== 'string' || (!this.compactions.has(key) && this.compactions.size >= 128)) return undefined;
    const id = this.compactions.get(key) ?? newId();
    this.compactions.set(key, id);
    const content = status === 'completed' ? 'Compaction completed.' : status === 'failed' ? 'Compaction failed.' : 'Compacting the session…';
    return { id, timestamp: Date.now(), type: 'system', content,
      metadata: { source: 'acp-compaction', transport: 'acp', phase: status, streaming: status === 'started' || status === 'in_progress', accumulatedContent: content } };
  }
}
