import { createHash } from 'node:crypto';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { CodexEphemeralUsage, CodexUsageTokens } from '../../../../shared/types/codex-ephemeral-usage.types';
import { CodexEphemeralUsageSchema, CodexUsageIdSchema } from '../../../../shared/validation/codex-ephemeral-usage.schemas';
import { appendCodexEphemeralUsage } from '../../../core/system/codex-ephemeral-usage-store';
import { getLogger } from '../../../logging/logger';
import { CodexCompactionSignalTracker } from './compaction-signals';
import type { AppServerNotification } from './app-server-types';
import type { CodexUsageAccounting } from './usage-accounting';
const logger = getLogger('CodexEphemeralUsage');
const safeId = (value: unknown): string | null => {
  const parsed = CodexUsageIdSchema.safeParse(value); return parsed.success ? parsed.data : null;
};
const empty = (): CodexUsageTokens => ({ input: null, cache: null, output: null, reasoning: null, total: null, estimated: false });
/** One receipt per root native thread; helper counters occupy a separate bucket. */
export class CodexEphemeralUsageTracker {
  private binding: { threadId: string; startedAt: number; exec: boolean } | null = null;
  private readonly finished = new Set<string>();
  private readonly baseline = new Map<string, CodexUsageTokens>();
  private readonly compactions = new Map<string, CodexCompactionSignalTracker>();
  private readonly nativeTurns = new Map<string, string>();
  private compactionCount = 0;
  private readonly completedCompactionItems = new Set<string>();
  constructor(private readonly config: CodexCliConfig, private readonly accounting: CodexUsageAccounting) {}

  bind(threadId: string, exec = false): void {
    if (!this.config.ephemeral || this.binding?.threadId === threadId || this.finished.has(threadId)) return;
    this.finish('reopened');
    this.accounting.clearOwnership();
    this.baseline.clear();
    for (const id of this.accounting.accountedThreadIds()) this.baseline.set(id, this.accounting.threadTokens(id));
    this.accounting.trackThread(threadId);
    this.binding = { threadId, startedAt: Date.now(), exec };
    this.compactions.clear(); this.nativeTurns.clear(); this.completedCompactionItems.clear(); this.compactionCount = 0;
  }
  observe(notification: AppServerNotification): void {
    if (!this.binding) return;
    const id = notification.params['threadId'];
    if (typeof id !== 'string' || !this.accounting.ownsThread(id)) return;
    const turn = notification.params['turn'] as { id?: string } | undefined;
    if (notification.method === 'turn/started' && turn?.id) this.nativeTurns.set(id, turn.id);
    const item = notification.params['item'] as { id?: unknown; type?: unknown } | undefined;
    if (notification.method === 'item/completed' && item?.type === 'contextCompaction' && typeof item.id === 'string') {
      const key = `${id}:${item.id}`;
      if (this.completedCompactionItems.has(key)) return;
      this.completedCompactionItems.add(key);
    }
    const tracker = this.compactions.get(id) ?? new CodexCompactionSignalTracker();
    this.compactions.set(id, tracker);
    const signal = tracker.accept(notification, id, this.nativeTurns.get(id) ?? null);
    if (signal === 'completed' || signal === 'observed-running') this.compactionCount++;
    if (notification.method === 'turn/completed') this.nativeTurns.delete(id);
  }
  private tokensSinceBinding(threadId: string): CodexUsageTokens {
    const tokens = this.accounting.threadTokens(threadId);
    const baseline = this.baseline.get(threadId);
    if (!baseline) return tokens;
    for (const key of ['input', 'cache', 'output', 'reasoning', 'total'] as const) {
      if (tokens[key] !== null) tokens[key] = Math.max(0, tokens[key]! - (baseline[key] ?? 0));
    }
    return tokens;
  }
  finish(reason: CodexEphemeralUsage['finishReason']): void {
    const binding = this.binding;
    if (!binding) return;
    // Drop ownership even if storage fails, so a dead runtime cannot keep charging.
    this.binding = null;
    this.finished.add(binding.threadId);
    const childIds = this.accounting.ownedThreadIds().filter(id => id !== binding.threadId);
    const helperTokens = childIds.map(id => this.tokensSinceBinding(id));
    const helpers = empty();
    for (const key of ['input', 'cache', 'output', 'reasoning', 'total'] as const) {
      helpers[key] = childIds.length === 0 && !binding.exec ? 0
        : helperTokens.length && helperTokens.every(tokens => tokens[key] !== null)
          ? helperTokens.reduce((sum, tokens) => sum + tokens[key]!, 0) : null;
    }
    helpers.estimated = helperTokens.some(tokens => tokens.estimated);
    const endedAt = Math.max(binding.startedAt, Date.now());
    const kind = this.config.sessionKind ?? 'chat';
    const row: CodexEphemeralUsage = {
      version: 1, threadId: binding.threadId,
      instanceId: safeId(this.config.instanceId ?? this.config.env?.['AI_ORCHESTRATOR_INSTANCE_ID'] ?? this.config.browserGatewayInstanceId),
      jobId: safeId(this.config.jobId),
      kind, trialKey: this.config.trialKey ? createHash('sha256').update(this.config.trialKey).digest('hex') : null,
      // The thread policy records the arm it applied on the config; a thread that never resolved one is unassigned.
      trialArm: this.config.trialArm ?? 'unassigned', requests: null, requestsAvailable: false,
      tokens: this.tokensSinceBinding(binding.threadId), helpers: { count: binding.exec ? null : childIds.length, tokens: helpers },
      compactions: binding.exec ? null : this.compactionCount, startedAt: binding.startedAt, endedAt,
      durationMs: endedAt - binding.startedAt, finishReason: reason,
    };
    this.accounting.clearOwnership();
    if (this.config.onEphemeralUsage) {
      try { this.config.onEphemeralUsage(CodexEphemeralUsageSchema.parse(row)); }
      catch { logger.warn('Could not relay temporary Codex usage'); }
      return;
    }
    // Plain Node unit tests must explicitly inject a scratch file. Production is Electron main.
    if (!this.config.usageLogFile && !process.versions.electron) return;
    try { appendCodexEphemeralUsage(row, this.config.usageLogFile); }
    catch { logger.warn('Could not save temporary Codex usage'); }
  }
}
