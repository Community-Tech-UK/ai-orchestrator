import type { OutputMessage } from '../types/instance.types';

interface ToolFact { id: string; name: string; durationMs?: number }
export function sessionFacts(messages: readonly OutputMessage[]) {
  const calls = new Map<string, { name: string; startedAt: number }>();
  const results = new Set<string>();
  const slowest: (ToolFact & { durationMs: number })[] = [];
  let failed = 0; let unmatchedIdentity = 0; let compactions = 0;
  for (const message of messages) {
    const meta = message.metadata;
    if (message.type === 'system' && (meta?.['isCompactionBoundary'] === true || meta?.['threadCompacted'] === true)) compactions++;
    if (message.type !== 'tool_use' && message.type !== 'tool_result') continue;
    const id = meta?.['tool_use_id'] ?? meta?.['id'] ?? meta?.['toolCallId'] ?? meta?.['toolUseId'];
    if (typeof id !== 'string' || !id) { unmatchedIdentity++; continue; }
    if (message.type === 'tool_use') {
      const name = meta?.['name'] ?? meta?.['toolName'];
      if (!calls.has(id)) calls.set(id, { name: typeof name === 'string' ? name : 'Tool', startedAt: message.timestamp });
    } else if (!results.has(id)) {
      results.add(id);
      if (meta?.['is_error'] === true) failed++;
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
