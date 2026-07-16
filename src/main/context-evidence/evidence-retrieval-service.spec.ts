import { describe, expect, it, vi } from 'vitest';
import type { EvidenceCard } from '@contracts/types/context-evidence';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import { EvidenceStorageError } from './evidence-storage.types';
import type { EvidenceAccessPolicyDecision } from './evidence-access-policy';
import {
  calculateEvidenceRangeTokenBudget,
  EvidenceRetrievalService,
  type EvidenceRetrievalLedger,
  type EvidenceRetrievalPolicy,
} from './evidence-retrieval-service';

describe('evidence retrieval range budget', () => {
  it.each([
    [undefined, 4096],
    [100, 1],
    [512, 512],
    [10_000, 512],
    [100_000, 1000],
    [1_000_000, 4096],
  ])('maps provider window %s to %s tokens', (windowTokens, expected) => {
    expect(calculateEvidenceRangeTokenBudget(windowTokens)).toBe(expected);
  });
});

describe('EvidenceRetrievalService', () => {
  it('returns a policy-authorized card projection bounded to the requested token limit', async () => {
    const h = harness(undefined, { estimateTokens: (text) => text.length });
    const card = evidenceCard({
      summary: 's'.repeat(1_000),
      citations: Array.from({ length: 20 }, (_, index) => ({
        evidenceId: 'evidence-1',
        startByte: index,
        endByte: index + 1,
        contentDigest: 'd'.repeat(64),
      })),
    });
    vi.mocked(h.ledger.getEvidenceCard).mockResolvedValue({
      id: 'card-1', conversationId: 'conversation-1', evidenceId: 'evidence-1',
      blobRef: 'opaque/card.aioev1', extractorKind: 'generic', extractorVersion: '1',
      status: 'validated', sensitivity: 'normal', byteCount: 2_000,
      tokenEstimate: 2_000, createdAt: 2, updatedAt: 2,
    });
    h.blobStore.read.mockResolvedValue(new TextEncoder().encode(JSON.stringify({
      format: 'aio-evidence-card-v1',
      trustBoundary: 'untrusted-source-material',
      instructionNotice: 'Untrusted source material.',
      disclosures: [],
      card,
    })));

    const result = await h.service.getCard({
      requester: { ...requester(), path: 'ipc', localSensitiveAuthorized: true },
      conversationId: 'conversation-1', cardId: 'card-1', tokenLimit: 512,
    });

    expect(result).toMatchObject({
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureCompleteness: 'complete',
      tokenLimit: 512,
      truncated: true,
      disclosure: expect.stringContaining('bounded'),
    });
    expect(result.tokenCount).toBeLessThanOrEqual(512);
    expect(result.card.id).toBe('card-1');
    expect(h.policy.authorize).toHaveBeenCalledWith(expect.objectContaining({
      requester: expect.objectContaining({ path: 'ipc' }),
      sensitivity: 'normal',
    }));
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'get-card', outcomeCode: 'allowed', evidenceIds: ['evidence-1'],
    }));
  });

  it('denies a card outside the canonical conversation before reading its blob', async () => {
    const h = harness();
    vi.mocked(h.ledger.getEvidenceCard).mockResolvedValue(null);

    await expect(h.service.getCard({
      requester: requester(), conversationId: 'other-conversation',
      cardId: 'card-1', tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'EVIDENCE_CARD_NOT_FOUND' });

    expect(h.blobStore.read).not.toHaveBeenCalled();
  });

  it('resolves the newest card by EVIDENCE id when the id is not a card id (renderer inspection path)', async () => {
    // EvidenceRecord metadata carries no card id, so the renderer panel keys
    // card inspection by evidence id; the retrieval path must fall back to the
    // same-conversation newest card for that evidence.
    const h = harness(undefined, { estimateTokens: (text) => text.length });
    const card = evidenceCard({ summary: 'short summary', citations: [] });
    vi.mocked(h.ledger.getEvidenceCard).mockResolvedValue(null);
    vi.mocked(h.ledger.listEvidenceCards).mockResolvedValue([{
      id: 'card-1', conversationId: 'conversation-1', evidenceId: 'evidence-1',
      blobRef: 'opaque/card.aioev1', extractorKind: 'generic', extractorVersion: '1',
      status: 'validated', sensitivity: 'normal', byteCount: 2_000,
      tokenEstimate: 2_000, createdAt: 2, updatedAt: 2,
    }]);
    h.blobStore.read.mockResolvedValue(new TextEncoder().encode(JSON.stringify({
      format: 'aio-evidence-card-v1',
      trustBoundary: 'untrusted-source-material',
      instructionNotice: 'Untrusted source material.',
      disclosures: [],
      card,
    })));

    const result = await h.service.getCard({
      requester: { ...requester(), path: 'ipc', localSensitiveAuthorized: true },
      conversationId: 'conversation-1', cardId: 'evidence-1', tokenLimit: 512,
    });

    expect(result.card.id).toBe('card-1');
    expect(h.ledger.listEvidenceCards).toHaveBeenCalledWith('conversation-1', {
      evidenceId: 'evidence-1', limit: 1,
    });
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'get-card', outcomeCode: 'allowed', evidenceIds: ['evidence-1'],
    }));
  });

  it('returns an exact authenticated UTF-8 byte range with an untrusted wrapper and citation', async () => {
    const h = harness();

    const result = await h.service.read({
      requester: requester(),
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 7,
      tokenLimit: 512,
      providerWindowTokens: 10_000,
    });

    expect(result).toMatchObject({
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 7,
      truncated: false,
      citation: {
        evidenceId: 'evidence-1', startByte: 0, endByte: 7, contentDigest: 'd'.repeat(64),
      },
    });
    expect(result.content).toContain('payload');
    expect(result.content).toContain('UNTRUSTED EVIDENCE');
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'read', outcomeCode: 'allowed', requestedRanges: [{ startByte: 0, endByte: 7 }],
    }));
  });

  it.each([
    ['', 'OWNERSHIP_REQUIRED'],
    ['other-conversation', 'EVIDENCE_NOT_FOUND'],
  ])('denies missing or wrong canonical ownership without decrypting', async (conversationId, code) => {
    const h = harness();
    if (conversationId) vi.mocked(h.ledger.getEvidence).mockResolvedValue(null);

    await expect(h.service.read({
      requester: requester(), conversationId, evidenceId: 'evidence-1',
      startByte: 0, endByte: 7, tokenLimit: 512,
    })).rejects.toMatchObject({ code });

    expect(h.blobStore.read).not.toHaveBeenCalled();
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: code,
    }));
  });

  it('denies oversized retrieval ranges before decrypting', async () => {
    const h = harness(record({ byteCount: 100_000 }));

    await expect(h.service.read({
      requester: requester(), conversationId: 'conversation-1', evidenceId: 'evidence-1',
      startByte: 0, endByte: 100_000, tokenLimit: 512, providerWindowTokens: 10_000,
    })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
    expect(h.blobStore.read).not.toHaveBeenCalled();
  });

  it('denies sensitivity policy failures and records only a content-free outcome', async () => {
    const h = harness(record({ sensitivity: 'restricted' }));
    vi.mocked(h.policy.authorize).mockReturnValue({ allowed: false, code: 'SENSITIVITY_DENIED' });

    await expect(h.service.read({
      requester: requester(), conversationId: 'conversation-1', evidenceId: 'evidence-1',
      startByte: 0, endByte: 7, tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'SENSITIVITY_DENIED' });
    expect(h.blobStore.read).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(h.ledger.logEvidenceAccess).mock.calls)).not.toContain('payload');
  });

  it('marks authentication failure corrupt and refuses subsequent reads without re-decrypting', async () => {
    const h = harness();
    vi.mocked(h.blobStore.readRange).mockRejectedValue(new EvidenceStorageError('BLOB_AUTH_FAILED'));

    await expect(h.service.read(readInput())).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });
    await expect(h.service.read(readInput())).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });

    expect(h.ledger.failEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: 'evidence-1', status: 'corrupt',
    }));
    expect(h.blobStore.readRange).toHaveBeenCalledOnce();
  });

  it('quarantines corrupt evidence when the durable status write fails', async () => {
    const h = harness();
    vi.mocked(h.blobStore.readRange).mockRejectedValue(
      new EvidenceStorageError('BLOB_AUTH_FAILED'),
    );
    vi.mocked(h.ledger.failEvidence).mockRejectedValue(new Error('fixture ledger unavailable'));

    await expect(h.service.read(readInput())).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });
    await expect(h.service.read(readInput())).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });

    expect(h.blobStore.readRange).toHaveBeenCalledOnce();
    expect(h.blobStore.remove).toHaveBeenCalledOnce();
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: 'EVIDENCE_CORRUPT',
    }));
  });

  it.each([
    [{ startByte: -1, endByte: 7, tokenLimit: 512 }, 'RANGE_INVALID'],
    [{ startByte: 0, endByte: 7, tokenLimit: 0 }, 'TOKEN_LIMIT_INVALID'],
  ])('audits denied read validation without content for %s', async (range, code) => {
    const h = harness();

    await expect(h.service.read({
      requester: requester(),
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      ...range,
    })).rejects.toMatchObject({ code });

    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'read',
      outcomeCode: code,
      evidenceIds: ['evidence-1'],
    }));
    expect(JSON.stringify(vi.mocked(h.ledger.logEvidenceAccess).mock.calls)).not.toContain('payload');
  });

  it('returns only complete UTF-8 code points covered by the citation', async () => {
    const bytes = new TextEncoder().encode('€x');
    const h = harness(record({ id: 'utf8', byteCount: bytes.byteLength }), {
      estimateTokens: (text) => text.includes('€x') ? 513 : 1,
    });
    vi.mocked(h.blobStore.readRange).mockResolvedValue(bytes);

    const result = await h.service.read({
      requester: requester(), conversationId: 'conversation-1', evidenceId: 'utf8',
      startByte: 0, endByte: bytes.byteLength, tokenLimit: 512,
    });

    expect(result).toMatchObject({ endByte: 3, truncated: true });
    expect(result.content).toContain('€');
    expect(result.content).not.toContain('�');
    expect(h.blobStore.deriveCitationDigest).toHaveBeenCalledWith(
      new TextEncoder().encode('€'), 1,
    );
  });

  it('audits non-integrity blob read failures without exposing content', async () => {
    const h = harness();
    vi.mocked(h.blobStore.readRange).mockRejectedValue(
      new EvidenceStorageError('BLOB_READ_FAILED'),
    );

    await expect(h.service.read(readInput())).rejects.toMatchObject({
      code: 'EVIDENCE_READ_FAILED',
    });

    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'read',
      outcomeCode: 'EVIDENCE_READ_FAILED',
      evidenceIds: ['evidence-1'],
    }));
    expect(JSON.stringify(vi.mocked(h.ledger.logEvidenceAccess).mock.calls)).not.toContain('payload');
  });

  it('fails closed when a required audit record cannot be persisted', async () => {
    const h = harness();
    vi.mocked(h.ledger.logEvidenceAccess).mockRejectedValue(new Error('fixture audit unavailable'));

    await expect(h.service.read({ ...readInput(), startByte: -1 }))
      .rejects.toMatchObject({ code: 'EVIDENCE_AUDIT_FAILED' });
    expect(h.blobStore.readRange).not.toHaveBeenCalled();
  });

  it('rejects malformed searches before listing or decrypting evidence', async () => {
    const h = harness();

    await expect(h.service.search({
      requester: requester(), conversationId: 'conversation-1', query: '   ', tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'SEARCH_QUERY_INVALID' });
    expect(h.ledger.listEvidence).not.toHaveBeenCalled();
    expect(h.blobStore.read).not.toHaveBeenCalled();
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'search', outcomeCode: 'SEARCH_QUERY_INVALID', evidenceIds: [],
    }));
    expect(JSON.stringify(vi.mocked(h.ledger.logEvidenceAccess).mock.calls)).not.toContain('payload');
  });

  it('searches authorized decrypted content and returns bounded exact citations', async () => {
    const h = harness();

    const matches = await h.service.search({
      requester: requester(), conversationId: 'conversation-1', query: 'load', tokenLimit: 512,
    });

    expect(matches).toEqual([
      expect.objectContaining({
        evidenceId: 'evidence-1', startByte: 3, endByte: 7,
        citation: expect.objectContaining({ contentDigest: 'd'.repeat(64) }),
      }),
    ]);
  });

  it('searches large raw evidence through the bounded authenticated scan API', async () => {
    const h = harness(record({ byteCount: 2_000_000 }));
    vi.mocked(h.blobStore.find).mockResolvedValue({
      startByte: 1_500_000,
      bytes: new TextEncoder().encode('load result'),
    });

    const matches = await h.service.search({
      requester: requester(), conversationId: 'conversation-1', query: 'load', tokenLimit: 512,
    });

    expect(matches[0]).toMatchObject({
      matchKind: 'raw', startByte: 1_500_000, endByte: 1_500_011,
    });
    expect(h.blobStore.find).toHaveBeenCalledWith(
      'opaque/evidence.aioev1', 'a'.repeat(64), new TextEncoder().encode('load'), 8_192,
    );
    expect(h.blobStore.read).not.toHaveBeenCalledWith(
      'opaque/evidence.aioev1', 'a'.repeat(64),
    );
  });

  it('returns authenticated card matches before raw matches', async () => {
    const h = harness();
    vi.mocked(h.ledger.listEvidenceCards).mockResolvedValue([{
      id: 'card-1', conversationId: 'conversation-1', evidenceId: 'evidence-1',
      blobRef: 'opaque/card.aioev', extractorKind: 'generic', extractorVersion: '1',
      status: 'validated', sensitivity: 'normal', byteCount: 100, tokenEstimate: 20,
      createdAt: 3, updatedAt: 3,
    }]);
    vi.mocked(h.blobStore.read).mockImplementation(async (blobRef: string) => blobRef.includes('card')
      ? new TextEncoder().encode(JSON.stringify({
          format: 'aio-evidence-card-v1',
          trustBoundary: 'untrusted-source-material',
          card: {
            id: 'card-1', evidenceId: 'evidence-1', summary: 'payload summary',
            citations: [{
              evidenceId: 'evidence-1', startByte: 0, endByte: 7,
              contentDigest: 'd'.repeat(64),
            }],
          },
        }))
      : new TextEncoder().encode('payload'));

    const matches = await h.service.search({
      requester: requester(), conversationId: 'conversation-1', query: 'payload', tokenLimit: 512,
    });

    expect(matches.map((match) => match.matchKind)).toEqual(['card', 'raw']);
    expect(matches[0]).toMatchObject({
      evidenceId: 'evidence-1', startByte: 0, endByte: 7,
      preview: expect.stringContaining('payload summary'),
      citation: { contentDigest: 'd'.repeat(64) },
    });
    expect(h.blobStore.readRange).toHaveBeenCalledWith(
      'opaque/evidence.aioev1', 'a'.repeat(64), 0, 7,
    );
  });

  it('lists only records allowed by the shared evidence policy', async () => {
    const h = harness();

    await expect(h.service.list({
      requester: requester(), conversationId: 'conversation-1',
    })).resolves.toEqual([expect.objectContaining({ id: 'evidence-1' })]);
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'list', outcomeCode: 'allowed', evidenceIds: ['evidence-1'],
    }));
  });

  it('audits records filtered from list and search by policy', async () => {
    const h = harness();
    vi.mocked(h.policy.authorize).mockReturnValue({
      allowed: false,
      code: 'SENSITIVITY_DENIED',
    });

    await expect(h.service.list({
      requester: requester(), conversationId: 'conversation-1',
    })).resolves.toEqual([]);
    await expect(h.service.search({
      requester: requester(), conversationId: 'conversation-1', query: 'load', tokenLimit: 512,
    })).resolves.toEqual([]);

    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'list', outcomeCode: 'SENSITIVITY_DENIED', evidenceIds: ['evidence-1'],
    }));
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'search', outcomeCode: 'SENSITIVITY_DENIED', evidenceIds: ['evidence-1'],
    }));
  });

  it('compares exact authenticated byte ranges without comparing wrapper prose', async () => {
    const h = harness();

    await expect(h.service.compare({
      requester: requester(),
      conversationId: 'conversation-1',
      left: { evidenceId: 'evidence-1', startByte: 0, endByte: 7 },
      right: { evidenceId: 'evidence-1', startByte: 0, endByte: 7 },
    })).resolves.toEqual({
      equal: true,
      leftCitation: {
        evidenceId: 'evidence-1', startByte: 0, endByte: 7, contentDigest: 'd'.repeat(64),
      },
      rightCitation: {
        evidenceId: 'evidence-1', startByte: 0, endByte: 7, contentDigest: 'd'.repeat(64),
      },
    });
  });

  it('denies compare and verify ranges above the shared provider-window budget', async () => {
    const h = harness(record({ byteCount: 100_000 }));
    const range = { evidenceId: 'evidence-1', startByte: 0, endByte: 20_000 };

    await expect(h.service.compare({
      requester: requester(), conversationId: 'conversation-1',
      left: range, right: range, providerWindowTokens: 100_000,
    })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
    await expect(h.service.verify({
      requester: requester(), conversationId: 'conversation-1', ...range,
      contentDigest: 'd'.repeat(64), providerWindowTokens: 100_000,
    })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });

    expect(h.blobStore.readRange).not.toHaveBeenCalled();
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'compare', outcomeCode: 'RANGE_TOO_LARGE',
    }));
    expect(h.ledger.logEvidenceAccess).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'verify', outcomeCode: 'RANGE_TOO_LARGE',
    }));
  });

  it('verifies a supplied citation digest in constant-time storage code', async () => {
    const h = harness();

    await expect(h.service.verify({
      requester: requester(), conversationId: 'conversation-1', evidenceId: 'evidence-1',
      startByte: 0, endByte: 7, contentDigest: 'd'.repeat(64),
    })).resolves.toEqual({ verified: true });
    expect(h.blobStore.readRange).toHaveBeenCalledWith(
      'opaque/evidence.aioev1', 'a'.repeat(64), 0, 7,
    );
  });
});

function harness(
  evidence = record(),
  overrides: { estimateTokens?: (text: string) => number } = {},
): {
  service: EvidenceRetrievalService;
  ledger: EvidenceRetrievalLedger;
  policy: EvidenceRetrievalPolicy;
  blobStore: {
    read: ReturnType<typeof vi.fn>;
    readRange: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    deriveCitationDigest: ReturnType<typeof vi.fn>;
    verifyCitationDigest: ReturnType<typeof vi.fn>;
  };
} {
  const ledger: EvidenceRetrievalLedger = {
    getEvidence: vi.fn(async (conversationId, evidenceId) =>
      conversationId === evidence.conversationId && evidenceId === evidence.id ? evidence : null),
    listEvidence: vi.fn(async () => [evidence]),
    listEvidenceCards: vi.fn(async () => []),
    getEvidenceCard: vi.fn(async () => null),
    logEvidenceAccess: vi.fn(async () => undefined),
    failEvidence: vi.fn(async (input) => ({ ...evidence, status: input.status ?? 'failed' })),
  };
  const blobStore = {
    read: vi.fn(async () => new TextEncoder().encode('payload')),
    readRange: vi.fn(async () => new TextEncoder().encode('payload')),
    find: vi.fn(async () => ({
      startByte: 3,
      bytes: new TextEncoder().encode('load'),
    })),
    remove: vi.fn(async () => undefined),
    deriveCitationDigest: vi.fn(async () => 'd'.repeat(64)),
    verifyCitationDigest: vi.fn(async () => true),
  };
  const policy: EvidenceRetrievalPolicy = {
    authorize: vi.fn((): EvidenceAccessPolicyDecision => ({ allowed: true, disclosures: [] })),
  };
  return {
    service: new EvidenceRetrievalService({
      ledger,
      blobStore,
      policy,
      estimateTokens: overrides.estimateTokens
        ?? ((text) => Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4))),
      now: () => 100,
    }),
    ledger,
    policy,
    blobStore,
  };
}

function evidenceCard(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    id: 'card-1', evidenceId: 'evidence-1', version: 1, status: 'validated',
    summary: 'Summary', findings: [], citations: [], contradictions: [],
    derivedBy: { kind: 'deterministic', version: 'generic-v1' }, createdAt: 2,
    ...overrides,
  };
}

function requester() {
  return {
    id: 'mcp:evidence_read',
    path: 'provider' as const,
    localSensitiveAuthorized: false,
    localRestrictedAuthorized: false,
  };
}

function readInput() {
  return {
    requester: requester(), conversationId: 'conversation-1', evidenceId: 'evidence-1',
    startByte: 0, endByte: 7, tokenLimit: 512,
  };
}

function record(overrides: Partial<EvidenceLedgerRecord> = {}): EvidenceLedgerRecord {
  return {
    id: 'evidence-1', conversationId: 'conversation-1', provider: 'codex',
    providerThreadRef: null, providerSessionRef: null, turnRef: null, toolCallRef: null,
    toolName: 'placeholder-tool', sourceKind: 'other', sourceLocatorRedacted: null,
    status: 'complete', blobRef: 'opaque/evidence.aioev1', keyedContentId: 'a'.repeat(64),
    byteCount: 7, tokenEstimate: 2, mimeType: 'text/plain', sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated', captureMode: 'pre-retention',
    captureCompleteness: 'complete', truncationReason: null, keyVersion: 1,
    captureKey: 'capture-key', createdAt: 1, completedAt: 2, updatedAt: 2,
    ...overrides,
  };
}
