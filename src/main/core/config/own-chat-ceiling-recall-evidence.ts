/**
 * The recall check that gates the 300,000-token ceiling for James's own Claude chats.
 *
 * `null` means no passing check has been recorded, and the migration in
 * `settings-migrations-own-chat-ceiling.ts` changes nothing. This file is replaced
 * by `scripts/audit/recall-replay.ts --write-evidence` after a real run: counts and
 * sizes only, never questions, answers or transcript text. Re-run it every quarter.
 */
import type { RecallEvidence } from '../../context/recall-replay/recall-types';

export const OWN_CHAT_CEILING_RECALL_EVIDENCE: RecallEvidence | null = null;
