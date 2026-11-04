import type { CodexCliConfig } from '../codex-adapter-config';
import { CodexUsageAccounting } from './usage-accounting';
import { CodexEphemeralUsageTracker } from './ephemeral-usage';
/** Per-exec ownership keeps process close/retry separate from a resident native thread. */
export function codexExecUsage(config: CodexCliConfig) {
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
        if (typeof id === 'string') { threadId = id; tracker.bind(id, true); }
      }
      if (!threadId) return;
      if (event['type'] === 'turn.started') accounting.beginNativeTurn(threadId, `exec-${++turn}`);
      if (event['type'] === 'turn.failed') failed = true;
      if (event['type'] === 'turn.completed' && event['usage'] && typeof event['usage'] === 'object') {
        accounting.fallback(threadId, event['usage'] as Record<string, unknown>, false, `exec-${turn}`);
      }
    },
    finish(error = false): void { tracker.finish(error || failed ? 'exec-failed' : 'exec-exit'); },
  };
}
