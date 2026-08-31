import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from './session-continuity.types';
import { reconcileRecoveryTranscript } from './recovery-transcript-reconciler';

function entry(
  id: string,
  role: ConversationEntry['role'],
  content: string,
  timestamp: number,
  overrides: Partial<ConversationEntry> = {},
): ConversationEntry {
  return { id, role, content, timestamp, ...overrides };
}

describe('reconcileRecoveryTranscript', () => {
  it('preserves the archived prefix and appends only the uncovered continuity suffix', () => {
    const archived = [
      entry('a-1', 'user', 'Opening request', 1_000),
      entry('a-2', 'assistant', 'First response', 2_000),
    ];
    const continuity = [
      ...archived,
      entry('c-3', 'user', 'Follow-up request', 3_000),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages).toEqual([...archived, continuity[2]]);
    expect(result).toMatchObject({
      archivedCount: 2,
      recoveredCount: 1,
      droppedDuplicates: 2,
      coverageEnd: 2_000,
    });
  });

  it('drops an exact-ID duplicate even when the duplicate payload changed', () => {
    const archived = [entry('shared-id', 'assistant', 'Archived response', 1_000)];
    const continuity = [entry('shared-id', 'assistant', 'Changed replay payload', 2_000)];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages).toEqual(archived);
    expect(result.droppedDuplicates).toBe(1);
  });

  it('charges exact-ID suppression to the archived payload fingerprint', () => {
    const archived = [
      entry('exact-id', 'assistant', 'Archived alpha', 10_001),
      entry('archived-beta', 'assistant', 'Archived beta', 10_002),
    ];
    const continuity = [
      entry('exact-id', 'assistant', 'Archived beta', 10_003),
      entry('replayed-beta', 'assistant', 'Archived beta', 10_004),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages).toEqual(archived);
    expect(result.recoveredCount).toBe(0);
    expect(result.droppedDuplicates).toBe(2);
  });

  it('drops replay duplicates whose IDs changed but stable fingerprints match', () => {
    const archived = [entry('archive-id', 'user', '  Continue the fixture.\r\n', 10_001)];
    const continuity = [entry('replay-id', 'user', 'Continue the fixture.\n', 10_999)];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages).toEqual(archived);
    expect(result.droppedDuplicates).toBe(1);
  });

  it('preserves distinct-ID continuity messages with identical fingerprints', () => {
    const continuity = [
      entry('continuity-copy-1', 'assistant', 'Repeated fixture response', 12_001),
      entry('continuity-copy-2', 'assistant', 'Repeated fixture response', 12_002),
    ];

    const result = reconcileRecoveryTranscript([], continuity);

    expect(result.messages.map((message) => message.id)).toEqual([
      'continuity-copy-1',
      'continuity-copy-2',
    ]);
    expect(result.recoveredCount).toBe(2);
    expect(result.droppedDuplicates).toBe(0);
  });

  it('consumes only the archived fingerprint multiplicity before preserving another copy', () => {
    const archived = [
      entry('archive-copy-1', 'assistant', 'Repeated fixture response', 15_001),
      entry('archive-copy-2', 'assistant', 'Repeated fixture response', 15_002),
    ];
    const continuity = [
      entry('replay-copy-1', 'assistant', 'Repeated fixture response', 15_003),
      entry('replay-copy-2', 'assistant', 'Repeated fixture response', 15_004),
      entry('new-copy-3', 'assistant', 'Repeated fixture response', 15_005),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);
    const repeated = reconcileRecoveryTranscript(result.messages, continuity);

    expect(result.messages.map((message) => message.id)).toEqual([
      'archive-copy-1',
      'archive-copy-2',
      'new-copy-3',
    ]);
    expect(result.recoveredCount).toBe(1);
    expect(result.droppedDuplicates).toBe(2);
    expect(repeated.messages).toEqual(result.messages);
  });

  it('does not consume archived multiplicity twice for one repeated continuity id', () => {
    const archived = [
      entry('archive-copy-1', 'assistant', 'Repeated fixture response', 15_001),
      entry('archive-copy-2', 'assistant', 'Repeated fixture response', 15_002),
    ];
    const continuity = [
      entry('archive-copy-1', 'assistant', 'Repeated fixture response', 15_001),
      entry('archive-copy-1', 'assistant', 'Repeated fixture response', 15_001),
      entry('continuity-copy-2', 'assistant', 'Repeated fixture response', 15_003),
      entry('continuity-copy-3', 'assistant', 'Repeated fixture response', 15_004),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages.map((message) => message.id)).toEqual([
      'archive-copy-1',
      'archive-copy-2',
      'continuity-copy-3',
    ]);
    expect(result.recoveredCount).toBe(1);
    expect(result.droppedDuplicates).toBe(3);
  });

  it('keeps a distinct entry at the exact history coverage timestamp', () => {
    const archived = [entry('archive-id', 'assistant', 'Archived response', 20_000)];
    const equalTimestamp = entry('suffix-id', 'tool', 'Distinct result', 20_000);

    const result = reconcileRecoveryTranscript(archived, [equalTimestamp]);

    expect(result.messages).toEqual([...archived, equalTimestamp]);
    expect(result.recoveredCount).toBe(1);
  });

  it('orders unseen continuity entries chronologically with source order as the tie-break', () => {
    const archived = [entry('archive-id', 'user', 'Start', 100)];
    const continuity = [
      entry('later', 'assistant', 'Later', 300),
      entry('same-b', 'assistant', 'Same timestamp second', 200),
      entry('same-a', 'user', 'Same timestamp first', 200),
      entry('covered', 'assistant', 'Covered by watermark', 99),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages.map((message) => message.id)).toEqual([
      'archive-id',
      'same-b',
      'same-a',
      'later',
    ]);
  });

  it('preserves tool calls and results while using their identity for replay deduplication', () => {
    const toolCall = entry('tool-call', 'assistant', 'Using fixture tool', 30_000, {
      toolUse: { toolName: 'FixtureTool', input: { beta: 2, alpha: 1 } },
    });
    const toolResult = entry('tool-result', 'tool', 'Fixture output', 31_000, {
      toolUse: {
        toolName: 'FixtureTool',
        input: { alpha: 1, beta: 2 },
        output: 'Fixture output',
      },
    });
    const replayedCall = entry('replayed-call', 'assistant', 'Using fixture tool', 30_500, {
      toolUse: { toolName: 'FixtureTool', input: { alpha: 1, beta: 2 } },
    });
    const newerResult = entry('new-result', 'tool', 'New fixture output', 32_000, {
      toolUse: {
        toolName: 'FixtureTool',
        input: { alpha: 1, beta: 2 },
        output: 'New fixture output',
      },
    });

    const result = reconcileRecoveryTranscript(
      [toolCall, toolResult],
      [replayedCall, newerResult],
    );

    expect(result.messages).toEqual([toolCall, toolResult, newerResult]);
    expect(result.messages[2]?.toolUse).toEqual(newerResult.toolUse);
    expect(result.droppedDuplicates).toBe(1);
  });

  it('reconciles 711 archived messages plus a newer suffix without losing the prefix', () => {
    const archived = Array.from({ length: 711 }, (_, index) => entry(
      `archive-${index}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `Archived fixture ${index}`,
      100_000 + index,
    ));
    const continuity = [
      ...archived.map((message) => ({ ...message, id: `replay-${message.id}` })),
      entry('suffix-1', 'assistant', 'Recovered suffix one', 101_000),
      entry('suffix-2', 'tool', 'Recovered suffix two', 101_001),
    ];

    const result = reconcileRecoveryTranscript(archived, continuity);

    expect(result.messages).toHaveLength(713);
    expect(result.messages.slice(0, archived.length)).toEqual(archived);
    expect(result.messages.slice(-2).map((message) => message.id)).toEqual([
      'suffix-1',
      'suffix-2',
    ]);
    expect(result.droppedDuplicates).toBe(711);
  });

  it('is deterministic and does not append the same suffix again', () => {
    const archived = [entry('archive-id', 'user', 'Start', 1_000)];
    const continuity = [
      entry('suffix-id', 'assistant', 'Recovered response', 2_000),
      entry('suffix-id', 'assistant', 'Recovered response', 2_000),
    ];

    const first = reconcileRecoveryTranscript(archived, continuity);
    const sameInputs = reconcileRecoveryTranscript(archived, continuity);
    const repeated = reconcileRecoveryTranscript(first.messages, continuity);

    expect(sameInputs).toEqual(first);
    expect(repeated.messages).toEqual(first.messages);
    expect(first.messages.map((message) => message.id)).toEqual(['archive-id', 'suffix-id']);
  });
});
