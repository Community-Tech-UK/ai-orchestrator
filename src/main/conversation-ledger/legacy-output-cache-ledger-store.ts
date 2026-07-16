import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  EvidenceLedgerRecord,
  LegacyMarkerCompareAndSwapInput,
  LegacyOutputCacheMarkerRecord,
} from './context-evidence-ledger.types';

export function compareAndSwapLegacyOutputMarker(
  db: SqliteDriver,
  input: LegacyMarkerCompareAndSwapInput,
  getEvidence: (conversationId: string, evidenceId: string) => EvidenceLedgerRecord | null,
): boolean {
  return db.transaction(() => {
    const evidence = getEvidence(input.conversationId, input.evidenceId);
    const citation = parseEvidenceCitation(input.evidenceCitation);
    if (
      !evidence
      || evidence.provenanceTrust !== 'legacy-unverified'
      || !citation
      || citation.evidenceId !== input.evidenceId
      || citation.endByte > evidence.byteCount
    ) return false;
    const replacementText = input.replacementText ?? input.evidenceCitation;
    if (
      replacementText.length > 2_048
      || replacementText.includes('\0')
      || replacementText.indexOf(input.evidenceCitation) < 0
      || replacementText.indexOf(input.evidenceCitation) !== replacementText.lastIndexOf(input.evidenceCitation)
    ) return false;
    const row = db.prepare(`
      SELECT conversation_messages.content FROM conversation_messages
      JOIN conversation_threads ON conversation_threads.id = conversation_messages.thread_id
      WHERE conversation_messages.id = ? AND conversation_messages.thread_id = ?
        AND conversation_threads.deleted_at IS NULL
    `).get<{ content: string }>(input.messageId, input.conversationId);
    if (!row) return false;
    const first = row.content.indexOf(input.expectedMarker);
    if (first < 0 || first !== row.content.lastIndexOf(input.expectedMarker)) return false;
    const replacement = `${row.content.slice(0, first)}${replacementText}${row.content.slice(first + input.expectedMarker.length)}`;
    return db.prepare(`
      UPDATE conversation_messages SET content = ?
      WHERE id = ? AND thread_id = ? AND content = ?
    `).run(replacement, input.messageId, input.conversationId, row.content).changes === 1;
  })();
}

export function listLegacyOutputCacheMarkers(db: SqliteDriver): LegacyOutputCacheMarkerRecord[] {
  return db.prepare(`
    SELECT conversation_messages.thread_id AS conversationId,
      conversation_messages.id AS messageId, conversation_messages.content AS content,
      conversation_threads.provider AS provider, conversation_threads.source_kind AS sourceKind
    FROM conversation_messages
    JOIN conversation_threads ON conversation_threads.id = conversation_messages.thread_id
    WHERE conversation_threads.deleted_at IS NULL
      AND conversation_messages.content LIKE '%[Full output saved: %] (% chars)%'
    ORDER BY conversation_messages.thread_id ASC, conversation_messages.sequence ASC,
      conversation_messages.id ASC
  `).all<LegacyOutputCacheMarkerRecord>();
}

function parseEvidenceCitation(value: string): { evidenceId: string; endByte: number } | null {
  const match = /^\[evidence:([^\]@]+)@(\d+)-(\d+)#[a-f0-9]{64}\]$/.exec(value);
  if (!match) return null;
  const startByte = Number(match[2]);
  const endByte = Number(match[3]);
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || endByte <= startByte) {
    return null;
  }
  return { evidenceId: match[1]!, endByte };
}
