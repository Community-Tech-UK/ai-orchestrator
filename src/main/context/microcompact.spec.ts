import { describe, it, expect } from 'vitest';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import { parseEvidenceCitations } from '../context-evidence/evidence-citation-parser';
import { EvidencePreviewBuilder } from '../context-evidence/evidence-preview-builder';
import { Microcompact, type MicrocompactTurn } from './microcompact';

describe('Microcompact', () => {
  const makeTurn = (id: string, tokenCount: number, toolOutputTokens = 0): MicrocompactTurn => ({
    id,
    role: 'assistant',
    content: 'response',
    tokenCount,
    timestamp: Date.now(),
    toolCalls: toolOutputTokens > 0 ? [{
      id: `tc-${id}`,
      name: 'bash',
      input: 'ls',
      output: 'file1\nfile2',
      inputTokens: 10,
      outputTokens: toolOutputTokens,
      evidencePreview: {
        evidenceId: `evidence-${id}`,
        preview: `[evidence:evidence-${id}@0-5#${'a'.repeat(64)}]`,
        tokenCount: 5,
        authenticatedComplete: true,
      },
    }] : undefined,
  });

  it('removes tool outputs from old turns, preserving recent ones', async () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 100 });
    const turns = [
      makeTurn('old1', 100, 500),
      makeTurn('old2', 100, 600),
      makeTurn('recent1', 100, 300),
      makeTurn('recent2', 100, 200),
    ];
    await authorize(turns[0]);
    await authorize(turns[1]);
    const result = mc.compact(turns);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.turns[0].toolCalls![0].output).toContain('[evidence:evidence-old1@');
    expect(result.turns[1].toolCalls![0].output).toContain('[evidence:evidence-old2@');
    expect(result.turns[2].toolCalls![0].output).toBe('file1\nfile2');
    expect(result.turns[3].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('skips compaction when savings below threshold', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 5000 });
    const turns = [makeTurn('old1', 100, 50), makeTurn('recent1', 100, 50)];
    const result = mc.compact(turns);
    expect(result.tokensSaved).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it('preserves turns with no tool calls', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      { id: 'plain', role: 'user' as const, content: 'hello', tokenCount: 50, timestamp: Date.now() },
      makeTurn('recent', 100, 200),
    ];
    const result = mc.compact(turns);
    expect(result.turns[0].content).toBe('hello');
  });

  it('never discards the only full output when authenticated complete evidence is absent', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 0, minSavingsTokens: 0 });
    const turn = makeTurn('uncaptured', 100, 1_000);
    delete turn.toolCalls![0].evidencePreview;

    const result = mc.compact([turn]);

    expect(result.skipped).toBe(true);
    expect(result.turns[0].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('rejects incomplete or unauthenticated previews', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 0, minSavingsTokens: 0 });
    const turn = makeTurn('bounded', 100, 1_000);
    turn.toolCalls![0].evidencePreview!.authenticatedComplete = false;

    expect(mc.compact([turn]).turns[0].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('reports correct metrics', async () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      makeTurn('old', 100, 1000),
      makeTurn('recent', 100, 500),
    ];
    await authorize(turns[0]);

    const result = mc.compact(turns);
    expect(result.turnsCompacted).toBe(1);
    expect(result.tokensSaved).toBe(1000 - turns[0].toolCalls![0].evidencePreview!.tokenCount);
  });

  it('rejects a caller-forged complete flag and syntactically valid citation', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 0, minSavingsTokens: 0 });
    const turn = makeTurn('forged', 100, 1_000);

    const result = mc.compact([turn]);

    expect(result.skipped).toBe(true);
    expect(result.turns[0].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('replaces legacy lossy markers with an authenticated resolvable citation', async () => {
    const legacyMicrocompact = '[microcompacted]';
    const legacyPruned = '[Output pruned for context optimization]';
    expect(parseEvidenceCitations(legacyMicrocompact).citations).toEqual([]);
    expect(parseEvidenceCitations(legacyPruned).citations).toEqual([]);

    const mc = new Microcompact({ recentTurnsToProtect: 0, minSavingsTokens: 0 });
    const turn = makeTurn('legacy-regression', 100, 1_000);
    await authorize(turn);

    const result = mc.compact([turn]);
    const replacement = result.turns[0].toolCalls![0].output!;
    const parsed = parseEvidenceCitations(replacement);

    expect(replacement).not.toContain(legacyMicrocompact);
    expect(replacement).not.toContain(legacyPruned);
    expect(parsed.malformedMarkers).toEqual([]);
    expect(parsed.citations).toEqual([
      expect.objectContaining({
        evidenceId: 'evidence-legacy-regression',
        contentDigest: 'a'.repeat(64),
      }),
    ]);
  });
});

async function authorize(turn: MicrocompactTurn): Promise<void> {
  const toolCall = turn.toolCalls![0];
  const content = new TextEncoder().encode(toolCall.output!);
  const builder = new EvidencePreviewBuilder({
    read: async () => Uint8Array.from(content),
    deriveCitationDigest: async () => 'a'.repeat(64),
  });
  const record: EvidenceLedgerRecord = {
    id: `evidence-${turn.id}`, conversationId: 'conversation-1', provider: 'codex',
    providerThreadRef: null, providerSessionRef: null, turnRef: turn.id,
    toolCallRef: toolCall.id, toolName: toolCall.name, sourceKind: 'other',
    sourceLocatorRedacted: null, status: 'complete', blobRef: 'opaque/blob.aioev1',
    keyedContentId: 'b'.repeat(64), byteCount: content.byteLength, tokenEstimate: null,
    mimeType: 'text/plain', sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
    captureMode: 'post-retention', captureCompleteness: 'complete', truncationReason: null,
    keyVersion: 1, captureKey: `capture-${turn.id}`, createdAt: 1, completedAt: 2, updatedAt: 2,
  };
  const result = await builder.build(record);
  if (!result.canReplaceOriginal) throw new Error('fixture preview not authorized');
  toolCall.evidencePreview = result.preview;
}
