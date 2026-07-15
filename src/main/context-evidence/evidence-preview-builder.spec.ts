import { describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import { EvidencePreviewBuilder } from './evidence-preview-builder';

describe('EvidencePreviewBuilder', () => {
  it('builds bounded head/tail previews with exact authenticated retrieval citations', async () => {
    const content = new TextEncoder().encode('head middle tail');
    const builder = new EvidencePreviewBuilder({
      read: vi.fn(async () => content),
      deriveCitationDigest: vi.fn(async () => 'd'.repeat(64)),
    });

    const result = await builder.build(record({ byteCount: content.byteLength }), {
      headBytes: 4,
      tailBytes: 4,
    });

    expect(result).toMatchObject({ canReplaceOriginal: true, evidenceId: 'evidence-1' });
    if (!result.canReplaceOriginal) throw new Error('expected preview');
    expect(result.preview.preview).toContain('head');
    expect(result.preview.preview).toContain('tail');
    expect(result.preview.preview).toContain(`[evidence:evidence-1@0-4#${'d'.repeat(64)}]`);
    expect(result.preview.preview).toContain(`[evidence:evidence-1@12-16#${'d'.repeat(64)}]`);
    expect(result.preview.preview).toContain('UNTRUSTED EVIDENCE PREVIEW');
  });

  it('does not permit replacement when durable capture failed or is unauthenticated', async () => {
    const builder = new EvidencePreviewBuilder({ read: vi.fn(), deriveCitationDigest: vi.fn() });
    await expect(builder.build(
      record({ status: 'failed', blobRef: null, keyedContentId: null, keyVersion: null }),
    )).resolves.toEqual({
      canReplaceOriginal: false,
      reasonCode: 'EVIDENCE_NOT_AUTHENTICATED',
    });
  });

  it('does not discard the only observed copy for bounded or metadata-only capture', async () => {
    const content = new TextEncoder().encode('bounded');
    const builder = new EvidencePreviewBuilder({
      read: vi.fn(async () => content),
      deriveCitationDigest: vi.fn(async () => 'e'.repeat(64)),
    });
    const result = await builder.build(record({
      byteCount: content.byteLength,
      captureCompleteness: 'bounded',
      truncationReason: 'Provider exposed only a bounded result.',
    }));
    expect(result).toEqual({
      canReplaceOriginal: false,
      reasonCode: 'EVIDENCE_CAPTURE_INCOMPLETE',
      disclosure: 'Provider exposed only a bounded result.',
    });
  });

  it('does not split UTF-8 code points when selecting preview boundaries', async () => {
    const content = new TextEncoder().encode('a🙂z');
    const builder = new EvidencePreviewBuilder({
      read: vi.fn(async () => content),
      deriveCitationDigest: vi.fn(async () => 'f'.repeat(64)),
    });
    const result = await builder.build(record({ byteCount: content.byteLength }), {
      headBytes: 3,
      tailBytes: 2,
    });
    if (!result.canReplaceOriginal) throw new Error('expected preview');
    expect(result.preview.preview).not.toContain('�');
  });

  it('does not mint replacement authority when authenticated blob loading fails', async () => {
    const builder = new EvidencePreviewBuilder({
      read: vi.fn(async () => { throw new Error('BLOB_AUTH_FAILED'); }),
      deriveCitationDigest: vi.fn(),
    });

    await expect(builder.build(record())).resolves.toEqual({
      canReplaceOriginal: false,
      reasonCode: 'EVIDENCE_NOT_AUTHENTICATED',
    });
  });
});

function record(overrides: Partial<EvidenceLedgerRecord> = {}): EvidenceLedgerRecord {
  return {
    id: 'evidence-1', conversationId: 'conversation-1', provider: 'codex',
    providerThreadRef: null, providerSessionRef: null, turnRef: null, toolCallRef: null,
    toolName: 'tool', sourceKind: 'other', sourceLocatorRedacted: null,
    status: 'complete', blobRef: 'opaque/blob.aioev1', keyedContentId: 'a'.repeat(64),
    byteCount: 16, tokenEstimate: null, mimeType: 'text/plain', sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated', captureMode: 'pre-retention',
    captureCompleteness: 'complete', truncationReason: null, keyVersion: 1,
    captureKey: 'capture-key', createdAt: 1, completedAt: 2, updatedAt: 2,
    ...overrides,
  };
}
