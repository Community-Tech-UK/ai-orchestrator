import type { OutputMessage } from '../types/instance.types';

interface ToolFact { id: string; name: string; durationMs?: number }
export function sessionFacts(messages: readonly OutputMessage[]) {
  const calls = new Map<string, { name: string; startedAt: number }>();
  const results = new Set<string>();
  const slowest: (ToolFact & { durationMs: number })[] = [];
  let failed = 0; let unmatchedIdentity = 0; let compactions = 0;
  // A compaction the app runs (`method: 'native'`) writes its own divider right after the provider's own boundary row
  // (`method: 'self-managed'` / `threadCompacted`). They are one compaction, so the divider is not counted again.
  let providerBoundaryAwaitingDivider = false;
  for (const message of messages) {
    const meta = message.metadata;
    if (message.type !== 'system') providerBoundaryAwaitingDivider = false;
    if (message.type === 'system' && (meta?.['isCompactionBoundary'] === true || meta?.['threadCompacted'] === true)) {
      if (meta?.['method'] === 'native' && providerBoundaryAwaitingDivider) providerBoundaryAwaitingDivider = false;
      else {
        compactions++;
        providerBoundaryAwaitingDivider = meta?.['method'] === 'self-managed' || meta?.['threadCompacted'] === true;
      }
    }
    if (message.type !== 'tool_use' && message.type !== 'tool_result') continue;
    const id = meta?.['tool_use_id'] ?? meta?.['id'] ?? meta?.['toolCallId'] ?? meta?.['toolUseId'];
    if (typeof id !== 'string' || !id) { unmatchedIdentity++; continue; }
    if (message.type === 'tool_use') {
      const name = meta?.['name'] ?? meta?.['toolName'];
      if (!calls.has(id)) calls.set(id, { name: typeof name === 'string' ? name : 'Tool', startedAt: message.timestamp });
    } else if (!results.has(id)) {
      results.add(id);
      // Codex marks a command that ran and exited non-zero with `status: 'failed'` while `is_error` stays false
      // (it means "did not run to its own exit"), so both count as the provider's own report of a failure.
      if (meta?.['is_error'] === true || meta?.['status'] === 'failed') failed++;
      const call = calls.get(id);
      if (call && Number.isFinite(message.timestamp) && Number.isFinite(call.startedAt) && message.timestamp >= call.startedAt) {
        slowest.push({ id, name: call.name, durationMs: message.timestamp - call.startedAt });
      }
    }
  }
  const withoutRecordedResult: ToolFact[] = [];
  for (const [id, call] of calls) if (!results.has(id)) withoutRecordedResult.push({ id, name: call.name });
  return { failed, unmatchedIdentity, compactions, slowest: slowest.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5), withoutRecordedResult };
}
