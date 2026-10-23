import type { ConversationEntry, SessionState } from './session-continuity.types';
import { stringifyJsonStringLiteral } from './continuity-payload-envelope';

/** Bound every new recovery state file; existing records are not swept or rewritten. */
export const MAX_SESSION_STATE_FILE_BYTES = 8 * 1024 * 1024;

export function assertSessionStatePayloadSize(serialized: string): string {
  if (Buffer.byteLength(serialized) > MAX_SESSION_STATE_FILE_BYTES) throw new Error('Session state exceeds the recovery file size limit.');
  return serialized;
}

/** Saturating JSON size measurement never stringifies an unbounded transcript. */
function jsonBytes(value: unknown, limit: number, parents = new Set<object>()): number {
  if (typeof value === 'string') {
    if (value.length > limit) return limit + 1;
    const literal = stringifyJsonStringLiteral(value);
    // Account for both possible on-disk envelopes: JSON escaping for plain
    // payloads, base64 expansion for encrypted payloads. Chunk both levels.
    return Math.max(Math.ceil(Buffer.byteLength(literal) * 4 / 3), Buffer.byteLength(stringifyJsonStringLiteral(literal)) - 2);
  }
  if (value === null || typeof value !== 'object') return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? 'null') * 4 / 3);
  if (parents.has(value)) throw new Error('Circular session state cannot be persisted.');
  parents.add(value);
  let size = 3;
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(value) && (item === undefined || typeof item === 'function')) continue;
    size += 2 + (Array.isArray(value) ? 0 : jsonBytes(key, limit) + 2) + jsonBytes(item, limit - size, parents);
    if (size > limit) break;
  }
  parents.delete(value);
  return size;
}

export function boundSessionStateForPersistence(state: SessionState, maxFileBytes = MAX_SESSION_STATE_FILE_BYTES): SessionState {
  // Reserve fixed envelope/encryption overhead; string measurement includes
  // escaping/base64 so Unicode text that fits on disk is not needlessly cut.
  const payloadBudget = maxFileBytes - 128;
  if (jsonBytes(state, payloadBudget) <= payloadBudget) return state;
  const bounded = { ...state, conversationHistory: [] as ConversationEntry[],
    conversationHistoryOriginKnown: false, conversationHistoryComplete: false };
  let remaining = payloadBudget - jsonBytes(bounded, payloadBudget);
  if (remaining < 256) throw new Error('Session state metadata exceeds the recovery file size limit.');

  for (let index = state.conversationHistory.length - 1; index >= 0; index--) {
    const entry = state.conversationHistory[index];
    const size = jsonBytes(entry, remaining) + 2;
    if (size <= remaining) {
      bounded.conversationHistory.push(entry);
      remaining -= size;
      continue;
    }
    if (bounded.conversationHistory.length === 0) {
      // A single tool result can be larger than the entire budget. Preserve
      // its recent text and identity; explicitly discard completeness proof.
      const content = entry.content || entry.toolUse?.output || '';
      const recent = { id: entry.id, role: entry.role, timestamp: entry.timestamp, content: '' };
      let low = 0; let high = Math.min(content.length, remaining);
      while (low < high) {
        const length = Math.ceil((low + high) / 2);
        recent.content = content.slice(-length);
        if (jsonBytes(recent, remaining) + 2 <= remaining) low = length;
        else high = length - 1;
      }
      recent.content = low === 0 ? '' : content.slice(-low);
      bounded.conversationHistory.push(recent);
    }
    break;
  }
  bounded.conversationHistory.reverse();
  return bounded;
}
