/** Claude system-message handling; adapter retains ownership of all state. */
import type { ClaudeCompactionObserver } from './claude-compaction-observer';
import { observeClaudeSubagentUsage } from './claude-subagent-usage';
import type { CliSystemMessage } from '../../../shared/types/cli.types';
import { MODEL_PRICING, CLAUDE_MODELS } from '../../../shared/types/provider.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { ClaudeCliSpawnOptions, RawCliPayload } from './claude-cli-adapter.types';
import type { ResumeAttemptResult } from './base-cli-adapter';
import type { ClaudeBackgroundTaskTracker, CliAsyncWorkEvent } from './claude-cli-async-work';

export interface ClaudeSystemMessageHost {
  emit(event: string, ...args: unknown[]): boolean;
  emitAsyncWork(event: CliAsyncWorkEvent | null): void;
  backgroundTasks: ClaudeBackgroundTaskTracker;
  compactionObserver: ClaudeCompactionObserver;
  spawnOptions: ClaudeCliSpawnOptions;
  lastKnownContextWindow: number;
  hasPerCallUsageThisTurn: boolean;
  lastObservedContextUsage: { used: number; total: number } | null;
  sessionId: string | null;
  lastResumeAttemptResult: ResumeAttemptResult | null;
}

export function processClaudeSystemMessage(host: ClaudeSystemMessageHost, message: CliSystemMessage, raw: RawCliPayload): void {
  observeClaudeSubagentUsage(host, raw);
  host.compactionObserver.observe(message);
  for (const event of host.backgroundTasks.observe(raw)) {
    host.emitAsyncWork(event);
  }
  if (message.subtype === 'context_usage' && message.usage) {
    const modelId = host.spawnOptions.model || CLAUDE_MODELS.OPUS_1M;
    const pricing = MODEL_PRICING[modelId] || {
      input: 3.0,
      output: 15.0
    };

    // Per-API-call usage — correctly reflects current context occupancy.
    // input_tokens = non-cached, cache_creation/cache_read = cached portions.
    const inputTokens = (message.usage.input_tokens || 0)
      + (message.usage.cache_creation_input_tokens || 0)
      + (message.usage.cache_read_input_tokens || 0);
    const outputTokens = message.usage.output_tokens || 0;
    const totalUsedTokens = inputTokens + outputTokens;

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const costEstimate = inputCost + outputCost;

    // max_tokens is the output token cap, NOT the context window.
    // Only trust modelUsage.contextWindow from result messages (handled below).
    const contextWindow = host.lastKnownContextWindow;
    const percentage = contextWindow > 0
      ? (totalUsedTokens / contextWindow) * 100
      : 0;

    host.hasPerCallUsageThisTurn = true;
    host.lastObservedContextUsage = { used: totalUsedTokens, total: contextWindow };
    host.emit('context', {
      used: totalUsedTokens,
      total: contextWindow,
      percentage: Math.min(percentage, 100),
      costEstimate
    });
  }
  if (message.session_id) {
    host.sessionId = message.session_id;
    // Confirm or annotate the resume proof with the authoritative session_id
    if (host.lastResumeAttemptResult?.source === 'native') {
      // A forked resume mints a new id by design, so receiving ANY
      // authoritative session_id back is the confirmation. Requiring an
      // exact echo made every fork read as a wrong-session failure and
      // destroyed the live session (LT-008).
      const confirmed = host.lastResumeAttemptResult.forked
        ? Boolean(message.session_id)
        : message.session_id === host.lastResumeAttemptResult.requestedSessionId;
      host.lastResumeAttemptResult = {
        ...host.lastResumeAttemptResult,
        confirmed,
        actualSessionId: message.session_id,
      };
    } else if (host.lastResumeAttemptResult) {
      host.lastResumeAttemptResult = {
        ...host.lastResumeAttemptResult,
        actualSessionId: message.session_id,
      };
    }
  }
  if (message.subtype === 'init' && Array.isArray(message.mcp_servers)) {
    // Claude connects MCP servers once per process and never retries a
    // failed one; the instance layer decides whether a respawn is needed.
    host.emit('mcp_servers', message.mcp_servers);
  }
  if (message.content) {
    host.emit('output', {
      id: generateId(),
      timestamp: message.timestamp || Date.now(),
      type: 'system',
      content: message.content
    });
  }
}
