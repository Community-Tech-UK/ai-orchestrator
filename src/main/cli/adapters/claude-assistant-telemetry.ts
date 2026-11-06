import { observeClaudeCacheLifetime } from './claude-cache-lifetime';
import { observeClaudeSubagentModel } from './claude-subagent-usage';

/**
 * Everything learned from the shape of an assistant frame, beyond its text: the
 * model a helper agent ran, and how long the main conversation's prompt cache
 * lasts. One call for the adapter, the spawn-worker proxy and remote workers.
 */
export function observeClaudeAssistantTelemetry(host: { emit(event: string, ...args: unknown[]): boolean }, frame: unknown): void {
  observeClaudeSubagentModel(host, frame);
  observeClaudeCacheLifetime(host, frame);
}
