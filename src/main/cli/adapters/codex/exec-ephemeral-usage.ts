import type { CodexCliConfig } from '../codex-adapter-config';
import type { CodexEphemeralUsage } from '../../../../shared/types/codex-ephemeral-usage.types';
import { CodexUsageAccounting } from './usage-accounting';
import { CodexEphemeralUsageTracker } from './ephemeral-usage';
/**
 * Per-exec ownership keeps process close/retry separate from a resident native thread.
 * `receipts` is owned by the adapter: a resumed thread starts a new exec process, and the log keeps only the newest
 * row per thread, so each process adds its usage to the receipt the earlier one left.
 */
export function codexExecUsage(config: CodexCliConfig, receipts = new Map<string, CodexEphemeralUsage>()) {
  const accounting = new CodexUsageAccounting();
  const tracker = new CodexEphemeralUsageTracker(config, accounting);
  let threadId: string | null = null;
  let turn = 0;
  let failed = false;
  return {
    observe(event: Record<string, unknown>): void {
      if (!config.ephemeral) return;
      if (['thread.started', 'thread.created', 'session.started', 'session.created'].includes(String(event['type']))) {
        const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
        if (typeof id === 'string') { threadId = id; tracker.bind(id, true, receipts.get(id) ?? null); }
      }
      if (!threadId) return;
      if (event['type'] === 'turn.started') accounting.beginNativeTurn(threadId, `exec-${++turn}`);
      if (event['type'] === 'turn.failed') failed = true;
      if (event['type'] === 'turn.completed' && event['usage'] && typeof event['usage'] === 'object') {
        accounting.fallback(threadId, event['usage'] as Record<string, unknown>, false, `exec-${turn}`);
      }
    },
    finish(error = false): void {
      const row = tracker.finish(error || failed ? 'exec-failed' : 'exec-exit');
      if (row) receipts.set(row.threadId, row);
    },
  };
}
