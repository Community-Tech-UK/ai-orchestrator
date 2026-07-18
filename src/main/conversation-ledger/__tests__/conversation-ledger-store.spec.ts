import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runConversationLedgerMigrations } from '../conversation-ledger-schema';
import { ConversationLedgerStore } from '../conversation-ledger-store';

describe('ConversationLedgerStore', () => {
  let db: SqliteDriver;
  let store: ConversationLedgerStore;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
    runConversationLedgerMigrations(db);
    store = new ConversationLedgerStore(db);
  });

  it('upserts threads idempotently by provider/native id and round-trips metadata', () => {
    const first = store.upsertThread({
      provider: 'codex',
      nativeThreadId: 'native-1',
      sourceKind: 'provider-native',
      workspacePath: '/tmp/project',
      metadata: { a: 1 },
    });
    const second = store.upsertThread({
      provider: 'codex',
      nativeThreadId: 'native-1',
      sourceKind: 'provider-native',
      title: 'Renamed',
      metadata: { b: 2 },
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Renamed');
    expect(second.metadata).toEqual({ a: 1, b: 2 });
  });

  it('upserts messages with stable ordering and native-message de-dupe', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertMessages(thread.id, [
      { nativeMessageId: 'msg-2', role: 'assistant', content: 'second', sequence: 2, rawJson: { b: 2 } },
      { nativeMessageId: 'msg-1', role: 'user', content: 'first', sequence: 1, rawJson: { a: 1 } },
      { nativeMessageId: 'msg-1', role: 'user', content: 'first edited', sequence: 1, rawJson: { c: 3 } },
    ]);

    const messages = store.getMessages(thread.id);
    expect(messages.map(message => message.content)).toEqual(['first edited', 'second']);
    expect(messages[0]!.rawJson).toEqual({ c: 3 });
  });

  it('upserts cursors by thread and kind', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertSyncCursor({
      threadId: thread.id,
      provider: 'codex',
      cursorKind: 'rollout',
      cursorValue: '1',
    });
    store.upsertSyncCursor({
      threadId: thread.id,
      provider: 'codex',
      cursorKind: 'rollout',
      cursorValue: '2',
    });

    expect(store.getSyncCursors(thread.id)).toMatchObject([{ cursorKind: 'rollout', cursorValue: '2' }]);
  });

  it('rolls back replace imports when a replacement message violates sequence uniqueness', () => {
    const thread = store.upsertThread({ provider: 'codex', nativeThreadId: 'native-1', sourceKind: 'provider-native' });
    store.upsertMessages(thread.id, [
      { role: 'user', content: 'original', sequence: 1 },
    ]);

    expect(() => store.replaceThreadMessagesFromImport(thread.id, [
      { role: 'user', content: 'new-1', sequence: 1 },
      { role: 'assistant', content: 'new-2', sequence: 1 },
    ])).toThrow();

    expect(store.getMessages(thread.id).map(message => message.content)).toEqual(['original']);
  });

  describe('appendMessagesWithThreadTouch', () => {
    it('assigns contiguous sequences, returns the appended records, and touches the thread', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'native-1', sourceKind: 'orchestrator', updatedAt: 1 });
      store.upsertMessages(thread.id, [{ role: 'user', content: 'first', sequence: 1 }]);

      const records = store.appendMessagesWithThreadTouch(thread.id, [
        { nativeMessageId: 'a', role: 'assistant', content: 'second' },
        { nativeMessageId: 'b', role: 'tool', content: 'third' },
      ]);

      expect(records).not.toBeNull();
      expect(records!.map(r => r.content)).toEqual(['second', 'third']);
      expect(records!.map(r => r.sequence)).toEqual([2, 3]);
      // Persisted transcript reflects the batch in order.
      expect(store.getMessages(thread.id).map(m => m.content)).toEqual(['first', 'second', 'third']);
      // Thread updated_at advanced past its seeded value.
      expect(store.findThreadById(thread.id)!.updatedAt).toBeGreaterThan(1);
    });

    it('returns null when the thread does not exist (no write)', () => {
      const records = store.appendMessagesWithThreadTouch('missing-thread', [
        { role: 'user', content: 'x' },
      ]);
      expect(records).toBeNull();
    });

    it('is a no-op returning [] for an empty batch', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      expect(store.appendMessagesWithThreadTouch(thread.id, [])).toEqual([]);
    });
  });

  describe('getRecentMessages', () => {
    it('returns the last N messages in ascending sequence order', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.upsertMessages(thread.id, [
        { role: 'user', content: 'm1', sequence: 1 },
        { role: 'assistant', content: 'm2', sequence: 2 },
        { role: 'user', content: 'm3', sequence: 3 },
        { role: 'assistant', content: 'm4', sequence: 4 },
      ]);

      expect(store.getRecentMessages(thread.id, 2).map(m => m.content)).toEqual(['m3', 'm4']);
      expect(store.getRecentMessages(thread.id, 10).map(m => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
    });
  });

  describe('hasMessageWithNativeId', () => {
    it('reports existence by native message id without loading the transcript', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.upsertMessages(thread.id, [
        { nativeMessageId: 'evt-1', role: 'system', content: 'x', sequence: 1 },
      ]);

      expect(store.hasMessageWithNativeId(thread.id, 'evt-1')).toBe(true);
      expect(store.hasMessageWithNativeId(thread.id, 'evt-2')).toBe(false);
    });
  });

  describe('conversation checkpoints (§4.4)', () => {
    it('returns null when no checkpoint exists', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      expect(store.getLatestCheckpoint(thread.id)).toBeNull();
    });

    it('writes a checkpoint and reads it back', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      const written = store.writeCheckpoint(thread.id, {
        upToSequence: 10,
        upToNativeId: 'msg-10',
        summary: 'Earlier work summary.',
        summarizedMessageCount: 10,
        summaryTokens: 4,
      });
      expect(written.threadId).toBe(thread.id);
      expect(store.getLatestCheckpoint(thread.id)).toMatchObject({
        upToSequence: 10,
        upToNativeId: 'msg-10',
        summary: 'Earlier work summary.',
        summarizedMessageCount: 10,
      });
    });

    it('upserts (replaces) on the same upToSequence rather than duplicating', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.writeCheckpoint(thread.id, {
        upToSequence: 5, upToNativeId: 'm5', summary: 'v1', summarizedMessageCount: 5, summaryTokens: 1,
      });
      store.writeCheckpoint(thread.id, {
        upToSequence: 5, upToNativeId: 'm5', summary: 'v2', summarizedMessageCount: 5, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(thread.id)?.summary).toBe('v2');
    });

    it('getLatestCheckpoint returns the one covering the largest prefix', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'n', sourceKind: 'orchestrator' });
      store.writeCheckpoint(thread.id, {
        upToSequence: 20, upToNativeId: 'm20', summary: 'later', summarizedMessageCount: 20, summaryTokens: 1,
      });
      store.writeCheckpoint(thread.id, {
        upToSequence: 10, upToNativeId: 'm10', summary: 'earlier', summarizedMessageCount: 10, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(thread.id)?.upToSequence).toBe(20);
    });

    it('isolates checkpoints per thread', () => {
      const a = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'a', sourceKind: 'orchestrator' });
      const b = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'b', sourceKind: 'orchestrator' });
      store.writeCheckpoint(a.id, {
        upToSequence: 3, upToNativeId: 'a3', summary: 'A', summarizedMessageCount: 3, summaryTokens: 1,
      });
      expect(store.getLatestCheckpoint(a.id)?.summary).toBe('A');
      expect(store.getLatestCheckpoint(b.id)).toBeNull();
    });
  });

  describe('provider event captures', () => {
    it('serializes cyclic canonical metadata without losing the capture batch', () => {
      const metadata: Record<string, unknown> = {};
      metadata['self'] = metadata;

      expect(() => store.appendProviderEventCaptures([
        {
          eventId: 'cyclic-event', provider: 'claude', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 1,
          event: { kind: 'output', content: 'safe', metadata },
          raw: { source: 'adapter-event:output', payload: { message: 'safe' } },
        },
      ])).not.toThrow();

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })[0]?.event).toMatchObject({
        kind: 'output',
        metadata: { self: { type: 'circular' } },
      });
    });

    it('serializes a cyclic raw payload without losing the capture batch', () => {
      const payload: Record<string, unknown> = {};
      payload['self'] = payload;

      expect(() => store.appendProviderEventCaptures([
        {
          eventId: 'cyclic-raw-event', provider: 'claude', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 1,
          event: { kind: 'status', status: 'busy' },
          raw: { source: 'adapter-event:status', payload },
        },
      ])).not.toThrow();

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })[0]?.raw).toEqual({
        source: 'adapter-event:status',
        payload: { self: { type: 'circular' } },
      });
    });

    it('stores raw-backed canonical events independently of conversation threads', () => {
      store.appendProviderEventCaptures([
        {
          eventId: 'evt-1',
          provider: 'claude',
          instanceId: 'instance-1',
          sessionId: 'session-1',
          sequence: 4,
          createdAt: 100,
          event: { kind: 'output', content: 'hello' },
          raw: { source: 'adapter-event:output', payload: { nativeId: 'n-1', text: 'hello' } },
        },
      ]);

      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' })).toEqual([
        expect.objectContaining({
          eventId: 'evt-1',
          provider: 'claude',
          sequence: 4,
          event: { kind: 'output', content: 'hello' },
          raw: { source: 'adapter-event:output', payload: { nativeId: 'n-1', text: 'hello' } },
        }),
      ]);
    });

    it('prunes only captures older than the supplied retention boundary', () => {
      store.appendProviderEventCaptures([
        {
          eventId: 'old', provider: 'codex', instanceId: 'instance-1', sessionId: null,
          sequence: 0, createdAt: 10, event: { kind: 'status', status: 'busy' },
          raw: { source: 'adapter-event:status', payload: 'busy' },
        },
        {
          eventId: 'fresh', provider: 'codex', instanceId: 'instance-1', sessionId: null,
          sequence: 1, createdAt: 100, event: { kind: 'status', status: 'idle' },
          raw: { source: 'adapter-event:status', payload: 'idle' },
        },
      ]);

      expect(store.pruneProviderEventCapturesBefore(50)).toBe(1);
      expect(store.listProviderEventCaptures({ instanceId: 'instance-1' }).map((capture) => capture.eventId))
        .toEqual(['fresh']);
    });
  });

  describe('context evidence metadata', () => {
    it('stages and finalizes evidence idempotently while rejecting divergent content', () => {
      const thread = store.upsertThread({
        provider: 'orchestrator',
        nativeThreadId: 'evidence-thread',
        sourceKind: 'orchestrator',
      });
      const staged = store.contextEvidence.stageEvidence({
        id: 'evidence-1',
        conversationId: thread.id,
        provider: 'codex',
        providerThreadRef: 'native-provenance-only',
        toolName: 'placeholder-tool',
        sourceKind: 'other',
        mimeType: 'text/plain',
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureMode: 'post-retention',
        captureCompleteness: 'complete',
        captureKey: 'turn-1:tool-1',
        createdAt: 10,
      });

      expect(staged.status).toBe('staging');
      expect(store.contextEvidence.listEvidence(thread.id)).toEqual([]);

      const complete = store.contextEvidence.finalizeEvidence({
        evidenceId: staged.id,
        conversationId: thread.id,
        blobRef: 'opaque/ref-1.aioev',
        keyedContentId: 'a'.repeat(64),
        byteCount: 42,
        tokenEstimate: 11,
        keyVersion: 1,
        completedAt: 20,
      });
      expect(complete).toMatchObject({ status: 'complete', byteCount: 42 });
      expect(store.contextEvidence.listEvidence(thread.id)).toHaveLength(1);

      const duplicateStage = store.contextEvidence.stageEvidence({
        id: 'evidence-duplicate',
        conversationId: thread.id,
        provider: 'codex',
        toolName: 'placeholder-tool',
        sourceKind: 'other',
        mimeType: 'text/plain',
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureMode: 'post-retention',
        captureCompleteness: 'complete',
        captureKey: 'turn-1:tool-1',
        createdAt: 30,
      });
      expect(duplicateStage.id).toBe(staged.id);
      expect(store.contextEvidence.finalizeEvidence({
        evidenceId: duplicateStage.id,
        conversationId: thread.id,
        blobRef: 'opaque/ref-1.aioev',
        keyedContentId: 'a'.repeat(64),
        byteCount: 42,
        tokenEstimate: 11,
        keyVersion: 1,
        completedAt: 30,
      }).id).toBe(staged.id);
      expect(() => store.contextEvidence.finalizeEvidence({
        evidenceId: duplicateStage.id,
        conversationId: thread.id,
        blobRef: 'opaque/ref-conflict.aioev',
        keyedContentId: 'b'.repeat(64),
        byteCount: 42,
        tokenEstimate: 11,
        keyVersion: 1,
        completedAt: 31,
      })).toThrow('EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT');
    });

    it('scopes reads to the canonical conversation and excludes non-readable states', () => {
      const left = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'left', sourceKind: 'orchestrator' });
      const right = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'right', sourceKind: 'orchestrator' });
      const staged = store.contextEvidence.stageEvidence({
        id: 'left-complete', conversationId: left.id, provider: 'codex', toolName: 'placeholder-tool',
        sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', captureKey: 'left-complete', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: staged.id, conversationId: left.id, blobRef: 'opaque/left.aioev',
        keyedContentId: 'c'.repeat(64), byteCount: 1, keyVersion: 1, completedAt: 2,
      });
      store.contextEvidence.stageEvidence({
        id: 'left-staging', conversationId: left.id, provider: 'codex', toolName: 'placeholder-tool',
        sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', captureKey: 'left-staging', createdAt: 3,
      });

      expect(store.contextEvidence.getEvidence(left.id, staged.id)?.id).toBe(staged.id);
      expect(store.contextEvidence.getEvidence(right.id, staged.id)).toBeNull();
      expect(store.contextEvidence.listEvidence(left.id).map(record => record.id)).toEqual([staged.id]);
      expect(store.contextEvidence.listEvidence(left.id, { includeMaintenanceStates: true }).map(record => record.id))
        .toEqual([staged.id, 'left-staging']);
      expect(store.contextEvidence.searchEvidenceMetadata(left.id, { text: 'placeholder' }))
        .toEqual([expect.objectContaining({ id: staged.id })]);
      expect(store.contextEvidence.searchEvidenceMetadata(right.id, { text: 'placeholder' }))
        .toEqual([]);
      expect(store.contextEvidence.authorizeEvidenceRange({
        conversationId: left.id, evidenceId: staged.id, startByte: 0, endByte: 1,
      })).toMatchObject({
        authorized: true,
        blobRef: 'opaque/left.aioev',
        keyedContentId: 'c'.repeat(64),
        keyVersion: 1,
      });
      expect(store.contextEvidence.authorizeEvidenceRange({
        conversationId: right.id, evidenceId: staged.id, startByte: 0, endByte: 1,
      })).toEqual({ authorized: false, reason: 'not-found' });
      expect(store.contextEvidence.authorizeEvidenceRange({
        conversationId: left.id, evidenceId: staged.id, startByte: 0, endByte: 2,
      })).toEqual({ authorized: false, reason: 'range-out-of-bounds' });
    });

    it('prepares authenticated blob metadata while retaining staging state for crash recovery', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'prepared', sourceKind: 'orchestrator' });
      const staged = store.contextEvidence.stageEvidence({
        id: 'prepared-evidence', conversationId: thread.id, provider: 'codex',
        toolName: 'tool', sourceKind: 'other', mimeType: 'text/plain',
        sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
        captureMode: 'pre-retention', captureCompleteness: 'complete',
        captureKey: 'prepared-key', createdAt: 1,
      });

      const prepared = store.contextEvidence.prepareEvidenceBlob({
        evidenceId: staged.id, conversationId: thread.id, blobRef: 'opaque/prepared.aioev',
        keyedContentId: 'a'.repeat(64), byteCount: 4, keyVersion: 1, completedAt: 2,
      });

      expect(prepared).toMatchObject({
        status: 'staging', blobRef: 'opaque/prepared.aioev', keyedContentId: 'a'.repeat(64),
      });
      expect(store.contextEvidence.listEvidence(thread.id)).toEqual([]);
    });

    it('lists maintenance rows globally and atomically replaces one authenticated blob version', () => {
      const thread = store.upsertThread({
        provider: 'orchestrator', nativeThreadId: 'maintenance', sourceKind: 'orchestrator',
      });
      const staged = store.contextEvidence.stageEvidence({
        id: 'maintenance-evidence', conversationId: thread.id, provider: 'codex',
        toolName: 'tool', sourceKind: 'other', mimeType: 'text/plain',
        sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
        captureMode: 'pre-retention', captureCompleteness: 'complete',
        captureKey: 'maintenance-key', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: staged.id, conversationId: thread.id, blobRef: 'opaque/old.aioev',
        keyedContentId: 'a'.repeat(64), byteCount: 4, keyVersion: 1, completedAt: 2,
      });

      expect(store.contextEvidence.listEvidenceForMaintenance({
        statuses: ['complete'], keyVersionNot: 2, limit: 1,
      })).toEqual([expect.objectContaining({ id: staged.id, keyVersion: 1 })]);
      expect(store.contextEvidence.replaceEvidenceBlob({
        evidenceId: staged.id, conversationId: thread.id,
        expectedBlobRef: 'opaque/wrong.aioev', expectedKeyVersion: 1,
        blobRef: 'opaque/new.aioev', keyedContentId: 'b'.repeat(64),
        byteCount: 4, keyVersion: 2, completedAt: 2, updatedAt: 3,
        cleanupGraceDeadline: 100,
      })).toBe(false);
      db.exec(`
        CREATE TRIGGER reject_rotation_cleanup
        BEFORE INSERT ON evidence_deletion_queue
        WHEN NEW.blob_ref = 'opaque/old.aioev'
        BEGIN SELECT RAISE(ABORT, 'fixture queue failure'); END
      `);
      expect(() => store.contextEvidence.replaceEvidenceBlob({
        evidenceId: staged.id, conversationId: thread.id,
        expectedBlobRef: 'opaque/old.aioev', expectedKeyVersion: 1,
        blobRef: 'opaque/new.aioev', keyedContentId: 'b'.repeat(64),
        byteCount: 4, keyVersion: 2, completedAt: 2, updatedAt: 3,
        cleanupGraceDeadline: 100,
      })).toThrow('fixture queue failure');
      expect(store.contextEvidence.getEvidence(thread.id, staged.id)).toMatchObject({
        blobRef: 'opaque/old.aioev', keyVersion: 1,
      });
      db.exec('DROP TRIGGER reject_rotation_cleanup');
      expect(store.contextEvidence.replaceEvidenceBlob({
        evidenceId: staged.id, conversationId: thread.id,
        expectedBlobRef: 'opaque/old.aioev', expectedKeyVersion: 1,
        blobRef: 'opaque/new.aioev', keyedContentId: 'b'.repeat(64),
        byteCount: 4, keyVersion: 2, completedAt: 2, updatedAt: 3,
        cleanupGraceDeadline: 100,
      })).toBe(true);
      expect(store.contextEvidence.getEvidence(thread.id, staged.id)).toMatchObject({
        blobRef: 'opaque/new.aioev', keyedContentId: 'b'.repeat(64), keyVersion: 2,
      });
      expect(store.contextEvidence.claimEvidenceDeletions(99, 10)).toEqual([]);
      expect(store.contextEvidence.claimEvidenceDeletions(100, 10)).toEqual([
        expect.objectContaining({
          conversationId: thread.id,
          evidenceId: staged.id,
          blobRef: 'opaque/old.aioev',
        }),
      ]);
      expect(store.contextEvidence.listReferencedEvidenceBlobRefs({ limit: 10 }))
        .toEqual(['opaque/new.aioev', 'opaque/old.aioev']);
      expect(store.contextEvidence.listReferencedEvidenceBlobRefs({
        afterBlobRef: 'opaque/new.aioev',
        limit: 10,
      })).toEqual(['opaque/old.aioev']);
    });

    it('keyset-paginates maintenance rows beyond the one-thousand-row page cap', () => {
      const thread = store.upsertThread({
        provider: 'orchestrator', nativeThreadId: 'maintenance-pages', sourceKind: 'orchestrator',
      });
      db.transaction(() => {
        for (let index = 0; index < 1_001; index += 1) {
          store.contextEvidence.stageEvidence({
            id: `evidence-${String(index).padStart(4, '0')}`,
            conversationId: thread.id,
            provider: 'codex',
            toolName: 'tool',
            sourceKind: 'other',
            mimeType: 'text/plain',
            sensitivity: 'normal',
            provenanceTrust: 'runtime-authenticated',
            captureMode: 'pre-retention',
            captureCompleteness: 'complete',
            captureKey: `maintenance-page-${index}`,
            createdAt: 10,
          });
        }
      })();

      const firstPage = store.contextEvidence.listEvidenceForMaintenance({
        statuses: ['staging'],
        limit: 1_000,
      });
      const secondPage = store.contextEvidence.listEvidenceForMaintenance({
        statuses: ['staging'],
        afterUpdatedAt: firstPage.at(-1)!.updatedAt,
        afterId: firstPage.at(-1)!.id,
        limit: 1_000,
      });

      expect(firstPage).toHaveLength(1_000);
      expect(firstPage.at(-1)?.id).toBe('evidence-0999');
      expect(secondPage.map((row) => row.id)).toEqual(['evidence-1000']);
    });

    it('stores card metadata and content-free audit/context events without raw evidence text', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'audit', sourceKind: 'orchestrator' });
      const staged = store.contextEvidence.stageEvidence({
        id: 'evidence-card-source', conversationId: thread.id, provider: 'codex', toolName: 'placeholder-tool',
        sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', captureKey: 'card-source', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: staged.id, conversationId: thread.id, blobRef: 'opaque/raw.aioev',
        keyedContentId: 'd'.repeat(64), byteCount: 10, keyVersion: 1, completedAt: 2,
      });

      const card = store.contextEvidence.storeEvidenceCard({
        id: 'card-1', conversationId: thread.id, evidenceId: staged.id,
        blobRef: 'opaque/card.aioev', extractorKind: 'generic', extractorVersion: '1',
        status: 'validated', sensitivity: 'normal', byteCount: 8, tokenEstimate: 2,
        createdAt: 3, cleanupGraceDeadline: 100,
      });
      expect(card).toMatchObject({ id: 'card-1', evidenceId: staged.id });
      expect(store.contextEvidence.getEvidenceCard(thread.id, card.id)).toEqual(card);
      expect(store.contextEvidence.getEvidenceCard('wrong-conversation', card.id)).toBeNull();
      expect(store.contextEvidence.listEvidenceCards(thread.id)).toEqual([card]);
      expect(store.contextEvidence.listEvidenceCards(thread.id, {
        evidenceId: staged.id,
      })).toEqual([card]);

      db.exec(`
        CREATE TRIGGER reject_displaced_card_cleanup
        BEFORE INSERT ON evidence_deletion_queue
        WHEN NEW.blob_ref = 'opaque/card.aioev'
        BEGIN SELECT RAISE(ABORT, 'fixture card cleanup failure'); END
      `);
      expect(() => store.contextEvidence.storeEvidenceCard({
        id: 'card-rejected', conversationId: thread.id, evidenceId: staged.id,
        blobRef: 'opaque/card-rejected.aioev', extractorKind: 'generic', extractorVersion: '1',
        status: 'validated', sensitivity: 'normal', byteCount: 9, tokenEstimate: 3,
        createdAt: 4, cleanupGraceDeadline: 100,
      })).toThrow('fixture card cleanup failure');
      expect(store.contextEvidence.getEvidenceCard(thread.id, card.id)).toEqual(card);
      db.exec('DROP TRIGGER reject_displaced_card_cleanup');

      const replacedCard = store.contextEvidence.storeEvidenceCard({
        id: 'card-2', conversationId: thread.id, evidenceId: staged.id,
        blobRef: 'opaque/card-v2.aioev', extractorKind: 'generic', extractorVersion: '1',
        status: 'validated', sensitivity: 'normal', byteCount: 9, tokenEstimate: 3,
        createdAt: 4, cleanupGraceDeadline: 100,
      });
      expect(replacedCard).toMatchObject({
        id: 'card-2', blobRef: 'opaque/card-v2.aioev', byteCount: 9, tokenEstimate: 3,
      });
      expect(store.contextEvidence.getEvidenceCard(thread.id, 'card-1')).toBeNull();
      expect(store.contextEvidence.claimEvidenceDeletions(99, 10)).toEqual([]);
      expect(store.contextEvidence.claimEvidenceDeletions(100, 10)).toEqual([
        expect.objectContaining({
          conversationId: thread.id,
          evidenceId: staged.id,
          blobRef: 'opaque/card.aioev',
        }),
      ]);

      store.contextEvidence.logEvidenceAccess({
        id: 'access-1', requester: 'mcp:evidence_read', conversationId: thread.id,
        operation: 'read', evidenceIds: [staged.id], requestedRanges: [{ startByte: 0, endByte: 4 }],
        outcomeCode: 'allowed', createdAt: 4,
      });
      store.contextEvidence.recordContextEvidenceEvent({
        id: 'event-1', conversationId: thread.id, provider: 'codex', eventKind: 'pressure-sample',
        recoveryEpoch: 0, outputBytes: 10, providerRequestCount: 1,
        newEvidenceCount: 1, newFindingCount: 0, createdAt: 5,
      });

      expect(db.prepare('SELECT evidence_ids_json, requested_ranges_json FROM evidence_access_log')
        .get<{ evidence_ids_json: string; requested_ranges_json: string }>()).toEqual({
        evidence_ids_json: JSON.stringify([staged.id]),
        requested_ranges_json: JSON.stringify([{ startByte: 0, endByte: 4 }]),
      });
      expect(db.prepare('SELECT event_kind, output_bytes FROM context_evidence_events')
        .get<{ event_kind: string; output_bytes: number }>()).toEqual({
        event_kind: 'pressure-sample', output_bytes: 10,
      });
    });

    it('atomically soft-deletes a conversation, transcript children, and queues opaque blobs', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'delete-me', sourceKind: 'orchestrator' });
      store.upsertMessages(thread.id, [{ id: 'delete-message', role: 'tool', content: 'placeholder', sequence: 1 }]);
      store.writeCheckpoint(thread.id, {
        id: 'delete-checkpoint', upToSequence: 1, summary: 'placeholder-summary',
        summarizedMessageCount: 1, summaryTokens: 1, createdAt: 1,
      });
      const staged = store.contextEvidence.stageEvidence({
        id: 'delete-evidence', conversationId: thread.id, provider: 'codex', toolName: 'placeholder-tool',
        sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', captureKey: 'delete-evidence', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: staged.id, conversationId: thread.id, blobRef: 'opaque/delete.aioev',
        keyedContentId: 'e'.repeat(64), byteCount: 10, keyVersion: 1, completedAt: 2,
      });
      store.contextEvidence.storeEvidenceCard({
        id: 'delete-card', conversationId: thread.id, evidenceId: staged.id,
        blobRef: 'opaque/delete.aioev', extractorKind: 'generic', extractorVersion: '1',
        status: 'validated', sensitivity: 'normal', byteCount: 10, createdAt: 3,
        cleanupGraceDeadline: 100,
      });
      const survivor = store.upsertThread({
        provider: 'orchestrator', nativeThreadId: 'keep-me', sourceKind: 'orchestrator',
      });
      store.upsertMessages(survivor.id, [{
        id: 'survivor-message', role: 'tool', content: 'surviving transcript', sequence: 1,
      }]);
      const survivorEvidence = store.contextEvidence.stageEvidence({
        id: 'survivor-evidence', conversationId: survivor.id, provider: 'codex',
        toolName: 'survivor-tool', sourceKind: 'other', mimeType: 'text/plain',
        sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
        captureMode: 'post-retention', captureCompleteness: 'complete',
        captureKey: 'survivor-evidence', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: survivorEvidence.id, conversationId: survivor.id,
        blobRef: 'opaque/survivor.aioev', keyedContentId: 'f'.repeat(64),
        byteCount: 10, keyVersion: 1, completedAt: 2,
      });

      const result = store.contextEvidence.softDeleteConversationWithEvidence({
        conversationId: thread.id,
        deletedAt: '2026-07-15T12:00:00.000Z',
        graceDeadline: 600_000,
      });

      expect(result.queuedBlobCount).toBe(1);
      expect(store.findThreadById(thread.id)).toBeNull();
      expect(store.listThreads({}).map((row) => row.id)).toEqual([survivor.id]);
      expect(store.contextEvidence.getEvidence(thread.id, staged.id)).toBeNull();
      expect(store.contextEvidence.getEvidenceCard(thread.id, 'delete-card')).toBeNull();
      expect(store.contextEvidence.listEvidenceCards(thread.id)).toEqual([]);
      expect(store.getMessages(thread.id)).toEqual([]);
      expect(store.getLatestCheckpoint(thread.id)).toBeNull();
      expect(store.getMessages(survivor.id).map((message) => message.content))
        .toEqual(['surviving transcript']);
      expect(store.contextEvidence.getEvidence(survivor.id, survivorEvidence.id))
        .toMatchObject({ id: survivorEvidence.id, status: 'complete' });
      const [firstClaim] = store.contextEvidence.claimEvidenceDeletions(600_000, 10);
      expect(firstClaim).toEqual(
        expect.objectContaining({
          conversationId: thread.id, blobRef: 'opaque/delete.aioev', attempts: 1,
          claimToken: expect.any(String), claimedUntil: 660_000,
        }),
      );
      expect(firstClaim?.claimToken).not.toBeNull();
      expect(store.contextEvidence.completeEvidenceDeletion(
        firstClaim!.id, 'wrong-token', 610_000,
      )).toBe(false);
      expect(store.contextEvidence.failEvidenceDeletion(
        firstClaim!.id, 'wrong-token', 'DELETE_IO_FAILED', 700_000,
      )).toBe(false);
      expect(store.contextEvidence.claimEvidenceDeletions(600_000, 10)).toEqual([]);
      expect(store.contextEvidence.failEvidenceDeletion(
        firstClaim!.id, firstClaim!.claimToken!, 'DELETE_IO_FAILED', 700_000,
      )).toBe(true);
      expect(store.contextEvidence.claimEvidenceDeletions(699_999, 10)).toEqual([]);
      const reclaimed = store.contextEvidence.claimEvidenceDeletions(700_000, 10);
      expect(reclaimed).toEqual([
        expect.objectContaining({ attempts: 2, claimToken: expect.any(String) }),
      ]);
      expect(reclaimed[0]?.claimToken).not.toBeNull();
      expect(store.contextEvidence.completeEvidenceDeletion(
        firstClaim!.id, firstClaim!.claimToken!, 700_001,
      )).toBe(false);
      expect(store.contextEvidence.completeEvidenceDeletion(
        reclaimed[0]!.id, reclaimed[0]!.claimToken!, 700_001,
      )).toBe(true);
      expect(store.contextEvidence.claimEvidenceDeletions(800_000, 10)).toEqual([]);
    });

    it('reports conversation-scoped renderer aggregates without combining card and result bytes', () => {
      const thread = store.upsertThread({
        provider: 'orchestrator', nativeThreadId: 'metrics-thread', sourceKind: 'orchestrator',
      });
      const evidence = store.contextEvidence.stageEvidence({
        id: 'metrics-evidence', conversationId: thread.id, provider: 'codex',
        toolCallRef: 'tool-call-1', toolName: 'exec_command', sourceKind: 'command',
        mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', captureKey: 'metrics-evidence', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: evidence.id, conversationId: thread.id,
        blobRef: 'opaque/metrics.aioev', keyedContentId: 'a'.repeat(64),
        byteCount: 10, keyVersion: 1, completedAt: 2,
      });
      const nonToolEvidence = store.contextEvidence.stageEvidence({
        id: 'metrics-file-evidence', conversationId: thread.id, provider: 'codex',
        toolName: 'file-observation', sourceKind: 'file', mimeType: 'text/plain',
        sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
        captureMode: 'observed-only', captureCompleteness: 'complete',
        captureKey: 'metrics-file-evidence', createdAt: 1,
      });
      store.contextEvidence.finalizeEvidence({
        evidenceId: nonToolEvidence.id, conversationId: thread.id,
        blobRef: 'opaque/metrics-file.aioev', keyedContentId: 'b'.repeat(64),
        byteCount: 7, keyVersion: 1, completedAt: 2,
      });
      store.contextEvidence.storeEvidenceCard({
        id: 'metrics-card', conversationId: thread.id, evidenceId: evidence.id,
        blobRef: 'opaque/metrics-card.aioev', extractorKind: 'generic', extractorVersion: '1',
        status: 'validated', sensitivity: 'normal', byteCount: 5, createdAt: 3,
        cleanupGraceDeadline: 100,
      });
      store.contextEvidence.recordContextEvidenceEvent({
        id: 'metrics-event', conversationId: thread.id, provider: 'codex',
        eventKind: 'recovery', recoveryEpoch: 2, actionCode: 'native-compaction',
        outputBytes: 10, providerRequestCount: 3, newEvidenceCount: 1,
        newFindingCount: 1, createdAt: 4,
      });

      expect(store.contextEvidence.getConversationMetrics(thread.id)).toEqual({
        evidenceRecordCount: 2,
        evidenceCardCount: 1,
        externallyStoredBytes: 22,
        toolCallCount: 1,
        toolResultBytes: 10,
        lastActionCode: 'native-compaction',
        recoveryCount: 2,
      });
    });
    it('never repopulates transcript rows after soft deletion', () => {
      const thread = store.upsertThread({ provider: 'orchestrator', nativeThreadId: 'deleted-write', sourceKind: 'orchestrator' });
      store.contextEvidence.softDeleteConversationWithEvidence({
        conversationId: thread.id,
        deletedAt: '2026-07-15T12:00:00.000Z',
        graceDeadline: 1,
      });

      expect(() => store.upsertMessages(thread.id, [
        { role: 'assistant', content: 'late provider result', sequence: 1 },
      ])).toThrow('CONVERSATION_NOT_FOUND');
      expect(store.getMessages(thread.id)).toEqual([]);
    });
  });
});
