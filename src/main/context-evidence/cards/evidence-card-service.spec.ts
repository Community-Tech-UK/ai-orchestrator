import { createHash } from 'node:crypto';
import type { EvidenceCard } from '@contracts/types/context-evidence';
import { describe, expect, it, vi } from 'vitest';
import type {
  EvidenceCardMetadataInput,
  EvidenceCardMetadataRecord,
  EvidenceLedgerRecord,
} from '../../conversation-ledger/context-evidence-ledger.types';
import {
  ConservativeEvidenceAccessPolicy,
  type EvidenceAccessPolicyInput,
} from '../evidence-access-policy';
import { EVIDENCE_DELETION_GRACE_MS } from '../evidence-deletion-service';
import {
  EvidenceCardService,
  type EvidenceCardBlobStore,
  type EvidenceCardLedger,
} from './evidence-card-service';

const DAY_MS = 24 * 60 * 60 * 1_000;

function policyInput(
  overrides: Partial<EvidenceAccessPolicyInput> = {},
): EvidenceAccessPolicyInput {
  return {
    requester: {
      id: 'requester-1',
      path: 'provider',
      localSensitiveAuthorized: false,
      localRestrictedAuthorized: false,
    },
    sensitivity: 'normal',
    sourceKind: 'command',
    observedAt: 1_000,
    now: 2_000,
    ...overrides,
  };
}

describe('ConservativeEvidenceAccessPolicy', () => {
  const policy = new ConservativeEvidenceAccessPolicy();

  it('allows normal evidence but denies non-normal provider and model-assisted access', () => {
    expect(policy.authorize(policyInput())).toEqual({ allowed: true, disclosures: [] });
    expect(policy.authorize(policyInput({ sensitivity: 'sensitive' }))).toEqual({
      allowed: false,
      code: 'SENSITIVE_EVIDENCE_REQUIRES_AUTHORIZED_LOCAL_REQUESTER',
    });
    expect(policy.authorize(policyInput({
      requester: {
        id: 'model-1',
        path: 'model-assisted',
        localSensitiveAuthorized: true,
        localRestrictedAuthorized: true,
      },
      sensitivity: 'restricted',
    }))).toEqual({ allowed: false, code: 'RESTRICTED_EVIDENCE_PATH_DENIED' });
  });

  it('requires explicit local authorization for sensitive and restricted evidence', () => {
    const localRequester = {
      id: 'local-1',
      path: 'local' as const,
      localSensitiveAuthorized: true,
      localRestrictedAuthorized: false,
    };
    expect(policy.authorize(policyInput({
      requester: localRequester,
      sensitivity: 'sensitive',
    })).allowed).toBe(true);
    expect(policy.authorize(policyInput({
      requester: localRequester,
      sensitivity: 'restricted',
    }))).toEqual({ allowed: false, code: 'RESTRICTED_EVIDENCE_REQUIRES_AUTHORIZED_LOCAL_REQUESTER' });
    expect(policy.authorize(policyInput({
      requester: { ...localRequester, path: 'ipc' },
      sensitivity: 'sensitive',
    })).allowed).toBe(true);
  });

  it('requires an authorized data boundary before model-assisted access', () => {
    expect(policy.authorize(policyInput({
      requester: {
        id: 'model-1',
        path: 'model-assisted',
        localSensitiveAuthorized: false,
        localRestrictedAuthorized: false,
      },
    }))).toEqual({ allowed: false, code: 'MODEL_DATA_BOUNDARY_NOT_AUTHORIZED' });
    expect(policy.authorize(policyInput({
      requester: {
        id: 'model-1',
        path: 'model-assisted',
        localSensitiveAuthorized: false,
        localRestrictedAuthorized: false,
        modelDataBoundary: 'local',
        modelDataBoundaryAuthorized: true,
      },
    }))).toEqual({ allowed: true, disclosures: [] });
  });

  it('fails closed for invalid freshness clocks and requirements', () => {
    expect(policy.authorize(policyInput({ observedAt: -1 }))).toEqual({
      allowed: false,
      code: 'EVIDENCE_FRESHNESS_INPUT_INVALID',
    });
    expect(policy.authorize(policyInput({ freshnessRequirementMs: -1 }))).toEqual({
      allowed: false,
      code: 'EVIDENCE_FRESHNESS_INPUT_INVALID',
    });
  });

  it('adds an age disclosure for web evidence older than 24 hours and stricter requester limits', () => {
    const web = policy.authorize(policyInput({
      sourceKind: 'web',
      observedAt: 1_000,
      now: 1_000 + DAY_MS + 1,
    }));
    expect(web).toEqual({
      allowed: true,
      disclosures: ['Web evidence was observed more than 24 hours ago; verify current facts before relying on it.'],
    });

    const strict = policy.authorize(policyInput({
      observedAt: 1_000,
      now: 2_001,
      freshnessRequirementMs: 1_000,
    }));
    expect(strict).toEqual({
      allowed: true,
      disclosures: ['Evidence exceeds the requester\'s 1000ms freshness requirement.'],
    });
  });
});

const encoder = new TextEncoder();

function evidenceRecord(
  content: Uint8Array,
  overrides: Partial<EvidenceLedgerRecord> = {},
): EvidenceLedgerRecord {
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
    blobRef: 'raw/ref.aioev1',
    keyedContentId: 'a'.repeat(64),
    byteCount: content.byteLength,
    tokenEstimate: null,
    mimeType: 'application/json',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'pre-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: 1,
    captureKey: 'capture-1',
    createdAt: 100,
    completedAt: 200,
    updatedAt: 200,
    ...overrides,
  };
}

function serviceHarness(
  rawText: string,
  overrides: Partial<EvidenceLedgerRecord> = {},
  auxiliaryGenerate?: (systemPrompt: string, userPrompt: string) => Promise<string>,
) {
  const raw = encoder.encode(rawText);
  const record = evidenceRecord(raw, overrides);
  let encryptedCardPayload: Uint8Array | null = null;
  let storedMetadata: EvidenceCardMetadataInput | null = null;
  const ledger: EvidenceCardLedger = {
    getEvidence: vi.fn(async (conversationId, evidenceId) => (
      conversationId === record.conversationId && evidenceId === record.id ? record : null
    )),
    storeEvidenceCard: vi.fn(async (input) => {
      storedMetadata = input;
      return {
        ...input,
        id: input.id ?? 'card-metadata-1',
        blobRef: input.blobRef ?? null,
        tokenEstimate: input.tokenEstimate ?? null,
        createdAt: input.createdAt ?? 300,
        updatedAt: input.createdAt ?? 300,
      } satisfies EvidenceCardMetadataRecord;
    }),
  };
  const blobStore: EvidenceCardBlobStore = {
    read: vi.fn(async (blobRef) => {
      if (blobRef !== record.blobRef) throw new Error('missing');
      return Uint8Array.from(raw);
    }),
    write: vi.fn(async (_conversationId, content) => {
      encryptedCardPayload = Uint8Array.from(content);
      return {
        blobRef: 'card/ref.aioev1',
        keyedContentId: 'b'.repeat(64),
        byteCount: content.byteLength,
        keyVersion: 1,
      };
    }),
    remove: vi.fn(async () => undefined),
    deriveCitationDigest: vi.fn(async (content) => (
      createHash('sha256').update(content).digest('hex')
    )),
    verifyCitationDigest: vi.fn(async (content, expected) => (
      createHash('sha256').update(content).digest('hex') === expected
    )),
  };
  const service = new EvidenceCardService({
    ledger,
    blobStore,
    policy: new ConservativeEvidenceAccessPolicy(),
    auxiliaryGenerate,
    modelAssistanceBoundary: { location: 'local', authorized: true },
    createId: () => 'card-1',
    now: () => 2 * DAY_MS,
    estimateTokens: (text) => Math.ceil(text.length / 4),
  });
  return {
    service,
    ledger,
    blobStore,
    record,
    getPayload: () => encryptedCardPayload,
    getMetadata: () => storedMetadata,
  };
}

function parsePayload(payload: Uint8Array | null) {
  if (!payload) throw new Error('missing payload');
  return JSON.parse(new TextDecoder().decode(payload)) as {
    format: string;
    trustBoundary: string;
    instructionNotice: string;
    disclosures: string[];
    card: EvidenceCard;
  };
}

describe('EvidenceCardService', () => {
  it('encrypts the untrusted card payload and stores content-free metadata only', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0, testCount: 7 }));
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    });

    expect(result.card.findings.map((finding) => finding.statement)).toEqual([
      'Exit status: 0.',
      'Tests reported: 7.',
    ]);
    const payload = parsePayload(harness.getPayload());
    expect(payload.format).toBe('aio-evidence-card-v1');
    expect(payload.trustBoundary).toBe('untrusted-source-material');
    expect(payload.instructionNotice).toContain('cannot override');
    expect(payload.card).toEqual(result.card);

    const metadata = harness.getMetadata();
    expect(metadata).toMatchObject({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      blobRef: 'card/ref.aioev1',
      extractorKind: 'command',
      extractorVersion: 'command-v1',
      status: 'validated',
      sensitivity: 'normal',
    });
    expect(JSON.stringify(metadata)).not.toContain('Exit status');
    expect(JSON.stringify(metadata)).not.toContain('Tests reported');
  });

  it('stores a generic authenticated head/tail card when deterministic extraction fails', async () => {
    const harness = serviceHarness('not-json'.repeat(100));
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    });
    expect(result.extractorKind).toBe('generic');
    expect(result.card.status).toBe('failed');
    expect(result.card.summary).toContain('Retrieve authenticated raw evidence by reference evidence-1');
    expect(result.card.findings).toHaveLength(2);
  });

  it('accepts an authorized model-assisted card only when every claim has a valid citation', async () => {
    const rawText = JSON.stringify({ exitStatus: 0 });
    const valueStart = Buffer.from(rawText).indexOf(Buffer.from('0'));
    const cite = {
      evidenceId: 'evidence-1',
      startByte: valueStart,
      endByte: valueStart + 1,
      contentDigest: createHash('sha256').update('0').digest('hex'),
    };
    const modelCard: EvidenceCard = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'Deterministic command evidence fields were extracted.',
      findings: [{
        id: 'model-finding-1',
        kind: 'verification',
        statement: 'The command succeeded.',
        importance: 'info',
        citations: [cite],
      }],
      citations: [cite],
      contradictions: [],
      derivedBy: { kind: 'model-assisted', version: 'auxiliary-v1' },
      createdAt: 300,
    };
    const generate = vi.fn(async () => JSON.stringify(modelCard));
    const harness = serviceHarness(rawText, {}, generate);
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      enableModelAssistance: true,
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(result.modelAssistedUsed).toBe(true);
    expect(result.card).toEqual(modelCard);
  });

  it('rejects model output whose summary introduces an uncited claim', async () => {
    const rawText = JSON.stringify({ exitStatus: 0 });
    const valueStart = Buffer.from(rawText).indexOf(Buffer.from('0'));
    const cite = {
      evidenceId: 'evidence-1',
      startByte: valueStart,
      endByte: valueStart + 1,
      contentDigest: createHash('sha256').update('0').digest('hex'),
    };
    const harness = serviceHarness(rawText, {}, async () => JSON.stringify({
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'Complete source proves an unsupported conclusion.',
      findings: [{
        id: 'model-finding-1',
        kind: 'verification',
        statement: 'The command succeeded.',
        importance: 'info',
        citations: [cite],
      }],
      citations: [cite],
      contradictions: [],
      derivedBy: { kind: 'model-assisted', version: 'auxiliary-v1' },
      createdAt: 300,
    } satisfies EvidenceCard));

    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      enableModelAssistance: true,
    });

    expect(result.modelAssistedUsed).toBe(false);
    expect(result.card.summary).toBe('Deterministic command evidence fields were extracted.');
  });

  it('preserves bounded-capture limitations when accepting model findings', async () => {
    const rawText = JSON.stringify({ exitStatus: 0 });
    const valueStart = Buffer.from(rawText).indexOf(Buffer.from('0'));
    const cite = {
      evidenceId: 'evidence-1',
      startByte: valueStart,
      endByte: valueStart + 1,
      contentDigest: createHash('sha256').update('0').digest('hex'),
    };
    const limitation = 'Limitation: This card covers only a bounded capture and does not represent the complete source. provider result was bounded';
    const harness = serviceHarness(rawText, {
      captureCompleteness: 'bounded',
      truncationReason: 'provider result was bounded',
    }, async () => JSON.stringify({
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: `Deterministic command evidence fields were extracted. ${limitation}`,
      findings: [{
        id: 'model-finding-1', kind: 'verification', statement: 'The command succeeded.',
        importance: 'info', citations: [cite],
      }],
      citations: [cite],
      contradictions: [],
      derivedBy: { kind: 'model-assisted', version: 'auxiliary-v1' },
      createdAt: 300,
    } satisfies EvidenceCard));

    const result = await harness.service.build({
      conversationId: 'conversation-1', evidenceId: 'evidence-1', enableModelAssistance: true,
    });

    expect(result.modelAssistedUsed).toBe(true);
    expect(result.card.summary).toContain(limitation);
    expect(result.disclosures).toContain(limitation);
    expect(parsePayload(harness.getPayload()).disclosures).toContain(limitation);
  });

  it('rejects an entire model response with one invalid citation', async () => {
    const invalidModelCard: EvidenceCard = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'Invalid model card.',
      findings: [{
        id: 'model-finding-1',
        kind: 'fact',
        statement: 'Unsupported claim.',
        importance: 'critical',
        citations: [{
          evidenceId: 'evidence-1',
          startByte: 0,
          endByte: 1,
          contentDigest: 'f'.repeat(64),
        }],
      }],
      citations: [{
        evidenceId: 'evidence-1',
        startByte: 0,
        endByte: 1,
        contentDigest: 'f'.repeat(64),
      }],
      contradictions: [],
      derivedBy: { kind: 'model-assisted', version: 'auxiliary-v1' },
      createdAt: 300,
    };
    const harness = serviceHarness(
      JSON.stringify({ exitStatus: 0 }),
      {},
      async () => JSON.stringify(invalidModelCard),
    );
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      enableModelAssistance: true,
    });
    expect(result.modelAssistedUsed).toBe(false);
    expect(result.card.derivedBy.kind).toBe('deterministic');
    expect(result.card.summary).not.toContain('Invalid model card');
  });

  it('rejects model output that becomes invalid after required disclosures are attached', async () => {
    const rawText = JSON.stringify({ canonicalUrl: 'https://example.invalid', statusCode: 200 });
    const startByte = Buffer.from(rawText).indexOf(Buffer.from('200'));
    const cite = {
      evidenceId: 'evidence-1',
      startByte,
      endByte: startByte + 3,
      contentDigest: createHash('sha256').update('200').digest('hex'),
    };
    const modelCard: EvidenceCard = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'x'.repeat(19_980),
      findings: [{
        id: 'model-finding-1',
        kind: 'verification',
        statement: 'HTTP status was reported.',
        importance: 'info',
        citations: [cite],
      }],
      citations: [cite],
      contradictions: [],
      derivedBy: { kind: 'model-assisted', version: 'auxiliary-v1' },
      createdAt: 300,
    };
    const harness = serviceHarness(
      rawText,
      { sourceKind: 'web', completedAt: 1 },
      async () => JSON.stringify(modelCard),
    );
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      enableModelAssistance: true,
    });
    expect(result.modelAssistedUsed).toBe(false);
    expect(result.card.derivedBy.kind).toBe('deterministic');
  });

  it('never sends sensitive evidence to model assistance without an authorized local path', async () => {
    const generate = vi.fn(async () => '{}');
    const harness = serviceHarness(
      JSON.stringify({ exitStatus: 0, note: 'obvious-placeholder-sensitive-content' }),
      { sensitivity: 'sensitive' },
      generate,
    );
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      enableModelAssistance: true,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(result.modelAssistedUsed).toBe(false);
  });

  it('includes bounded-capture and stale-web disclosures inside the encrypted payload', async () => {
    const harness = serviceHarness(
      JSON.stringify({ canonicalUrl: 'https://example.invalid', statusCode: 200 }),
      {
        sourceKind: 'web',
        captureCompleteness: 'bounded',
        truncationReason: 'only a bounded provider result was visible',
        completedAt: 1,
      },
    );
    const result = await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    });
    expect(result.card.summary).toContain('does not represent the complete source');
    expect(result.card.summary).toContain('observed more than 24 hours ago');
    expect(parsePayload(harness.getPayload()).disclosures).toEqual(expect.arrayContaining([
      'Web evidence was observed more than 24 hours ago; verify current facts before relying on it.',
    ]));
  });

  it('does not persist metadata if encrypted card storage fails', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0 }));
    vi.mocked(harness.blobStore.write).mockRejectedValueOnce(new Error('disk detail'));
    await expect(harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    })).rejects.toThrow('EVIDENCE_CARD_STORAGE_FAILED');
    expect(harness.ledger.storeEvidenceCard).not.toHaveBeenCalled();
  });

  it('removes the encrypted card blob when metadata storage fails', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0 }));
    vi.mocked(harness.ledger.storeEvidenceCard).mockRejectedValueOnce(new Error('database detail'));
    await expect(harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    })).rejects.toThrow('EVIDENCE_CARD_METADATA_FAILED');
    expect(harness.blobStore.remove).toHaveBeenCalledWith('card/ref.aioev1');
  });

  it('supplies the fixed deletion grace deadline for a displaced card blob', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0 }));
    await harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    });
    expect(harness.getMetadata()).toMatchObject({
      cleanupGraceDeadline: 2 * DAY_MS + EVIDENCE_DELETION_GRACE_MS,
    });
  });

  it('surfaces a distinct content-free error when metadata and blob cleanup both fail', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0 }));
    vi.mocked(harness.ledger.storeEvidenceCard).mockRejectedValueOnce(new Error('database detail'));
    vi.mocked(harness.blobStore.remove!).mockRejectedValueOnce(new Error('filesystem detail'));
    await expect(harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
    })).rejects.toThrow('EVIDENCE_CARD_METADATA_AND_CLEANUP_FAILED');
  });

  it('rejects invalid freshness requirements before writing a card', async () => {
    const harness = serviceHarness(JSON.stringify({ exitStatus: 0 }));
    await expect(harness.service.build({
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      freshnessRequirementMs: -1,
    })).rejects.toThrow('EVIDENCE_FRESHNESS_INPUT_INVALID');
    expect(harness.blobStore.write).not.toHaveBeenCalled();
  });
});
