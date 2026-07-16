import { createHash } from 'node:crypto';
import type { EvidenceCard, EvidenceCitation } from '@contracts/types/context-evidence';
import { describe, expect, it } from 'vitest';
import type { EvidenceLedgerRecord } from '../../conversation-ledger/context-evidence-ledger.types';
import { CardCitationValidator } from './card-citation-validator';

const encoder = new TextEncoder();

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(overrides: Partial<EvidenceLedgerRecord> = {}): EvidenceLedgerRecord {
  return {
    id: 'evidence-1',
    conversationId: 'conversation-1',
    provider: 'codex',
    providerThreadRef: null,
    providerSessionRef: null,
    turnRef: null,
    toolCallRef: null,
    toolName: 'exec',
    sourceKind: 'command',
    sourceLocatorRedacted: null,
    status: 'complete',
    blobRef: 'opaque/ref.aioev1',
    keyedContentId: 'a'.repeat(64),
    byteCount: 15,
    tokenEstimate: null,
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'pre-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: 2,
    captureKey: 'capture-1',
    createdAt: 1,
    completedAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function citation(overrides: Partial<EvidenceCitation> = {}): EvidenceCitation {
  const content = encoder.encode('ok café\nfailed');
  const startByte = overrides.startByte ?? 3;
  const endByte = overrides.endByte ?? 8;
  return {
    evidenceId: 'evidence-1',
    startByte,
    endByte,
    contentDigest: digest(content.subarray(startByte, endByte)),
    ...overrides,
  };
}

function card(cite = citation()): EvidenceCard {
  return {
    id: 'card-1',
    evidenceId: 'evidence-1',
    version: 1,
    status: 'validated',
    summary: 'A cited finding is available.',
    findings: [{
      id: 'finding-1',
      kind: 'fact',
      statement: 'The output contains café.',
      importance: 'info',
      citations: [cite],
    }],
    citations: [cite],
    contradictions: [],
    derivedBy: { kind: 'deterministic', version: 'test-v1' },
    createdAt: 3,
  };
}

function validator(): CardCitationValidator {
  return new CardCitationValidator({
    verifyCitationDigest: async (bytes, expected) => digest(bytes) === expected,
  });
}

describe('CardCitationValidator', () => {
  const content = encoder.encode('ok café\nfailed');

  it('validates exact UTF-8 byte ranges against authenticated complete evidence', async () => {
    await expect(validator().validate(card(), record(), content)).resolves.toEqual({ valid: true });
  });

  it.each([
    ['wrong evidence', citation({ evidenceId: 'evidence-2' }), 'CITATION_EVIDENCE_MISMATCH'],
    ['out of bounds', citation({ startByte: 0, endByte: 100 }), 'CITATION_RANGE_INVALID'],
    ['wrong digest', citation({ contentDigest: 'f'.repeat(64) }), 'CITATION_DIGEST_INVALID'],
  ])('rejects %s citations', async (_name, invalidCitation, code) => {
    await expect(validator().validate(card(invalidCitation), record(), content)).resolves.toEqual({
      valid: false,
      code,
    });
  });

  it('rejects cards backed by incomplete, unauthenticated evidence state', async () => {
    await expect(validator().validate(
      card(),
      record({ status: 'staging', keyVersion: null }),
      content,
    )).resolves.toEqual({ valid: false, code: 'EVIDENCE_NOT_AUTHENTICATED' });
  });

  it('rejects finding citations omitted from the card citation set', async () => {
    const invalid = card();
    invalid.citations = [];
    await expect(validator().validate(invalid, record(), content)).resolves.toEqual({
      valid: false,
      code: 'CARD_SCHEMA_INVALID',
    });
  });
});
