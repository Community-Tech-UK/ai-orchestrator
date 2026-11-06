import type { AppServerNotification } from './app-server-types';
import type { CodexUsageAccounting } from './usage-accounting';
import { tokenCount } from './token-usage-breakdown';
export function seedCodexIdleUsage(accounting: CodexUsageAccounting, notification: AppServerNotification): void {
  if (notification.method !== 'thread/tokenUsage/updated') return;
  const id = notification.params['threadId'];
  const usage = (notification.params['tokenUsage'] ?? notification.params['token_usage']) as Record<string, unknown> | undefined;
  const total = (usage?.['total'] ?? usage?.['total_token_usage']) as Record<string, unknown> | undefined;
  if (typeof id === 'string' && total) accounting.seed(id, total);
}
/** Idle native usage and completion receipts share the same accounting as captured turns. */
export function handleCodexIdleUsage(notification: AppServerNotification, host: {
  accounting: CodexUsageAccounting; rootThreadId: string | null;
  rootSample(occupancy: number, window: number): void; flush(): void;
}): void {
  const { method, params } = notification;
  if (!['thread/tokenUsage/updated', 'turn/started', 'turn/completed'].includes(method)) return;
  const threadId = params['threadId'];
  if (typeof threadId !== 'string') return;
  if (!host.accounting.ownsThread(threadId)) {
    if (threadId === host.rootThreadId) seedCodexIdleUsage(host.accounting, notification);
    return;
  }
  const child = threadId !== host.rootThreadId;
  const turn = params['turn'] as { id?: string; usage?: Record<string, unknown> } | undefined;
  if (method === 'turn/started') { host.accounting.beginNativeTurn(threadId, turn?.id); return; }
  if (method === 'turn/completed') host.accounting.fallback(threadId, turn?.usage, child, turn?.id);
  else {
    const usage = (params['tokenUsage'] ?? params['token_usage']) as Record<string, unknown> | undefined;
    const total = (usage?.['total'] ?? usage?.['total_token_usage']) as Record<string, unknown> | undefined;
    const last = (usage?.['last'] ?? usage?.['last_token_usage']) as Record<string, unknown> | undefined;
    const window = tokenCount(usage?.['modelContextWindow'] ?? usage?.['model_context_window']);
    host.accounting.observe(threadId, total, last, child, window);
    if (!child) host.rootSample(tokenCount(last?.['totalTokens'] ?? last?.['total_tokens']), window);
  }
  host.flush();
}
