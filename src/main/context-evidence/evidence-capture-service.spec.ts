import { describe, expect, it, vi } from 'vitest';
import type { EvidenceBlobWriteResult } from './evidence-storage.types';
import type {
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceStageInput,
} from '../conversation-ledger/context-evidence-ledger.types';
import {
  EvidenceCaptureService,
  type EvidenceCaptureBlobStore,
  type EvidenceCaptureLedger,
  type EvidenceCaptureServiceInput,
} from './evidence-capture-service';

const content = new TextEncoder().encode('fixture evidence content');
const blobResult: EvidenceBlobWriteResult = {
  blobRef: `${'a'.repeat(64)}/${'b'.repeat(32)}.aioev1`,
  keyedContentId: 'c'.repeat(64),
  byteCount: content.byteLength,
  keyVersion: 1,
};

function request(overrides: Partial<EvidenceCaptureServiceInput> = {}): EvidenceCaptureServiceInput {
  return {
    captureKey: 'turn-1:call-1:result',
    conversationId: 'conversation-1',
    provider: 'codex',
    turnRef: 'turn-1',
    toolCallRef: 'call-1',
    toolName: 'exec_command',
    sourceKind: 'command',
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'pre-retention',
    captureCompleteness: 'complete',
    content,
    observedBoundary: 'before-provider-retention',
    ...overrides,
  };
}

function stagingRecord(input: EvidenceStageInput, id = input.id ?? 'evidence-1'): EvidenceLedgerRecord {
  const createdAt = input.createdAt ?? 100;
  return {
    id,
    conversationId: input.conversationId,
    provider: input.provider,
    providerThreadRef: input.providerThreadRef ?? null,
    providerSessionRef: input.providerSessionRef ?? null,
    turnRef: input.turnRef ?? null,
    toolCallRef: input.toolCallRef ?? null,
    toolName: input.toolName,
    sourceKind: input.sourceKind,
    sourceLocatorRedacted: input.sourceLocatorRedacted ?? null,
    status: 'staging',
    blobRef: null,
    keyedContentId: null,
    byteCount: 0,
    tokenEstimate: null,
    mimeType: input.mimeType,
    sensitivity: input.sensitivity,
    provenanceTrust: input.provenanceTrust,
    captureMode: input.captureMode,
    captureCompleteness: input.captureCompleteness,
    truncationReason: input.truncationReason ?? null,
    keyVersion: null,
    captureKey: input.captureKey,
    createdAt,
    completedAt: null,
    updatedAt: createdAt,
  };
}

function completeRecord(
  input: EvidenceStageInput,
  result: EvidenceBlobWriteResult = blobResult,
): EvidenceLedgerRecord {
  return {
    ...stagingRecord(input),
    status: 'complete',
    blobRef: result.blobRef,
    keyedContentId: result.keyedContentId,
    byteCount: result.byteCount,
    keyVersion: result.keyVersion,
    completedAt: 200,
    updatedAt: 200,
  };
}

function createHarness(options: {
  stage?: (input: EvidenceStageInput) => Promise<EvidenceLedgerRecord>;
  prepare?: (input: EvidenceFinalizeInput) => Promise<EvidenceLedgerRecord>;
  write?: EvidenceCaptureBlobStore['write'];
  finalize?: (input: EvidenceFinalizeInput) => Promise<EvidenceLedgerRecord>;
  deriveContentId?: EvidenceCaptureBlobStore['deriveContentId'];
} = {}) {
  const order: string[] = [];
  let staged: EvidenceLedgerRecord | null = null;
  const ledger: EvidenceCaptureLedger = {
    stageEvidence: vi.fn(async (input) => {
      order.push('metadata-stage');
      staged = options.stage ? await options.stage(input) : stagingRecord(input);
      return staged;
    }),
    prepareEvidenceBlob: vi.fn(async (input) => {
      order.push('metadata-prepare');
      if (options.prepare) return options.prepare(input);
      if (!staged) throw new Error('fixture missing stage');
      staged = {
        ...staged,
        blobRef: input.blobRef,
        keyedContentId: input.keyedContentId,
        byteCount: input.byteCount,
        tokenEstimate: input.tokenEstimate ?? null,
        keyVersion: input.keyVersion,
      };
      return staged;
    }),
    finalizeEvidence: vi.fn(async (input) => {
      order.push('metadata-finalize');
      if (options.finalize) return options.finalize(input);
      if (!staged) throw new Error('fixture missing stage');
      return completeRecord({
        ...request(),
        id: staged.id,
        sensitivity: staged.sensitivity,
        captureMode: staged.captureMode,
      });
    }),
    failEvidence: vi.fn(async (input) => {
      order.push('metadata-fail');
      if (!staged) throw new Error('fixture missing stage');
      staged = { ...staged, status: input.status ?? 'failed' };
      return staged;
    }),
  };
  const blobStore: EvidenceCaptureBlobStore = {
    write: options.write ?? vi.fn(async (_conversationId, _bytes, onStaged) => {
      order.push('blob-stage-fsync');
      await onStaged?.(blobResult);
      order.push('blob-rename');
      return blobResult;
    }),
    deriveContentId: options.deriveContentId ?? vi.fn(async () => blobResult.keyedContentId),
  };
  return {
    service: new EvidenceCaptureService({ ledger, blobStore, now: () => 200 }),
    ledger,
    blobStore,
    order,
  };
}

describe('EvidenceCaptureService', () => {
  it('orders metadata stage, encrypted staging/fsync, prepared metadata, rename, then finalization', async () => {
    const harness = createHarness();

    const result = await harness.service.capture(request());

    expect(result.status).toBe('captured');
    expect(harness.order).toEqual([
      'metadata-stage',
      'blob-stage-fsync',
      'metadata-prepare',
      'blob-rename',
      'metadata-finalize',
    ]);
  });

  it('does not write a blob when metadata staging fails', async () => {
    const harness = createHarness({
      stage: async () => { throw new Error('fixture sqlite detail'); },
    });

    const result = await harness.service.capture(request());

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CAPTURE_STAGE_FAILED' });
    expect(harness.blobStore.write).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sqlite detail');
  });

  it.each(['BLOB_WRITE_FAILED', 'DISK_FULL', 'FSYNC_FAILED']) (
    'marks the staged receipt failed after a content-free %s blob failure',
    async (code) => {
      const harness = createHarness({
        write: vi.fn(async () => { throw Object.assign(new Error('fixture raw detail'), { code }); }),
      });

      const result = await harness.service.capture(request());

      expect(result).toMatchObject({ status: 'failed', errorCode: code });
      expect(harness.ledger.failEvidence).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain('raw detail');
    },
  );

  it('fails the staged receipt when prepared metadata cannot commit before rename', async () => {
    const harness = createHarness({
      prepare: async () => { throw new Error('fixture prepare detail'); },
    });

    const result = await harness.service.capture(request());

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CAPTURE_BLOB_WRITE_FAILED' });
    expect(harness.ledger.failEvidence).toHaveBeenCalledOnce();
    expect(harness.order).not.toContain('blob-rename');
    expect(JSON.stringify(result)).not.toContain('prepare detail');
  });

  it('leaves prepared metadata recoverable when finalization fails after rename', async () => {
    const harness = createHarness({
      finalize: async () => { throw new Error('fixture finalize detail'); },
    });

    const result = await harness.service.capture(request());

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CAPTURE_FINALIZE_PENDING' });
    expect(harness.ledger.prepareEvidenceBlob).toHaveBeenCalledOnce();
    expect(harness.ledger.failEvidence).not.toHaveBeenCalled();
    expect(harness.order).toEqual([
      'metadata-stage',
      'blob-stage-fsync',
      'metadata-prepare',
      'blob-rename',
      'metadata-finalize',
    ]);
  });

  it('upgrades sensitivity when secret detection matches without exposing match details', async () => {
    const secretFixture = new TextEncoder().encode(
      `token=ghp_${'A'.repeat(40)}`,
    );
    const harness = createHarness();

    const result = await harness.service.capture(request({ content: secretFixture }));

    expect(harness.ledger.stageEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: 'sensitive' }),
    );
    expect(result.status).toBe('captured');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('scans valid UTF-8 secrets regardless of MIME classification', async () => {
    const secretFixture = new TextEncoder().encode(
      `token=ghp_${'A'.repeat(40)}`,
    );
    const harness = createHarness();

    const result = await harness.service.capture(request({
      content: secretFixture,
      mimeType: 'application/octet-stream',
    }));

    expect(harness.ledger.stageEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: 'sensitive' }),
    );
    expect(result.status).toBe('captured');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('downgrades an impossible pre-retention claim to truthful post-retention capture', async () => {
    const harness = createHarness();

    await harness.service.capture(request({ observedBoundary: 'after-provider-retention' }));

    expect(harness.ledger.stageEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ captureMode: 'post-retention' }),
    );
  });

  it('rejects incomplete capture metadata without an explicit limitation disclosure', async () => {
    const harness = createHarness();

    const result = await harness.service.capture(request({
      captureCompleteness: 'bounded',
      truncationReason: undefined,
    }));

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CAPTURE_INVALID_REQUEST' });
    expect(harness.ledger.stageEvidence).not.toHaveBeenCalled();
    expect(harness.blobStore.write).not.toHaveBeenCalled();
  });

  it('returns an idempotent duplicate only when capture key and keyed content identity match', async () => {
    const original = request();
    const stageInput = { ...original, content: undefined as never, id: 'existing-evidence' };
    const existing = completeRecord(stageInput);
    const matching = createHarness({ stage: async () => existing });
    const divergent = createHarness({
      stage: async () => existing,
      deriveContentId: vi.fn(async () => 'd'.repeat(64)),
    });

    await expect(matching.service.capture(original)).resolves.toMatchObject({ status: 'duplicate' });
    await expect(divergent.service.capture(original)).resolves.toEqual({
      status: 'conflict',
      errorCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT',
      disclosure: 'The logical capture key was reused for different authenticated content.',
    });
    expect(matching.blobStore.write).not.toHaveBeenCalled();
    expect(divergent.blobStore.write).not.toHaveBeenCalled();
  });

  it('serializes divergent concurrent captures instead of aliasing the second result', async () => {
    let stored: EvidenceLedgerRecord | null = null;
    const harness = createHarness({
      stage: async (input) => stored ?? stagingRecord(input),
      finalize: async (input) => {
        stored = completeRecord({ ...request(), id: input.evidenceId });
        return stored;
      },
      deriveContentId: vi.fn(async (bytes) =>
        new TextDecoder().decode(bytes).includes('different')
          ? 'd'.repeat(64)
          : blobResult.keyedContentId),
    });

    const [first, second] = await Promise.all([
      harness.service.capture(request()),
      harness.service.capture(request({
        content: new TextEncoder().encode('different authenticated content'),
      })),
    ]);

    expect(first.status).toBe('captured');
    expect(second.status).toBe('conflict');
    expect(harness.blobStore.write).toHaveBeenCalledOnce();
  });
});
