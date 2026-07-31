/**
 * Authenticated evidence loader for manual compaction.
 *
 * Extracted from `compaction-runtime.ts` (WS-B7) so both the real
 * restart-with-summary strategy and the read-only manual-compaction preview
 * (`compaction-preview.ts`) share one source of truth for "will authenticated
 * evidence survive this compaction" — without the two modules importing each
 * other.
 */

import type { Instance } from '../../shared/types/instance.types';
import { getConversationLedgerService } from '../conversation-ledger';
import { getContextEvidenceRuntime } from '../context-evidence/evidence-maintenance-service';
import {
  EvidencePreviewBuilder,
  type VerifiedEvidencePreview,
} from '../context-evidence/evidence-preview-builder';
import { getLogger } from '../logging/logger';

const logger = getLogger('CompactionEvidencePreview');

/**
 * Loads authenticated evidence previews for restart-with-summary compaction.
 * Read-only; never mutates ledger state. Returns `[]` (never throws) when
 * the instance has no evidence-tracked conversation or the lookup fails.
 */
export async function loadAuthenticatedEvidencePreviews(
  instance: Instance,
): Promise<VerifiedEvidencePreview[]> {
  const conversationId = instance.contextEvidence?.conversationId;
  if (!conversationId) return [];
  try {
    const runtime = getContextEvidenceRuntime();
    const records = await getConversationLedgerService().listEvidence(conversationId, { limit: 25 });
    const builder = new EvidencePreviewBuilder(runtime.blobStore);
    const previews: VerifiedEvidencePreview[] = [];
    for (const record of records) {
      const result = await builder.build(record);
      if (result.canReplaceOriginal) previews.push(result.preview);
    }
    return previews;
  } catch (error) {
    logger.warn('Authenticated evidence previews unavailable', {
      instanceId: instance.id,
      errorCode: evidencePreviewFailureCode(error),
    });
    return [];
  }
}

function evidencePreviewFailureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'EVIDENCE_PREVIEW_UNAVAILABLE';
}
