import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { ContextCompactor } from './context-compactor';
import { previewCompaction } from './compaction-preview';

const evidenceMocks = vi.hoisted(() => ({
  listEvidence: vi.fn(),
  read: vi.fn(),
  deriveCitationDigest: vi.fn(),
}));

vi.mock('../conversation-ledger', () => ({
  getConversationLedgerService: () => ({ listEvidence: evidenceMocks.listEvidence }),
}));

vi.mock('../context-evidence/evidence-maintenance-service', () => ({
  getContextEvidenceRuntime: () => ({
    blobStore: {
      read: evidenceMocks.read,
      deriveCitationDigest: evidenceMocks.deriveCitationDigest,
    },
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function message(overrides: Partial<OutputMessage> & Pick<OutputMessage, 'type' | 'content'>): OutputMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    outputBuffer: [],
    contextUsage: { used: 0, total: 100_000, percentage: 0 },
    ...overrides,
  } as unknown as Instance;
}

function makeInstanceManager(overrides: {
  instance?: Instance | undefined;
  capabilities?: { supportsNativeCompaction?: boolean } | null;
} = {}): InstanceManager {
  return {
    getInstance: vi.fn(() => overrides.instance),
    getAdapterRuntimeCapabilities: vi.fn(() => overrides.capabilities ?? null),
  } as unknown as InstanceManager;
}

function makeEvidenceRecord(byteCount: number): EvidenceLedgerRecord {
  return {
    id: 'evidence-1',
    conversationId: 'conv-1',
    provider: 'codex',
    providerThreadRef: null,
    providerSessionRef: null,
    turnRef: null,
    toolCallRef: null,
    toolName: 'read_file',
    sourceKind: 'file',
    sourceLocatorRedacted: null,
    status: 'complete',
    blobRef: 'opaque/evidence-1.aioev1',
    keyedContentId: 'c'.repeat(64),
    byteCount,
    tokenEstimate: null,
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'post-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: 1,
    captureKey: 'capture-1',
    createdAt: 1,
    completedAt: 2,
    updatedAt: 2,
  };
}

describe('previewCompaction', () => {
  beforeEach(() => {
    ContextCompactor._resetForTesting();
    evidenceMocks.listEvidence.mockReset();
    evidenceMocks.listEvidence.mockResolvedValue([]);
    evidenceMocks.read.mockReset();
    evidenceMocks.deriveCitationDigest.mockReset();
  });

  it('returns mode unavailable with an honest note when the instance no longer exists', async () => {
    const instanceManager = makeInstanceManager({ instance: undefined });
    const preview = await previewCompaction(instanceManager, 'gone', { keepLatestExchanges: 2 });

    expect(preview.mode).toBe('unavailable');
    expect(preview.affectedRange).toEqual({ fromIndex: 0, toIndex: -1, messageCount: 0 });
    expect(preview.note).toMatch(/no longer exists/);
    // Echoes the caller's requested boundary even when unavailable.
    expect(preview.keepLatestExchanges).toBe(2);
  });

  it('returns mode adapter-self-managed and defers honestly when the provider self-manages compaction', async () => {
    const instance = makeInstance({
      outputBuffer: [message({ type: 'user', content: 'hi' })],
      contextUsage: { used: 42_000, total: 100_000, percentage: 42, isEstimated: false },
    });
    const instanceManager = makeInstanceManager({
      instance,
      capabilities: { supportsNativeCompaction: true },
    });

    const preview = await previewCompaction(instanceManager, 'inst-1');

    expect(preview.mode).toBe('adapter-self-managed');
    expect(preview.affectedRange).toEqual({ fromIndex: 0, toIndex: -1, messageCount: 0 });
    expect(preview.keptVerbatimCount).toBe(0);
    expect(preview.tokenEstimate).toEqual({ value: 42_000, source: 'measured' });
    expect(preview.note).toMatch(/manages context compaction internally/);
  });

  it('labels the self-managed token estimate heuristic when contextUsage is itself an estimate', async () => {
    const instance = makeInstance({
      contextUsage: { used: 1000, total: 100_000, percentage: 1, isEstimated: true },
    });
    const instanceManager = makeInstanceManager({
      instance,
      capabilities: { supportsNativeCompaction: true },
    });

    const preview = await previewCompaction(instanceManager, 'inst-1');
    expect(preview.tokenEstimate.source).toBe('heuristic');
  });

  it('is a pure read: two consecutive calls never mutate instance or compactor state', async () => {
    const instance = makeInstance({
      outputBuffer: [
        message({ type: 'user', content: 'Build the widget.' }),
        message({ type: 'assistant', content: 'Working on it.' }),
        message({ type: 'user', content: 'Also add tests.' }),
        message({ type: 'assistant', content: 'Added tests.' }),
      ],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });
    const bufferSnapshot = JSON.stringify(instance.outputBuffer);
    const compactorStateBefore = ContextCompactor.getInstance().getState();

    const first = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 1 });
    const second = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 1 });

    expect(JSON.stringify(instance.outputBuffer)).toBe(bufferSnapshot);
    expect(ContextCompactor.getInstance().getState()).toEqual(compactorStateBefore);
    expect(second).toEqual(first);
  });

  it('computes the affected range and kept count for an explicit keepLatestExchanges boundary', async () => {
    const instance = makeInstance({
      outputBuffer: [
        message({ type: 'user', content: 'one' }),
        message({ type: 'assistant', content: 'two' }),
        message({ type: 'user', content: 'three' }),
        message({ type: 'assistant', content: 'four' }),
        message({ type: 'user', content: 'five' }),
        message({ type: 'assistant', content: 'six' }),
      ],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 1 });

    expect(preview.mode).toBe('aio-managed');
    expect(preview.totalMessageCount).toBe(6);
    expect(preview.totalExchangeCount).toBe(3);
    // Exchange 2 ("three"/"four") is the last exchange the boundary cuts, so
    // its opening user turn ("three", index 2) is rescued by the
    // always-protect-most-recent-user-turn rule — leaving a real (not a bug)
    // hole in the affected indices at 2. fromIndex/toIndex bound the span;
    // messageCount is the authoritative affected count.
    expect(preview.affectedRange).toEqual({ fromIndex: 0, toIndex: 3, messageCount: 3 });
    expect(preview.keptVerbatimCount).toBe(3);
    expect(preview.keepLatestExchanges).toBe(1);
    expect(preview.protectedItems.mostRecentUserTurnProtected).toBe(true);
  });

  it('N=0 still protects the single most recent user turn and reports it as rescued', async () => {
    const instance = makeInstance({
      outputBuffer: [
        message({ type: 'user', content: 'one' }),
        message({ type: 'assistant', content: 'two' }),
        message({ type: 'user', content: 'three' }),
        message({ type: 'assistant', content: 'four' }),
      ],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 0 });

    expect(preview.affectedRange.messageCount).toBe(3);
    expect(preview.keptVerbatimCount).toBe(1);
    expect(preview.protectedItems.mostRecentUserTurnProtected).toBe(true);
  });

  it('N >= total exchanges keeps everything verbatim (nothing to summarize)', async () => {
    const instance = makeInstance({
      outputBuffer: [
        message({ type: 'user', content: 'one' }),
        message({ type: 'assistant', content: 'two' }),
      ],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 50 });

    expect(preview.affectedRange).toEqual({ fromIndex: 0, toIndex: -1, messageCount: 0 });
    expect(preview.keptVerbatimCount).toBe(2);
    expect(preview.tokenEstimate.value).toBe(0);
  });

  it('handles an empty transcript without error', async () => {
    const instance = makeInstance({ outputBuffer: [] });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1', { keepLatestExchanges: 3 });

    expect(preview.mode).toBe('aio-managed');
    expect(preview.totalMessageCount).toBe(0);
    expect(preview.totalExchangeCount).toBe(0);
    expect(preview.affectedRange).toEqual({ fromIndex: 0, toIndex: -1, messageCount: 0 });
    expect(preview.keptVerbatimCount).toBe(0);
  });

  it('falls back to the compactor default preserveRecent when no boundary is given', async () => {
    ContextCompactor.getInstance().updateConfig({ preserveRecent: 2 });
    const instance = makeInstance({
      outputBuffer: [
        message({ type: 'user', content: 'one' }),
        message({ type: 'assistant', content: 'two' }),
        message({ type: 'user', content: 'three' }),
        message({ type: 'assistant', content: 'four' }),
      ],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1');

    // preserveRecent=2 keeps the trailing 2 messages, but the
    // most-recent-user-turn rescue rule pulls the opening user turn of the
    // cut exchange ("one", index 0) back out of the affected set too.
    expect(preview.keptVerbatimCount).toBe(3);
    expect(preview.affectedRange).toEqual({ fromIndex: 1, toIndex: 1, messageCount: 1 });
    // Echoed keepLatestExchanges reflects the default's exchange span.
    expect(preview.keepLatestExchanges).toBe(1);
  });

  it('reports authenticated evidence preservation only when the ledger has replayable evidence', async () => {
    const content = new TextEncoder().encode('authenticated body');
    evidenceMocks.listEvidence.mockResolvedValue([makeEvidenceRecord(content.byteLength)]);
    evidenceMocks.read.mockResolvedValue(Uint8Array.from(content));
    evidenceMocks.deriveCitationDigest.mockResolvedValue('d'.repeat(64));

    const instance = makeInstance({
      contextEvidence: { mode: 'enforce', conversationId: 'conv-1', captureFailureCount: 0 },
      outputBuffer: [message({ type: 'user', content: 'hi' })],
    });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1');
    expect(preview.protectedItems.authenticatedEvidencePreserved).toBe(true);
  });

  it('reports no authenticated evidence when the instance has no evidence-tracked conversation', async () => {
    const instance = makeInstance({ outputBuffer: [message({ type: 'user', content: 'hi' })] });
    const instanceManager = makeInstanceManager({ instance, capabilities: { supportsNativeCompaction: false } });

    const preview = await previewCompaction(instanceManager, 'inst-1');
    expect(preview.protectedItems.authenticatedEvidencePreserved).toBe(false);
    expect(evidenceMocks.listEvidence).not.toHaveBeenCalled();
  });
});
